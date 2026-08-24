# Moony Collections and Queue Remove Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-collection favorite organization and a desktop-only hover-to-remove queue action without changing the one-click heart behavior.

**Architecture:** Extend the existing player state machine as the single source of truth for favorite collections, queue removal, and undo. Expose narrow `/dsh-alger/favorites` and extended `/dsh-alger/queue` actions, then render collection organization and hover-only removal in the existing React client module.

**Tech Stack:** Node.js ESM, built-in `node:test`, DSH web routes, React `createElement` client module, CSS.

**Spec:** `docs/superpowers/specs/2026-08-24-moony-collections-queue-remove.md`

## Global Constraints

- Desktop DSH web only; no touch, swipe, context-menu, or keyboard deletion behavior.
- Heart click remains immediate global favorite/unfavorite with no popup.
- Global unfavorite removes every custom collection membership.
- “全部收藏” is virtual and immutable; songs may belong to multiple custom collections.
- Queue removal never mutates favorites and must offer one short-lived undo action.
- Persisted state remains backward compatible and follows `DSH_HOME`.
- New behavior is written test-first and the production DSH service is not restarted during development.

---

### Task 1: Favorite collection state model

**Files:**
- Modify: `lib/player.js`
- Modify: `test/player.test.mjs`

**Interfaces:**
- Produces: `listFavoriteCollections()`, `createFavoriteCollection(name)`, `renameFavoriteCollection(id, name)`, `deleteFavoriteCollection(id)`, `setFavoriteMemberships(songId, collectionIds)`, `favoriteCollection(id)`, and `playFavoriteCollection(id)`.
- Persistence: `favoriteCollections: Array<{id:string,name:string,songIds:number[]}>`.

- [ ] **Step 1: Write failing migration and collection behavior tests**

Add tests using a temporary state file that assert legacy favorites load into virtual `all`, a song can belong to two custom collections, renaming preserves membership, deleting a collection preserves global favorites, and global unfavorite clears memberships.

- [ ] **Step 2: Run the focused player tests and verify RED**

Run: `node --test test/player.test.mjs`

Expected: FAIL because collection methods and snapshot data do not exist.

- [ ] **Step 3: Implement minimal collection state and persistence**

Normalize names, reject blank/duplicate names, keep IDs stable, filter missing favorite IDs from membership views, and expose a virtual `{id:'all', name:'全部收藏'}` view.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/player.test.mjs`

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/player.js test/player.test.mjs
git commit -m "feat: add Moony favorite collections"
```

### Task 2: Queue single-item removal and undo

**Files:**
- Modify: `lib/player.js`
- Modify: `test/player.test.mjs`

**Interfaces:**
- Produces: `removeQueueAt(index)` returning `{removed, token, currentChanged, current, queueLength}` and `undoQueueRemoval(token)` returning `{restored, current, queueLength}`.

- [ ] **Step 1: Write failing queue transition tests**

Cover removing an item before the current index, after it, the current item with a next item, the last current item with a previous fallback, the sole item, and undo after each representative branch. Assert favorites remain unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/player.test.mjs`

Expected: FAIL because removal methods do not exist.

- [ ] **Step 3: Implement minimal removal state machine**

Store only the latest removal token in memory, preserve the current song by identity when a different row is removed, and clear playback only when the queue becomes empty.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/player.test.mjs`

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/player.js test/player.test.mjs
git commit -m "feat: remove and restore individual queue songs"
```

### Task 3: Server actions and routes

**Files:**
- Modify: `index.js`
- Modify: `test/recommendation/integration.test.mjs`

**Interfaces:**
- Produces: `POST /dsh-alger/favorites` actions `list`, `create`, `rename`, `delete`, `set-memberships`, and `play`.
- Extends: `POST /dsh-alger/queue` with actions `remove` and `undo-remove`.

- [ ] **Step 1: Write failing route/action contract tests**

Use the real player with injected no-network client boundaries. Assert invalid collection names fail honestly, collection play replaces the queue, removing the current row resolves the new current URL, and undo returns a restorable result.

- [ ] **Step 2: Run the integration tests and verify RED**

Run: `node --test test/recommendation/integration.test.mjs`

Expected: FAIL because the favorites route and queue actions are absent.

- [ ] **Step 3: Implement actions and route**

Return compact collection/song JSON, keep `toggle-favorite` as the sole global unfavorite command, and reuse existing `urlFor` when removal changes the current track.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/recommendation/integration.test.mjs`

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add index.js test/recommendation/integration.test.mjs
git commit -m "feat: expose favorite collection and queue removal actions"
```

### Task 4: Collection organizer client UI

**Files:**
- Modify: `client.js`
- Modify: `test/moony-series.test.mjs`

**Interfaces:**
- Consumes: `/dsh-alger/favorites` action contract from Task 3.
- Produces: `FavoriteCollectionPanel`, `FavoriteMembershipPicker`, and desktop long-press heart handling.

- [ ] **Step 1: Write failing real component tests**

Extend the existing VM React harness to render the collection panel and picker. Assert heart `onClick` remains direct, long press opens the picker without also toggling, rows expose “收藏到…”, the virtual all collection has no rename/delete controls, and custom collections can be selected for multi-membership.

- [ ] **Step 2: Run client tests and verify RED**

Run: `node --test test/moony-series.test.mjs`

Expected: FAIL because the organizer components and long-press behavior do not exist.

- [ ] **Step 3: Implement minimal organizer UI**

Keep the existing control row compact. Make the “收藏” button open the organizer, place whole-collection play inside it, use an inline collection-name editor, and use checkbox membership save in the picker.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/moony-series.test.mjs`

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client.js test/moony-series.test.mjs
git commit -m "feat: organize favorites into Moony collections"
```

### Task 5: Hover queue removal and undo UI

**Files:**
- Modify: `client.js`
- Modify: `test/moony-series.test.mjs`

**Interfaces:**
- Consumes: queue `remove` and `undo-remove` actions from Task 3.
- Produces: hover-only `.dsa-qremove` control and clickable undo notice.

- [ ] **Step 1: Write failing interaction tests**

Render a queue with multiple rows and assert each row contains an accessible remove button, the button stops row click propagation and posts the correct index, and a successful response renders an undo action. Assert the CSS keeps the control transparent until row hover/focus.

- [ ] **Step 2: Run client tests and verify RED**

Run: `node --test test/moony-series.test.mjs`

Expected: FAIL because queue remove and undo UI are absent.

- [ ] **Step 3: Implement hover removal and undo**

Render `×` at the row end, use `onClick(event)` with `stopPropagation()`, refresh immediately after success, and let the existing notice timer expire the undo opportunity.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/moony-series.test.mjs`

Run: `npm run check`

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client.js test/moony-series.test.mjs
git commit -m "feat: add hover queue removal with undo"
```

### Task 6: Documentation and isolated acceptance

**Files:**
- Modify: `README.md`
- Modify: `FEATURES.md`
- Create: `docs/verification/moony-collections-queue-remove.md`

**Interfaces:**
- Documents: one-click heart semantics, long-press organization, collection privacy, hover removal, and undo.

- [ ] **Step 1: Update user-facing documentation**

Document the behavior without implying mobile support or automatic genre classification.

- [ ] **Step 2: Run complete verification**

Run: `npm run check`

Run: `TZ=UTC npm test`

Run: `npm_config_cache=/private/tmp/moony-npm-cache npm pack --dry-run --json --ignore-scripts`

Expected: all commands exit 0 and the package includes modified runtime files.

- [ ] **Step 3: Install into an isolated `DSH_HOME` and test in browser**

Start DSH on non-production loopback ports. Verify collection creation/assignment/play, global unfavorite cleanup, hover removal, current-song transition, undo, reload persistence, and zero browser console errors.

- [ ] **Step 4: Record evidence and commit**

```bash
git add README.md FEATURES.md docs/verification/moony-collections-queue-remove.md
git commit -m "docs: verify Moony collections and queue removal"
```

- [ ] **Step 5: Stop before production cutover**

Report the branch, commit range, test evidence, preserved main changes, and rollback path. Do not merge or restart production DSH without explicit user approval.
