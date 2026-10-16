# Supported station placement and verified access

This repair addresses two failures seen while bootstrapping iron goals: choosing
a crafting-table position with no solid support, and reporting that a table
could not be reached even when a usable side position was available.

## Behavior

- Free-space checks require an empty collision space and a full, nonhazardous
  support block. Plants, liquids, unloaded blocks and damaging support blocks
  do not qualify. The support need not be diggable or drop an item.
- New crafting tables and managed furnaces use the same placement routine. It
  considers up to twelve nearby supported candidates within six blocks, checks
  a path to a work position, rechecks support after movement/equipping, and
  places on the actual support's top face. It avoids the player's body and
  restores the prior sneak state after the placement call.
- A work position has supported feet, headroom, interaction range and a visible
  block face. Pathfinder can choose among those positions. Arrival is checked
  against the actual world again; a resolved navigation promise alone is not
  enough. Owned table returns, borrowed table use and managed furnace access
  use this rule, including when a wall obscures the nearest side.
- Station placement has a fifteen-second planning/travel budget; the underlying
  Mineflayer placement acknowledgement can take up to five more seconds. Access
  uses the existing bounded navigation and cancellation cleanup. These routes
  cannot dig, pillar or bridge and allow at most a one-block drop.
- Table placement intent is saved before sending the placement packet, then
  confirmed against the actual block. The optional metadata fits the existing
  SQLite schema. Historical ownership remains scoped to the world/dimension;
  unloaded locations stay unknown and loaded missing stations are forgotten.

Mia still leaves her table nearby, returns to it for later crafts, and packs
that exact table before ordinary travel beyond 32 blocks. Pickup is verified.
Other players' tables can be borrowed without being claimed or retrieved.
Emergency actions retain priority and the managed target resumes from live
inventory afterward. An inaccessible station blocks the goal with its location
retained; the repair does not claim it can reach every terrain arrangement.

## Install

The current GitHub `develop` branch includes the repair. For an existing Mia
installation, apply the smelting update and its command/startup follow-up first,
then stop Mindcraft and run:

```powershell
cd D:\mai\mindcraft
node .\mia-station-access-fix.cjs --apply
node main.js --profiles .\andy.json
```

The standalone installer checks known source before writing and keeps byte-exact
rollback copies. Settings, profiles, credentials, dependencies, saved history,
SQLite data and the configured world ID are preserved. No npm reinstall or
memory reset is needed. Options: `--check`, `--verify`, `--test`, `--restore`.

## In-game test

1. Check `!inventory`. Choose stone tools below that Mia does not already hold,
   or increase a target by one. Have enough cobblestone/sticks available so this
   test isolates the station behavior from resource finding.
2. Request `!makeGoal("stone_shovel", 1)`. Observe her table on solid support,
   the verified tool, and the table left placed.
3. Stand about 12–20 blocks away and send `!goToPlayer("CaptainNeyo", 3)`.
   Request `!makeGoal("stone_axe", 1)`. She should return to the same table,
   use a reachable visible side and finish the tool.
4. Stand beyond 32 blocks from that table, on reachable terrain, and ask her
   to come again. She should retrieve her table before leaving, verify pickup,
   then place it at the next work area when another craft needs it.
5. If a goal is blocked, inspect the reported reason and `!memory` before
   retrying with `!resumeGoal`. `!endGoal` or `!stop` still cancels a goal.

## Validation and scope

The combined suite has **163 passing tests**, including actual upstream block
shapes, raycasting and goal predicates; support changes during placement;
interruption/listener cleanup; ownership and intent persistence; and existing
crafting, smelting, memory and process-recovery regressions.

A controlled native Java 26.3 fixture uses survival mode, supplied materials and
the real command parser, planner, ActionManager, placement, navigation, crafting
and SQLite. It checks supported table placement, ownership after reopening
SQLite, return around a wall after a controlled safety-action preemption,
verified tool output, pickup before a trip beyond 32 blocks, and reuse of the
carried table at the new work area. The shared furnace path is checked with an
iron goal as well. The safety preemption is simulated; this fixture does not
exercise a naturally attacking mob or independent survival planning.

Autonomous staircase/branch excavation remains a separate planned capability.
This repair also does not add natural-language grounding for phrases such as
"iron here". Explicit player/coordinate commands remain available for testing.
