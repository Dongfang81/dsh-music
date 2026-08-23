# Moony Recommendation V2 Verification

Date: 2026-08-23

## Automated checks

- `npm run check`: pass
- `npm test`: pass (111 tests, 0 failures)
- `npm pack --dry-run --json --ignore-scripts`: pass; recommendation modules are included in the package

## Isolated DSH acceptance

The feature branch was installed into a temporary `DSH_HOME` and started on loopback-only ports separate from the production profile.

- DSH web: `127.0.0.1:3091`
- bundled music API: `127.0.0.1:30597`
- initial state: music API ready, empty queue, no active track
- UI action: clicked the player `推荐` button once
- result: playback started and a recommendation queue was populated
- browser console: no warnings or errors
- production profile and persisted player state were not read or changed

## Behaviour covered by tests

- UI recommendation calls the local deterministic coordinator directly.
- Request IDs prevent stale recommendation responses from overwriting a newer request.
- Recommendations preserve the current track and manual queue entries.
- Candidate ranking, artist limits, duplicate/version filtering, source preflight, cancellation and timeout degradation are covered.
- Natural-language tool descriptions preserve ordinary conversation and only invoke recommendation/search tools when the user explicitly asks for a concrete music action.
- Long-term preference writes require explicit user intent and a valid value.
- Recommendation/profile/player data follows `DSH_HOME`, keeping isolated profiles separate.

## Known external limitation

The bundled NetEase-compatible API can return only the catalogue and playable sources available to it at request time. If an exact original recording cannot be verified, Moony keeps the existing playback/queue unchanged or reports the shortfall; it does not silently substitute an unrelated cover.
