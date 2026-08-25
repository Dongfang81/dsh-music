import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecommendationGenerator } from '../../lib/recommendation/generator.js';
import { normalizeTrack } from '../../lib/recommendation/identity.js';
import { createRecommendationPool } from '../../lib/recommendation/pool.js';

function tracks(count, offset = 0) {
	return Array.from({ length: count }, (_, index) => normalizeTrack({
		id: offset + index + 1,
		name: `候选${offset + index + 1}`,
		artists: `歌手${offset + index + 1}`,
		durationMs: 180000 + index * 100
	}, 'test'));
}

async function fixture(candidateCount = 80) {
	const dir = await mkdtemp(join(tmpdir(), 'moony-generator-'));
	const pool = createRecommendationPool({ file: join(dir, 'pool.json') });
	const current = normalizeTrack({ name: '当前', artists: '当前歌手' }, 'player');
	const candidates = tracks(candidateCount);
	let resolverCalls = 0;
	const generator = createRecommendationGenerator({
		pool,
		player: { current: () => current, state: { queue: [current] } },
		profile: { snapshot: async () => ({ version: 2, tracks: {}, artists: {}, rules: [], resolverStats: {}, updatedAt: 9 }) },
		collectCandidates: async () => ({ tracks: candidates, failures: [] }),
		rankCandidates: ({ candidates: input }) => input.map((track, index) => ({ track, total: input.length - index })),
		planQueue: ({ ranked, targetSize }) => ({ tracks: ranked.slice(0, targetSize).map((entry) => entry.track), shortfall: Math.max(0, targetSize - ranked.length) }),
		resolver: { resolve: async (track) => {
			resolverCalls += 1;
			return { playable: true, sourceKey: 'netease', url: `https://temporary.example/${track.trackKey}`, expiresAt: Date.now() + 1000 };
		} },
		targetSize: 60
	});
	return { generator, pool, current, candidates, resolverCalls: () => resolverCalls };
}

test('generates and atomically replaces a 60-track pool without persisting URLs', async () => {
	const { generator, pool, resolverCalls } = await fixture();
	const result = await generator.generate({ reasons: ['startup'] });
	const state = await pool.snapshot();
	assert.equal(result.ok, true);
	assert.equal(result.count, 60);
	assert.equal(state.items.length, 60);
	assert.equal(state.profileRevision, 9);
	assert.ok(resolverCalls() >= 60);
	assert.equal(state.items.some((track) => track.resolvedUrl || track.url || track.expiresAt), false);
});

test('preserves a complete old pool when a new generation cannot reach 60', async () => {
	const { pool } = await fixture();
	await pool.replace(tracks(60, 1000), { generationId: 'old' });
	const dir = await mkdtemp(join(tmpdir(), 'moony-short-generator-'));
	const shortPool = createRecommendationPool({ file: join(dir, 'pool.json') });
	await shortPool.replace(tracks(60, 1000), { generationId: 'old' });
	const short = createRecommendationGenerator({
		pool: shortPool,
		player: { current: () => null, state: { queue: [] } },
		profile: { snapshot: async () => ({ tracks: {}, artists: {}, rules: [], resolverStats: {} }) },
		collectCandidates: async () => ({ tracks: tracks(40), failures: [] }),
		resolver: { resolve: async (track) => ({ playable: true, url: `https://temporary/${track.trackKey}` }) },
		targetSize: 60
	});
	const result = await short.generate({ reasons: ['favorite'] });
	assert.equal(result.ok, false);
	assert.equal((await shortPool.snapshot()).generationId, 'old');
});

test('tops up an incomplete pool with new verified tracks instead of replacing all 58 songs', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'moony-top-up-generator-'));
	const pool = createRecommendationPool({ file: join(dir, 'pool.json') });
	await pool.replace(tracks(58, 1000), { generationId: 'incomplete' });
	const generator = createRecommendationGenerator({
		pool,
		player: { current: () => null, state: { queue: [] } },
		profile: { snapshot: async () => ({ tracks: {}, artists: {}, rules: [], resolverStats: {} }) },
		collectCandidates: async () => ({ tracks: tracks(2, 2000), failures: [] }),
		rankCandidates: ({ candidates }) => candidates.map((track, index) => ({ track, total: 10 - index })),
		planQueue: ({ ranked, targetSize }) => ({ tracks: ranked.slice(0, targetSize).map((entry) => entry.track) }),
		resolver: { resolve: async (track) => ({ playable: true, url: `https://temporary/${track.trackKey}` }) },
		targetSize: 60
	});

	const result = await generator.generate({ reasons: ['startup'] });
	const state = await pool.snapshot();
	assert.equal(result.ok, true);
	assert.equal(state.items.length, 60);
	assert.deepEqual(state.items.slice(0, 2).map((track) => track.trackKey), tracks(2, 2000).map((track) => track.trackKey));
});

test('unplayed button recommendations use soft queue penalties when refilling a depleted pool', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'moony-recover-generator-'));
	const pool = createRecommendationPool({ file: join(dir, 'pool.json') });
	await pool.replace(tracks(48, 1000), { generationId: 'partial' });
	const consumed = await pool.consume(30);
	await pool.commit(consumed.transaction);

	const current = { ...tracks(1, 5000)[0], moonyOrigin: 'recommendation', recommendationSessionId: 'button-recommendation' };
	const replaceable = tracks(29, 6000).map((track) => ({
		...track,
		moonyOrigin: 'recommendation',
		recommendationSessionId: 'button-recommendation'
	}));
	const queue = [current, ...replaceable];
	const generator = createRecommendationGenerator({
		pool,
		player: { current: () => current, state: { queue, index: 0 } },
		profile: { snapshot: async () => ({ tracks: {}, artists: {}, rules: [], resolverStats: {} }) },
		collectCandidates: async () => ({ tracks: replaceable, failures: [] }),
		resolver: { resolve: async (track) => ({ playable: true, url: `https://temporary/${track.trackKey}` }) },
		targetSize: 60,
		rng: () => 0.5
	});

	const result = await generator.generate({ reasons: ['low-watermark'] });
	const state = await pool.snapshot();
	assert.equal(result.ok, true);
	assert.equal(state.ready, true);
	assert.equal(state.count, 47);
});

test('returns an honest failure and keeps the pool when candidate collection fails', async () => {
	const { pool } = await fixture();
	await pool.replace(tracks(60, 2000), { generationId: 'old' });
	const generator = createRecommendationGenerator({
		pool,
		player: { current: () => null, state: { queue: [] } },
		profile: { snapshot: async () => ({ tracks: {}, artists: {}, rules: [], resolverStats: {} }) },
		collectCandidates: async () => { throw new Error('catalog offline'); },
		resolver: { resolve: async () => null }
	});
	const result = await generator.generate({ reasons: ['search-play'] });
	assert.equal(result.ok, false);
	assert.match(result.error, /catalog offline/);
	assert.equal((await pool.snapshot()).generationId, 'old');
});

test('generation passes cancellation through candidate collection and stops cleanly', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'moony-cancel-generator-'));
	const pool = createRecommendationPool({ file: join(dir, 'pool.json') });
	let receivedSignal = null;
	let markCollectorStarted;
	const collectorStarted = new Promise((resolve) => { markCollectorStarted = resolve; });
	const generator = createRecommendationGenerator({
		pool,
		player: { current: () => null, state: { queue: [] } },
		profile: { snapshot: async () => ({ tracks: {}, artists: {}, rules: [], resolverStats: {} }) },
		collectCandidates: async ({ signal }) => {
			receivedSignal = signal;
			markCollectorStarted();
			return new Promise((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error('cancellation did not reach collector')), 200);
				signal?.addEventListener('abort', () => {
					clearTimeout(timeout);
					reject(signal.reason);
				}, { once: true });
			});
		},
		resolver: { resolve: async () => null }
	});
	const controller = new AbortController();
	const pending = generator.generate({ reasons: ['favorite'], signal: controller.signal });
	await collectorStarted;
	controller.abort(new Error('generation cancelled'));
	const result = await pending;
	assert.equal(receivedSignal, controller.signal);
	assert.equal(result.ok, false);
	assert.match(result.error, /generation cancelled/);
});

test('excludes tracks already heard in the active radio session and applies the exploration cap', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'moony-radio-generator-'));
	const pool = createRecommendationPool({ file: join(dir, 'pool.json') });
	const [seen, ...fresh] = tracks(62);
	let planningOptions = null;
	const generator = createRecommendationGenerator({
		pool,
		player: {
			current: () => null,
			state: { queue: [] },
			radioStatus: () => ({ active: true, seenTrackKeys: [seen.trackKey] })
		},
		profile: { snapshot: async () => ({ tracks: {}, artists: {}, rules: [], resolverStats: {} }) },
		collectCandidates: async () => ({ tracks: [seen, ...fresh], failures: [] }),
		rankCandidates: ({ candidates }) => candidates.map((track, index) => ({ track, total: 100 - index })),
		planQueue: (options) => {
			planningOptions = options;
			return { tracks: options.ranked.slice(0, options.targetSize).map((entry) => entry.track), shortfall: 0 };
		},
		resolver: { resolve: async (track) => ({ playable: true, url: `https://temporary/${track.trackKey}` }) },
		targetSize: 60
	});

	const result = await generator.generate({ reasons: ['radio-next-batch'] });
	const state = await pool.snapshot();
	assert.equal(result.ok, true);
	assert.equal(planningOptions.maxExplorationRatio, 0.2);
	assert.equal(state.items.some((track) => track.trackKey === seen.trackKey), false);
});
