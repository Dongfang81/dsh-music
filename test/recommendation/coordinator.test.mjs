import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTrack } from '../../lib/recommendation/identity.js';
import { createRecommendationCoordinator } from '../../lib/recommendation/coordinator.js';

const current = normalizeTrack({ name: '当前', artists: '当前歌手' }, 'player');
const candidates = Array.from({ length: 8 }, (_, index) => normalizeTrack({
	name: `推荐${index + 1}`,
	artists: `歌手${index + 1}`,
	durationMs: 200000 + index * 1000
}, 'test'));

function fakePlayer() {
	return {
		cleared: false,
		afterCurrent: [],
		state: { queue: [current] },
		current: () => current,
		insertRecommendationAfterCurrent(tracks, sessionId) {
			this.afterCurrent = tracks.map((track) => ({ ...track, recommendationSessionId: sessionId }));
			this.state.queue = [current, ...this.afterCurrent];
			return this.afterCurrent.length;
		}
	};
}

function coordinator(overrides = {}) {
	const player = overrides.player ?? fakePlayer();
	return {
		player,
		value: createRecommendationCoordinator({
			player,
			profile: { snapshot: async () => ({ tracks: {}, artists: {}, rules: [] }), record: async () => true },
			contextBuilder: (input) => ({
				...input,
				weights: { taste: 0.5, context: 0.3, exploration: 0.2 },
				recentTrackKeys: [],
				queueTrackKeys: []
			}),
			collectCandidates: async () => ({ tracks: candidates, failures: [] }),
			resolver: { resolve: async (track) => ({ playable: true, kind: 'direct', url: `https://${track.trackKey}`, confidence: 0.95 }) },
			rankCandidates: ({ candidates: tracks }) => tracks.map((track, index) => ({ track, total: 100 - index })),
			planQueue: ({ ranked, targetSize, currentTrack, existingQueue }) => {
				const blocked = new Set((existingQueue || []).map((track) => track.trackKey));
				const available = ranked.filter((entry) => !blocked.has(entry.track.trackKey));
				return {
				insertAfterTrackKey: currentTrack.trackKey,
				tracks: available.slice(0, targetSize).map((entry) => entry.track),
				shortfall: Math.max(0, targetSize - available.length)
				};
			},
			targetSize: 8,
			preflightCount: 5,
			timeoutMs: 1000,
			...overrides
		})
	};
}

test('preflights five tracks before inserting after current', async () => {
	const { value, player } = coordinator();
	const result = await value.recommend();
	assert.equal(result.ok, true);
	assert.equal(result.verifiedBeforeInsert, 5);
	assert.equal(player.current().trackKey, current.trackKey);
	assert.deepEqual(player.afterCurrent.slice(0, 5).map((track) => track.trackKey), result.tracks.slice(0, 5).map((track) => track.trackKey));
});

test('a second request cancels the first without clearing the queue', async () => {
	let call = 0;
	const collectCandidates = ({ signal }) => {
		call += 1;
		if (call > 1) return Promise.resolve({ tracks: candidates, failures: [] });
		return new Promise((resolve, reject) => {
			signal.addEventListener('abort', () => reject(signal.reason), { once: true });
		});
	};
	const { value, player } = coordinator({ collectCandidates });
	const first = value.recommend();
	await Promise.resolve();
	await Promise.resolve();
	const second = value.recommend();
	assert.equal((await first).cancelled, true);
	assert.equal((await second).ok, true);
	assert.equal(player.cleared, false);
});

test('background expansion preserves the five preflight tracks', async () => {
	const { value, player } = coordinator();
	const first = await value.recommend();
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.equal(first.tracks.length, 5);
	assert.equal(player.afterCurrent.length, 8);
	assert.deepEqual(player.afterCurrent.slice(0, 5).map((track) => track.trackKey), first.tracks.map((track) => track.trackKey));
});

test('plugin-local failures return honest structure instead of throwing', async () => {
	const { value } = coordinator({ collectCandidates: async () => { throw new Error('source down'); } });
	const result = await value.recommend();
	assert.equal(result.ok, false);
	assert.match(result.guidance, /没有改动|保持/);
	assert.match(result.error, /source down/);
});
