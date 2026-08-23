import { isRequestedVersion, trackKey } from './identity.js';
import { safeCrossSourceDuration } from '../source-match.js';

function requestKey(requested) {
	if (!requested) return '';
	return JSON.stringify({
		title: String(requested.title ?? requested.name ?? '').trim().normalize('NFKC').toLocaleLowerCase(),
		artists: (Array.isArray(requested.artists) ? requested.artists : [requested.artist]).filter(Boolean)
			.map((artist) => String(artist).trim().normalize('NFKC').toLocaleLowerCase())
	});
}

async function invoke(adapter, track, options) {
	if (!adapter) return null;
	if (typeof adapter === 'function') return adapter(track, options);
	if (typeof adapter.resolve === 'function') return adapter.resolve(track.trackKey, options);
	return null;
}

function resultFor(kind, result, now, track, requested) {
	if (!result) return null;
	const value = typeof result === 'string' ? { url: result } : result;
	const url = value.url ?? (kind === 'local' ? value.localPath : null);
	if (!url) return null;
	return {
		playable: true,
		kind,
		url,
		sourceKey: String(value.sourceKey ?? value.source ?? kind),
		confidence: Number.isFinite(Number(value.confidence)) ? Number(value.confidence) : (kind === 'cross-source' ? 0.9 : 1),
		expiresAt: Number(value.expiresAt) || (kind === 'local' ? Number.MAX_SAFE_INTEGER : now + 5 * 60 * 1000),
		matchedIdentity: value.matchedIdentity ?? (kind === 'cross-source' && requested ? requested : track)
	};
}

export function createSourceResolver(options = {}) {
	const now = typeof options.now === 'function' ? options.now : Date.now;
	const minimumCrossConfidence = Number(options.minimumCrossConfidence) || 0.9;
	const adapters = [
		{ kind: 'local', adapter: options.local },
		{ kind: 'direct', adapter: options.direct },
		{ kind: 'cross-source', adapter: options.cross }
	];
	const cache = new Map();
	const sourceStats = new Map();

	async function resolve(track, requested, callOptions = {}) {
		if (!track) return null;
		const key = `${track.trackKey || trackKey(track)}|${requestKey(requested)}`;
		const cached = cache.get(key);
		if (cached && cached.expiresAt > now()) return { ...cached };
		if (cached) cache.delete(key);

		const candidateMatchesRequest = !requested || isRequestedVersion(track, requested);
		for (const { kind, adapter } of adapters) {
			if (!adapter) continue;
			if ((kind === 'local' || kind === 'direct') && !candidateMatchesRequest) continue;
			let raw;
			try {
				raw = await invoke(adapter, track, {
					requested,
					durationMs: kind === 'cross-source' ? safeCrossSourceDuration(track, requested) : track.durationMs,
					signal: callOptions.signal
				});
			} catch {
				continue;
			}
			const qualified = resultFor(kind, raw, now(), track, requested);
			if (!qualified) continue;
			if (kind === 'cross-source' && requested) {
				if (qualified.confidence < minimumCrossConfidence) continue;
				if (!isRequestedVersion(qualified.matchedIdentity, requested)) continue;
			}
			cache.set(key, qualified);
			const stat = sourceStats.get(qualified.sourceKey) ?? { ok: 0, failed: 0 };
			stat.ok += 1;
			sourceStats.set(qualified.sourceKey, stat);
			return { ...qualified };
		}
		return null;
	}

	async function qualify(track, requested, callOptions) {
		const result = await resolve(track, requested, callOptions);
		return result ?? { playable: false, kind: null, url: null, sourceKey: null, confidence: 0, expiresAt: 0, matchedIdentity: null };
	}

	async function reportFailure(sourceKey) {
		const key = String(sourceKey ?? '').trim();
		if (!key) return false;
		for (const [cacheKey, value] of cache) {
			if (value.sourceKey === key) cache.delete(cacheKey);
		}
		const stat = sourceStats.get(key) ?? { ok: 0, failed: 0 };
		stat.failed += 1;
		sourceStats.set(key, stat);
		return true;
	}

	async function clear() {
		cache.clear();
		sourceStats.clear();
		return true;
	}

	return { qualify, resolve, reportFailure, clear };
}
