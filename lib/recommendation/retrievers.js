import { dedupeTracks, normalizeTrack } from './identity.js';

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function songsFrom(value) {
	return asArray(value?.songs ?? value?.result?.songs ?? value?.tracks ?? value?.playlist?.tracks);
}

function positiveTracks(profile, limit = 4) {
	return Object.values(profile?.tracks ?? {})
		.filter((entry) => Number(entry?.affinity) > 0)
		.sort((a, b) => Number(b.affinity) - Number(a.affinity))
		.slice(0, limit);
}

function positiveArtists(profile, limit = 4) {
	return Object.values(profile?.artists ?? {})
		.filter((entry) => Number(entry?.affinity) > 0 && entry?.name)
		.sort((a, b) => Number(b.affinity) - Number(a.affinity))
		.slice(0, limit);
}

async function search(client, query, limit = 20, signal) {
	if (!client || typeof client.search !== 'function' || !String(query || '').trim()) return [];
	return songsFrom(await client.search(String(query).trim(), 1, limit, { signal }));
}

async function playlistCandidates(client, keyword, playlistLimit = 3, trackLimit = 25, signal) {
	if (!client || typeof client.search !== 'function' || typeof client.playlist !== 'function') return [];
	const result = await client.search(keyword, 1000, playlistLimit, { signal });
	const playlists = asArray(result?.playlists).slice(0, playlistLimit);
	const settled = await Promise.allSettled(playlists.map((item) => client.playlist(item.id, trackLimit, { signal })));
	return settled.flatMap((item) => item.status === 'fulfilled' ? asArray(item.value?.tracks).slice(0, trackLimit) : []);
}

export async function retrieveLikedNeighbors({ profile, client, signal }) {
	const settled = await Promise.allSettled(positiveTracks(profile).map((track) =>
		search(client, `${asArray(track.artists)[0] ?? ''} ${track.title}`, 12, signal)
	));
	return settled.flatMap((item) => item.status === 'fulfilled' ? item.value : []);
}

export async function retrieveCurrentSimilar({ context, client, signal }) {
	const current = context?.currentTrack;
	if (!current) return [];
	const id = current.raw?.id;
	if (id && typeof client?.getJson === 'function') {
		const result = await client.getJson(`${client.apiBase}/simi/song?id=${encodeURIComponent(id)}`, { signal });
		const songs = songsFrom(result);
		if (songs.length > 0) return songs;
	}
	return search(client, `${current.artists?.[0] ?? ''} ${current.title ?? ''}`, 20, signal);
}

export async function retrieveArtists({ profile, client, signal }) {
	const settled = await Promise.allSettled(positiveArtists(profile).map((artist) => search(client, artist.name, 15, signal)));
	return settled.flatMap((item) => item.status === 'fulfilled' ? item.value : []);
}

function sceneKeyword(context) {
	const activity = String(context?.activity ?? 'listen').toLocaleLowerCase();
	if (activity === 'focus') return '专注 工作 音乐';
	if (activity === 'workout') return '运动 跑步 音乐';
	if (activity === 'commute') return '通勤 音乐';
	if (activity === 'sleep') return '助眠 轻音乐';
	return '日常 好听 音乐';
}

export async function retrieveScenePlaylists({ context, client, signal }) {
	return playlistCandidates(client, sceneKeyword(context), 3, 20, signal);
}

export async function retrieveLocalLibrary({ context, profile, localLibrary, signal }) {
	if (!localLibrary || typeof localLibrary.candidates !== 'function') return [];
	return asArray(await localLibrary.candidates({ context, profile, signal }));
}

export async function retrieveExploration({ client, signal }) {
	if (!client) return [];
	if (typeof client.getJson === 'function' && typeof client.playlist === 'function') {
		const data = await client.getJson(`${client.apiBase}/personalized?limit=4`, { signal });
		const playlists = asArray(data?.result).slice(0, 4);
		const settled = await Promise.allSettled(playlists.map((item) => client.playlist(item.id, 15, { signal })));
		const songs = settled.flatMap((item) => item.status === 'fulfilled' ? asArray(item.value?.tracks).slice(0, 15) : []);
		if (songs.length > 0) return songs;
	}
	return search(client, '热门 音乐', 20, signal);
}

function timedAdapter(sourceKey, retrieve, timeoutMs, defaults = {}) {
	const adapter = async (input) => {
		const controller = new AbortController();
		const parentSignal = input?.signal;
		const relayAbort = () => controller.abort(parentSignal.reason);
		if (parentSignal?.aborted) relayAbort();
		else parentSignal?.addEventListener('abort', relayAbort, { once: true });
		const timer = setTimeout(() => controller.abort(new Error(`${sourceKey} timed out`)), timeoutMs);
		try {
			return await Promise.race([
				retrieve({
					...defaults,
					...input,
					client: input?.client ?? defaults.client,
					localLibrary: input?.localLibrary ?? defaults.localLibrary,
					signal: controller.signal
				}),
				new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason ?? new Error(`${sourceKey} aborted`)), { once: true }))
			]);
		} finally {
			clearTimeout(timer);
			parentSignal?.removeEventListener('abort', relayAbort);
		}
	};
	adapter.sourceKey = sourceKey;
	return adapter;
}

export function createRetrievers({ client, localLibrary, timeoutMs = 2500 } = {}) {
	const defaults = { client, localLibrary };
	return [
		timedAdapter('liked-neighbors', retrieveLikedNeighbors, timeoutMs, defaults),
		timedAdapter('current-similar', retrieveCurrentSimilar, timeoutMs, defaults),
		timedAdapter('artists', retrieveArtists, timeoutMs, defaults),
		timedAdapter('scene-playlists', retrieveScenePlaylists, timeoutMs, defaults),
		timedAdapter('local-library', retrieveLocalLibrary, timeoutMs, defaults),
		timedAdapter('exploration', retrieveExploration, timeoutMs, defaults)
	].map((adapter) => Object.assign(adapter, { client, localLibrary }));
}

export async function collectCandidates(input = {}) {
	const retrievers = input.retrievers ?? createRetrievers(input);
	const settled = await Promise.allSettled(retrievers.map((adapter) => adapter({
		context: input.context,
		profile: input.profile,
		client: input.client ?? adapter.client,
		localLibrary: input.localLibrary ?? adapter.localLibrary,
		signal: input.signal
	})));
	const candidates = [];
	const failures = [];
	for (let index = 0; index < settled.length; index += 1) {
		const item = settled[index];
		const sourceKey = retrievers[index]?.sourceKey ?? `retriever-${index + 1}`;
		if (item.status === 'rejected') {
			failures.push({ sourceKey, message: item.reason?.message ?? String(item.reason) });
			continue;
		}
		for (const raw of asArray(item.value)) {
			const track = raw?.trackKey
				? { ...raw, origins: [...new Set([...(raw.origins ?? []), sourceKey])] }
				: normalizeTrack(raw, sourceKey);
			if (track) candidates.push(track);
		}
	}
	return { tracks: dedupeTracks(candidates), failures };
}
