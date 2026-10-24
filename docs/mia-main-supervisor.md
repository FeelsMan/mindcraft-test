# Main Supervisor v1

Release: `mia-main-supervisor-v1-2026-10-23`.
Baseline: GitHub develop `7cd350fbb7fd1889cb9c717d25b330ad74c68eba`.

Mia now has one coordinator around her existing managed gathering, crafting,
smelting and shelter controllers. `src/core/mainSupervisor.js` tracks the
foreground goal, specialist, physical action owner and lifecycle reason.
`src/core/worldState.js` supplies fresh, scoped observations; the Minecraft
bridge is `src/adapters/minecraft/supervisor.js`.

The existing Action Manager remains the only physical executor and retains its
priority ordering: self-preservation, retreat, defense, unstuck, managed work,
ordinary commands, then background modes. The supervisor checks a managed
action's goal identity both before and after the previous action stops. Queued
work cannot acquire the body after its goal is cancelled or replaced. Only the
current action can release ownership.

Goals use running, paused, blocked, complete and cancelled states. Existing
planners still calculate materials, select routes, perform actions and verify
steps. After an interruption and the existing calm delay, the supervisor reads
current health, hunger, scope and safety modes; the controller replans from
live inventory and blocks. This observation is not a guarantee that an area is
safe. Urgent reactions continue to use existing modes; autonomous food/shelter
selection belongs to the future Survival Supervisor.

Completion requires both the controller's successful checks and a final live
inventory or shelter check. Explicit cancellation wins over late completion
and invalidates queued memory restores. Startup checkpoints precede the first
asynchronous handoff, so stopping during startup also remains cancelled across
a restart. Concurrent memory resumes share one restore. Blocked goals retain
their target for explicit `!resumeGoal`; they do not retry forever.

`!supervisor` is a read-only query available during managed work. It shows the
active or saved goal, specialist, current action owner, pause/block reason and
fresh health/hunger. `[Mia supervisor]` logs show lifecycle transitions. A small
bounded transition buffer and fresh observations are session data. Existing
SQLite checkpoints remain the durable source; there is no schema migration or
second evolving memory database.

This first version coordinates one foreground goal. It does not introduce a
goal backlog, autonomous project selection, the six new specialized supervisor
modules or personality evolution. It adds no periodic LLM calls or competing
action loop. Existing commands and saved world identities remain in use.

## Installation

Stop Mia. Save `mia-main-supervisor-update.cjs` beside `main.js`, then run:

```powershell
node .\mia-main-supervisor-update.cjs --check
node .\mia-main-supervisor-update.cjs --apply
node .\mia-main-supervisor-update.cjs --verify
node .\mia-main-supervisor-update.cjs --test
node main.js --profiles .\mia-qwen.json
```

The cumulative installer checks known source bytes before writing and backs up
changed files for exact `--restore`. It preserves profiles, settings,
credentials, model configuration and JSON/SQLite memories. No dependency or
model download is required. Its release name is printed on every invocation.
Git checkouts can run the same suite with `npm run test:goals`.

## Verification and live acceptance

Automated tests cover real 1.21.4/26.3 block data and the pinned A* planner with
controlled movement/combat I/O. They test building to defense handoff, changed
supplies and condition checks, continued construction without duplicate
placements, final outcome verification, cancellation during combat/startup,
slow stop races, stale callbacks, scoped restart recovery and single-flight
resume. These are automated replays, not evidence of a new live Minecraft run.

For a live check, inspect `!supervisor`, then use `!resumeGoal` on an unfinished
saved shelter or `!shelterGoal` for the normal starter build. The existing site
and supplies are reused. During an ordinary hostile interruption, query
`!supervisor`: control should pass to defense/retreat and the build should be
paused. After the threat, the same target should resume from actual blocks and
inventory. Check the finished structure and the complete status. Test
`!endGoal` separately and confirm a restart does not revive the cancelled goal.

The next architectural update is `supervisors/survival.js`, using this
coordinator to request useful work from observed needs.
