# Moony Collections and Queue Removal Verification

Date: 2026-08-24

## Automated checks

- `npm run check`: pass
- `npm test`: pass (122 tests, 0 failures)
- `npm pack --dry-run`: pass; client, server, state model, docs and tests are included
- `git diff --check`: pass

## Isolated DSH acceptance

The feature branch was linked into a temporary `DSH_HOME` and started separately from production.

- DSH web: `127.0.0.1:3091`
- bundled music API: `127.0.0.1:30597`
- production DSH on port 3080 was not restarted or modified
- collection panel rendered inside the 280 px player with the immutable `全部收藏`, directory play and create controls
- queue rows kept their remove buttons at `opacity: 0` and `pointer-events: none` before hover
- hovering a queue row changed its remove button to `opacity: 1` and `pointer-events: auto`
- browser console: no warnings or errors

## Behaviour covered by tests

- Legacy favorites migrate to the immutable virtual `全部收藏` view.
- A favorite can belong to multiple custom collections; deleting a collection leaves global favorites intact.
- Global unfavorite removes all custom collection memberships.
- Heart long press opens organization and suppresses the following one-click toggle.
- Every favorites-list row exposes `收藏到…`; only custom collections can be renamed or deleted.
- Removing a non-current queue item preserves the active song.
- Removing the current item advances to the original next item, falls back to the previous item, and stops when empty.
- Only the latest queue removal can be undone, and restoring it does not interrupt the active song.
