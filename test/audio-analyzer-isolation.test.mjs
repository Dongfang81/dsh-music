import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the real analyzer with browser-boundary doubles. Routing the audible
// element, leaking a second audible output, or resuming after close must fail.
function setup({ suspended = false, rejectPlay = false } = {}) {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const start = source.indexOf('function attachAudioAnalyzer(audio) {');
  const end = source.indexOf('// 秒 → m:ss', start);
  const routes = [], helpers = [], contexts = [], listeners = new Map();
  let resolveResume;
  class Media extends EventTarget {
    src = ''; currentSrc = ''; currentTime = 0; playbackRate = 1;
    paused = true; ended = false; readyState = 4; volume = 1; muted = false;
    playCalls = 0; loads = 0;
    play() { this.playCalls++; if (rejectPlay) return Promise.reject(new Error('CORS')); this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() { this.loads++; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  }
  const main = new Media();
  main.src = main.currentSrc = 'https://music.example/song.mp3';
  main.currentTime = 42; main.paused = false; main.volume = 0.8;
  const gains = [];
  class AudioContext {
    state = suspended ? 'suspended' : 'running'; destination = {};
    constructor() { contexts.push(this); }
    createMediaElementSource(media) { routes.push(media); return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { frequencyBinCount: 128, connect() {}, disconnect() {}, getByteFrequencyData(buf) { buf.fill(64); } }; }
    createGain() { const gain = { gain: { value: 1 }, connect() {}, disconnect() {} }; gains.push(gain); return gain; }
    resume() { return new Promise(resolve => { resolveResume = () => { this.state = 'running'; resolve(); }; }); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  const doc = {
    createElement(tag) { assert.equal(tag, 'audio'); const helper = new Media(); helpers.push(helper); return helper; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); }
  };
  const attach = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', {
    window: { AudioContext }, document: doc, Uint8Array, setTimeout() {}, clearTimeout() {}
  });
  return { main, routes, helpers, gains, contexts, listeners, analyzer: attach(main), finishResume: () => resolveResume?.() };
}

test('auto-match routes only a separate CORS element, never the audible player', async () => {
  const s = setup();
  await s.analyzer.resume();
  assert.equal(s.routes.includes(s.main), false, 'automatic matching must never reroute playback');
  assert.equal(s.helpers.length, 1);
  const helper = s.helpers[0];
  assert.equal(helper.crossOrigin, 'anonymous');
  assert.equal(helper.src, s.main.currentSrc);
  assert.equal(helper.currentTime, 42);
  assert.equal(s.gains[0].gain.value, 0, 'analysis copy must not create duplicate sound');
  assert.ok(s.analyzer.sample()?.energy > 0);
  assert.equal(s.main.paused, false);
  assert.equal(s.main.volume, 0.8);
});

test('disable and re-enable affect only analysis; close releases its resources', async () => {
  const s = setup();
  await s.analyzer.resume();
  s.analyzer.suspend();
  assert.equal(s.helpers[0]?.paused, true);
  assert.equal(s.analyzer.sample(), null);
  assert.equal(s.main.paused, false);
  await s.analyzer.resume();
  assert.equal(s.helpers[0].paused, false);
  assert.equal(s.routes.length, 1);
  await s.analyzer.close();
  assert.equal(s.helpers[0].src, '');
  assert.equal(s.contexts[0].state, 'closed');
  assert.equal(s.listeners.size, 0);
  assert.equal(s.main.paused, false);
  assert.equal(s.main.playCalls, 0);
});

test('seek and song changes sync the analysis copy without modifying playback', async () => {
  const s = setup(); await s.analyzer.resume();
  s.main.currentTime = 80; s.analyzer.sample();
  assert.equal(s.helpers[0]?.currentTime, 80);
  s.main.currentSrc = s.main.src = 'https://music.example/next.mp3';
  s.main.currentTime = 0; s.analyzer.sample();
  assert.equal(s.helpers[0].src, s.main.src);
  assert.equal(s.routes.length, 1);
  assert.equal(s.main.loads, 0);
});

test('analysis playback rejection cannot silence the main player or retry every sample', async () => {
  const s = setup({ rejectPlay: true });
  await s.analyzer.resume(); await Promise.resolve();
  for (let i = 0; i < 8; i++) assert.equal(s.analyzer.sample(), null);
  assert.equal(s.routes.includes(s.main), false);
  assert.equal(s.helpers[0]?.playCalls, 1);
  assert.equal(s.main.paused, false);
  assert.equal(s.main.volume, 0.8);
});

test('pending context resume cannot restart analysis after disable or close', async () => {
  for (const action of ['suspend', 'close']) {
    const s = setup({ suspended: true });
    const pending = s.analyzer.resume(); await Promise.resolve();
    s.analyzer[action](); s.finishResume(); await pending;
    assert.equal(s.routes.length, 0);
    assert.equal(s.helpers[0]?.playCalls || 0, 0);
    assert.equal(s.main.paused, false);
  }
});

test('media error in analysis is bounded and a new song can be analyzed', async () => {
  const s = setup(); await s.analyzer.resume();
  s.helpers[0].dispatchEvent(new Event('error'));
  const count = s.helpers[0].playCalls;
  for (let i = 0; i < 8; i++) assert.equal(s.analyzer.sample(), null);
  assert.equal(s.helpers[0].playCalls, count);
  s.main.src = s.main.currentSrc = 'https://music.example/new.mp3';
  s.analyzer.sample();
  assert.equal(s.helpers[0].src, s.main.src);
  assert.equal(s.main.paused, false);
});

test('analysis waits for metadata before seeking to the current playback position', async () => {
  const s = setup();
  s.helpers[0].readyState = 0;
  await s.analyzer.resume();
  assert.equal(s.helpers[0].currentTime, 0);
  s.helpers[0].readyState = 4;
  s.helpers[0].dispatchEvent(new Event('loadedmetadata'));
  assert.equal(s.helpers[0].currentTime, 42);
  assert.ok(s.analyzer.sample()?.energy > 0);
});
