import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function loadClient(onHook = () => {}) {
  let definition;
  const react = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(value) { onHook(); return [value, () => {}]; }
  };
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    setTimeout, clearTimeout
  });
  return definition.factory(name => name === 'react' ? react : {});
}

const flush = () => new Promise(setImmediate);
const goodView = { ok: true, instanceId: 'boot-a', revision: 1, count: 1, index: 0, items: [{ id: 7, name: '歌曲', artists: '歌手' }] };

function setup(load) {
  const client = loadClient();
  assert.equal(typeof client.createQueueViewLoader, 'function', 'queue loads need cancellable bounded recovery');
  const timers = new Map();
  const loaded = [], errors = [], delays = [];
  let nextTimer = 0;
  const stop = client.createQueueViewLoader({
    load, version: 'boot-a:1', onLoad: view => loaded.push(view), onError: error => errors.push(error),
    setTimer(fn, ms) { const id = ++nextTimer; timers.set(id, fn); delays.push(ms); return id; },
    clearTimer(id) { timers.delete(id); }
  });
  return { loaded, errors, stop, timers, delays, async tick() {
    const [id, fn] = timers.entries().next().value || [];
    assert.ok(fn, 'a failed attempt must schedule recovery');
    timers.delete(id); fn(); await flush();
  } };
}

test('queue recovers after timeout without changing queue revision or reopening panel', async () => {
  let calls = 0;
  const h = setup(async () => { if (++calls === 1) throw new Error('request timeout'); return goodView; });
  await flush();
  assert.equal(h.loaded.length, 0);
  await h.tick();
  assert.deepEqual(h.loaded, [goodView]);
  assert.equal(calls, 2);
  assert.equal(h.errors.length, 0);
  assert.equal(h.timers.size, 0);
});

test('queue stops after three failed attempts and reports a terminal error', async () => {
  let calls = 0;
  const h = setup(async () => { calls++; throw new Error('offline'); });
  await flush(); await h.tick(); await h.tick();
  assert.equal(calls, 3);
  assert.equal(h.errors.length, 1);
  assert.equal(h.timers.size, 0, 'no endless retry loop');
  assert.equal(h.delays.length, 2);
  assert.ok(h.delays[0] > 0 && h.delays[1] >= h.delays[0]);
});

for (const [label, response] of [
  ['server error', { ok: false, error: 'unavailable' }],
  ['stale version', { ...goodView, instanceId: 'boot-old' }],
  ['malformed rows', { ...goodView, items: null }]
]) test(`queue retries ${label} instead of silently remaining in loading state`, async () => {
  let calls = 0;
  const h = setup(async () => ++calls === 1 ? response : goodView);
  await flush(); assert.equal(h.loaded.length, 0);
  await h.tick(); assert.deepEqual(h.loaded, [goodView]);
});

test('closing the queue cancels a scheduled retry', async () => {
  const h = setup(async () => { throw new Error('offline'); });
  await flush(); assert.equal(h.timers.size, 1);
  h.stop(); assert.equal(h.timers.size, 0);
  assert.equal(h.errors.length, 0);
});

test('a late response from a closed or superseded queue cannot overwrite current rows', async () => {
  let resolve;
  const h = setup(() => new Promise(done => { resolve = done; }));
  await flush(); h.stop(); resolve(goodView); await flush();
  assert.equal(h.loaded.length, 0);
  assert.equal(h.errors.length, 0);
});

test('empty queue is a successful result, not an endlessly loading list', async () => {
  const empty = { ...goodView, count: 0, index: -1, items: [] };
  const h = setup(async () => empty);
  await flush(); assert.deepEqual(h.loaded, [empty]); assert.equal(h.timers.size, 0);
});

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}

test('failed queue presents a retry button instead of a perpetual loading indicator', () => {
  const { QueueListPanel } = loadClient();
  let retries = 0;
  const rendered = nodes(QueueListPanel({ items: [], loading: true, error: '加载失败', onRetry() { retries++; } }));
  const retry = rendered.find(node => node.type === 'button' && node.props['aria-label'] === '重新加载播放列表');
  assert.ok(retry, 'failed queue must offer a manual retry');
  retry.props.onClick(); assert.equal(retries, 1);
  assert.equal(rendered.some(node => node.props.children?.includes('正在加载播放列表…')), false);
});

test('queue hook order remains stable when loading finishes with no songs', () => {
  let hooks = 0;
  const { QueueListPanel } = loadClient(() => hooks++);
  QueueListPanel({ items: [], loading: true });
  const initialHooks = hooks;
  hooks = 0;
  QueueListPanel({ items: [], loading: false });
  assert.equal(hooks, initialHooks, 'empty result must not remove a hook and crash React');
});

test('MusicPlayer queue effect recovers and manual retry works without a revision change', async () => {
  const client = loadClient();
  const timers = new Map();
  let timerId = 0, dependencies, cleanup, failure = true, requests = 0;
  const context = {
    ...client,
    queueOpen: true, queueRetry: 0, queueView: null,
    state: { instanceId: 'boot-a', queue: { revision: 1 } },
    queueLoadError: null,
    setQueueView(view) { context.queueView = view; },
    setQueueLoadError(error) { context.queueLoadError = error; },
    getQueueView: async () => { requests++; if (failure) throw new Error('timeout'); return goodView; },
    createQueueViewLoader(options) {
      return client.createQueueViewLoader({ ...options,
        setTimer(fn) { const id = ++timerId; timers.set(id, fn); return id; },
        clearTimer(id) { timers.delete(id); }
      });
    },
    React: { useEffect(fn, next) {
      if (!dependencies || next.some((v, i) => v !== dependencies[i])) {
        cleanup?.(); dependencies = next; cleanup = fn();
      }
    } }
  };
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const start = source.indexOf('React.useEffect(function () {', source.indexOf('// 播放列表仅在面板打开'));
  const effect = source.slice(start, source.indexOf('\n\n', start));
  const render = () => vm.runInNewContext(effect, context);
  const tick = async () => {
    const [id, fn] = timers.entries().next().value;
    timers.delete(id); fn(); await flush(); render();
  };
  render(); await flush(); await tick(); await tick();
  assert.ok(context.queueLoadError);
  assert.equal(requests, 3);
  render(); assert.equal(requests, 3, 'ordinary rerenders cannot start endless retry cycles');
  failure = false;
  context.queueRetry++;
  render(); await flush(); render();
  assert.deepEqual(context.queueView, goodView);
  assert.equal(context.queueLoadError, null);
  assert.equal(requests, 4);
  assert.equal(timers.size, 0);
  cleanup?.();
});
