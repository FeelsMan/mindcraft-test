# Crafting decisions and verified reports

Mia uses a fresh carried-inventory snapshot for every conversation-model request,
including profiles that omit the inventory placeholder. The snapshot is appended
after historical messages and explicitly defines absent carried items as zero.
If inventory changes while the model generates a reply, that reply is discarded
and the decision is retried with the new state, with at most three attempts.
Temporary snapshots are not written into persistent memory.

## Total items and recipe batches

Prefer a managed total target:

```text
!makeGoal("stone_axe", 1)
!makeGoal("stick", 4)
```

The target includes items already held. An existing axe satisfies the first
request without collecting or crafting another.

Older `!craftRecipe` calls retain their **additional batch** meaning. For the
supported oak/wooden/stone recipes, the dispatcher converts them into a managed
target before taking an action slot:

| Request | Meaning |
| --- | --- |
| `!makeGoal("stick", 4)` | Keep at least four sticks total. |
| `!craftRecipe("stick", 1)` | Produce one additional recipe batch: four sticks. |
| `!craftRecipe("oak_planks", 1)` | Produce one additional recipe batch: four planks. |

The resulting managed inventory target must be at most 64. A blocked
`!makeGoal` cannot be bypassed through the older command. Recipes outside the
managed planner retain the original one-shot skill.

Crafting receipts distinguish requested batches, executed batches, verified
output item gains and the current item total. A batch count is never presented
as an item count. The live total remains authoritative after movement, transfers
or safety actions consume items.

## Completion feedback

After verified managed completion, the agent records an action receipt and
sends one concise report based on the inventory that is still present.
Completion does not start another model action loop. Replaced goals, newer
instructions, death, shutdown and a missing target suppress obsolete reports.
An already-satisfied target is reported without claiming that another item
was crafted.

The built-in examples use the managed planner for supported crafting tasks.
Custom profiles and existing Ollama models remain usable; no profile,
credentials, settings or saved world memory must be replaced.

## Manual regression sequence

1. Ask: “Check your inventory and make sure you have one stone axe. Keep it
   when finished, then tell me what you actually did.”
2. Repeat the same request. The existing axe should satisfy it.
3. Ask Mia to give you the axe, and confirm receipt in your own inventory.
4. Repeat the crafting request. The new snapshot should show the axe missing,
   and the managed planner should make one replacement from current stock.
5. Check `!inventory`. Keep the full log, including the final verified report.

Automated regression coverage also checks batch quantities, stale model
responses, missing inventory reads, disabled commands, bounded targets and
obsolete completion callbacks. Run `npm run test:goals` on Node 22.13 or newer.

This update improves the observation and control path. Language-model behavior
still needs the manual gameplay sequence above; it does not add an autonomous
survival schedule, mines or shelter building.
