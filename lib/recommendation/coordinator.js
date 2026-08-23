import { normalizeTrack } from './identity.js';
import { buildButtonContext } from './context.js';
import { collectCandidates as defaultCollectCandidates } from './retrievers.js';
import { rankCandidates as defaultRankCandidates } from './ranker.js';
import { planQueue as defaultPlanQueue } from './queue-planner.js';

function currentTrack(player) {
	const raw = typeof player?.current === 'function' ? player.current() : player?.current;
	if (!raw) return null;
	return raw.trackKey ? raw : normalizeTrack(raw, 'player');
}

function errorMessage(error) {
	return error?.message ?? String(error);
}

export function createRecommendationCoordinator(options = {}) {
	const player = options.player;
	const profile = options.profile;
	const contextBuilder = options.contextBuilder ?? buildButtonContext;
	const collectCandidates = options.collectCandidates ?? defaultCollectCandidates;
	const rankCandidates = options.rankCandidates ?? defaultRankCandidates;
	const planQueue = options.planQueue ?? defaultPlanQueue;
	const resolver = options.resolver;
	const targetSize = Math.max(1, Number(options.targetSize) || 15);
	const preflightCount = Math.max(1, Number(options.preflightCount) || 5);
	const timeoutMs = Math.max(100, Number(options.timeoutMs) || 8000);
	const rng = options.rng ?? Math.random;
	let sequence = 0;
	let active = null;
	let lastStatus = { state: 'idle', sessionId: null, count: 0, failures: [] };

	function cancel(reason = 'cancelled') {
		if (!active || active.controller.signal.aborted) return false;
		active.controller.abort(new Error(reason));
		lastStatus = { ...lastStatus, state: 'cancelled', sessionId: active.sessionId };
		return true;
	}

	async function resolveEntry(entry, signal) {
		if (signal.aborted) throw signal.reason;
		try {
			const hit = await resolver.resolve(entry.track, null, { signal });
			if (!hit?.playable) return null;
			return { ...entry.track, ...hit };
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			return null;
		}
	}

	function makePlan(tracks, context, snapshot, current) {
		const ranked = rankCandidates({ candidates: tracks, context, profile: snapshot, rng });
		return planQueue({
			ranked,
			targetSize,
			rng,
			currentTrack: current,
			existingQueue: player?.state?.queue ?? []
		});
	}

	async function recommend(input = {}) {
		cancel('superseded');
		const sessionId = `recommendation-${Date.now()}-${++sequence}`;
		const controller = new AbortController();
		const session = { sessionId, controller };
		active = session;
		lastStatus = { state: 'collecting', sessionId, count: 0, failures: [] };
		const timeout = setTimeout(() => controller.abort(new Error('recommendation timed out')), timeoutMs);
		try {
			const snapshot = profile?.snapshot ? await profile.snapshot() : { tracks: {}, artists: {}, rules: [] };
			if (controller.signal.aborted) throw controller.signal.reason;
			const current = currentTrack(player);
			const context = contextBuilder({ ...input, profile: snapshot, currentTrack: current, queue: player?.state?.queue ?? [] });
			const collected = await collectCandidates({
				...options,
				context,
				profile: snapshot,
				signal: controller.signal
			});
			if (controller.signal.aborted) throw controller.signal.reason;
			const roughRanked = rankCandidates({ candidates: collected.tracks ?? [], context, profile: snapshot, rng });
			const verified = [];
			let cursor = 0;
			while (verified.length < preflightCount && cursor < roughRanked.length) {
				const needed = preflightCount - verified.length;
				const batch = roughRanked.slice(cursor, cursor + needed);
				cursor += batch.length;
				const settled = await Promise.all(batch.map((entry) => resolveEntry(entry, controller.signal)));
				verified.push(...settled.filter(Boolean));
			}
			if (controller.signal.aborted) throw controller.signal.reason;
			if (verified.length === 0) {
				clearTimeout(timeout);
				lastStatus = { state: 'failed', sessionId, count: 0, failures: collected.failures ?? [] };
				return { ok: false, tracks: [], failures: collected.failures ?? [], guidance: '暂时没有验证到可播放歌曲，当前播放和队列保持不变。' };
			}
			const initialPlan = makePlan(verified, context, snapshot, current);
			player.insertRecommendationAfterCurrent(initialPlan.tracks, sessionId);
			lastStatus = { state: cursor < roughRanked.length ? 'expanding' : 'ready', sessionId, count: initialPlan.tracks.length, failures: collected.failures ?? [] };

			const remaining = roughRanked.slice(cursor);
			if (remaining.length > 0) {
				const background = setTimeout(async () => {
					try {
						const more = (await Promise.all(remaining.map((entry) => resolveEntry(entry, controller.signal)))).filter(Boolean);
						if (active !== session || controller.signal.aborted) return;
						const finalPlan = makePlan([...verified, ...more], context, snapshot, current);
						player.insertRecommendationAfterCurrent(finalPlan.tracks, sessionId);
						lastStatus = { state: 'ready', sessionId, count: finalPlan.tracks.length, failures: collected.failures ?? [] };
					} catch {
						if (active === session && !controller.signal.aborted) lastStatus = { ...lastStatus, state: 'ready' };
					} finally {
						clearTimeout(timeout);
					}
				}, 0);
				background.unref?.();
			} else {
				clearTimeout(timeout);
			}
			return {
				ok: true,
				sessionId,
				insertMode: 'after-current',
				verifiedBeforeInsert: initialPlan.tracks.length,
				tracks: initialPlan.tracks,
				failures: collected.failures ?? [],
				shortfall: initialPlan.shortfall
			};
		} catch (error) {
			clearTimeout(timeout);
			if (controller.signal.aborted) {
				return { ok: false, cancelled: true, sessionId, tracks: [], error: errorMessage(controller.signal.reason) };
			}
			if (active === session) lastStatus = { state: 'failed', sessionId, count: 0, failures: [errorMessage(error)] };
			return {
				ok: false,
				sessionId,
				tracks: [],
				error: errorMessage(error),
				guidance: '推荐暂时不可用，当前播放和队列保持不变。'
			};
		}
	}

	async function feedback(event) {
		if (!profile?.record) return false;
		await profile.record(event);
		return true;
	}

	function status() {
		return { ...lastStatus, failures: [...(lastStatus.failures ?? [])] };
	}

	return { recommend, feedback, cancel, status };
}
