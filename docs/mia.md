# Mia runtime and recovery notes

This fork combines experimental native Minecraft Java 26.3 support with Mia's managed gathering/crafting, reusable stations, navigation reservations, and safe stone collection. For installation and the local Ollama profile, start with the [README](../README.md). Supported targets and station behavior are described in [crafting and stations](mia-crafting-stations.md).

## Runtime and installation

The `develop` branch contains the complete source and native runtime setup. `npm install` runs `scripts/install-native-minecraft.cjs`, which verifies the bundled archives, installs the pinned data overlay on top of `minecraft-data@3.117.0`, and then applies the remaining dependency patches. The overlay supplies the dataset files referenced by the tested 26.3 build; the standard package supplies older datasets.

The native target uses protocol **777**. Connection address, port, version, and authentication remain controlled by `settings.js`. The README uses Node.js 22.x as the Windows setup baseline and explicitly configures Ollama; the checked-in default `andy.json` still selects OpenAI until edited.

For an existing locally modified installation, preserve `settings.js`, personal profiles, `keys.json`, and `bots/` when updating. The separately supplied Mia installers target particular source revisions, check compatibility before editing, retain rollback copies, and preserve those local files. The current GitHub branch includes their gameplay changes; a fresh clone uses the normal dependency install.

## Managed execution

`!makeGoal` supports oak planks, sticks, crafting tables, cobblestone, furnaces, wooden/stone tools, raw iron, iron ingots and charcoal. `!gatherGoal` supports log blocks. Targets are total inventory quantities from 1 to 64. See [verified smelting](mia-smelting.md) for fuel calculation, owned furnaces and recovery of queued work.

- Mining, dropped-item pickup, and inventory verification run under one action owner. The planner waits for inventory updates and attempts pickup before deciding an item was not obtained. Verified inventory takes precedence over a false skill return.
- Crafting reserves prerequisites in a virtual inventory, including the table and any required wooden pickaxe. It obtains wooden prerequisites before stone and replans from real inventory after each step.
- During managed crafting, routine navigation and the collection plugin preserve recipe materials against scaffolding use. Urgent self-preservation, combat, and escape retain access to building blocks; the goal replans afterward.
- Cobblestone mining chooses an exposed block and a supported side position with an existing walking route. Its approach cannot dig, build, pillar, or drop more than one block. It never selects the bot's own support block as a mining target. Pickup can enter a cleared block only when a solid floor and headroom remain.
- Managed log/stone gathering searches other supported areas when local collection fails, using historical resource hints only after live rechecks. Exploration attempts survive automatic restart. Managed travel has awaited stall cancellation and supported detours; blocked routes retain the goal and owned station. See [resource and navigation recovery](mia-resource-recovery.md).
- Self-preservation, fleeing, combat, and unstuck actions can preempt a managed goal. The goal waits, retains its target, and replans afterward. A completed craft is not repeated merely because its action was interrupted.
- Hunting, incidental item collection, torch placement, idle staring, and NPC routines yield while the goal is active. Serialized action handoffs prevent two callers from owning the bot at once.
- PvP attack/stop promises are awaited. Concurrent stop requests share a pending cleanup, preventing a late cleanup from clearing a later owner's movement goal.

Use `!inventory`, `!stats`, and `!memory` during a goal. `!endGoal` or `!stop` persists cancellation, including while paused for safety. Repeated lack of verified progress blocks the target. With a stable world ID configured, local memory can replan after death, disconnect, or restart. Two deaths block automatic continuation. See [memory setup and recovery](mia-memory.md).

## Stations and command availability

Mia remembers the exact coordinates of a table placed by her crafting routine. Later crafts return there. Normal movement, mining, and player-following beyond 32 blocks retrieve that table first and verify pickup. A table borrowed from another player is not marked as owned or retrieved. An interrupted table pickup retains its pending drop state. `!makeGoal("crafting_table", 1)` retrieves her placed station instead of crafting another to meet the inventory target.

Configured memory retains historical ownership per world/dimension across restart and death. Loaded blocks are revalidated before use; a missing table is forgotten. Unloaded chunks remain unknown. Nearby player tables are not adopted.

Disabled commands are filtered from the model's command docs and rejected at execution. Two requests for the same unavailable command, or three unavailable requests in total, pause automatic commands and explain the limitation. Changing arguments or interleaving valid commands does not reset that budget; a new human instruction does.

The managed commands work with `allow_insecure_coding: false`. They do not require `!newAction` or enable generated code execution.

## Validation and provenance

Run the committed regression suite with `npm run test:goals` (`npm.cmd run test:goals` in Windows PowerShell). It covers crafting/navigation/memory, bounded resource recovery, real pathfinder cancellation, collection-plugin listener cleanup, process restart races, socket ownership, and real Node child-process replacement. See [resource recovery](mia-resource-recovery.md) and [restart/cancellation fixes](mia-lifecycle.md).

Additional local integration runs used a disposable official Java 26.3 server, the native packages, real collection/crafting/navigation skills, safety modes, and PvP plugin. They exercised wooden/stone tools, exact furnace ingredients, real zombie combat interruption/resume, station reuse outside the normal 16-block search, retrieval before a 40-block trip, foreign-table preservation, station relocation, and uneven terrain. The final mining run recorded no cobblestone scaffolding placements or stone support-block digs.

Starting equipment and combat effects were supplied to isolate the execution and recovery behaviors. No external model/API was needed for those controlled runs. Full autonomous survival and all server/mod/plugin combinations remain unverified.

A separate memory integration run killed the process after two verified stone
pickups. A new process reopened SQLite, reused the original owned table, and
completed the furnace with exactly six more cobblestone. Live table removal,
world isolation, and cancellation surviving a third process were also checked.

The runtime remains experimental: new 26.3 recipes and some protocol/item-component codecs are incomplete. Browser and screenshot vision are disabled on protocol 777 in this build; Minecraft spectator view provides the smooth in-game perspective.

Pinned upstream revisions and checksums are recorded in [the runtime manifest](../vendor/mia-26.3/manifest.json). Archives retain upstream sources/licenses, and [the data notice](../vendor/mia-26.3/DATA-NOTICE.md) credits the data sources.

## Local memory and next steps

Local SQLite memory now stores verified outcomes, world-specific locations, table/furnace ownership, managed targets, and repeated-failure cooldowns. It supplements the retained JSON history format and can use existing loopback Ollama embeddings. See [the memory guide](mia-memory.md). Safe staircase mining, iron equipment, broader cooking, and a managed shelter/survival workflow remain future work.
