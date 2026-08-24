import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as plugin from '../../index.js';
import { createPlayer } from '../../lib/player.js';

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

test('recommend route invokes the local coordinator action directly', async () => {
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

test('favorites route exposes one flat read-only song list', async () => {
	const routes = [];
	registerRoutesForTest({ register: (route) => routes.push(route) }, {
		favoritesList: async () => ({ ok: true, count: 1, songs: [{ id: 1, name: '晴天', artists: '周杰伦' }] })
	});
	const route = routes.find((item) => item.path === '/dsh-alger/favorites');
	assert.ok(route);
	const res = response();
	await route.handler(request({}), res);
	assert.deepEqual(res.body, { ok: true, count: 1, songs: [{ id: 1, name: '晴天', artists: '周杰伦' }] });
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
	assert.doesNotMatch(tools.alger_recommend.description, /随机挑一个整单/);
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

test('client recommendation button sends request ids and ignores stale responses', async () => {
	const source = await readFile(join(root, 'client.js'), 'utf8');
	assert.match(source, /recommendRequestRef/);
	assert.match(source, /requestId:\s*requestId/);
	assert.match(source, /recommendRequestRef\.current\s*!==\s*requestId/);
});

test('profile data follows DSH_HOME instead of leaking across isolated profiles', () => {
	assert.equal(resolveDataRoot({ DSH_HOME: '/private/tmp/isolated-dsh' }, '/Users/example'), '/private/tmp/isolated-dsh');
	assert.equal(resolveDataRoot({}, '/Users/example'), '/Users/example/.dsh');
});
