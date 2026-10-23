# Mia live world-to-memory synchronization

Release: `mia-live-world-memory-2026-10-23`.

Mia now connects received world changes to her local memory and active decisions.
Verified past experiences remain history. A separate bounded observation cache
tracks what loaded blocks currently establish, so a furnace crafted earlier is
not evidence that its old location is still usable.

This uses the existing Mineflayer connection, Node.js and local SQLite store.
It requires no Paper server, server plugin, extra dependency or different LLM.
Local memory must be enabled. The existing configured world ID and dimension
continue to scope locations and persistent managed goals.

## Install

Stop Mindcraft and put `mia-live-world-memory-fix.cjs` beside `main.js` in
your existing Mindcraft folder:

```powershell
node .\mia-live-world-memory-fix.cjs --check
node .\mia-live-world-memory-fix.cjs --apply
node .\mia-live-world-memory-fix.cjs --test
node main.js --profiles .\mia-qwen.json
```

The source installer backs up changed files and rejects unrecognized local
source edits before writing. It preserves profiles, credentials, settings,
memory configuration, saved goals and actual bot database files.
`node .\mia-live-world-memory-fix.cjs --restore` restores the exact previous
source bytes. No database schema migration is required: observations use
additional metadata and location kinds in the existing schema version 1.
Fresh repository checkouts already include this code and use
`npm.cmd run test:goals` for the complete regression suite.

## Behavior

| Received evidence | Response |
|---|---|
| Owned table or furnace replaced by loaded air/another block | Its current state becomes missing, the old ownership is revoked, and stale manager references/contents are invalidated. The saved goal remains. |
| Station is being placed or its dropped table is awaiting pickup | Keep the pending receipt/placement intent. A block removal alone never proves pickup succeeded. |
| Chunk unloads | Mark affected knowledge unknown; retain historical coordinates and ownership. Loading it again triggers a fresh block check. |
| Observed ore/log/stone target disappears | Invalidate that exact block hint, abandon its approach if still owned by that action, and consider the next live target. One mined block does not prove a whole resource area is depleted. |
| Shelter blocks or door states change | Refresh its block observations and invalidate affected decisions. Retain the blueprint and home coordinate. Structure/door traversal verification still determines completion. |
| A block on the active path changes, including state-only changes | Request a bounded pathfinder replan with the same goal and movement policy. Digging/scaffolding permissions are not broadened. |
| Server forces a move or the dimension changes | Refresh position/scope, invalidate the old decision and stop an obsolete ordinary action so its target can be replanned. Safety modes retain priority. |
| Inventory changes | Refresh the decision from current carried totals. Inventory counts and current position stay ephemeral, rather than becoming durable claims. |

`!memory` now includes current observation states. **Present** means the expected
loaded blocks were found, not that they are reachable or that a shelter is safe.
**Missing/changed** requires contradictory loaded blocks. **Unknown** includes
unloaded data. Nearby player stations can appear in observations without being
adopted, packed or assigned to Mia's owned station managers.

An observed removal followed by another player's replacement at the same
coordinate does not automatically recover ownership. When Mia was offline or
the chunk was unloaded, an identical replacement can be indistinguishable from
the original; block data contains no owner identity.

## Processing and limits

Event handlers update the small in-process cache immediately. SQLite writes
are coalesced over about 250 ms and flushed before orderly close. The observed
resource/station cache is capped at 128 locations, with owned stations and the
shelter retained separately. It does not save every world block, every tick,
ordinary movement or current inventory as experience history.

Each model request receives fresh native position, inventory, aim, nearby
workstations/ores/oak doors and current location states after historical context.
Relevant changes while the model is generating or its log is being saved reject
that stale response, within the existing three-attempt decision limit. Ordinary
movement and unrelated terrain changes do not continually restart generation.
No event handler calls an LLM or embedding model.

These observations cover only received, loaded world data. They cannot observe
remote unloaded changes, guarantee a safe route, infer a closed furnace's new
contents, repair every navigation failure or automatically revive a goal that
was already blocked/cancelled. After addressing a blocked goal, use
`!resumeGoal`; existing retry and exploration limits still apply.

## Live checks

Use disposable test stations or a separate test world/world ID for destructive
checks. Keep the current shelter intact for the first check.

1. Start Mia and send `!memory`. Confirm the correct world/dimension and saved
   sites. A remembered distant unloaded station should be unknown, not missing.
2. Run a normal `!makeGoal("stone_axe", 1)` and confirm it still verifies the
   requested total and keeps the item. This is the baseline regression check.
3. With Mia idle near an **empty owned test furnace**, remove that furnace.
   `!memory` should report its loaded absence. Her next crafting/smelting plan
   should not trust the old furnace or its cached contents. A newly observed
   player furnace remains unowned.
4. Open/close the existing shelter door. Reissue `!shelterGoal` when no other
   managed goal is active: she should verify that same structure/entrance and
   avoid building a duplicate. A blocked shelter goal can use `!resumeGoal`.
5. For a resource test, remove one targeted exposed ore block during approach.
   She should skip that block, recheck the next candidate, and count only actual
   inventory gains. No safe accessible alternative should produce a bounded
   stop with the target retained.
6. Leave and return to a station's chunk, then restart Mindcraft. Unknown data
   should be rechecked on arrival; old coordinates must not override live air.

Automated regressions cover SQLite reopen/cleanup, ownership and pending pickup,
source-block depletion, chunk/dimension changes, queued action ownership,
model-generation/logging races, native 1.21.4/26.3 door geometry and real upstream
mining path searches. Server packets and physical movement I/O are simulated;
the live checks remain necessary for a particular world.
