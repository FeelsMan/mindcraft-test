# Survival Supervisor v1

Survival runs from the existing agent update loop. `src/supervisors/survival.js`
assesses fresh conditions; `src/adapters/minecraft/survival.js` observes and
executes Minecraft recovery. Main Supervisor retains the interrupted managed
goal. All retreat and food actions use ActionManager at priority 95, below the
existing immediate self-preservation priority 100. The independent auto-eat
plugin is disabled so it cannot equip or consume alongside another owner.

## Entry and recovery

Configurable defaults enter recovery at health 12 or less, a hostile within
5 blocks, or a hostile within 24 blocks combined with health 16 or less,
hunger 6 or less, or damage within the last 6 seconds. Recent damage at
health 16 or less, or a potentially lethal recent hit, also enters recovery.
Hunger 14 or less starts verified feeding even without danger.

Recovery holds managed work, defense, hunting, item collection and optional
modes between physical actions. Immediate fire/drowning/suffocation/lethal-hit
responses retain their existing priority. Recovery ends only after no observed
hostile within 16 blocks, no damage in the last 6 seconds, health at least 14,
and acceptable hunger have held for 5 seconds. Entry danger must also have
cleared; a hostile at 20 blocks with health 16 cannot cause repeated handbacks.
While health is below 18,
carried food is used up to full hunger to support healing. Observation gaps
hold the task rather than inventing safety.

Each intervention has a 90-second work budget, at most three retreat actions
and six food actions. Exhaustion leaves a visible blocked recovery reason;
fresh acceptable conditions can still release the task. No food produces a
blocked reason because existing managed gathering does not implement food
acquisition. It does not start optional hunting during danger.

## Verification and ownership

Retreat prefers the current world/dimension's saved shelter only after live
blocks, supported interior and door geometry checks. Navigation uses bounded
safe routes and the existing explicit owned-door controller. Arrival must be
observed, with the entrance sealed. Broken, unloaded and unreachable shelters
are rejected. Alternatives use loaded supported positions with observed solid
cover, or bounded escape increasing distance from actual threats. An escape
position alone is not protective cover for eating near a remaining threat.

Food selection uses the actual current inventory and registry food data;
poisonous, teleporting and otherwise unsuitable foods are excluded. Successful
feeding requires both selected-item count reduction and increased hunger,
with the same scope, live agent and no interruption. An `undefined` consume
result supplies no evidence. Physical promises settle before ownership is
released; watchdogs handle an abnormal hang.

`!supervisor` reports survival status and the pause/block reason. `!stop` and
`!endGoal` invalidate queued survival work and cancel the saved task through
the existing durable checkpoint. Death/scope changes invalidate stale actions;
respawn uses fresh observations. No memory schema or model change is needed.

## Installation and acceptance

Stop Mia before applying runtime changes. The cumulative
`mia-survival-supervisor-update.cjs` supports `--check`, `--apply`, `--verify`,
`--test` and exact-source `--restore`. It preserves private profiles, settings,
world identity, JSON/SQLite memory and SQLite sidecars. Rebuild it with
`node scripts/build-survival-installer.cjs` after changing embedded files.

Automated regressions and controlled native 1.21.4/26.3 replays are separate
from live Minecraft acceptance. The outstanding live scenario remains active
same-site shelter repair → hostile interruption → retreat/recovery → fresh
conditions → automatic repair completion and released ownership. Also check
hungry with carried food, missing food, blocked/broken shelter, dropped loot
during danger, and cancellation surviving restart. Keep the current world and
saved home. No live pass is established by this document.

Local checks on Node 22.23.2: full suite 413/413, Windows interactions 198/198,
Windows memory 61/61, focused Survival 39/39, with no skips in those successful
runs. The full-history suite includes installer upgrades, private-state
preservation and exact rollback. A sandbox temporary-file rename restriction
required unrestricted isolated memory/full-suite reruns.
