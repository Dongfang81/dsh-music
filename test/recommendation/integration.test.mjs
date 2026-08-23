import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildToolsForTest, createPreferenceAction, registerRoutesForTest } from '../../index.js';

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
