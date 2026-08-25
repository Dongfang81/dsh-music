import test from 'node:test';
import assert from 'node:assert/strict';

import { createRecommendationScheduler } from '../../lib/recommendation/scheduler.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('whenIdle keeps an explicitly awaited unrefed debounce alive', async () => {
	let callback;
	let refCalls = 0;
	let unrefCalls = 0;
	const timerHandle = {
		ref() { refCalls += 1; },
		unref() { unrefCalls += 1; }
	};
	const scheduler = createRecommendationScheduler({
		debounceMs: 10,
		setTimeoutFn(fn) { callback = fn; return timerHandle; },
		clearTimeoutFn() {},
		generate: async () => {}
	});

	scheduler.schedule('favorite');
	assert.equal(unrefCalls, 1, 'background debounce does not keep DSH alive');
	const idle = scheduler.whenIdle();
	assert.equal(refCalls, 1, 'an explicit waiter keeps the pending debounce alive');
	callback();
	await idle;
	assert.equal(scheduler.status().state, 'idle');
});

test('coalesces consecutive triggers into one background generation', async () => {
	const calls = [];
	const scheduler = createRecommendationScheduler({
		debounceMs: 1,
		generate: async ({ reasons }) => calls.push(reasons)
	});
	scheduler.schedule('favorite');
	scheduler.schedule('search-play');
	await scheduler.whenIdle();
	assert.equal(calls.length, 1);
	assert.deepEqual(new Set(calls[0]), new Set(['favorite', 'search-play']));
	assert.equal(scheduler.status().state, 'idle');
});

test('urgent refill bypasses the quiet debounce and absorbs pending preference reasons', async () => {
	const timers = [];
	const cleared = [];
	const calls = [];
	const scheduler = createRecommendationScheduler({
		debounceMs: 10000,
		setTimeoutFn(fn, delay) { timers.push({ fn, delay }); return timers.length; },
		clearTimeoutFn(id) { cleared.push(id); },
		generate: async ({ reasons }) => calls.push(reasons)
	});
	scheduler.schedule('favorite');
	scheduler.schedule('unfavorite');
	assert.equal(calls.length, 0);
	assert.equal(timers.at(-1).delay, 10000);
	scheduler.schedule('low-watermark', { urgent: true });
	await tick();
	assert.equal(calls.length, 1);
	assert.deepEqual(new Set(calls[0]), new Set(['favorite', 'unfavorite', 'low-watermark']));
	assert.ok(cleared.length >= 1);
});

test('runs only one follow-up generation when triggers arrive during active work', async () => {
	let releaseFirst;
	const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
	const calls = [];
	const scheduler = createRecommendationScheduler({
		debounceMs: 0,
		generate: async ({ reasons }) => {
			calls.push(reasons);
			if (calls.length === 1) await firstBlocked;
		}
	});
	scheduler.startNow('startup');
	await tick();
	scheduler.schedule('favorite');
	scheduler.schedule('preference');
	releaseFirst();
	await scheduler.whenIdle();
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0], ['startup']);
	assert.deepEqual(new Set(calls[1]), new Set(['favorite', 'preference']));
});

test('captures detached generation failures without rejecting or blocking the next run', async () => {
	let attempts = 0;
	const scheduler = createRecommendationScheduler({
		debounceMs: 0,
		generate: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error('source unavailable');
		}
	});
	scheduler.startNow('startup');
	await scheduler.whenIdle();
	assert.match(scheduler.status().lastError, /source unavailable/);
	scheduler.startNow('retry');
	await scheduler.whenIdle();
	assert.equal(attempts, 2);
	assert.equal(scheduler.status().lastError, null);
});

test('retries a failed background refill until it recovers', async () => {
	let attempts = 0;
	const scheduler = createRecommendationScheduler({
		debounceMs: 0,
		retryDelayMs: 1,
		generate: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error('short-generation');
		}
	});

	scheduler.startNow('low-watermark');
	await scheduler.whenIdle();
	assert.equal(attempts, 2);
	assert.equal(scheduler.status().lastError, null);
});

test('dispose cancels queued work and rejects new scheduling', async () => {
	let calls = 0;
	const scheduler = createRecommendationScheduler({ debounceMs: 50, generate: async () => { calls += 1; } });
	scheduler.schedule('favorite');
	scheduler.dispose();
	await tick();
	assert.equal(calls, 0);
	assert.equal(scheduler.schedule('search-play'), false);
	assert.equal(scheduler.status().state, 'disposed');
});

test('dispose aborts the signal of a running generation', async () => {
	let aborted = false;
	const scheduler = createRecommendationScheduler({
		debounceMs: 0,
		generate: ({ signal }) => new Promise((resolve) => {
			signal?.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
			setTimeout(resolve, 20);
		})
	});
	scheduler.startNow('startup');
	await tick();
	scheduler.dispose();
	await tick();
	assert.equal(aborted, true);
});
