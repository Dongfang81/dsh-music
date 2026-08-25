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

test('recommend action consumes 30 cached tracks without invoking click-time generation', async () => {
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
	assert.deepEqual(player.state.queue.slice(1, 31).map((item) => item.name), recommended.map((item) => item.title));
	assert.equal(player.state.queue.at(-1).name, '手动');
	assert.equal(player.current().name, '推荐1');
	assert.equal(player.state.index, 1);
	assert.equal(player.state.playing, true);
	assert.equal(player.state.currentUrl, 'https://audio.test/100.mp3');
	assert.equal(result.insertMode, 'after-current-and-play');
});

test('consecutive button recommendations keep every earlier song and add 30 more', async () => {
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
		snapshot: async () => ({ ready: true, count: 60, items: batches.flat() })
	};
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: true },
		{ musicApiUp: async () => true, songUrl: async (id) => `https://audio.test/${id}.mp3` },
		{}, player, {}, { recordPlayback: async () => {} },
		{ pool, scheduler: { schedule: () => true, status: () => ({ state: 'idle' }) } }
	);

	await actions.recommend({ requestId: 'first' });
	await actions.recommend({ requestId: 'second' });

	assert.equal(player.state.queue.length, 62);
	assert.equal(player.state.queue.filter((song) => song.recommendationSessionId === 'button-recommendation').length, 60);
	assert.equal(player.state.queue.filter((song) => song.name.startsWith('第一批')).length, 30);
	assert.equal(player.current().name, '第二批1');
	assert.equal(player.state.queue.at(-1).name, '手动');
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
	assert.deepEqual(status.recommendation, { ready: true, count: 60, generating: false, lastError: null });
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
	const player = createPlayer({ file: null });
	player.replaceAndPlay([{ id: 1, name: '晴天', ar: [{ name: '周杰伦' }] }]);
	player.toggleFavorite();
	const actions = plugin.buildActionsForTest(
		{ musicApiPort: 30588, musicApiHost: '127.0.0.1', timeoutMs: 1000, recommendationLearning: true },
		{ musicApiUp: async () => true }, {}, player, {}, { recordPlayback: async () => {} }
	);
	const listed = await actions.favoritesList();
	assert.equal(listed.revision, player.revisions().favoritesRevision);
	const removed = await actions.favoritesRemove({ songId: 1 });
	assert.equal(removed.revision, player.revisions().favoritesRevision);
	assert.ok(removed.revision > listed.revision);
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
	assert.match(tools.alger_recommend.description, /第一首推荐.*播放/);
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

test('client recommendation opens the queue, closes competing panels, and keeps a stable label', async () => {
	const source = await readFile(join(root, 'client.js'), 'utf8');
	const handler = source.slice(source.indexOf('var onRecommend = function () {'), source.indexOf('var loadFavorites = function () {'));
	assert.match(handler, /setFavoritesOpen\(false\)/);
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
