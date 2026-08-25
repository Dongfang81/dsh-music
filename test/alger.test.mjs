import test from 'node:test';
import assert from 'node:assert/strict';

import { createClient } from '../lib/alger.js';

test('parent abort reaches the final music API fetch', async () => {
	let requestSignal = null;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_url, options) => {
		requestSignal = options.signal;
		return new Promise((resolve, reject) => requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true }));
	};
	try {
		const client = createClient({ musicApiHost: '127.0.0.1', musicApiPort: 30588, timeoutMs: 10000 });
		const controller = new AbortController();
		const pending = client.getJson('http://127.0.0.1:30588/search', { signal: controller.signal });
		controller.abort(new Error('caller cancelled'));
		await Promise.resolve();
		assert.equal(requestSignal.aborted, true);
		assert.match(String(requestSignal.reason?.message), /caller cancelled/);
		await assert.rejects(() => pending, /caller cancelled/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('parent abort remains active while the response body is being read', async () => {
	let requestSignal = null;
	const client = createClient(
		{ musicApiHost: '127.0.0.1', musicApiPort: 30588, timeoutMs: 10000 },
		{
			fetch: async (_url, options) => {
				requestSignal = options.signal;
				return {
					ok: true,
					status: 200,
					text: () => new Promise((resolve, reject) => {
						const fallback = setTimeout(() => reject(new Error('body cancellation did not propagate')), 50);
						requestSignal.addEventListener('abort', () => {
							clearTimeout(fallback);
							reject(requestSignal.reason);
						}, { once: true });
					})
				};
			}
		}
	);
	const controller = new AbortController();
	const pending = client.getJson('http://127.0.0.1:30588/search', { signal: controller.signal });
	await Promise.resolve();
	controller.abort(new Error('body cancelled'));
	await assert.rejects(() => pending, /body cancelled/);
});

test('music API health probes the local root without issuing a search', async () => {
	const urls = [];
	const client = createClient(
		{ musicApiHost: '127.0.0.1', musicApiPort: 30588, timeoutMs: 10000 },
		{
			fetch: async (url) => {
				urls.push(String(url));
				return { ok: false, status: 404, text: async () => '' };
			}
		}
	);
	assert.equal(await client.musicApiUp(), true);
	assert.deepEqual(urls, ['http://127.0.0.1:30588/']);
});
