import { buildButtonContext } from './context.js';
import { collectCandidates as defaultCollectCandidates } from './retrievers.js';
import { rankCandidates as defaultRankCandidates } from './ranker.js';
import { planQueue as defaultPlanQueue } from './queue-planner.js';

function errorMessage(error) {
	return error?.message ?? String(error);
}

function currentTrack(player) {
	return typeof player?.current === 'function' ? player.current() : player?.current ?? null;
}

function isReplaceableButtonRecommendation(track, index, currentIndex) {
	return index > currentIndex &&
		track?.moonyOrigin === 'recommendation' &&
		track?.recommendationSessionId === 'button-recommendation';
}

function withoutTransientUrl(track, hit) {
	const value = {
		...track,
		playable: true,
		sourceKey: hit?.sourceKey ?? track.sourceKey ?? null,
		confidence: Number(hit?.confidence ?? track.confidence) || 1,
		lastVerifiedAt: Date.now()
	};
	delete value.url;
	delete value.resolvedUrl;
	delete value.currentUrl;
	delete value.expiresAt;
	return value;
}

export function createRecommendationGenerator(options = {}) {
	const pool = options.pool;
	const player = options.player;
	const profile = options.profile;
	const collectCandidates = options.collectCandidates ?? defaultCollectCandidates;
	const rankCandidates = options.rankCandidates ?? defaultRankCandidates;
	const planQueue = options.planQueue ?? defaultPlanQueue;
	const resolver = options.resolver;
	const contextBuilder = options.contextBuilder ?? buildButtonContext;
	const targetSize = Math.max(30, Number(options.targetSize) || 60);
	const verifyConcurrency = Math.max(1, Math.min(16, Number(options.verifyConcurrency) || 8));
	let sequence = 0;

	if (!pool || typeof pool.snapshot !== 'function' || typeof pool.replace !== 'function') throw new Error('recommendation generator requires a pool');
	if (!resolver || typeof resolver.resolve !== 'function') throw new Error('recommendation generator requires a resolver');

	async function verify(entry) {
		try {
			const hit = await resolver.resolve(entry.track, null, {});
			if (!hit || hit.playable === false || (!hit.url && !hit.localPath)) return null;
			return { ...entry, track: withoutTransientUrl(entry.track, hit) };
		} catch {
			return null;
		}
	}

	async function generate(input = {}) {
		const generationId = `pool-generation-${Date.now()}-${++sequence}`;
		try {
			const [snapshot, poolState] = await Promise.all([
				profile?.snapshot ? profile.snapshot() : { tracks: {}, artists: {}, rules: [], resolverStats: {} },
				pool.snapshot()
			]);
			const current = currentTrack(player);
			const queue = [...(player?.state?.queue ?? [])];
			const currentIndex = Number.isInteger(player?.state?.index) ? player.state.index : queue.indexOf(current);
			const protectedQueue = queue.filter((track, index) => !isReplaceableButtonRecommendation(track, index, currentIndex));
			const context = contextBuilder({
				profile: snapshot,
				currentTrack: current,
				queue,
				recentRecommendedTrackKeys: poolState.recentRecommendedTrackKeys
			});
			const collected = await collectCandidates({
				...options,
				context,
				profile: snapshot
			});
			const blocked = new Set([
				current?.trackKey,
				...protectedQueue.map((track) => track?.trackKey),
				...poolState.items.map((track) => track?.trackKey)
			].filter(Boolean));
			const candidates = (collected?.tracks ?? []).filter((track) => track?.trackKey && !blocked.has(track.trackKey));
			const ranked = rankCandidates({ candidates, context, profile: snapshot, rng: options.rng ?? Math.random });
			const verified = [];
			for (let index = 0; index < ranked.length; index += verifyConcurrency) {
				const batch = ranked.slice(index, index + verifyConcurrency);
				const settled = await Promise.all(batch.map(verify));
				verified.push(...settled.filter(Boolean));
				const preview = planQueue({
					ranked: verified,
					targetSize,
					currentTrack: current,
					existingQueue: protectedQueue,
					rng: options.rng ?? Math.random
				});
				if (preview.tracks.length >= targetSize) break;
			}
			const planningEntries = poolState.items.length < targetSize
				? verified.concat(poolState.items.map((track, index) => ({ track, total: -1_000_000 - index })))
				: verified;
			const plan = planQueue({
				ranked: planningEntries,
				targetSize,
				currentTrack: current,
				existingQueue: protectedQueue,
				rng: options.rng ?? Math.random
			});
			const replaced = await pool.replace(plan.tracks, {
				generationId,
				profileRevision: Number(snapshot?.updatedAt) || 0,
				lastGenerationStatus: { ok: plan.tracks.length >= 30, count: plan.tracks.length, failures: collected?.failures ?? [], reasons: input.reasons ?? [] }
			});
			if (!replaced.ok) {
				return { ok: false, generationId, count: 0, failures: collected?.failures ?? [], shortfall: targetSize - plan.tracks.length, reason: replaced.reason };
			}
			return { ok: true, generationId, count: replaced.count, failures: collected?.failures ?? [], shortfall: Math.max(0, targetSize - replaced.count) };
		} catch (error) {
			return { ok: false, generationId, count: 0, error: errorMessage(error), failures: [errorMessage(error)] };
		}
	}

	return { generate };
}
