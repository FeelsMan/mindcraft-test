# Mia local memory

The memory update adds a local SQLite store for verified managed-goal outcomes,
failed attempts, owned crafting tables, resource areas, and named places. It
supports the managed crafting/smelting planners and fixed starter shelter builder.
It stores historical evidence and progress; it does not train a new language model.

## Setup

Use Node.js **22.13 or newer** with built-in `node:sqlite` (the existing Windows
Node 22.23 setup is compatible). No database server, npm package, or additional
model download is needed. Node may print an experimental SQLite warning on
older supported releases.

Stop Mindcraft, then assign a stable ID to the current Minecraft world:

```powershell
node scripts/configure-memory.cjs --world-id mia-survival-1 --bot Mia
node main.js --profiles .\andy.json
```

The incremental `mia-memory-update.cjs` installer accepts the same configuration:

```powershell
node .\mia-memory-update.cjs --apply --world-id mia-survival-1
```

Use the **same ID when reopening the same world**, even if its LAN port changes.
Before joining a different world, stop Mia and run the configuration command
with a different ID. Memory is separated by bot, server hostname, world ID and
dimension. The server does not expose a reliable saved-world identity to the
client, so selecting the correct world ID is required. Without one, memory uses
a unique session scope and cannot restore old coordinates or goals.

`bots/Mia/memory-config.json` defaults to:

```json
{
  "enabled": true,
  "resume_goals": true,
  "embeddings": true,
  "world_id": "mia-survival-1"
}
```

Set `resume_goals` to `false` to require `!resumeGoal` after restarting. Set
`embeddings` to `false` for keyword-only retrieval. Setting `enabled` to `false`
turns off SQLite; session-local places still work. Restart after changing config.
This configuration is separate from the legacy `load_memory` setting: SQLite
recovery works even when loading old conversation history is disabled.

## What gets remembered

| Record | Evidence and behavior |
| --- | --- |
| Gather/craft/recovery result | The existing managed goal verified the inventory increase. A skill returning `true` or an assistant claiming success is insufficient. |
| Completed goal | Live inventory met the requested total. This records a historical achievement, not ownership of those items forever. |
| Resource area | The position where managed collection produced a verified inventory increase. This is a hint for later planning; remaining resources must be observed again. |
| Crafting table | Exact coordinates of a table placed and verified by Mia's crafting routine. Restored tables are checked against loaded blocks before use. Unloaded chunks remain unknown. |
| Named place/death position | Actual observed coordinates, scoped to the current world and dimension. Unscoped legacy JSON places are retained but are not automatically imported. |
| Failed attempt | No verified progress after bounded retries, or an action timeout. The next identical attempt in that area has a two-minute cooldown. Moving to another eight-block resource area, changing inventory, or changing sampled nearby blocks invalidates the old failure fingerprint. Spatial work also uses exact foot-cell coordinates and target-neighbor block states, so a different approach within that area can be retried. |

Outcomes are deduplicated by kind, item, and area. The store retains at most
5,000 experience records after periodic pruning and 500 resource areas; it starts
small and does not require a downloaded knowledge corpus. Raw chats, generated
summaries, and screenshots are not ingested into this database.

## Goals and recovery

- Active `!makeGoal` and `!gatherGoal` targets are checkpointed before actions and
  after verified progress. A restart/reconnect restores the target and computes
  a fresh plan from current inventory; an already fulfilled target completes
  without making more items.
- `!shelterGoal` saves its versioned blueprint and site before construction.
  Recovery reads live world blocks, recalculates the missing supplies, and
  continues at that same site. It never treats inventory loss as proof that a
  wall was placed. After the full shell/door and entrance traversal are verified,
  the interior is saved as the named place `home`. That is a waypoint, not a bed
  or Minecraft respawn point. See [the shelter guide](mia-shelter.md).
- Combat retains the current in-process target as before. Death interrupts the
  action, waits for respawn and action cleanup, then replans. Two deaths during
  the same restored goal block automatic continuation to prevent a death loop.
- A dimension change suspends the goal. It can resume only in its original
  dimension. A different world never restores it.
- `!stop` and `!endGoal` persist cancellation. Completed/cancelled goals are never
  automatically resumed. Repeated failures become blocked goals and require a
  new instruction or `!resumeGoal`. Explicit resume renews one blocked step's bounded attempt; automatic recovery still observes cooldowns. Failed gather areas are still skipped during managed resource exploration.
- `!memory` shows the current scope, saved target/status, and historical locations.
  It is available while a managed goal is active. `!resumeGoal` retries the saved
  unfinished target after you have addressed a blockage.

The [resource recovery update](mia-resource-recovery.md) uses same-world,
same-dimension collection areas as navigation hints and rechecks live blocks.
Its visited areas and bounded exploration attempts are included in the existing
goal checkpoint. Automatic restart retains that budget; explicit `!resumeGoal`
renews it. A gathering cooldown skips the failing local area while allowing a
bounded search elsewhere. These additions keep schema version 1 and preserve
all existing records and world configuration.

[Managed smelting](mia-smelting.md) also remembers an owned furnace and pending
placement in the current world/dimension. Its contents are inspected live on
resume, including ore and fuel already transferred before disconnect. Verified
smelting results are recorded as outcomes; cached contents alone are not proof
of completed output. The SQLite schema version remains 1.

Tables remain remembered across restart/death. On dimension changes, each
dimension retains its own table record. Nearby player tables are not adopted.
A pending dropped-table pickup is discarded after death because its inventory
baseline no longer applies. A table removed by another player is forgotten
when its chunk loads. Replacement of a table at the same coordinates while Mia
is offline cannot be distinguished from the original table.

## Retrieval and failure behavior

Conversation prompts receive at most five historical facts within 1,800
characters. SQLite FTS5 supplies keyword matches. An explicitly configured
Ollama embedding model on loopback can additionally rank results by meaning;
only three missing record embeddings are indexed per retrieval. Embeddings are
cached locally and separated by model identity. The request budget is 700 ms;
unavailable embeddings fall back to keyword results with a 30-second backoff.
Memory text is not sent to a hosted embedding provider.

Live inventory, health, blocks, and tool results always take precedence.
Coordinate-bearing legacy conversation context is not restored across a scope
change. Memory retrieval is evidence for planning, not a source of commands.

If the database cannot be opened or written, Mia reports that memory is
unavailable and continues gameplay without persistent memory. A damaged database
is not overwritten. Its files and config live under the existing ignored
`bots/Mia/` directory: `memory.sqlite`, possible `-wal`/`-shm` companions, and
`memory-config.json`. Back these up with Mia stopped. Git updates and source
rollback leave personal memory data in place.

## Quick test

1. Run `!makeGoal("stone_pickaxe", 1)` near reachable resources.
2. Restart Mindcraft while it is gathering prerequisites. Confirm a
   `[Mia memory] Restored ...` line, and verify she only obtains what is missing.
3. Confirm a placed table is reused after restart instead of being duplicated.
4. Run `!memory` to inspect the saved result.
5. Start another goal, send `!endGoal`, restart, and confirm it stays cancelled.

Use a different world ID for a disposable test world. The regression suite
includes real SQLite reopen/scope/cooldown checks, actual managed-goal recovery,
and the conversation prompt and command entry points. Full unattended survival
remains a separate development milestone.

If a restore succeeds but collection prints `MaxListenersExceededWarning`, see
the [restart and cancellation follow-up](mia-lifecycle.md). It fixes repeated
cancel requests and coordinates parent process replacement without changing
the database or world ID.

## Live state, retries and site corrections

Every conversational model request receives a fresh native world observation
alongside current inventory, including position/dimension, aim and a small nearby
workstation/ore scan. Old memory does not establish where Mia is now or whether
a resource remains. Unknown/unloaded information stays unknown. Movement while
the model is generating is expected; actions recheck routes and block state.

Use `!resumeGoal` after changing the world or clearing an obstacle. It allows one
fresh bounded retry at the first blocked step rather than waiting out an old
cooldown. It does not remove ordinary retry limits or revive cancelled/completed
goals. A failed resumed attempt becomes blocked again.

Use `!resetShelter` to abandon the current shelter site. It cancels an active
shelter build, atomically removes this world/dimension's working site and its
matching `home` waypoint, and prevents restoring that old shelter goal. It leaves
the real blocks, other named places, owned stations and historical experience
records intact. The next `!shelterGoal` chooses a site near Mia's actual position.
For a normal retry that should preserve construction progress, use `!resumeGoal`.
