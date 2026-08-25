import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTrack } from '../../lib/recommendation/identity.js';
import { collectCandidates, createRetrievers } from '../../lib/recommendation/retrievers.js';

const context = { activity: 'listen', currentTrack: null, recentTrackKeys: [], queueTrackKeys: [] };
const profile = { version: 2, tracks: {}, artists: {}, rules: [], resolverStats: {} };
const trackA = normalizeTrack({ name: '晴天', artists: '周杰伦', durationMs: 269000 }, 'first');

test('one rejected source does not discard fulfilled candidates', async () => {
	const result = await collectCandidates({
		context,
		profile,
		retrievers: [async () => { throw new Error('down'); }, async () => [trackA]],
		signal: new AbortController().signal
	});
	assert.deepEqual(result.tracks.map((track) => track.trackKey), [trackA.trackKey]);
	assert.equal(result.failures.length, 1);
	assert.match(result.failures[0].message, /down/);
});

test('normalizes raw candidates, merges duplicate origins, and drops malformed rows', async () => {
	const result = await collectCandidates({
		context,
		profile,
		retrievers: [
			Object.assign(async () => [{ name: '晴天', artists: '周杰伦', duration: 269000 }, { name: '', artists: '' }], { sourceKey: 'search' }),
			Object.assign(async () => [trackA], { sourceKey: 'profile' })
		],
		signal: new AbortController().signal
	});
	assert.equal(result.tracks.length, 1);
	assert.deepEqual(result.tracks[0].origins.sort(), ['first', 'profile', 'search']);
	assert.deepEqual(result.failures, []);
});

test('factory exposes six read-only candidate adapters', () => {
	const retrievers = createRetrievers({ client: {}, localLibrary: null, timeoutMs: 50 });
	assert.equal(retrievers.length, 6);
	assert.deepEqual(retrievers.map((adapter) => adapter.sourceKey), [
		'liked-neighbors',
		'current-similar',
		'artists',
		'scene-playlists',
		'local-library',
		'exploration'
	]);
});

test('each factory adapter enforces its own timeout', async () => {
	const client = { search: async () => new Promise(() => {}) };
	const [liked] = createRetrievers({ client, localLibrary: null, timeoutMs: 10 });
	await assert.rejects(() => liked({
		context,
		profile: {
			...profile,
			tracks: { a: { title: '晴天', artists: ['周杰伦'], affinity: 5 } }
		},
		signal: new AbortController().signal
	}), /timed out/);
});

test('factory adapters pass parent cancellation to the underlying music request', async () => {
	let requestSignal = null;
	const client = {
		search: async (_query, _type, _limit, options) => {
			requestSignal = options?.signal ?? null;
			return new Promise((resolve, reject) => requestSignal?.addEventListener('abort', () => reject(requestSignal.reason), { once: true }));
		}
	};
	const [liked] = createRetrievers({ client, localLibrary: null, timeoutMs: 1000 });
	const controller = new AbortController();
	const pending = liked({
		context,
		profile: { ...profile, tracks: { a: { title: '晴天', artists: ['周杰伦'], affinity: 5 } } },
		signal: controller.signal
	});
	controller.abort(new Error('user cancelled'));
	await assert.rejects(() => pending, /user cancelled/);
	assert.equal(requestSignal?.aborted, true);
});
