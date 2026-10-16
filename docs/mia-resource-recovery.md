# Resource finding and navigation recovery

Managed `!makeGoal` and `!gatherGoal` now relocate when reachable local wood or
stone is unavailable. This addresses the furnace test that made its wooden
pickaxe correctly but repeatedly stopped at the cobblestone step until a human
moved Mia and sent `!resumeGoal`.

## Behavior

- Check loaded blocks for harvestable logs or exposed stone with a supported
  standing position. Try multiple blocks and sides instead of repeatedly
  selecting one inaccessible block.
- If local collection cannot proceed, check nearby historical collection areas
  from the current world and dimension, then supported exploration waypoints.
  Recheck live blocks after moving; remembered coordinates are only hints.
- Each resource has at most **eight relocation attempts** within **96 blocks**
  of its initial gathering area. Each collection call also has a time budget.
  Visited areas and charged attempts are part of the saved goal, so combat and
  automatic restart cannot reset the search budget indefinitely.
- Mining and ordinary managed travel cannot dig a route, place scaffolding,
  pillar upward, parkour across gaps, or drop more than one block. Recipe
  ingredients are retained. Urgent combat/escape retains its existing safety
  priority and emergency building policy.
- Navigation proves arrival against the actual position. Stalled paths are
  cancelled with `setGoal(null)`, awaited to completion, and can try supported
  detours. Completion listeners and monitoring timers are released before the
  action returns. The general unstuck mode yields during these bounded routes.
- A managed unstuck attempt uses bounded safe movement. If all such routes
  fail, the goal becomes blocked with progress retained instead of deliberately
  killing the process. Existing process recovery remains a fallback for an
  unrelated action that cannot stop safely.
- The existing owned-table policy applies throughout resource searches:
  retrieve and verify pickup before ordinary travel beyond 32 blocks, reuse
  the same table, and preserve other players' tables. If the owned table is
  unreachable, stop with its location retained rather than abandon it.

Travel does **not** count as gathering progress. Inventory must increase before
the planner advances. Targets remain total inventory amounts, including supplies
already held. A completed craft is not repeated after an interruption.

A recent failure cooldown skips mining the same failing area and permits a
bounded search elsewhere. `!resumeGoal` explicitly renews exploration attempts
for the saved target; cancellation and completed targets remain final. A new
automatic restart retains the old attempt count. No database migration or
memory reset is needed.

## Install on an existing Mia installation

Requires the native 26.3, crafting station/tools, safe-mining, local-memory, and
coordinated lifecycle updates. Stop Mindcraft, place the installer in its folder,
and run:

```powershell
node .\mia-resource-recovery.cjs --apply
node main.js --profiles .\andy.json
```

The installer checks known source hashes before changing anything and saves
byte-exact rollback copies. It preserves settings, profiles, keys, dependencies,
SQLite files, JSON history, and the configured world ID. No npm reinstall is
required. It also supports `--check`, `--verify`, `--test`, and `--restore`.

## Acceptance test

Use a test world with ordinary walkable terrain, reachable trees, and some
exposed stone in the wider surrounding area. Empty Mia's inventory and send:

```text
!makeGoal("furnace", 1)
```

Expect her to gather the missing wood, make/reuse a table, craft a wooden
pickaxe, find reachable stone, verify eight cobblestone, and craft the furnace
without `find stone` or repeated `!resumeGoal` instructions. The console prints
`Resource recovery N/8` when relocation is necessary. Check `!inventory` and
`!memory` at the end.

Also test a genuinely inaccessible area: after the bounded attempts, the goal
must show blocked and explain the obstruction. After clearing it, `!resumeGoal`
replans from current supplies. `!endGoal` must prevent continuation, including
after restart.

## Limits

This is bounded local exploration, not unrestricted exploration or staircase
mining. Dense forest, steep cliffs, water, narrow trenches, an inaccessible
owned table, or resources beyond the search bounds can still block a goal.
Logs above supported reach remain for later. Smelting, iron progression,
shelter construction, and general autonomous survival are separate work.

## Validation

The regression suite has **106 passing tests**, including actual pathfinder
completion-listener cleanup on stalls and combat interrupts, continued partial
path searches, stale hints, exploration bounds, scoped resource memory, and
exploration budgets retained across automatic restart.

A controlled official Java 26.3 run started with empty inventory, with wood 74
blocks away and exposed stone another 76 blocks beyond it. Deliberately stale
collection-area hints were seeded to exercise live rechecking. The real skills
completed the furnace, mined exactly eight stone blocks, and crafted one table
that was packed and reused. No LLM, human relocation/resume, cobblestone
scaffolding, or support-block mining was used. A sealed owned-table test blocked
with supplies and station ownership retained and no process restart. These
fixtures isolate execution/recovery; full autonomous survival remains unverified.

A separate empty-inventory log goal had no usable remembered resource area
within its search bounds. It explored a supported waypoint, discovered a tree
outside the initial 64-block scan, and verified the requested log without a
manual movement or resume command.
