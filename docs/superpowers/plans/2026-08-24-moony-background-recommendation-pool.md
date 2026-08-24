# Moony Background Recommendation Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace click-time recommendation computation with a persistent 60-track background pool that returns 30 tracks within 300 ms and learns from a minimal set of strong triggers.

**Architecture:** Add focused pool, scheduler, and generator modules under `lib/recommendation/`. The plugin builds and refreshes the pool asynchronously, while the existing route and tool action atomically consume cached batches and replace only unplayed button-generated queue entries. The client reads pool readiness from status and never starts the slow recommendation pipeline on click.

**Tech Stack:** Node.js 20+ ESM, React without JSX in `client.js`, Node built-in test runner, atomic JSON persistence under `DSH_HOME`.

**Spec:** `docs/superpowers/specs/2026-08-24-moony-background-recommendation-pool-design.md`

## Global Constraints

- Pool target is exactly 60 tracks.
- Each recommendation consumes exactly 30 tracks.
- Recent recommendation history contains at most 120 track keys and is a soft ranking penalty, not a permanent exclusion.
- The only behavior triggers are favorite/unfavorite, search-and-play, and explicit long-term preference changes.
- Completion, short skip, pause, volume, time of day, weekday, and player expansion do not trigger generation.
- Time of day and weekday do not affect scoring or candidate retrieval.
- A warm-pool click must return within 300 ms without calling candidate retrievers or bulk source verification.
- Online playback URLs are resolved at playback time and are not persisted in the pool.
- Background failures never clear a valid old pool or produce unhandled promise rejections.

---

### Task 1: Persistent Recommendation Pool

**Files:**
- Create: `lib/recommendation/pool.js`
- Create: `test/recommendation/pool.test.mjs`

**Interfaces:**
- Produces: `createRecommendationPool({ file, targetSize = 60, batchSize = 30, historySize = 120 })`
- Produces methods: `load()`, `snapshot()`, `replace(items, metadata)`, `consume(count)`, `restore(transaction)`, `commit(transaction)`, `needsRefill()`.
- `consume(count)` returns `{ ok, tracks, transaction, remaining, ready }`; history is committed only by `commit(transaction)`.

- [ ] **Step 1: Write failing tests for loading, replacement, atomic consumption, rollback, and 120-item history**

```js
test('consumes 30 from a 60-track pool and commits bounded history', async () => {
  const pool = createRecommendationPool({ file: join(dir, 'pool.json') });
  await pool.replace(tracks(60), { generationId: 'g1' });
  const result = await pool.consume(30);
  assert.equal(result.tracks.length, 30);
  assert.equal(result.remaining, 30);
  await pool.commit(result.transaction);
  assert.equal((await pool.snapshot()).recentRecommendedTrackKeys.length, 30);
});

test('restores a consumed batch when queue insertion fails', async () => {
  const result = await pool.consume(30);
  await pool.restore(result.transaction);
  assert.equal((await pool.snapshot()).items.length, 60);
  assert.equal((await pool.snapshot()).recentRecommendedTrackKeys.length, 0);
});
```

- [ ] **Step 2: Run the pool tests and verify they fail**

Run: `node --test test/recommendation/pool.test.mjs`

Expected: FAIL because `lib/recommendation/pool.js` does not exist.

- [ ] **Step 3: Implement validated state, hard dedupe, atomic file persistence, and compensating transactions**

```js
export function createRecommendationPool(options = {}) {
  const targetSize = Number(options.targetSize) || 60;
  const batchSize = Number(options.batchSize) || 30;
  const historySize = Number(options.historySize) || 120;
  // load validates version and unique trackKey values.
  // replace persists a valid 30-60 track generation atomically.
  // consume removes a batch in memory and persists it before returning.
  // commit appends track keys to bounded history.
  // restore prepends the exact transaction batch and persists it.
}
```

- [ ] **Step 4: Run pool tests and syntax checks**

Run: `node --test test/recommendation/pool.test.mjs && node --check lib/recommendation/pool.js`

Expected: PASS.

- [ ] **Step 5: Commit the pool component**

```bash
git add lib/recommendation/pool.js test/recommendation/pool.test.mjs
git commit -m "feat: add persistent recommendation pool"
```

### Task 2: Single-Flight Background Scheduler

**Files:**
- Create: `lib/recommendation/scheduler.js`
- Create: `test/recommendation/scheduler.test.mjs`

**Interfaces:**
- Produces: `createRecommendationScheduler({ generate, debounceMs = 2000, setTimeoutFn, clearTimeoutFn })`.
- Produces methods: `schedule(reason)`, `startNow(reason)`, `status()`, `dispose()`.
- `generate({ reasons })` is the Task 3 generator callback.

- [ ] **Step 1: Write failing tests for debounce, single-flight rerun, error capture, and disposal**

```js
test('coalesces consecutive triggers and reruns once after an in-flight update', async () => {
  const calls = [];
  const scheduler = createRecommendationScheduler({
    debounceMs: 0,
    generate: async ({ reasons }) => calls.push(reasons)
  });
  scheduler.schedule('favorite');
  scheduler.schedule('search-play');
  await scheduler.whenIdle();
  assert.equal(calls.length, 1);
  assert.deepEqual(new Set(calls[0]), new Set(['favorite', 'search-play']));
});
```

- [ ] **Step 2: Run scheduler tests and verify they fail**

Run: `node --test test/recommendation/scheduler.test.mjs`

Expected: FAIL because the scheduler module does not exist.

- [ ] **Step 3: Implement debounced scheduling with one active Promise and one queued rerun**

```js
export function createRecommendationScheduler({ generate, debounceMs = 2000 } = {}) {
  let timer = null;
  let running = null;
  let rerunRequested = false;
  const reasons = new Set();
  // schedule() merges reasons; startNow() bypasses debounce;
  // errors are recorded in status and never rethrown from detached work.
}
```

- [ ] **Step 4: Run scheduler tests and syntax checks**

Run: `node --test test/recommendation/scheduler.test.mjs && node --check lib/recommendation/scheduler.js`

Expected: PASS.

- [ ] **Step 5: Commit the scheduler**

```bash
git add lib/recommendation/scheduler.js test/recommendation/scheduler.test.mjs
git commit -m "feat: schedule recommendation refreshes safely"
```

### Task 3: Pool Generator and Time-Independent Ranking

**Files:**
- Create: `lib/recommendation/generator.js`
- Create: `test/recommendation/generator.test.mjs`
- Modify: `lib/recommendation/context.js`
- Modify: `lib/recommendation/retrievers.js`
- Modify: `lib/recommendation/ranker.js`
- Modify: `test/recommendation/context.test.mjs`
- Modify: `test/recommendation/ranker.test.mjs`

**Interfaces:**
- Produces: `createRecommendationGenerator({ profile, player, collectCandidates, rankCandidates, resolver, pool, targetSize = 60 })`.
- Produces: `generate({ reasons }) -> Promise<{ ok, count, generationId, failures }>`.
- Consumes `pool.snapshot()` for recent 120 history and `pool.replace()` for successful generations.

- [ ] **Step 1: Write failing tests proving no time fields affect context and recent history is a soft penalty**

```js
test('button context is identical across morning and late night', () => {
  const morning = buildButtonContext({ now: '2026-08-24T08:00:00+08:00' });
  const night = buildButtonContext({ now: '2026-08-24T23:30:00+08:00' });
  assert.deepEqual(morning, night);
});

test('recent recommendation history lowers score without excluding a track', () => {
  const scored = scoreCandidate(track, { recentRecommendedTrackKeys: [track.trackKey] }, profile);
  assert.equal(scored.excluded, false);
  assert.ok(scored.penalties.recentRecommendation < 0);
});
```

- [ ] **Step 2: Write failing generator tests for 60-track replacement and old-pool preservation**

```js
test('generates and atomically replaces a 60-track pool', async () => {
  const result = await generator.generate({ reasons: ['startup'] });
  assert.equal(result.count, 60);
  assert.equal((await pool.snapshot()).items.length, 60);
});

test('does not replace a valid pool with fewer than 60 tracks', async () => {
  await pool.replace(tracks(60), { generationId: 'old' });
  const result = await shortGenerator.generate({ reasons: ['favorite'] });
  assert.equal(result.ok, false);
  assert.equal((await pool.snapshot()).generationId, 'old');
});
```

- [ ] **Step 3: Run focused tests and verify failures**

Run: `node --test test/recommendation/context.test.mjs test/recommendation/ranker.test.mjs test/recommendation/generator.test.mjs`

Expected: FAIL on time-dependent fields, missing recent-history penalty, and missing generator.

- [ ] **Step 4: Remove time fields and late-night retrieval from button context**

```js
export function buildButtonContext(input = {}) {
  return {
    weights: { ...WEIGHTS },
    activity: String(input.activity || 'listen'),
    energyHint: input.energyHint ?? 'balanced',
    currentTrack: input.currentTrack ?? null,
    recentTrackKeys: keys(input.recentTracks),
    queueTrackKeys: keys(input.queue),
    recentRecommendedTrackKeys: keys(input.recentRecommendedTracks),
    profile: input.profile ?? emptyProfile()
  };
}
```

- [ ] **Step 5: Add a graduated recent-history penalty and generate a verified 60-track list without mutating the player**

```js
const position = context.recentRecommendedTrackKeys.indexOf(candidate.trackKey);
const recentRecommendation = position < 0 ? 0 : -Math.max(4, 24 - Math.floor(position / 6));
```

The generator must collect, normalize, hard-filter current/queue/pool duplicates, rank, verify identities, omit persisted online URLs, and call `pool.replace()` only after satisfying the Task 1 replacement threshold.

- [ ] **Step 6: Run focused recommendation tests**

Run: `node --test test/recommendation/context.test.mjs test/recommendation/ranker.test.mjs test/recommendation/generator.test.mjs test/recommendation/retrievers.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit the generator and ranking changes**

```bash
git add lib/recommendation/generator.js lib/recommendation/context.js lib/recommendation/retrievers.js lib/recommendation/ranker.js test/recommendation/generator.test.mjs test/recommendation/context.test.mjs test/recommendation/ranker.test.mjs
git commit -m "feat: generate time-independent recommendation pools"
```

### Task 4: Plugin Actions, Strong Triggers, and Queue Replacement

**Files:**
- Modify: `index.js`
- Modify: `lib/player.js`
- Modify: `lib/recommendation/profile.js`
- Modify: `test/player.test.mjs`
- Modify: `test/recommendation/profile.test.mjs`
- Modify: `test/recommendation/integration.test.mjs`

**Interfaces:**
- `buildActions()` consumes `{ pool, scheduler, preference }` through its recommendation dependency object.
- `actions.recommend()` consumes 30 tracks and returns `{ ok, tracks, count, remaining, poolStatus }`.
- Player uses a stable recommendation session ID, `button-recommendation`, so a second click replaces only unplayed button recommendations.

- [ ] **Step 1: Write failing player and action tests for replacing only unplayed button recommendations**

```js
test('a second button batch replaces unplayed recommendations but preserves manual tracks', () => {
  player.insertRecommendationAfterCurrent(firstBatch, 'button-recommendation');
  player.append([manualSong]);
  player.insertRecommendationAfterCurrent(secondBatch, 'button-recommendation');
  assert.deepEqual(player.state.queue.map(song => song.name), ['当前', ...secondNames, '手动']);
});
```

- [ ] **Step 2: Write failing integration tests for cached consumption and exact trigger set**

```js
test('recommend action consumes the pool without invoking the generator', async () => {
  const result = await actions.recommend({ requestId: 'r1' });
  assert.equal(result.count, 30);
  assert.equal(generatorCalls, 0);
});

test('favorite and search-play schedule refresh but skip and complete do not', async () => {
  await actions.control({ action: 'toggle-favorite' });
  await actions.play({ keyword: '周杰伦 晴天' });
  await actions.control({ action: 'next' });
  assert.deepEqual(scheduled, ['favorite', 'search-play']);
});
```

- [ ] **Step 3: Run focused tests and verify failures**

Run: `node --test test/player.test.mjs test/recommendation/profile.test.mjs test/recommendation/integration.test.mjs`

Expected: FAIL because pool-backed actions and trigger scheduling are not wired.

- [ ] **Step 4: Add `unfavorite` profile feedback and schedule only strong signals**

```js
const EVENT_WEIGHTS = Object.freeze({
  favorite: 5,
  unfavorite: -5,
  'search-play': 4,
  replay: 4,
  'complete-80': 2,
  'skip-short': -4,
  dislike: -8
});
```

Record skip and completion exactly as before if already observed, but do not call `scheduler.schedule()` for them.

- [ ] **Step 5: Wire pool, generator, and scheduler during plugin apply**

Create the pool under `resolveDataRoot()`, load it without blocking plugin registration, schedule startup generation only when fewer than 30 valid items exist, and dispose timers during plugin cleanup if the host exposes a disposal hook.

- [ ] **Step 6: Replace click-time coordinator execution with transactional pool consumption**

```js
const consumed = await pool.consume(30);
if (!consumed.ok) return { ok: false, preparing: true, guidance: '推荐正在准备中，请稍后再试。' };
try {
  player.insertRecommendationAfterCurrent(consumed.tracks, 'button-recommendation');
  await pool.commit(consumed.transaction);
} catch (error) {
  await pool.restore(consumed.transaction);
  throw error;
}
if (consumed.remaining <= 30) scheduler.schedule('low-watermark');
```

- [ ] **Step 7: Run focused integration tests**

Run: `node --test test/player.test.mjs test/recommendation/profile.test.mjs test/recommendation/integration.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit plugin integration**

```bash
git add index.js lib/player.js lib/recommendation/profile.js test/player.test.mjs test/recommendation/profile.test.mjs test/recommendation/integration.test.mjs
git commit -m "feat: serve recommendations from the background pool"
```

### Task 5: Client Readiness and Immediate Feedback

**Files:**
- Modify: `client.js`
- Modify: `test/moony-series.test.mjs`
- Modify: `test/recommendation/integration.test.mjs`

**Interfaces:**
- Status response adds `recommendation: { ready, count, generating, lastError }`.
- Recommend button displays `推荐`, `准备中`, or transient `已推荐 30 首`.

- [ ] **Step 1: Write failing source and route tests for readiness status and button copy**

```js
assert.match(source, /recommendation\.ready/);
assert.match(source, /准备中/);
assert.match(source, /已推荐.*30 首/);
assert.doesNotMatch(source, /成功时结果由宠物气泡播报/);
```

- [ ] **Step 2: Run client-focused tests and verify failures**

Run: `node --test test/moony-series.test.mjs test/recommendation/integration.test.mjs`

Expected: FAIL because the current button only uses global `busy` and has no pool status.

- [ ] **Step 3: Add recommendation status to `actions.status()` and update the button state**

The button is disabled only when the music service is unavailable, a request is actively consuming, or the pool has fewer than 30 items. A warm click shows `已推荐 30 首` briefly and refreshes state. No slow spinner is shown for background generation when at least 30 cached tracks remain.

- [ ] **Step 4: Run client-focused tests and syntax checks**

Run: `node --test test/moony-series.test.mjs test/recommendation/integration.test.mjs && node --check client.js && node --check index.js`

Expected: PASS.

- [ ] **Step 5: Commit client feedback**

```bash
git add client.js index.js test/moony-series.test.mjs test/recommendation/integration.test.mjs
git commit -m "feat: show recommendation pool readiness"
```

### Task 6: Documentation, Packaging, and End-to-End Verification

**Files:**
- Modify: `README.md`
- Modify: `test/package-contents.test.mjs`
- Modify: `cordis.patch.yml`
- Modify: `index.js`

**Interfaces:**
- Package ships all new recommendation modules.
- Legacy `recommendationTargetSize` remains readable but no longer controls button batch size.

- [ ] **Step 1: Update documentation and package assertions**

Document the fixed 60/30/120 product behavior, strong refresh triggers, time-independent ranking, cold-start state, and local pool path. Add `pool.js`, `scheduler.js`, and `generator.js` to package-content expectations.

- [ ] **Step 2: Remove the visible legacy target-size setting while retaining compatibility**

Keep reading `recommendationTargetSize` if present so old configurations do not fail, but do not expose it as a current tuning control and do not use it for button batch size.

- [ ] **Step 3: Run the full validation suite**

Run: `npm run check && npm test && git diff --check`

Expected: syntax checks pass and every test passes.

- [ ] **Step 4: Safely restart local DSH and verify the live plugin**

Use the installed safe restart guard. Confirm:

- DSH remains reachable at `http://127.0.0.1:3080/`.
- Music API is up.
- Recommendation status eventually reports 60 cached tracks.
- A warm click returns 30 tracks without disabling the UI for seconds.
- A second click replaces unplayed button recommendations and preserves manual queue entries.

- [ ] **Step 5: Commit final documentation and verification adjustments**

```bash
git add README.md cordis.patch.yml index.js test/package-contents.test.mjs
git commit -m "docs: explain background recommendation pools"
```

