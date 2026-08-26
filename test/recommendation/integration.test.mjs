import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as plugin from '../../index.js';
import { createPlayer } from '../../lib/player.js';
import { normalizeTrack } from '../../lib/recommendation/identity.js';

const { buildToolsForTest, createPreferenceAction, registerRoutesForTest, resolveDataRoot } = plugin;

const root = fileURLToPath(new URL('../..', import.meta.url));

function request(body) {
	const req = new EventEmitter();
	queueMicrotask(() => {
		req.emit('data', JSON.stringify(body));
		req.emit('end');
	});
	return req;
}

function response() {
	return {
		body: null,
		writeHead() {},
		end(value) { this.body = JSON.parse(value); }
	};
}

test('recommend route invokes the cached recommendation action directly', async () => {
	const routes = [];
	let calls = 0;
	registerRoutesForTest({ register: (route) => routes.push(route) }, {
		recommend: async (input) => { calls += 1; return { ok: true, insertMode: 'after-current', requestId: input.requestId }; }
	});
	const route = routes.find((item) => item.path === '/dsh-alger/recommend');
	const res = response();
	await route.handler(request({ requestId: 'button-1' }), res);
	assert.equal(calls, 1);
	assert.equal(res.body.ok, true);
	assert.equal(res.body.insertMode, 'after-current');
	assert.equal(res.body.requestId, 'button-1');
});

test('recommend action atomically replaces the whole queue with a 30-track radio batch', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([{ id: 1, name: '当前', ar: [{ name: '歌手' }] }, { id: 2, name: '手动', ar: [{ name: '歌手' }] }]);
	const recommended = Array.from({ length: 30 }, (_, index) => ({
		...normalizeTrack({ id: index + 100, name: `推荐${index + 1}`, artists: `推荐歌手${index + 1}` }, 'pool')
	}));
	let coordinatorCalls = 0;
	let committed = null;
	const scheduled = [];
	const pool = {
		consume: async () => ({ ok: true, tracks: recommended, transaction: 'tx-1', remaining: 30, ready: true }),
		commit: async (transaction) => { committed = transaction; },
		restore: async () => { throw new Error('should not restore'); },
		snapshot: async () => ({ ready: true, items: recommended, count: 30 })
	};
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: true },
		{ musicApiUp: async () => true, songUrl: async (id) => `https://audio.test/${id}.mp3` }, {}, player, {}, { recordPlayback: async () => {} },
		{
			coordinator: { recommend: async () => { coordinatorCalls += 1; }, feedback: async () => true },
			pool,
			scheduler: { schedule: (reason) => scheduled.push(reason), status: () => ({ state: 'idle' }) }
		}
	);
	const result = await actions.recommend({ requestId: 'cached-1' });
	assert.equal(result.ok, true);
	assert.equal(result.count, 30);
	assert.equal(coordinatorCalls, 0);
	assert.equal(committed, 'tx-1');
	assert.deepEqual(scheduled, ['low-watermark']);
	assert.deepEqual(player.state.queue.map((item) => item.name), recommended.map((item) => item.title));
	assert.equal(player.current().name, '推荐1');
	assert.equal(player.state.index, 0);
	assert.equal(player.state.playing, true);
	assert.equal(player.state.currentUrl, 'https://audio.test/100.mp3');
	assert.equal(result.mode, 'recommendation-radio');
	assert.equal(result.batchNumber, 1);
	assert.equal(player.radioStatus().active, true);
});

test('a second recommendation click starts a fresh radio session and replaces the first batch', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([
		{ id: 1, name: '当前', ar: [{ name: '歌手' }] },
		{ id: 2, name: '手动', ar: [{ name: '歌手' }] }
	]);
	const makeBatch = (label, offset) => Array.from({ length: 30 }, (_, index) => normalizeTrack({
		id: offset + index,
		name: `${label}${index + 1}`,
		artists: `${label}歌手${index + 1}`
	}, 'pool'));
	const batches = [makeBatch('第一批', 100), makeBatch('第二批', 200)];
	let batchIndex = 0;
	const pool = {
		consume: async () => ({
			ok: true,
			tracks: batches[batchIndex],
			transaction: `tx-${++batchIndex}`,
			remaining: 30,
			ready: true
		}),
		commit: async () => {},
		restore: async () => {},
		snapshot: async () => ({ ready: true, count: 60, items: batches.flat(), recentRecommendedTrackKeys: [] })
	};
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: true },
		{ musicApiUp: async () => true, songUrl: async (id) => `https://audio.test/${id}.mp3` },
		{}, player, {}, { recordPlayback: async () => {} },
		{ pool, scheduler: { schedule: () => true, status: () => ({ state: 'idle' }) } }
	);

	const first = await actions.recommend({ requestId: 'first' });
	const second = await actions.recommend({ requestId: 'second' });

	assert.equal(player.state.queue.length, 30);
	assert.equal(player.state.queue.filter((song) => song.name.startsWith('第一批')).length, 0);
	assert.equal(player.current().name, '第二批1');
	assert.notEqual(first.sessionId, second.sessionId);
	assert.equal(player.radioStatus().sessionId, second.sessionId);
});

test('recommendation keeps the old queue when the first recommended track cannot resolve', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([{ id: 1, name: '手动歌曲', ar: [{ name: '歌手' }] }]);
	const batch = Array.from({ length: 30 }, (_, index) => normalizeTrack({
		id: index + 100,
		name: `推荐${index + 1}`,
		artists: `歌手${index + 1}`
	}, 'pool'));
	let restored = null;
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: true },
		{ musicApiUp: async () => true, songUrl: async () => null }, {}, player, {}, { recordPlayback: async () => {} },
		{
			pool: {
				consume: async () => ({ ok: true, tracks: batch, transaction: 'tx-fail', remaining: 30 }),
				commit: async () => { throw new Error('must not commit'); },
				restore: async (transaction) => { restored = transaction; },
				snapshot: async () => ({ recentRecommendedTrackKeys: [] })
			},
			scheduler: { schedule: () => true, status: () => ({ state: 'idle' }) }
		}
	);

	const result = await actions.recommend({ requestId: 'unplayable' });
	assert.equal(result.ok, false);
	assert.equal(restored, 'tx-fail');
	assert.deepEqual(player.state.queue.map((song) => song.name), ['手动歌曲']);
	assert.equal(player.radioStatus(), null);
});

test('next at a radio boundary swaps in a fresh non-repeating batch', async () => {
	const player = createPlayer({ file: null });
	const first = Array.from({ length: 30 }, (_, index) => normalizeTrack({ id: index + 1, name: `第一批${index + 1}`, artists: `甲${index + 1}` }, 'pool'));
	const second = Array.from({ length: 30 }, (_, index) => normalizeTrack({ id: index + 101, name: `第二批${index + 1}`, artists: `乙${index + 1}` }, 'pool'));
	player.startRecommendationRadio(first, 'radio-boundary');
	player.jump(29);
	let exclusions = [];
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: true },
		{ musicApiUp: async () => true, songUrl: async (id) => `https://audio.test/${id}.mp3` }, {}, player, {}, { recordPlayback: async () => {} },
		{
			pool: {
				consume: async (_count, options) => { exclusions = options.excludeTrackKeys; return { ok: true, tracks: second, transaction: 'tx-next', remaining: 30 }; },
				commit: async () => {}, restore: async () => {}, snapshot: async () => ({ recentRecommendedTrackKeys: [] })
			},
			scheduler: { schedule: () => true, status: () => ({ state: 'idle' }) }
		}
	);

	const result = await actions.control({ action: 'next' });
	assert.equal(result.ok, true);
	assert.equal(result.mode, 'recommendation-radio');
	assert.equal(result.batchNumber, 2);
	assert.equal(player.state.queue.length, 30);
	assert.equal(player.current().name, '第二批1');
	assert.equal(player.state.currentUrl, 'https://audio.test/101.mp3');
	assert.deepEqual(exclusions.sort(), first.map((track) => track.trackKey).sort());
});

test('next at a radio boundary waits without looping when the next batch is not ready', async () => {
	const player = createPlayer({ file: null });
	const first = Array.from({ length: 30 }, (_, index) => normalizeTrack({ id: index + 1, name: `第一批${index + 1}`, artists: `甲${index + 1}` }, 'pool'));
	player.startRecommendationRadio(first, 'radio-wait');
	player.jump(29);
	const scheduled = [];
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: true },
		{ musicApiUp: async () => true }, {}, player, {}, { recordPlayback: async () => {} },
		{
			pool: { consume: async () => ({ ok: false, remaining: 12 }), snapshot: async () => ({ recentRecommendedTrackKeys: [] }) },
			scheduler: { schedule: (reason) => scheduled.push(reason), status: () => ({ state: 'idle' }) }
		}
	);

	const result = await actions.control({ action: 'next' });
	assert.equal(result.ok, false);
	assert.equal(result.preparing, true);
	assert.equal(player.state.index, 29);
	assert.equal(player.state.playing, false);
	assert.equal(player.radioStatus().waitingForNextBatch, true);
	assert.deepEqual(player.state.queue.map((song) => song.name), first.map((track) => track.title));
	assert.deepEqual(scheduled, ['radio-boundary']);
});

test('status exposes recommendation pool readiness without starting generation', async () => {
	let generationCalls = 0;
	const player = createPlayer({ file: null });
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: true },
		{ musicApiUp: async () => true }, {}, player, {}, { recordPlayback: async () => {} },
		{
			pool: {
				status: async () => ({ ready: true, count: 60 }),
				snapshot: async () => { throw new Error('full pool snapshot must not run during status polling'); }
			},
			scheduler: { status: () => ({ state: 'idle', generating: false, scheduled: false, lastError: null }) },
			coordinator: { recommend: async () => { generationCalls += 1; } }
		}
	);
	const status = await actions.status();
	assert.deepEqual(status.recommendation, {
		ready: true,
		count: 60,
		generating: false,
		lastError: null,
		radio: { active: false, batchNumber: 0, waitingForNextBatch: false }
	});
	assert.equal(generationCalls, 0);
});

test('status health cache shares probes and uses adaptive success and failure TTLs', async () => {
	let current = 1;
	let calls = 0;
	let releaseFirst;
	const laterResults = [false, true];
	const client = {
		musicApiUp: async () => {
			calls += 1;
			if (calls === 1) return new Promise((resolve) => { releaseFirst = resolve; });
			return laterResults.shift();
		}
	};
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: true },
		client, {}, createPlayer({ file: null }), {}, { recordPlayback: async () => {} },
		{ now: () => current }
	);
	const first = actions.status();
	const second = actions.status();
	await Promise.resolve();
	assert.equal(calls, 1, 'concurrent status reads share one health probe');
	releaseFirst(true);
	assert.equal((await first).musicApiUp, true);
	assert.equal((await second).musicApiUp, true);

	current = 60_000;
	assert.equal((await actions.status()).musicApiUp, true);
	assert.equal(calls, 1, 'a successful probe is cached for 60 seconds');

	current = 60_002;
	assert.equal((await actions.status()).musicApiUp, false);
	assert.equal(calls, 2);
	current = 65_001;
	assert.equal((await actions.status()).musicApiUp, false);
	assert.equal(calls, 2, 'a failed probe is cached for 5 seconds');
	current = 65_003;
	assert.equal((await actions.status()).musicApiUp, true);
	assert.equal(calls, 3);
});

test('browser status is compact while model status retains collection details', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([{ id: 1, name: '晴天', ar: [{ name: '周杰伦' }] }]);
	player.toggleFavorite();
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: true },
		{ musicApiUp: async () => true }, {}, player, {}, { recordPlayback: async () => {} }
	);
	const compact = await actions.status({ compact: true });
	assert.deepEqual(compact.queue, { count: 1, index: 0, revision: player.revisions().queueRevision });
	assert.deepEqual(compact.favorites, { count: 1, revision: player.revisions().favoritesRevision });
	assert.equal('favoriteIds' in compact, false);
	const full = await actions.status();
	assert.equal(full.queue.items.length, 1);
	assert.deepEqual(full.favoriteIds, [1]);
});

test('state route requests compact status and queue-view exposes revisioned rows', async () => {
	const routes = [];
	const statusOptions = [];
	registerRoutesForTest({ register: (route) => routes.push(route) }, {
		status: async (options) => { statusOptions.push(options); return { ok: true, queue: { count: 2 } }; },
		queueView: async () => ({ ok: true, revision: 4, count: 2, index: 0, items: [{ id: 1 }] })
	});
	const stateRes = response();
	await routes.find((item) => item.path === '/dsh-alger/state').handler(request({}), stateRes);
	assert.deepEqual(statusOptions, [{ compact: true }]);
	assert.deepEqual(stateRes.body, { ok: true, queue: { count: 2 } });
	const queueRes = response();
	const queueRoute = routes.find((item) => item.path === '/dsh-alger/queue-view');
	assert.ok(queueRoute);
	await queueRoute.handler(request({}), queueRes);
	assert.deepEqual(queueRes.body, { ok: true, revision: 4, count: 2, index: 0, items: [{ id: 1 }] });
});

test('action-level playback mutations invalidate compact player state', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([{ id: 1, name: '晴天', ar: [{ name: '周杰伦' }] }]);
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: true },
		{ musicApiUp: async () => true }, {}, player, {}, { recordPlayback: async () => {} }
	);
	const before = player.revisions().stateRevision;
	await actions.control({ action: 'pause' });
	assert.equal(player.state.playing, false);
	assert.equal(player.revisions().stateRevision, before + 1);
});

test('active playback records habits before checking night while paused reports skip the check', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([{ id: 1, name: '晴天', ar: [{ name: '周杰伦' }] }]);
	const events = [];
	const shared = {};
	const habits = {
		async recordPlayback() { events.push('record'); },
		async nightCheck() { events.push('night'); return { remind: true, nightSeconds: 7200 }; }
	};
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: true },
		{ musicApiUp: async () => true }, shared, player, {}, habits
	);
	await actions.playback({ position: 5, duration: 200, playing: true, ready: true });
	assert.deepEqual(events, ['record', 'night']);
	assert.match(shared.getNotice(), /夜深了/);
	events.length = 0;
	await actions.playback({ position: 5, duration: 200, playing: false, ready: true });
	assert.deepEqual(events, ['record']);
});

test('a terminal browser audio failure stops the server from advertising fake playback', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([{ id: 1, name: '晴天', ar: [{ name: '周杰伦' }] }]);
	const recorded = [];
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000 },
		{}, {}, player, {}, { recordPlayback: async (value) => { recorded.push(value); } }
	);
	await actions.playback({ songId: 1, position: 0, duration: 0, playing: false, ready: false, failed: true });
	assert.equal(player.state.playing, false);
	assert.equal(player.state.ready, false);
	player.playSong({ id: 2, name: '夜曲', ar: [{ name: '周杰伦' }] });
	player.state.position = 12;
	player.state.duration = 200;
	player.state.ready = true;
	const recordedBeforeStale = recorded.length;
	const stale = await actions.playback({ songId: 1, position: 0, duration: 0, playing: false, ready: false, failed: true });
	assert.equal(stale.stale, true);
	assert.equal(player.state.playing, true, 'a late failure report from the previous song must not pause the new song');
	assert.deepEqual({ position: player.state.position, duration: player.state.duration, ready: player.state.ready }, { position: 12, duration: 200, ready: true });
	assert.equal(recorded.length, recordedBeforeStale, 'stale values are not recorded against the new song');
});

test('strong preference signals schedule refresh while skip and completion only update history', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([
		{ id: 1, name: '当前', ar: [{ name: '歌手一' }] },
		{ id: 2, name: '下一首', ar: [{ name: '歌手二' }] }
	]);
	const scheduled = [];
	const feedback = [];
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: true },
		{ musicApiUp: async () => true, songUrl: async (id) => `https://audio/${id}` }, {}, player, {}, { recordPlayback: async () => {} },
		{
			coordinator: { feedback: async (event) => feedback.push(event.type) },
			preference: async (args) => ({ ok: true, action: args.action }),
			scheduler: { schedule: (reason) => scheduled.push(reason), status: () => ({ state: 'idle' }) }
		}
	);
	await actions.control({ action: 'toggle-favorite' });
	await actions.control({ action: 'toggle-favorite' });
	player.state.position = 5;
	await actions.control({ action: 'next' });
	await actions.preference({ action: 'remember', kind: 'artist', value: '周杰伦' });
	assert.deepEqual(scheduled, ['favorite', 'unfavorite', 'preference']);
	assert.deepEqual(feedback, ['favorite', 'unfavorite', 'skip-short']);
});

test('favorites route lists songs and removes one favorite without touching playback', async () => {
	const routes = [];
	const calls = [];
	registerRoutesForTest({ register: (route) => routes.push(route) }, {
		favoritesList: async () => ({ ok: true, count: 1, songs: [{ id: 1, name: '晴天', artists: '周杰伦' }] }),
		favoritesRemove: async (input) => { calls.push(input.songId); return { ok: true, removedId: input.songId, count: 0, songs: [] }; }
	});
	const route = routes.find((item) => item.path === '/dsh-alger/favorites');
	assert.ok(route);
	const res = response();
	await route.handler(request({}), res);
	assert.deepEqual(res.body, { ok: true, count: 1, songs: [{ id: 1, name: '晴天', artists: '周杰伦' }] });
	const removeRes = response();
	await route.handler(request({ action: 'remove', songId: 1 }), removeRes);
	assert.deepEqual(calls, [1]);
	assert.deepEqual(removeRes.body, { ok: true, removedId: 1, count: 0, songs: [] });
});

test('favorite list responses carry the revision that invalidates an open panel', async () => {
	const player = createPlayer({ file: null, instanceId: 'boot-a' });
	player.replaceAndPlay([{ id: 1, name: '晴天', ar: [{ name: '周杰伦' }] }]);
	player.toggleFavorite();
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: true },
		{ musicApiUp: async () => true }, {}, player, {}, { recordPlayback: async () => {} }
	);
	const listed = await actions.favoritesList();
	assert.equal(listed.instanceId, 'boot-a');
	assert.equal(listed.revision, player.revisions().favoritesRevision);
	const removed = await actions.favoritesRemove({ songId: 1 });
	assert.equal(removed.revision, player.revisions().favoritesRevision);
	assert.ok(removed.revision > listed.revision);
});

test('refreshing the active song URL updates the server playback source and rejects stale songs', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([{ id: 1, name: '晴天', ar: [{ name: '周杰伦' }] }]);
	const calls = [];
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000 },
		{ songUrl: async (id, level) => { calls.push([id, level]); return 'https://audio.test/fresh.mp3'; } },
		{}, player, {}, { recordPlayback: async () => {} }
	);
	const refreshed = await actions.songUrl({ id: 1, refreshCurrent: true });
	assert.equal(refreshed.url, 'https://audio.test/fresh.mp3');
	assert.equal(player.state.currentUrl, refreshed.url);
	assert.equal(player.state.playing, true);
	assert.deepEqual(calls, [[1, 'higher']]);
	await assert.rejects(() => actions.songUrl({ id: 2, refreshCurrent: true }), /当前歌曲已切换/);
});

test('favorite playback falls back to an exact metadata source when the official URL is unavailable', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([{
		id: 2083989384,
		name: '大梦 (Live)',
		ar: [{ name: '瓦依那' }, { name: '任素汐' }],
		al: { name: '乐队的夏天3 第7期' },
		dt: 475367
	}]);
	player.toggleFavorite();
	const matched = [];
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: false },
		{ songUrl: async () => null }, {}, player, {}, { recordPlayback: async () => {} },
		{ matchSourceUrl: async (song) => { matched.push(song); return 'https://audio.test/exact-live.mp3'; } }
	);

	const result = await actions.queue({ action: 'favorites', favoriteIndex: 0 });
	assert.equal(result.ok, true);
	assert.equal(player.state.currentUrl, 'https://audio.test/exact-live.mp3');
	assert.equal(matched.length, 1);
	assert.equal(matched[0].id, 2083989384);
	assert.equal(matched[0].dt, 475367);
});

test('active-song recovery uses the same exact metadata fallback as initial playback', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([{
		id: 76881,
		name: '关于小熊',
		ar: [{ name: '蛋堡' }],
		al: { name: '收敛水' },
		dt: 246000,
		resolvedUrl: 'https://audio.test/expired.mp3'
	}]);
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: false },
		{ songUrl: async () => null }, {}, player, {}, { recordPlayback: async () => {} },
		{ matchSourceUrl: async () => 'https://audio.test/exact-bear.mp3' }
	);

	const refreshed = await actions.songUrl({ id: 76881, refreshCurrent: true });
	assert.equal(refreshed.ok, true);
	assert.equal(refreshed.url, 'https://audio.test/exact-bear.mp3');
	assert.equal(player.state.currentUrl, refreshed.url);
});

test('cross-source fallback is rejected when exact song metadata is incomplete', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([{ id: 9, name: '同名歌曲', ar: [{ name: '歌手' }], dt: 0 }]);
	let fallbackCalls = 0;
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: false },
		{ songUrl: async () => null }, {}, player, {}, { recordPlayback: async () => {} },
		{ matchSourceUrl: async () => { fallbackCalls += 1; return 'https://audio.test/unverified.mp3'; } }
	);

	const refreshed = await actions.songUrl({ id: 9, refreshCurrent: true });
	assert.equal(refreshed.ok, false);
	assert.equal(refreshed.url, null);
	assert.equal(fallbackCalls, 0);
});

test('official playback URLs remain preferred over cross-source fallback', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([{ id: 1, name: '晴天', ar: [{ name: '周杰伦' }], dt: 269000 }]);
	let fallbackCalls = 0;
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: false },
		{ songUrl: async () => 'https://audio.test/official.mp3' }, {}, player, {}, { recordPlayback: async () => {} },
		{ matchSourceUrl: async () => { fallbackCalls += 1; return 'https://audio.test/fallback.mp3'; } }
	);

	const refreshed = await actions.songUrl({ id: 1, refreshCurrent: true });
	assert.equal(refreshed.url, 'https://audio.test/official.mp3');
	assert.equal(fallbackCalls, 0);
});

test('a URL refresh that finishes after a song change cannot overwrite the new song', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([
		{ id: 1, name: '晴天', ar: [{ name: '周杰伦' }] },
		{ id: 2, name: '夜曲', ar: [{ name: '周杰伦' }] }
	]);
	let resolveUrl;
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000 },
		{ songUrl: () => new Promise((resolve) => { resolveUrl = resolve; }) },
		{}, player, {}, { recordPlayback: async () => {} }
	);
	const pending = actions.songUrl({ id: 1, refreshCurrent: true });
	player.jump(1);
	resolveUrl('https://audio.test/stale.mp3');
	await assert.rejects(() => pending, /当前歌曲已切换/);
	assert.equal(player.current().id, 2);
	assert.notEqual(player.state.currentUrl, 'https://audio.test/stale.mp3');
});

test('favorite removal action updates only favorites and schedules preference refresh', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([
		{ id: 1, name: '晴天', ar: [{ name: '周杰伦' }] },
		{ id: 2, name: '夜曲', ar: [{ name: '周杰伦' }] }
	]);
	player.toggleFavorite();
	player.jump(1);
	player.toggleFavorite();
	const scheduled = [];
	const feedback = [];
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: true },
		{ songUrl: async () => null }, {}, player, {}, { recordPlayback: async () => {} },
		{
			coordinator: { feedback: async (event) => feedback.push(event.type) },
			scheduler: { schedule: (reason) => scheduled.push(reason), status: () => ({ state: 'idle' }) }
		}
	);
	const queueBefore = player.state.queue.map((item) => item.id);
	const result = await actions.favoritesRemove({ songId: 1 });
	assert.equal(result.removedId, 1);
	assert.deepEqual(result.songs.map((item) => item.id), [2]);
	assert.deepEqual(player.state.queue.map((item) => item.id), queueBefore);
	assert.equal(player.current().id, 2);
	assert.deepEqual(feedback, ['unfavorite']);
	assert.deepEqual(scheduled, ['unfavorite']);
});

test('real actions resolve playback after removing the current song', async () => {
	assert.equal(typeof plugin.buildActionsForTest, 'function', 'real action factory must be testable');
	const player = createPlayer({ file: null });
	player.replaceAndPlay([
		{ id: 1, name: '晴天', ar: [{ name: '周杰伦' }] },
		{ id: 2, name: '夜曲', ar: [{ name: '周杰伦' }] }
	]);
	player.toggleFavorite();
	const client = {
		musicApiUp: async () => true,
		songUrl: async (id) => `https://audio.test/${id}.mp3`
	};
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: false },
		client,
		{},
		player,
		{},
		{ recordPlayback: async () => {} }
	);

	const removed = await actions.queue({ action: 'remove', index: 0 });
	assert.equal(removed.currentChanged, true);
	assert.equal(player.current().id, 2);
	assert.equal(player.state.currentUrl, 'https://audio.test/2.mp3');
	assert.equal((await actions.queue({ action: 'undo-remove', token: removed.token })).restored.id, 1);
});

test('favorite rows can start playback at their position without losing the rest of the list', async () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([
		{ id: 1, name: '晴天', ar: [{ name: '周杰伦' }] },
		{ id: 2, name: '夜曲', ar: [{ name: '周杰伦' }] }
	]);
	player.toggleFavorite();
	player.jump(1);
	player.toggleFavorite();
	const client = { songUrl: async (id) => `https://audio.test/${id}.mp3` };
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: false },
		client, {}, player, {}, { recordPlayback: async () => {} }
	);
	assert.deepEqual((await actions.favoritesList()).songs.map((item) => item.id), [1, 2]);
	const played = await actions.queue({ action: 'favorites', favoriteIndex: 1 });
	assert.equal(played.playedName, '夜曲');
	assert.deepEqual(player.state.queue.map((item) => item.id), [1, 2]);
	assert.equal(player.state.index, 1);
});

test('search does not inject an unverified cross-source recording', async () => {
	const player = createPlayer({ file: null });
	const cover = { id: 77, name: '晴天', ar: [{ name: 'A-Lin' }], al: { name: '翻唱' }, dt: 240000 };
	const client = {
		musicApiUp: async () => true,
		search: async () => ({ songs: [cover] }),
		songUrl: async () => null
	};
	let matchCalls = 0;
	const matchSourceByKeyword = async (name, artist) => {
		matchCalls += 1;
		return {
		url: 'https://audio.test/jay-qingtian.mp3', source: 'migu', title: name || '晴天', artist
		};
	};
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: false },
		client, {}, player, {}, { recordPlayback: async () => {} }, { matchSourceByKeyword }
	);

	const searched = await actions.search({ keywords: '周杰伦 晴天', type: 1 });
	assert.equal(matchCalls, 0);
	assert.equal(searched.items.some((item) => item.crossSource), false);
	assert.deepEqual(searched.items, []);
	assert.match(searched.guidance, /没有找到.*歌手和歌名.*完全匹配/);
});

test('tool copy preserves natural dialogue and only recommends on an explicit request', () => {
	const noop = async () => ({ ok: true });
	const actions = new Proxy({ preference: noop }, { get: (target, key) => target[key] ?? noop });
	const tools = Object.fromEntries(buildToolsForTest({ musicApiPort: 30588, timeoutMs: 1000 }, actions)
		.map((tool) => [tool.name, tool]));
	assert.match(tools.alger_recommend.description, /明确要求.*立即推荐|直接播放/);
	assert.match(tools.alger_recommend.description, /自然回应/);
	assert.match(tools.alger_recommend.description, /不要.*自动搜索/);
	assert.match(tools.alger_recommend.description, /持续推荐电台/);
	assert.match(tools.alger_recommend.description, /替换当前播放列表/);
	assert.match(tools.alger_recommend.description, /每批结束后自动续播/);
	assert.doesNotMatch(tools.alger_recommend.description, /保留当前歌曲/);
	assert.doesNotMatch(tools.alger_recommend.description, /随机挑一个整单/);
	const rendered = JSON.stringify(tools.alger_recommend.output.render({}, { ok: true, tracks: [{ title: '推荐一' }] }));
	assert.match(rendered, /开始播放/);
	assert.doesNotMatch(rendered, /保持不变/);
	assert.match(tools.alger_preference.description, /明确.*记住|以后/);
});

test('long-term preference writes require an explicit valid value', async () => {
	const action = createPreferenceAction({
		snapshot: async () => ({ rules: [] }),
		remember: async (rule) => rule,
		forget: async () => true,
		clear: async () => true
	});
	await assert.rejects(() => action({ action: 'remember', kind: 'artist' }), /value/);
	assert.deepEqual(await action({ action: 'remember', kind: 'artist', value: '周杰伦', weight: 1 }), {
		ok: true,
		rule: { kind: 'artist', value: '周杰伦', weight: 1 }
	});
});

test('client recommendation opens the queue, preserves favorites, and keeps a stable label', async () => {
	const source = await readFile(join(root, 'client.js'), 'utf8');
	const handler = source.slice(source.indexOf('var onRecommend = function () {'), source.indexOf('var loadFavorites = function'));
	assert.doesNotMatch(handler, /setFavoritesOpen\(false\)/);
	assert.match(handler, /setQueueOpen\(true\)/);
	assert.match(handler, /setResults\(null\)/);
	assert.match(handler, /setSearched\(false\)/);
	assert.match(handler, /requestId:\s*requestId/);
	assert.match(handler, /recommendRequestRef\.current\s*!==\s*requestId/);
	assert.doesNotMatch(handler, /setRecommendLabel/);
	assert.match(source, /onClick:\s*onRecommend\s*\n\s*},\s*"推荐"\)/);
});

test('profile data follows DSH_HOME instead of leaking across isolated profiles', () => {
	assert.equal(resolveDataRoot({ DSH_HOME: '/private/tmp/isolated-dsh' }, '/Users/example'), '/private/tmp/isolated-dsh');
	assert.equal(resolveDataRoot({}, '/Users/example'), '/Users/example/.dsh');
});
