# Moony Hybrid Music Recommendation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the random-playlist recommendation button with a local, explainable, playable dynamic queue while preserving a separate, natural LLM conversation path for emotional value and music discussion.

**Architecture:** Build focused recommendation modules for identity, profile, retrieval, source qualification, ranking, queue planning, and session coordination. The UI button calls the deterministic coordinator directly; DSH conversation tools remain atomic capabilities that the LLM may choose after natural dialogue, with no mandatory natural-language-to-JSON parser.

**Tech Stack:** Node.js 24+, ESM JavaScript, `node:test`, existing DSH Cordis plugin APIs, browser `fetch`/React injection, `music-metadata` for optional local-library tags.

**Spec:** `docs/superpowers/specs/2026-08-23-moony-hybrid-music-recommendation-design.md`

## Global Constraints

- Button recommendation uses no LLM and targets 50% taste, 30% context, 20% exploration.
- Button recommendation keeps the current song and inserts the new queue after it.
- The first five recommended tracks must have verified playable sources before insertion.
- Conversation input remains natural LLM context; no mandatory intent parser or automatic search for every utterance.
- Full DSH conversations, microphone, camera, and ambient data are never read into the recommendation profile.
- Preference data stays under `~/.dsh/`, supports inspection and complete deletion, and uses versioned migration.
- Missing originals must not be replaced by covers, Live versions, medleys, or accompaniment tracks without an explicit user request.
- External-source, candidate, or model failures must remain plugin-local and must never fail plugin loading or terminate DSH.
- Preserve the existing uncommitted `index.js` changes in the main working tree. Before changing `index.js` in an isolated worktree, port their cross-source duration and exact-artist behavior into regression tests and reconcile them explicitly; never discard or overwrite the dirty file.
- Perform implementation in an isolated worktree. Do not restart production DSH until unit tests, integration tests, build checks, and an isolated-profile browser check all pass.

---

## File Structure

Create focused modules under `lib/recommendation/`:

- `identity.js` — canonical track identity, version tagging, deduplication.
- `profile.js` — versioned local preference store, feedback weights, decay, migration, deletion.
- `context.js` — button-only context derived from time, playback, queue, and saved preferences.
- `retrievers.js` — independent candidate sources combined with failure isolation.
- `local-library.js` — allowlisted directory indexing, metadata parsing, and local-source lookup.
- `source-resolver.js` — local/direct/cross-source qualification, confidence, and short-lived caching.
- `ranker.js` — deterministic 50/30/20 scoring plus penalties and explanations.
- `queue-planner.js` — 15-track constrained ordering and stable seeded randomness.
- `coordinator.js` — request cancellation, orchestration, preflight of five tracks, and fallback.

Modify existing files only at integration boundaries:

- `lib/habits.js` — expose migration-safe raw/aggregate signals and explicit feedback hooks.
- `lib/player.js` — insert recommended tracks after current without deleting user-added tracks.
- `index.js` — construct modules, replace recommendation action, add atomic preference tool/routes, keep tool descriptions conversationally safe.
- `client.js` — keep button direct, prevent duplicate requests, show one short result/failure notice.
- `cordis.patch.yml` — optional local paths and learning toggle.
- `package.json` — add `music-metadata`, preserve existing scripts.
- `README.md` / `FEATURES.md` — explain fast button vs conversational Moony and local data controls.

Tests live in `test/recommendation/*.test.mjs` plus existing `test/e2e.mjs` and client/package tests.

---

### Task 1: Canonical Track Identity and Version Safety

**Files:**
- Create: `lib/recommendation/identity.js`
- Create: `test/recommendation/identity.test.mjs`

**Interfaces:**
- Consumes: raw tracks shaped like Netease songs, compact songs, local metadata, or cross-source hits.
- Produces: `normalizeTrack(raw, origin)`, `trackKey(track)`, `classifyVersion(title)`, `dedupeTracks(tracks)`, and `isRequestedVersion(candidate, requested)`.

- [ ] **Step 1: Write failing normalization and version tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrack, dedupeTracks, isRequestedVersion } from '../../lib/recommendation/identity.js';

test('keeps original and cover identities separate', () => {
  const original = normalizeTrack({ name: '晴天', ar: [{ name: '周杰伦' }], dt: 269000 }, 'netease');
  const cover = normalizeTrack({ name: '晴天 (原唱 周杰伦)', ar: [{ name: 'RyaVocal' }], dt: 250000 }, 'netease');
  assert.notEqual(original.trackKey, cover.trackKey);
  assert.equal(isRequestedVersion(cover, { title: '晴天', artists: ['周杰伦'] }), false);
});

test('deduplicates punctuation variants with the same artist and duration', () => {
  const tracks = [
    normalizeTrack({ name: '七里香', artists: '周杰伦', durationMs: 299000 }, 'history'),
    normalizeTrack({ name: '七里香！', ar: [{ name: '周杰伦' }], dt: 300500 }, 'netease')
  ];
  assert.equal(dedupeTracks(tracks).length, 1);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test test/recommendation/identity.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `identity.js`.

- [ ] **Step 3: Implement the canonical identity functions**

```js
export function normalizeTrack(raw, origin) {
  const title = normalizeText(raw.name ?? raw.title);
  const artists = normalizeArtists(raw.ar ?? raw.artists);
  const durationMs = Number(raw.dt ?? raw.durationMs ?? raw.duration) || 0;
  const versionTags = classifyVersion(title);
  return {
    trackKey: buildTrackKey(raw.isrc, title, artists, durationMs, versionTags),
    title: displayTitle(raw.name ?? raw.title),
    artists,
    album: raw.al?.name ?? raw.album?.name ?? raw.album ?? '',
    durationMs,
    isrc: raw.isrc || null,
    versionTags,
    origins: [origin],
    raw
  };
}
```

Implement duration dedupe tolerance as ±3 seconds. Recognize at least `live`, `cover`, `instrumental`, `accompaniment`, `remix`, and `medley`. Prefer ISRC only when both candidates provide it.

- [ ] **Step 4: Run focused and syntax tests**

Run: `node --test test/recommendation/identity.test.mjs && npm run check`

Expected: identity tests PASS and syntax check exits 0.

- [ ] **Step 5: Commit**

```bash
git add lib/recommendation/identity.js test/recommendation/identity.test.mjs
git commit -m "feat: add canonical recommendation track identity"
```

---

### Task 2: Versioned Taste Profile, Feedback, Decay, and Migration

**Files:**
- Create: `lib/recommendation/profile.js`
- Create: `test/recommendation/profile.test.mjs`
- Modify: `lib/habits.js`
- Modify: `test/habits.test.mjs`

**Interfaces:**
- Consumes: `{ type, track, at, position?, duration? }` feedback events and legacy `habits.summary()`.
- Produces: `createTasteProfile({ file, now })` with `load()`, `record(event)`, `snapshot()`, `remember(rule)`, `forget(ruleId)`, `clear()`, and `flush()`.

- [ ] **Step 1: Write failing feedback and clear tests**

```js
test('favorite outweighs one accidental short skip', async () => {
  const p = createTasteProfile({ file: null, now: () => NOW });
  await p.record({ type: 'favorite', track: jay, at: NOW });
  await p.record({ type: 'skip-short', track: jay, at: NOW + 1000 });
  assert.ok((await p.snapshot()).tracks[jay.trackKey].affinity > 0);
});

test('clear removes aggregates, rules, and resolver history', async () => {
  const p = createTasteProfile({ file, now: () => NOW });
  await p.remember({ kind: 'artist', value: '周杰伦', weight: 1 });
  await p.clear();
  assert.deepEqual((await p.snapshot()).rules, []);
  assert.equal((await p.snapshot()).version, 2);
});
```

Add a migration test that converts legacy top songs/artists without inventing skips, dislikes, or conversation-derived preferences.

- [ ] **Step 2: Run profile and habits tests and verify RED**

Run: `node --test test/recommendation/profile.test.mjs test/habits.test.mjs`

Expected: FAIL because `createTasteProfile` and explicit feedback exports do not exist.

- [ ] **Step 3: Implement bounded weights and time decay**

Use these initial event weights:

```js
const EVENT_WEIGHTS = {
  favorite: 5,
  searchPlay: 4,
  replay: 4,
  complete80: 2,
  skipShort: -4,
  dislike: -8
};
const HALF_LIFE_DAYS = 45;
```

Clamp a single track/artist affinity to `[-20, 20]`. Treat a switch after 50% playback as neutral. Persist version `2` atomically through a sibling temporary file and rename. With `file: null`, stay entirely in memory.

- [ ] **Step 4: Expose migration-safe aggregate data from habits**

Add a read-only `exportLegacy()` method returning only existing facts:

```js
return {
  songs: Object.values(data.songs).map(({ id, name, artists, album, plays, seconds, completed, lastAt }) =>
    ({ id, name, artists, album, plays, seconds, completed, lastAt })),
  byHour: [...data.byHour]
};
```

Do not change the current `summary()`, `nightCheck()`, or storage format in this step.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/recommendation/profile.test.mjs test/habits.test.mjs`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/recommendation/profile.js lib/habits.js test/recommendation/profile.test.mjs test/habits.test.mjs
git commit -m "feat: add local Moony taste profile"
```

---

### Task 3: Button Context and Failure-Isolated Candidate Retrieval

**Files:**
- Create: `lib/recommendation/context.js`
- Create: `lib/recommendation/retrievers.js`
- Create: `test/recommendation/context.test.mjs`
- Create: `test/recommendation/retrievers.test.mjs`

**Interfaces:**
- Consumes: profile snapshot, current track, recent tracks, queue, time, API client, and optional local library.
- Produces: `buildButtonContext(input)` and `collectCandidates({ context, profile, client, localLibrary, signal })`.

- [ ] **Step 1: Write failing context tests**

```js
test('night is an energy hint, not an automatic sleep request', () => {
  const cx = buildButtonContext({ now: new Date('2026-08-23T23:30:00+08:00'), profile: emptyProfile });
  assert.equal(cx.weights.taste, 0.5);
  assert.equal(cx.weights.context, 0.3);
  assert.equal(cx.weights.exploration, 0.2);
  assert.notEqual(cx.activity, 'sleep');
});
```

- [ ] **Step 2: Write failing retriever isolation test**

```js
test('one rejected source does not discard fulfilled candidates', async () => {
  const result = await collectCandidates({
    context,
    profile,
    retrievers: [async () => { throw new Error('down'); }, async () => [trackA]],
    signal: new AbortController().signal
  });
  assert.deepEqual(result.tracks.map((x) => x.trackKey), [trackA.trackKey]);
  assert.equal(result.failures.length, 1);
});
```

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/recommendation/context.test.mjs test/recommendation/retrievers.test.mjs`

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement context and retriever adapters**

`collectCandidates` must run adapters with `Promise.allSettled`, normalize through Task 1, dedupe, and return both tracks and diagnostic failures. Provide adapters for:

```js
export const createRetrievers = ({ client, localLibrary }) => [
  retrieveLikedNeighbors,
  retrieveCurrentSimilar,
  retrieveArtists,
  retrieveScenePlaylists,
  retrieveLocalLibrary,
  retrieveExploration
];
```

Each adapter receives one `AbortSignal` and enforces its own timeout. It returns candidates only; it never mutates the player.

- [ ] **Step 5: Run tests**

Run: `node --test test/recommendation/context.test.mjs test/recommendation/retrievers.test.mjs`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/recommendation/context.js lib/recommendation/retrievers.js test/recommendation/context.test.mjs test/recommendation/retrievers.test.mjs
git commit -m "feat: add recommendation context and candidate retrieval"
```

---

### Task 4: Optional Local Music Library

**Files:**
- Create: `lib/recommendation/local-library.js`
- Create: `test/recommendation/local-library.test.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `cordis.patch.yml`

**Interfaces:**
- Consumes: allowlisted absolute roots and injected `parseFile` implementation.
- Produces: `createLocalLibrary({ roots, parseFile, fs, now })` with `scan()`, `search(query)`, `candidates()`, `resolve(trackKey)`, and `clear()`.

- [ ] **Step 1: Write failing allowlist and metadata tests**

```js
test('indexes only supported files under configured roots', async () => {
  const lib = createLocalLibrary({ roots: [root], parseFile: fakeTags });
  await lib.scan();
  assert.deepEqual((await lib.search('晴天')).map((x) => x.title), ['晴天']);
  assert.equal(await lib.resolve('../outside.mp3'), null);
});

test('local track identity includes artist and duration tags', async () => {
  const [track] = await lib.candidates();
  assert.deepEqual(track.artists, ['周杰伦']);
  assert.equal(track.durationMs, 269000);
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `node --test test/recommendation/local-library.test.mjs`

Expected: FAIL because module does not exist.

- [ ] **Step 3: Add and install `music-metadata`**

Run: `pnpm add music-metadata`

Expected: `package.json` and `pnpm-lock.yaml` contain the resolved dependency.

- [ ] **Step 4: Implement safe indexing**

Support `.mp3`, `.flac`, `.m4a`, `.aac`, `.ogg`, and `.wav`. Resolve each path with `realpath`, confirm it remains within an allowlisted root, parse only metadata and cover references, and never follow a symlink outside the root. Keep the index in memory and persist only canonical metadata, never file contents.

Add config defaults:

```yml
localMusicPaths: []
recommendationLearning: true
recommendationTargetSize: 15
```

- [ ] **Step 5: Run focused tests and dependency audit**

Run: `node --test test/recommendation/local-library.test.mjs && pnpm audit --prod`

Expected: tests PASS; audit reports no unreviewed high/critical production issue. If the audit finds one, stop and choose a safe fixed version before continuing.

- [ ] **Step 6: Commit**

```bash
git add lib/recommendation/local-library.js test/recommendation/local-library.test.mjs package.json pnpm-lock.yaml cordis.patch.yml
git commit -m "feat: add allowlisted local music library"
```

---

### Task 5: Qualified Source Resolver and Cross-Source Regression Protection

**Files:**
- Create: `lib/recommendation/source-resolver.js`
- Create: `test/recommendation/source-resolver.test.mjs`
- Modify: `lib/source-match.js`
- Modify: `index.js` only to remove duplicated inline resolution after the new resolver is ready.

**Interfaces:**
- Consumes: canonical track, optional explicit requested identity, local library, API client, cross-source matcher, cache, and signal.
- Produces: `createSourceResolver(deps)` with `qualify(track, requested?)`, `resolve(track, requested?)`, `reportFailure(sourceKey)`, and `clear()`.

- [ ] **Step 1: Write failing resolver-order and cover-rejection tests**

```js
test('prefers local, then direct, then exact cross-source', async () => {
  const resolver = createSourceResolver({ local: hit('local'), direct: hit('direct'), cross: hit('cross') });
  assert.equal((await resolver.resolve(jay)).kind, 'local');
});

test('does not use cover duration to validate requested original', async () => {
  const resolver = createSourceResolver({ cross: captureCross });
  await resolver.resolve(coverResult, { title: '晴天', artists: ['周杰伦'] });
  assert.equal(captureCross.lastDurationMs, 0);
});
```

Add a regression test for exact artist token matching so `周杰伦-` and unrelated partial strings do not count as the verified original.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/recommendation/source-resolver.test.mjs`

Expected: FAIL because resolver does not exist.

- [ ] **Step 3: Implement qualification and cache**

```js
return {
  playable: true,
  kind: 'local' | 'direct' | 'cross-source',
  url,
  sourceKey,
  confidence: 0.0,
  expiresAt,
  matchedIdentity
};
```

Require confidence `>= 0.9` for a different catalog item to satisfy an explicit original request. Cache playback URLs only until `expiresAt`; keep source success/failure aggregates separately.

- [ ] **Step 4: Reconcile the existing dirty `index.js` behavior**

Compare the main-worktree diff before editing. Preserve its intended rules in the new resolver: use duration only when normalized title is exact and the requested artist is an exact artist token; otherwise pass duration `0` to cross-source keyword matching. Do not copy the old inline implementation after the new tests cover it.

- [ ] **Step 5: Run resolver, search, and syntax tests**

Run: `node --test test/recommendation/source-resolver.test.mjs test/package-contents.test.mjs && npm run check`

Expected: all tests PASS and syntax check exits 0.

- [ ] **Step 6: Commit**

```bash
git add lib/recommendation/source-resolver.js lib/source-match.js index.js test/recommendation/source-resolver.test.mjs
git commit -m "feat: qualify recommendation playback sources"
```

---

### Task 6: Explainable Ranker and Constrained Queue Planner

**Files:**
- Create: `lib/recommendation/ranker.js`
- Create: `lib/recommendation/queue-planner.js`
- Create: `test/recommendation/ranker.test.mjs`
- Create: `test/recommendation/queue-planner.test.mjs`

**Interfaces:**
- Consumes: qualified candidates, context, profile, current queue, and seeded RNG.
- Produces: `scoreCandidate(candidate, context, profile)`, `rankCandidates(input)`, and `planQueue({ ranked, targetSize, rng, currentTrack, existingQueue })`.

- [ ] **Step 1: Write failing score-direction tests**

```js
test('favorite and completion rank above neutral exploration', () => {
  const liked = scoreCandidate(jay, context, profileWithFavorite);
  const unknown = scoreCandidate(stranger, context, profileWithFavorite);
  assert.ok(liked.total > unknown.total);
  assert.ok(liked.reasons.some((x) => x.code === 'favorite'));
});

test('recent short skips produce a bounded penalty', () => {
  const scored = scoreCandidate(skipped, context, profileWithThreeSkips);
  assert.ok(scored.penalties.skip < 0);
  assert.ok(scored.penalties.skip >= -60);
});
```

- [ ] **Step 2: Write failing queue-constraint tests**

```js
test('keeps current song and avoids adjacent same artists', () => {
  const plan = planQueue({ ranked, targetSize: 15, rng: seeded(7), currentTrack, existingQueue });
  assert.equal(plan.insertAfterTrackKey, currentTrack.trackKey);
  for (let i = 1; i < plan.tracks.length; i++) {
    assert.notEqual(plan.tracks[i - 1].artists[0], plan.tracks[i].artists[0]);
  }
});
```

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/recommendation/ranker.test.mjs test/recommendation/queue-planner.test.mjs`

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement explicit score breakdown**

Return:

```js
{
  total,
  taste: { score, reasons },
  context: { score, reasons },
  exploration: { score, reasons },
  penalties,
  explanationCodes
}
```

Cap positive categories at `50`, `30`, and `20`. Hard-filter unplayable or explicit-dislike candidates before sorting. Use stable seeded tie-breaking.

- [ ] **Step 5: Implement queue constraints**

The planner must enforce: target 15 when available, first three high confidence, maximum two tracks per artist, no adjacent same artist, one version per identity, smooth energy transitions, and shorter honest queues when fewer than ten qualified tracks exist.

- [ ] **Step 6: Run focused tests**

Run: `node --test test/recommendation/ranker.test.mjs test/recommendation/queue-planner.test.mjs`

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/recommendation/ranker.js lib/recommendation/queue-planner.js test/recommendation/ranker.test.mjs test/recommendation/queue-planner.test.mjs
git commit -m "feat: rank and plan Moony recommendations"
```

---

### Task 7: Recommendation Coordinator, Cancellation, and Safe Fallback

**Files:**
- Create: `lib/recommendation/coordinator.js`
- Create: `test/recommendation/coordinator.test.mjs`
- Modify: `lib/player.js`
- Create: `test/player.test.mjs`

**Interfaces:**
- Consumes: context builder, profile, retrievers, resolver, ranker, planner, player, clock, and timeout.
- Produces: `createRecommendationCoordinator(deps)` with `recommend()`, `feedback(event)`, `cancel()`, and `status()`.

- [ ] **Step 1: Write failing orchestration tests**

```js
test('preflights five tracks before inserting after current', async () => {
  const result = await coordinator.recommend();
  assert.equal(result.ok, true);
  assert.equal(result.verifiedBeforeInsert, 5);
  assert.equal(player.current.trackKey, current.trackKey);
  assert.deepEqual(player.afterCurrent.slice(0, 5), result.tracks.slice(0, 5));
});

test('a second request cancels the first without clearing the queue', async () => {
  const first = coordinator.recommend();
  const second = coordinator.recommend();
  assert.equal((await first).cancelled, true);
  assert.equal((await second).ok, true);
  assert.equal(player.cleared, false);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/recommendation/coordinator.test.mjs test/player.test.mjs`

Expected: FAIL because coordinator and insertion API do not exist.

- [ ] **Step 3: Add player insertion semantics**

Implement `player.insertRecommendationAfterCurrent(tracks, sessionId)` and mark queue entries with origin `manual`, `recommendation`, or `existing`. Never reorder the current track or manually added tracks. A later feedback replan may reorder only unplayed entries from the same recommendation session.

- [ ] **Step 4: Implement coordinator with total timeout**

Use one `AbortController` per request. Resolve enough candidates concurrently to get five verified tracks, then plan/insert; continue resolving the remainder in the background while the session remains current. Return plugin-local structured failures instead of throwing past the coordinator boundary.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/recommendation/coordinator.test.mjs test/player.test.mjs`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/recommendation/coordinator.js lib/player.js test/recommendation/coordinator.test.mjs test/player.test.mjs
git commit -m "feat: coordinate safe dynamic recommendations"
```

---

### Task 8: DSH Button Integration and Conversational Tool Boundary

**Files:**
- Modify: `index.js`
- Modify: `client.js`
- Create: `test/recommendation/integration.test.mjs`
- Modify: `test/client-slots-injection.test.mjs`
- Modify: `test/e2e.mjs`

**Interfaces:**
- Consumes: coordinator and taste profile from Tasks 2–7.
- Produces: direct `/dsh-alger/recommend`, atomic `alger_preference`, revised tool descriptions, and duplicate-click-safe client behavior.

- [ ] **Step 1: Write failing direct-button integration test**

```js
test('recommend route invokes coordinator directly and never an LLM adapter', async () => {
  const response = await routes.post('/dsh-alger/recommend', {});
  assert.equal(response.ok, true);
  assert.equal(fakeLlm.calls, 0);
  assert.equal(response.insertMode, 'after-current');
});
```

- [ ] **Step 2: Write failing conversation-boundary tests**

```js
test('tool descriptions do not instruct automatic search for emotions', () => {
  const tools = registeredTools();
  assert.match(tools.alger_recommend.description, /明确要求.*立即推荐|直接播放/);
  assert.doesNotMatch(tools.alger_recommend.description, /情绪.*自动|每次.*调用/);
});

test('long-term preference write requires explicit remember action', async () => {
  await assert.rejects(() => tools.alger_preference.execute({ action: 'remember' }), /value/);
});
```

- [ ] **Step 3: Run integration tests and verify RED**

Run: `node --test test/recommendation/integration.test.mjs test/client-slots-injection.test.mjs`

Expected: FAIL because coordinator integration and preference tool do not exist.

- [ ] **Step 4: Construct modules in `apply()` and replace old recommendation action**

Instantiate profile, local library, resolver, retrievers, ranker/planner, and coordinator behind individual `try/catch` boundaries. Replace the old random-playlist body; do not retain a fallback that replaces the queue with a random whole playlist.

Add atomic preference operations:

```js
{
  action: 'summary' | 'remember' | 'forget' | 'clear',
  kind?: 'artist' | 'track' | 'language' | 'style' | 'energy',
  value?: string,
  weight?: number
}
```

`remember` requires explicit `kind` and `value`. Tool copy must say it is only for an explicit long-term instruction such as “以后” or “记住”.

- [ ] **Step 5: Keep the button fast and duplicate-safe**

The existing `onRecommend` continues to call `/dsh-alger/recommend` directly. Disable the button while active, attach a request identifier, ignore stale responses, and show only a short Moony notice on success. On failure, preserve the current queue and show the returned honest guidance.

- [ ] **Step 6: Record feedback from existing player events**

Map favorite, explicit search/play, replay, >=80% completion, <20-second skip, and explicit dislike to Task 2 events. Do not treat a switch after 50% as negative. Do not send DSH conversation text into the profile.

- [ ] **Step 7: Run unit and E2E tests**

Run: `npm test && node test/e2e.mjs`

Expected: all unit tests PASS; E2E reports successful load, button recommendation, preserved current track, and no unhandled rejection.

- [ ] **Step 8: Commit**

```bash
git add index.js client.js test/recommendation/integration.test.mjs test/client-slots-injection.test.mjs test/e2e.mjs
git commit -m "feat: integrate fast recommendations and conversational tools"
```

---

### Task 9: Documentation, Privacy Controls, and Package Verification

**Files:**
- Modify: `README.md`
- Modify: `FEATURES.md`
- Modify: `test/package-contents.test.mjs`

**Interfaces:**
- Consumes: final config, routes, and tools.
- Produces: user-facing explanation of two mechanisms, local library configuration, data controls, and troubleshooting.

- [ ] **Step 1: Write failing package/documentation assertions**

```js
test('package ships all recommendation modules', () => {
  for (const file of ['identity.js', 'profile.js', 'coordinator.js']) {
    assert.ok(existsSync(join(root, 'lib/recommendation', file)));
  }
});
```

Add assertions that README contains “快速推荐”, “对话情绪价值”, the `~/.dsh/` data boundary, and the clear/disable instructions.

- [ ] **Step 2: Run package test and verify RED**

Run: `node --test test/package-contents.test.mjs`

Expected: FAIL because documentation text and/or package assertions are not yet complete.

- [ ] **Step 3: Update README and FEATURES**

Document:

- button = immediate local recommendation;
- DSH conversation = natural LLM-led interaction;
- `localMusicPaths`, `recommendationLearning`, and `recommendationTargetSize`;
- what is stored locally and how to inspect/clear it;
- missing-original behavior and honest alternatives;
- no automatic reading of DSH conversations.

- [ ] **Step 4: Run full static and package checks**

Run: `npm run check && npm test && npm pack --dry-run`

Expected: syntax exits 0, all tests PASS, and dry-run includes every `lib/recommendation/*.js` file plus docs required by `package.json`.

- [ ] **Step 5: Commit**

```bash
git add README.md FEATURES.md test/package-contents.test.mjs package.json
git commit -m "docs: explain Moony recommendation mechanisms"
```

---

### Task 10: Isolated Runtime and Browser Acceptance

**Files:**
- Modify only if acceptance exposes a defect: the smallest responsible module and its focused regression test.
- Create: `docs/verification/moony-recommendation-v2.md`

**Interfaces:**
- Consumes: complete feature branch.
- Produces: reproducible verification evidence; no production cutover in this task.

- [ ] **Step 1: Create an isolated DSH profile and install the branch**

Use a temporary `DSH_HOME` and non-production port. Copy credentials only with mode `600`; do not print them. Link the plugin branch into the isolated profile and start DSH with `--no-open`.

- [ ] **Step 2: Run automated verification**

Run:

```bash
npm run check
npm test
node test/e2e.mjs
```

Expected: all commands exit 0 with no failed test.

- [ ] **Step 3: Verify the button path in a browser**

Check:

- page loads with no plugin overlay or console error;
- one click sends exactly one `/dsh-alger/recommend` request;
- current song remains unchanged;
- recommended tracks appear after current;
- success copy is short and no LLM request occurs;
- repeated click while pending does not create a second active session.

- [ ] **Step 4: Verify conversation behavior without forcing tools**

Use a mock LLM/tool-policy fixture, not a paid live prompt, to verify:

- “今天心情特别差” does not automatically call search/recommend;
- “播放周杰伦的晴天” may call search/resolve/play directly;
- unavailable original produces an honest explanation and related alternatives;
- no structured intent JSON is rendered to the user.

- [ ] **Step 5: Verify source and profile failure modes**

Abort one retriever, return malformed data from another, expire a playback URL, and make the model adapter unavailable. Expected: button still produces a shorter valid queue or an honest local failure; current playback and DSH remain alive.

- [ ] **Step 6: Record evidence**

Write exact commands, exit codes, browser checks, port, and remaining limitations to `docs/verification/moony-recommendation-v2.md`. Do not include API keys, credentials, full local paths to private music, or playback URLs.

- [ ] **Step 7: Commit verification evidence**

```bash
git add docs/verification/moony-recommendation-v2.md
git commit -m "test: verify Moony recommendation v2"
```

- [ ] **Step 8: Stop and request production cutover approval**

Do not restart the production 3080 service or merge into a dirty main worktree automatically. Present test evidence, the feature commit range, the preserved main-worktree `index.js` diff, and a rollback path for explicit approval.
