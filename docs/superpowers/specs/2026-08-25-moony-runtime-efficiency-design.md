# Moony Runtime Efficiency Design

**Date:** 2026-08-25

## Goal

Reduce Moony's idle network, CPU, rendering, and disk overhead while preserving the current product behavior: browser audio remains the playback engine, DSH tools remain authoritative for controls, recommendations continue to append in 30-track batches, and existing user queue and favorites data remain compatible.

## Scope

This change includes:

1. Replace search-based music-service health polling with a lightweight reachability probe and adaptive cache.
2. Replace unconditional two-second playback reporting with playing-only periodic reports plus immediate event reports.
3. Add a timeout to client state requests so one hung request cannot permanently stop polling.
4. Fold night-reminder checks into playback reporting and remove the independent minute timer.
5. Add player, queue, and favorites revisions and make the frequent state response compact.
6. Load queue and favorites rows only when their panels need them.
7. Avoid React state updates for unchanged compact server state.
8. Stop audio-analysis work while auto-match is disabled, audio is paused, or the document is hidden.
9. Replace synchronous player persistence with serialized asynchronous atomic writes.
10. Window long queue and favorites lists so DOM cost is bounded without deleting songs.

This change does not introduce WebSocket/SSE transport, a database, a new worker process, queue deletion policies, or changes to recommendation ranking.

## Architecture

The existing HTTP pull architecture remains. The high-frequency `/dsh-alger/state` route becomes a compact control snapshot. Collection contents move behind explicit collection reads. Revisions connect the two: the compact response tells the client whether queue or favorites data changed, and an open panel reloads only the affected collection.

The client continues to poll adaptively and single-flight. Every state fetch has a finite timeout. A stable compact-state signature prevents unchanged responses from triggering a React render.

Playback facts become event-driven. The browser sends immediately on play, pause, seek completion, song end, media error, and URL/song change. While actively playing it sends a periodic checkpoint every five seconds. It sends nothing periodically while paused. The server performs the night-reminder check after accepting an active playback checkpoint, so the separate minute timer is removed.

## Server State Contract

### Player revisions

`createPlayer` maintains three monotonic in-memory counters:

- `stateRevision`: increments when current song, play/pause, position checkpoint, duration, volume, mode, URL, or readiness materially changes.
- `queueRevision`: increments when queue order or membership changes.
- `favoritesRevision`: increments when favorites membership changes.

Loading persisted state initializes all counters to `1`. Revisions do not need to survive process restart because a restarted client fetches fresh state.

### Compact state

The browser route returns current playback information plus collection metadata:

```json
{
  "stateRevision": 12,
  "queue": { "count": 90, "index": 4, "revision": 8 },
  "favorites": { "count": 26, "revision": 3 },
  "playing": {},
  "playback": {},
  "favorite": true,
  "playMode": 0,
  "volume": 0.8,
  "currentUrl": "...",
  "ready": true,
  "notice": null,
  "agentStatus": "idle",
  "recommendation": {}
}
```

It does not include queue rows or the full favorite-ID array. The DSH model-facing status action may request a full snapshot when it genuinely needs to describe the queue, preserving tool behavior independently from the browser route.

### Collection reads

- `GET /dsh-alger/queue-view` returns `{ok, revision, count, index, items}`.
- Existing `POST /dsh-alger/queue` remains the mutation endpoint.
- Existing `POST /dsh-alger/favorites` remains the favorites read/mutation endpoint and includes `revision` in list responses.

The client caches collection rows. It reloads an open collection when its revision changes. Opening a panel always ensures its current revision has been loaded. Closing a panel retains the cache for fast reopening.

Old browser tabs receiving the compact queue shape fail closed: they simply do not render queue rows until refreshed. No persisted data format is removed.

## Health Probe

`musicApiUp` receives a lightweight reachability implementation that connects to the local API HTTP server without issuing a music search. Any HTTP response from the configured local host and port proves process reachability; response content is irrelevant.

The status action caches a successful probe for 60 seconds and a failed probe for 5 seconds. Concurrent status calls share one in-flight probe. A failed probe never blocks unrelated player data from being returned longer than the probe's one-second timeout.

## Playback Reporting and Night Reminder

A small client-side playback reporter owns checkpoint scheduling. Its behavior is testable without React:

- `playing=true` sends immediately and starts one five-second timer.
- Repeated `playing=true` notifications do not create duplicate timers.
- Each timer checkpoint schedules the next only after the request settles.
- `playing=false` sends immediately and cancels periodic work.
- Explicit events such as seek completion may force an immediate report without changing timer ownership.
- Disposal cancels timers and aborts an in-flight request where supported.

The server records the checkpoint in player state and listening habits. If the checkpoint represents active playback, it runs `habits.nightCheck()` after the habit record completes. A reminder is still limited by the existing two-hour threshold and 24-hour cooldown. The separate `/habits action=night` route can remain for compatibility, but the client no longer polls it.

## Client Polling and Render Suppression

`getState` uses an `AbortController` with a five-second timeout. Timeout is a normal transient polling failure: the poller settles the request, waits according to the current adaptive delay, and retries. Manual refresh requests still coalesce behind the in-flight request.

Before calling `setState`, the client computes a compact signature from the returned scalar fields, revisions, current song identity, notice, agent state, and recommendation metadata. An identical signature preserves the existing React object and produces no render.

Local audio progress continues to come from `<audio>` events, so suppressing unchanged server state does not make the progress bar less smooth.

## Audio Analyzer Lifecycle

The analyzer's media-element source remains single-instance because browsers do not allow recreating it for the same element. Sampling and AudioContext execution are independently controllable:

- Enabling auto-match while visible and playing resumes the context and starts one 800ms sampling timer.
- Disabling auto-match, pausing, ending, or hiding the document stops the sampling timer and suspends the context.
- Resuming playback or returning to a visible document restarts sampling only if auto-match remains enabled.
- Cleanup closes the context when possible and removes all listeners.

The selected Moony does not change merely because analysis is suspended.

## Atomic Player Persistence

Player persistence moves to a focused asynchronous persistence helper using `node:fs/promises`:

1. Coalesce mutations for 300ms.
2. Serialize the current persistable state before starting I/O.
3. Write to a unique temporary file in `dirname(stateFile)` with mode `0600`.
4. Rename the temporary file over the destination atomically.
5. If data changes during a write, retain a dirty revision and schedule one follow-up write.
6. On dispose, flush pending state without blocking DSH shutdown indefinitely.

Failures remain non-fatal to playback and remove their own temporary file when possible. A custom state-file path creates its own parent directory rather than always using `~/.dsh`.

The persisted JSON fields remain `favorites`, `queue`, `index`, `playMode`, `volume`, and `at`, so existing files load unchanged.

## Long-List Rendering

Queue and favorites lists use fixed-height row windowing once they exceed 50 items. The scrolling container renders the visible range plus five overscan rows above and below, with top and bottom spacer heights preserving native scrolling.

Lists of 50 or fewer keep the current simple map path. Windowing does not paginate, delete, reorder, or cap songs. Hover removal, current-row highlighting, click-to-play, and undo behavior remain unchanged. Scroll position is clamped when rows are removed.

## Error Handling

- State timeout: ignore the transient error and retry; never leave the poller in-flight forever.
- Collection reload failure: keep the last successful rows, show the existing lightweight error notice, and retry when reopened or revision changes again.
- Health failure: report `musicApiUp=false` using the short failure TTL; do not suppress player controls.
- Playback report failure: do not stop local audio; the next event or periodic checkpoint retries naturally.
- Persistence failure: keep state in memory and dirty for a later retry; playback remains available.
- Analyzer failure: disable analysis work only; playback and manual Moony selection remain available.

## Testing

Tests must cover:

- adaptive success/failure health TTL and in-flight probe sharing;
- state-fetch timeout releasing the single-flight poller;
- playing-only checkpoint scheduling and immediate pause/seek/end reports;
- night checks triggered by active playback and absent for paused checkpoints;
- exact player revision increments and compact snapshot shape;
- queue/favorites collection reads and revision-based client reload decisions;
- unchanged compact state preserving React state identity;
- analyzer timer/context suspend-resume lifecycle;
- atomic persistence, custom directory creation, concurrent mutation during write, and flush;
- virtual-window boundaries, overscan, row removal, and small-list fallback;
- all existing 168 tests and syntax checks.

## Delivery and Safety

Implementation occurs on a new `codex/` worktree branch. Each subsystem follows red-green-refactor. After the full suite passes, the branch is pushed to the existing GitHub workflow, local `main` is fast-forwarded only if clean, and DSH is updated through `/dsh-restart-guard/restart-safe`. Live verification checks both `/dsh-alger/state` and the served client module revision.
