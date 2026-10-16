# Verified smelting and owned furnaces

`!makeGoal` now supports `iron_ingot`, `charcoal`, and `raw_iron` in addition to
the existing wooden/stone tools, tables and furnaces. Targets remain **total
inventory quantities**, including items Mia already holds.

```text
!makeGoal("iron_ingot", 3)
!makeGoal("charcoal", 2)
```

Older model examples can still choose `!smeltItem`. Requests with `raw_iron` or
`oak_log` now route into the same managed planner before acquiring an action
slot. They keep their **additional output quantity**: with two ingots held,
`!smeltItem("raw_iron", 3)` starts a five-ingot total target. The resulting total
must be 1–64; oversized requests are rejected before starting work. Existing
active-goal and disabled-command guards still apply. Other inputs retain the
original one-shot smelting behavior.

## Planning and execution

- An iron goal obtains a stone pickaxe (or reuses copper/better) before mining exposed iron or
  deepslate iron ore. It bootstraps the wooden tool, crafting table and furnace
  as needed, using the existing supported-side mining and bounded search policy.
- Raw iron already held, ore already queued in the owned furnace, and output
  waiting inside it are considered before requesting additional ore. Furnace
  contents are inspected live when starting or restoring a smelting goal.
- Fuel calculations reuse coal, charcoal, or available plank types. Missing
  fuel falls back to crafted oak planks: two planks can smelt three items. Logs
  reserved as charcoal input are not also counted as fuel, and charcoal being
  made is not consumed as newly inserted fuel for its own goal.
- The executor reopens and checks the actual furnace before feeding it. At
  most eight input items are loaded at a time. Each action collects and verifies
  output, closes the window, then the planner recomputes from live inventory.
  A successful API return without an inventory increase is insufficient.
- Existing heat and queued fuel are reused. Initial progress packets arriving
  with window opening are retained, so a missed total-fuel bar cannot make a
  burning furnace look empty. Small fuel/cooking packet skew does not trigger
  an unnecessary extra fuel unit. Window listeners are removed on close.
- Furnace waiting has a deadline and yields to emergency actions. The normal
  unstuck mode treats bounded smelting as intentional waiting. A stopped or
  unproductive furnace blocks the goal with a useful report.

## Ownership and recovery

The managed executor places a furnace from inventory, verifies the block, and
remembers its exact position in the current world/dimension. Placement intent
is saved before placing, then validated against loaded blocks on recovery.
Furnaces are left in place for reuse. A remembered furnace is revalidated;
loaded removal is forgotten, while unloaded chunks remain unknown.

Combat, death, disconnect and restart retain the existing managed target.
Inputs and fuel already transferred remain in the furnace. On resume, the bot
inspects its contents instead of treating transferred ore as missing inventory.
SQLite uses the existing schema and world ID; no reset or migration is needed.

The current [station-access repair](mia-station-access.md) gives managed furnaces
the same supported placement and visible work-position checks as crafting tables.

An arbitrary nearby furnace is not adopted or emptied. Only a remembered owned
furnace or a furnace newly placed by this managed routine is used. If it contains
input/output for another recipe, the goal blocks without clearing those items.
Furnaces placed manually or by the older freeform smelting skill do not acquire
managed ownership automatically. Unreachable owned furnaces retain their record
and block the goal rather than being silently replaced.

`!endGoal` and `!stop` persist cancellation. Already queued server-side furnace
work can continue burning after cancellation; the cancelled goal does not resume.
Failure cooldowns include the latest inspected input, fuel and output, so newly
produced output or cleared conflicting contents can permit a retry immediately.
As with crafting tables, ownership is location-based: replacement by another
player at the same coordinates while Mia is absent cannot be distinguished.

## Install the standalone update

Install the resource-recovery update first. Stop Mindcraft, put the installer in
the project folder and run:

```powershell
cd D:\mai\mindcraft
node .\mia-smelting-update.cjs --apply
node main.js --profiles .\andy.json
```

The installer checks reviewed source hashes, keeps rollback copies and preserves
settings, model profiles, keys, dependencies and all memories/configuration.
No npm reinstall is required. It supports `--check`, `--verify`, `--test` and
`--restore`. The current GitHub branch contains the same source changes.

### Command-routing and startup-restart follow-up

For installations that already applied `mia-smelting-update.cjs`, stop Mindcraft
and apply the follow-up:

```powershell
node .\mia-smelting-command-fix.cjs --apply
node main.js --profiles .\andy.json
```

This makes supported `!smeltItem` requests use managed verification/recovery
instead of the old furnace pickup and forced inventory-refresh restart. It also
fixes dashboard Restart during initialization: unloaded history is preserved,
chat is sent only while connected, and shutdown waits for initialized history
before closing memory and exiting. See [lifecycle](mia-lifecycle.md).
The installer has the same check, backup, verify, test and restore options; it
preserves configuration, profiles, dependencies and saved memory.

## Tests to run in Minecraft

1. For the first test, give Mia **one furnace, three raw iron and one coal**,
   with no iron ingots. Send `!makeGoal("iron_ingot", 3)`. Expect three ingots in
   inventory, one owned furnace left for reuse, and one coal used.
2. Give her oak logs and planks with no charcoal, then request two charcoal.
   Expect the same furnace to be reused and both charcoal verified in inventory.
3. Request a larger ingot target with the additional raw iron/fuel available.
   Restart after the furnace is loaded. She should inspect it, retain the
   target, and finish without gathering replacement ore or making a new furnace.
4. After these pass, try an empty-inventory iron goal near reachable trees,
   exposed stone and exposed iron ore to exercise the complete prerequisite plan.
5. Note the current ingot count, provide two raw iron and fuel, then send
   `!smeltItem("raw_iron", 2)`. Expect two additional ingots, the furnace left
   placed, and no inventory-refresh restart. Repeat for oak-log charcoal if desired.
6. Click dashboard Restart once while initialization is still in progress.
   The replacement should start without an undefined `chat` error, and existing
   memory should remain available.

## Current limits

Only iron ingots and oak-log charcoal are managed smelting outputs in this
revision. Iron equipment, food cooking, blast furnaces/smokers, general mining
staircases and shelter construction remain future work. Exposed ore still needs
a safe existing approach within the bounded search area. An inaccessible furnace,
missing fuel, conflicting contents, a full inventory, or a stalled server can
block a goal. Process recovery remains the fallback for I/O that cannot stop
safely. Memory and these deterministic skills do not retrain the language model.

## Validation

The suite has **163 passing tests**, including supported station placement/access, fuel/input reservation, initial
progress-packet capture, output inventory verification, window/listener cleanup,
smelting preemption, persistent ownership and cooldown invalidation by live
furnace contents.

The follow-up tests exercise the real command parser, managed planner and action
manager with game I/O replaced. They verify additional-count conversion, active
goal/disabled-command guards, no nested action ownership, the 64-output bound,
and fallback for other recipes. Actual Agent shutdown tests cover pre-login
restart, preservation of unloaded history, awaited saves, duplicate requests,
and cleanup failures. These are regression tests, separate from the native
Minecraft checks below.

A controlled official Java 26.3 run began with empty inventory and nearby
reachable trees, exposed stone and exposed iron ore. It made the wooden and
stone pickaxes, table and furnace, gathered exactly three raw iron, and verified
three iron ingots using exactly two planks. A controlled safety action interrupted
the first loaded furnace; the same target resumed. The next charcoal goal reused
that owned furnace and verified two charcoal.

The run then loaded three more raw iron and fuel for a six-ingot total target
and exited the process without closing the furnace window or SQLite. A new
process reopened memory, inspected the same furnace and verified six total
ingots without collecting replacement ore or crafting another furnace. Progress
listeners returned to their baseline after window use. These fixtures exercise
execution and recovery without an LLM; they do not establish full autonomous
survival or support for every terrain/server combination.
