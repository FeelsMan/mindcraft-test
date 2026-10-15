# Mia crafting stations, stone tools, and furnaces

`!makeGoal("stone_pickaxe", 1)` calculates the missing materials from live inventory, gathers only what is missing, and verifies the finished tool. It can bootstrap a wooden pickaxe before mining stone. Existing pickaxes are reused.

Supported targets are `oak_planks`, `stick`, `crafting_table`, `cobblestone`, `furnace`, and the axe, pickaxe, shovel, hoe, and sword in wooden or stone form. Targets are total inventory counts from 1 to 64. The oak/cobblestone recipe path is intentional; smelting and shelter construction are not added by this update.

Try these goals one at a time:

```text
!makeGoal("stone_pickaxe", 1)
!makeGoal("stone_axe", 1)
!makeGoal("furnace", 1)
```

Crafting leaves a table that Mia placed in the world. She remembers its exact coordinates and returns to it for subsequent crafts, including when it is outside the ordinary 16-block table search. Another player's nearby table can be used, but it is not owned or retrieved.

`!makeGoal("crafting_table", 1)` also retrieves her owned table if it is placed, rather than crafting a duplicate to satisfy the inventory target.

Before normal navigation, mining, or following a player beyond 32 blocks from her owned table, she returns, breaks that exact table, verifies its pickup, then continues. A moving player is checked every half-second while following. A new table placement uses the carried table at the next work site. Nearby activity leaves the table in place, including between separate make goals.

Combat, escape, and unstuck actions take priority over retrieval. Interrupted crafting retains its target and replans from current inventory after safety actions finish. If table recovery is interrupted after digging, the pending pickup is remembered. Failed recovery or a full inventory stops the trip instead of claiming that the table was packed. `!endGoal` and `!stop` cancel a crafting goal.

With [local memory configured](mia-memory.md), historical station ownership is retained per world/dimension across restart and death. Loaded blocks are revalidated before use; nearby player tables are not adopted. Resource collection searches the nearby loaded world; unavailable logs or stone produce a bounded failure report rather than an endless search. Verified resource areas are saved as historical planning hints.

Managed crafting now gathers wooden prerequisites before stone and reserves crafting ingredients against routine pathfinder scaffolding, including the collection plugin's separate movement settings. Dirt may still be used for ordinary navigation. Combat and urgent escape can use reserved blocks when necessary, after which the goal replans from the remaining inventory.

Cobblestone collection for a make goal selects exposed stone with a supported side position and an existing walking route. The approach cannot dig, bridge, pillar, or drop more than one block. It will not mine the block under Mia's feet or dig a vertical shaft. If no safe stone is reachable, move her near an exposed stone wall or an accessible cave; autonomous staircase mining is not implemented by this repair.

## Validation

Run `npm run test:goals` in a repository checkout. The standalone patch also supports `--test` to run all included goal and station tests directly without changing package settings.

The 26.3 integration check uses a disposable flat test world and the real Mineflayer crafting, mining, navigation, and self-defense code. Starting tools/table and controlled survival effects isolate goal execution from unrelated survival failures.
