# Shelter repair and server corrections

Release: `mia-shelter-repair-2026-10-24`.
Baseline: Main Supervisor v1, `2633247ae8515d35cc08308eefce7728ae29a742`.

A live repair replaced an east wall only after Joe repeatedly operated the
door. The log also showed repeated `world_changed` interruptions during log
collection. Completion with manual assistance is not an independent repair
pass, and this update still needs the same scenario checked in Minecraft.

Placement and plant-clearing now group actual supported work positions by
inside/outside. The door crossing is chosen from those positions, rather than
the nominal wall or roof block. Ordinary pathfinding cannot toggle the owned
door or use it as an implicit shortcut. The crossing controller verifies the
real collision geometry, opens the passage, crosses, and seals it only after
moving clear. A player pressed against a door inside its cell opens it before
trying to reach a standing position across the panel. Player blocks, unknown
door halves, unloaded terrain and unsupported work positions remain blocked.

Mineflayer emits `forcedMove` for local corrections as well as teleports.
The shared correction observer retains the pre-reply position from
`move(oldPosition)`. Corrections of at most one block refresh decision state
without cancelling physical work. Larger or unmeasurable relocations and
dimension changes still invalidate the route. Repeated small corrections do
not reset the existing physical-stall or no-progress deadline. Failed paths
remain bounded and retain the saved target; no teleport is performed.

Stop Mia, place `mia-shelter-repair-update.cjs` beside `main.js`, then run:

```powershell
node .\mia-shelter-repair-update.cjs --check
node .\mia-shelter-repair-update.cjs --apply
node .\mia-shelter-repair-update.cjs --verify
node .\mia-shelter-repair-update.cjs --test
node main.js --profiles .\mia-qwen.json
```

The installer is cumulative and preserves profiles, settings, credentials,
world IDs and saved JSON/SQLite memory. `--restore` restores the previous code.

Regression cases use native 1.21.4/26.3 collision shapes and the pinned A*
planner. They cover an exterior wall with only an interior work position,
repairing all 15 east-wall blocks after collecting supplies, starting at the
reported doorway position, ordinary entrance reuse, every facing/hinge/state,
cancellation, and small corrections followed by a real teleport. Automated
movement uses controlled I/O and is not a substitute for a live gameplay run.

Live acceptance: keep the same site. Remove a few wall blocks, stand clear,
and send `!shelterGoal`. Mia should obtain missing supplies, handle the door
herself, replace only missing cells, verify and seal the entrance, and stop.
No reset or new world is needed. If it blocks, retain the log with her actual
feet, the target coordinate, door state, and any movement corrections.
