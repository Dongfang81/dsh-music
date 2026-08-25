# Moony Continuous Recommendation Radio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace one-shot recommendation appends with a persistent 30-track recommendation radio that atomically replaces each completed batch, never repeats a track inside one active session, and exits when the user manually takes over playback.

**Architecture:** The player owns persistent radio session state and atomically swaps queue batches. The action layer transactionally consumes the recommendation pool for both initial start and batch-boundary advance, while the existing scheduler keeps the 60-track pool warm. The client retries only a boundary that is waiting for a new batch; candidate normalization and queue planning prevent placeholder identities and cap pure exploration.

**Tech Stack:** Node.js 24 ESM, DSH/Cordis plugin routes, browser React runtime in `client.js`, Node built-in test runner, atomic JSON persistence.

**Spec:** `docs/superpowers/specs/2026-08-25-moony-continuous-recommendation-radio-design.md`

## Global Constraints

- A recommendation click replaces the entire playback queue only after a playable 30-track batch is ready.
- The active queue contains one 30-track recommendation batch; the next batch replaces it instead of appending.
- An active radio session must not deliver the same `trackKey` twice, including across a DSH restart.
- Favorites are never deleted by queue replacement or local remediation.
- Manual search playback, playlist/favorite playback, append/insert, clear, or play-mode changes exit radio mode.
- Pause, resume, favorite toggles, batch-local jumps, and single-row deletion do not exit radio mode.
- At a batch boundary with no ready batch, never loop to the first song; keep the last row and return `preparing: true`.
- Pure `exploration`-only tracks may occupy at most 20% of a planned recommendation pool.
- Do not add dependencies.

---

### Task 1: Persistent recommendation radio state in the player

**Files:**
- Modify: `lib/player.js`
- Test: `test/player.test.mjs`

**Interfaces:**
- Produces: `player.startRecommendationRadio(songs, sessionId) -> { song, sessionId, batchNumber, count }`
- Produces: `player.replaceRecommendationRadioBatch(songs) -> { song, sessionId, batchNumber, count }`
- Produces: `player.exitRecommendationRadio() -> boolean`
- Produces: `player.radioStatus() -> { active, sessionId, batchNumber, seenTrackKeys, waitingForNextBatch } | null`
- Produces: `player.setRecommendationRadioWaiting(value) -> boolean`
- Consumes later: Task 4 calls these methods from `recommend` and `next` actions.

- [ ] **Step 1: Write failing player tests for atomic start and favorites preservation**

Add tests that create a manual queue and favorite, call:

```js
const result = player.startRecommendationRadio(
  [song(30, '推荐一'), song(31, '推荐二')],
  'radio-1'
);
assert.deepEqual(player.state.queue.map((item) => item.name), ['推荐一', '推荐二']);
assert.equal(player.current().name, '推荐一');
assert.equal(player.state.playing, true);
assert.deepEqual(player.state.favorites.map((item) => item.id), [1]);
assert.deepEqual(result, { song: player.current(), sessionId: 'radio-1', batchNumber: 1, count: 2 });
assert.deepEqual(player.radioStatus().seenTrackKeys, player.state.queue.map((item) => item.trackKey));
```

- [ ] **Step 2: Run the targeted player tests and confirm RED**

Run: `node --test --test-name-pattern='recommendation radio' test/player.test.mjs`

Expected: FAIL because `startRecommendationRadio` and `radioStatus` are not defined.

- [ ] **Step 3: Implement the persistent radio state and atomic batch methods**

In `createPlayer`, initialize `state.recommendationRadio = null`. Load and persist only structurally valid data:

```js
{
  active: true,
  sessionId: String(saved.sessionId),
  batchNumber: Math.max(1, Number(saved.batchNumber) || 1),
  seenTrackKeys: [...new Set(saved.seenTrackKeys.filter(Boolean).map(String))],
  waitingForNextBatch: Boolean(saved.waitingForNextBatch)
}
```

`startRecommendationRadio` must tag every track as `moonyOrigin: 'recommendation'`, replace the whole queue, set index `0`, set playing `true`, and seed `seenTrackKeys` from the delivered batch. `replaceRecommendationRadioBatch` requires active state, replaces the whole queue, increments `batchNumber`, appends new unique keys to `seenTrackKeys`, clears waiting, and starts index `0`. Both methods call `markQueue()` and one `persist()`.

- [ ] **Step 4: Write failing tests for restart recovery, batch replacement, and boundary behavior**

Persist a radio batch to a temporary state file, dispose, reload, and assert the queue, current index, session ID, batch number, and seen keys survive. Add assertions that replacing batch 1 with batch 2 leaves only batch 2 and increments the number. Add a player-level boundary query such as:

```js
assert.equal(player.isRecommendationRadioBoundary(), false);
player.jump(player.state.queue.length - 1);
assert.equal(player.isRecommendationRadioBoundary(), true);
```

- [ ] **Step 5: Implement recovery, waiting state, and boundary query**

Expose `isRecommendationRadioBoundary()` as true only when radio is active, the queue is non-empty, and `state.index === state.queue.length - 1`. Ensure `next()` itself retains ordinary semantics; Task 4 must intercept the boundary before calling it.

- [ ] **Step 6: Write and satisfy manual-takeover tests**

For each of `replaceAndPlay`, `playSong`, `append`, `insertNext`, `clearQueue`, `playFavorites`, and `togglePlayMode`, start radio first, perform the operation, and assert `radioStatus() === null`. Verify `toggleFavorite`, `jump`, `removeQueueAt`, pause, and resume leave it active.

- [ ] **Step 7: Run player tests and commit**

Run: `node --test test/player.test.mjs`

Expected: PASS.

Commit:

```bash
git add lib/player.js test/player.test.mjs
git commit -m "feat: add persistent recommendation radio state"
```

---

### Task 2: Exclusion-aware pool consumption and invalid identity rejection

**Files:**
- Modify: `lib/recommendation/pool.js`
- Modify: `lib/recommendation/identity.js`
- Test: `test/recommendation/pool.test.mjs`
- Test: `test/recommendation/identity.test.mjs`

**Interfaces:**
- Produces: `pool.consume(count, { excludeTrackKeys })` with the existing transaction response shape.
- Produces: `isPlaceholderArtist(value) -> boolean` exported from `identity.js`.
- Consumes later: Task 3 uses `isPlaceholderArtist`; Task 4 passes radio seen keys to `pool.consume`.

- [ ] **Step 1: Write failing tests for exclusion-aware transactional consumption**

Create a 60-track pool and consume 30 with keys 1–5 excluded. Assert returned tracks omit all excluded keys, still contain 30 songs, excluded items remain available behind the transaction, `restore()` returns the exact logical pool, and `commit()` adds only delivered keys to recent history.

- [ ] **Step 2: Run the targeted pool test and confirm RED**

Run: `node --test --test-name-pattern='excludes active radio' test/recommendation/pool.test.mjs`

Expected: FAIL because `consume` ignores the options argument.

- [ ] **Step 3: Implement exclusion-aware consumption without losing excluded tracks**

Change the signature to:

```js
async function consume(count = batchSize, options = {})
```

Partition `state.items` into eligible and excluded using `new Set(options.excludeTrackKeys ?? [])`. Consume the first requested eligible tracks, and leave the untouched order of every other item in `state.items`. The pending transaction contains only consumed tracks. Preserve all existing commit/restore crash guarantees.

- [ ] **Step 4: Write failing normalization tests for placeholder artists**

Assert `normalizeTrack` returns `null` for artist values equal to `[Object Object]`, `Object Object`, an object without a usable `name`, or a nested object name; assert legitimate artist `Object` is not globally banned.

- [ ] **Step 5: Implement placeholder detection at the normalization boundary**

Export:

```js
export function isPlaceholderArtist(value) {
  const text = displayText(value).normalize('NFKC').toLocaleLowerCase();
  return text === '[object object]' || text === 'object object';
}
```

Make `normalizeArtists` discard placeholder names and objects whose `name` is not a string or number. Do not convert arbitrary objects with `String(item)`.

- [ ] **Step 6: Run pool and identity tests and commit**

Run: `node --test test/recommendation/pool.test.mjs test/recommendation/identity.test.mjs`

Expected: PASS.

Commit:

```bash
git add lib/recommendation/pool.js lib/recommendation/identity.js test/recommendation/pool.test.mjs test/recommendation/identity.test.mjs
git commit -m "fix: exclude seen tracks and reject placeholder artists"
```

---

### Task 3: Recommendation-source quality controls

**Files:**
- Modify: `lib/recommendation/retrievers.js`
- Modify: `lib/recommendation/queue-planner.js`
- Modify: `lib/recommendation/generator.js`
- Test: `test/recommendation/retrievers.test.mjs`
- Test: `test/recommendation/queue-planner.test.mjs`
- Test: `test/recommendation/generator.test.mjs`

**Interfaces:**
- Produces: `planQueue({ ..., maxExplorationRatio: 0.2 })` enforcing an origin quota.
- Consumes: `isPlaceholderArtist` from Task 2.
- Consumes: active `player.radioStatus()?.seenTrackKeys` as generator hard exclusions.

- [ ] **Step 1: Write a failing current-similar guard test**

Call `retrieveCurrentSimilar` with a current track whose artist is `[Object Object]` and a spy client. Assert neither `getJson` nor `search` is called and the result is `[]`. Repeat for missing title, missing artists, and missing raw ID when only the similarity endpoint would be used. Retain a valid-current-track test proving `/simi/song` still works.

- [ ] **Step 2: Implement the current-similar identity guard**

Before any API call, require a non-empty title, at least one non-placeholder artist, and a finite positive raw ID for `/simi/song`. If ID is absent but identity is valid, retain exact title-plus-artist search fallback; invalid identity returns `[]`.

- [ ] **Step 3: Write a failing 20% exploration-cap planner test**

Build 60 high-scoring tracks with `origins: ['exploration']` and at least 48 lower-scoring tracks with reliable origins. Plan 60 with `maxExplorationRatio: 0.2` and assert at most 12 selected tracks are exploration-only. Add a case where a track has both `exploration` and `artists`; it counts as reliable, not pure exploration.

- [ ] **Step 4: Implement origin quotas in `planQueue`**

Define pure exploration as `origins.length === 1 && origins[0] === 'exploration'`. Compute `explorationLimit = Math.floor(target * maxExplorationRatio)`. Make `eligible` and relaxed artist-cap fills reject pure-exploration entries once the selected count reaches the limit. Do not relax the exploration cap to fill a shortfall.

- [ ] **Step 5: Write failing generator tests for radio seen exclusions and quota propagation**

Stub `player.radioStatus()` with known seen keys and assert those candidates never reach `pool.replace`. Spy on `planQueue` and assert every planning call receives `maxExplorationRatio: 0.2`.

- [ ] **Step 6: Implement generator exclusions and quota propagation**

Add active radio seen keys to the generator blocked set and pass `maxExplorationRatio: 0.2` to preview and final planning. Retain global recent penalties and the existing 60-track target.

- [ ] **Step 7: Run recommendation quality tests and commit**

Run: `node --test test/recommendation/retrievers.test.mjs test/recommendation/queue-planner.test.mjs test/recommendation/generator.test.mjs`

Expected: PASS.

Commit:

```bash
git add lib/recommendation/retrievers.js lib/recommendation/queue-planner.js lib/recommendation/generator.js test/recommendation/retrievers.test.mjs test/recommendation/queue-planner.test.mjs test/recommendation/generator.test.mjs
git commit -m "fix: constrain recommendation exploration quality"
```

---

### Task 4: Server-side radio start and automatic batch advance

**Files:**
- Modify: `index.js`
- Test: `test/recommendation/integration.test.mjs`

**Interfaces:**
- Consumes: player radio methods from Task 1.
- Consumes: exclusion-aware `pool.consume` from Task 2.
- Produces: `actions.recommend()` returning `{ ok, mode: 'recommendation-radio', sessionId, batchNumber, count, tracks, remaining }`.
- Produces: `actions.control({ action: 'next' })` returning `{ preparing: true, mode: 'recommendation-radio' }` at an empty boundary or the normal new batch payload after a successful swap.

- [ ] **Step 1: Replace old append expectations with failing initial-radio tests**

Update integration tests so a manual 3-song queue followed by `actions.recommend()` becomes exactly the consumed 30 tracks, index `0`, and active radio state. Assert the first URL is resolved before the old queue disappears. Add a resolver-failure test that checks the manual queue and radio state remain unchanged and the pool transaction is restored.

- [ ] **Step 2: Implement atomic initial radio start**

Create a unique session ID from request ID plus timestamp/sequence. Consume 30 with exclusions from global recent history, resolve the first track, call `player.startRecommendationRadio`, commit, and schedule urgent low-watermark refill. Remove `insertRecommendationAfterCurrent(... replaceUnplayed: false)` from button recommendation.

- [ ] **Step 3: Write failing boundary-advance tests**

Start a 30-track radio batch, jump to index 29, and invoke `control(next)`. Assert a ready pool replaces the queue with the next 30, increments batch number, keeps the session ID, and does not repeat any first-batch key. For an insufficient pool, assert index stays 29, queue stays unchanged, playing becomes false, waiting becomes true, and response contains `preparing: true`.

- [ ] **Step 4: Implement the radio-aware `next` path**

Before ordinary `player.next()`, detect `player.isRecommendationRadioBoundary()`. At the boundary, consume 30 excluding `radioStatus().seenTrackKeys`, resolve the first track, replace the batch, commit, and refill. If consume is not ready, mark waiting, pause playback, schedule `radio-boundary` urgently, and return a non-throwing preparing response. If replacement fails, restore the transaction and keep the old batch.

- [ ] **Step 5: Write and satisfy takeover integration tests**

Exercise search play, playlist/favorite play, append/insert, clear, and play-mode action paths through real actions; assert each exits radio. Exercise pause/resume, favorite, jump, and single-row removal; assert radio remains active.

- [ ] **Step 6: Update tool copy and status payload**

Change recommendation tool text from “添加推荐歌曲” to “开启持续推荐电台：替换当前列表，每批 30 首自动续播”。Expose compact fields only:

```js
recommendation.radio = { active, batchNumber, waitingForNextBatch }
```

Do not expose `seenTrackKeys` to frequent browser status polling.

- [ ] **Step 7: Run integration tests and commit**

Run: `node --test test/recommendation/integration.test.mjs test/player.test.mjs test/recommendation/pool.test.mjs`

Expected: PASS.

Commit:

```bash
git add index.js test/recommendation/integration.test.mjs
git commit -m "feat: stream continuous recommendation batches"
```

---

### Task 5: Browser boundary retry and lightweight feedback

**Files:**
- Modify: `client.js`
- Test: `test/moony-series.test.mjs`

**Interfaces:**
- Consumes: `POST /dsh-alger/command { action: 'next' }` response field `preparing`.
- Consumes: compact `state.recommendation.radio.waitingForNextBatch`.
- Produces: one cancellable boundary retry loop with capped delays `[1000, 2000, 3000, 5000]` milliseconds.

- [ ] **Step 1: Write failing source-level client tests**

Assert the audio `ended` handler calls a shared `advancePlayback()` instead of fire-and-forget `command('next')`; the function schedules exactly one retry when `result.preparing`; cleanup/manual takeover cancels it; and the queue heading renders “正在准备下一批…” only when radio waiting is true.

- [ ] **Step 2: Implement the cancellable retry helper**

Use refs for retry timer, attempt number, and generation token. `advancePlayback()` posts `next`; success clears retry and refreshes; `preparing` schedules the next capped delay. Any successful recommendation click, manual search/play/add action, player unmount, or status showing inactive radio invalidates the token and clears the timer.

- [ ] **Step 3: Keep the recommendation button interaction simple**

Retain the fixed “推荐” label. On success, close favorites/results, open queue, and refresh. Do not render progress text on the button.

- [ ] **Step 4: Run client tests and commit**

Run: `node --test test/moony-series.test.mjs test/recommendation/integration.test.mjs`

Expected: PASS.

Commit:

```bash
git add client.js test/moony-series.test.mjs
git commit -m "feat: continue recommendation radio across batches"
```

---

### Task 6: Sanitize old pool data and safely remediate the local profile

**Files:**
- Modify: `lib/recommendation/pool.js`
- Modify: `test/recommendation/pool.test.mjs`
- Runtime data after tests: `$DSH_HOME/moony-singer-state.json`, `$DSH_HOME/moony-singer-recommendation-pool.json`

**Interfaces:**
- Consumes: Task 2 identity validation.
- Produces: loader sanitation that drops invalid old pool rows without discarding valid favorites or taste profile data.

- [ ] **Step 1: Write a failing corrupt-placeholder migration test**

Load a version-1 pool containing valid rows plus `[Object Object]` artists. Assert invalid rows are dropped, valid rows keep order, pending invalid rows are not restored, and `lastGenerationStatus` records `reason: 'sanitized-legacy-pool'` when removal occurred.

- [ ] **Step 2: Implement pool sanitation during load**

Apply strict valid-track and artist validation to `items` and pending tracks before pending recovery. Persist once only if rows were removed. If fewer than 30 valid tracks remain, status is not ready and startup scheduling regenerates the pool.

- [ ] **Step 3: Run the full automated suite before touching live data**

Run:

```bash
npm run check
npm test
git diff --check
```

Expected: all tests pass and no whitespace errors.

- [ ] **Step 4: Commit sanitation**

```bash
git add lib/recommendation/pool.js test/recommendation/pool.test.mjs
git commit -m "fix: sanitize legacy recommendation pool data"
```

- [ ] **Step 5: Back up and remediate only recommendation runtime state**

After merging to the local plugin path, copy the two runtime JSON files to timestamped `.bak` siblings. Use the plugin API/player helper rather than manual JSON rewriting to clear the current 85-row recommendation queue. Remove the pool file so the new loader/generator creates a clean pool. Do not modify `moony-singer-recommendation.json`, `moony-singer-habits.json`, or favorites.

- [ ] **Step 6: Safely restart and smoke test DSH**

Use `POST /dsh-restart-guard/restart-safe`, wait for a new launchd PID, and verify:

```text
GET /dsh-restart-guard/active -> safe response
GET /dsh-alger/state -> plugin state without load failure
Browser -> DSH page loads, Moony appears, no Failed to load plugins
```

Click recommendation once only after the pool reports ready; verify queue length 30, first song starts, radio is active, favorites count is unchanged, and no rendered artist is `[Object Object]`.

---

### Task 7: Final regression and branch handoff

**Files:**
- Verify all modified source, tests, spec, and plan files.

**Interfaces:**
- Produces: a clean feature branch ready for review and merge.

- [ ] **Step 1: Run fresh full verification**

Run:

```bash
npm ci
npm run check
npm test
git diff --check main...HEAD
git status --short --branch
```

Expected: all tests pass, no diff errors, and only intentional commits differ from `main`.

- [ ] **Step 2: Review requirements against the approved spec**

Confirm every behavior in the spec has a named test: full queue replacement, 30-track swap, no repeat within active session, boundary wait without looping, manual takeover, restart recovery, placeholder rejection, exploration cap, and favorites preservation.

- [ ] **Step 3: Prepare the handoff summary**

Report commit list, test count, live DSH PID/health, local runtime backup paths, and any non-blocking limitations. Do not merge, push, or release unless the user requests those actions.
