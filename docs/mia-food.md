# Managed world food and carried reserve

Release: `mia-food-foundation-v1-2026-10-29`.

`!foodGoal(8)` obtains and keeps a **total of eight prepared food items** from
live world sources. Existing suitable carried food counts toward the target.
Raw meat/fish, raw potatoes, unsafe food and planting reservations do not.
The goal finishes after its actual inventory target and harvested-plot
replanting are verified. This is an item count, not a nutrition score.

`!foodReserve(8)` enables a persistent world/dimension-scoped reserve. It uses
the existing agent tick and Main Supervisor to replenish when idle and safe.
`!foodReserve(0)` disables it and cancels its active automatic food task.
`!stop`/`!endGoal` cancel food work and disable the reserve across restart.
Use `!resumeGoal` to explicitly retry a blocked food task after conditions
change. `!supervisor` shows the current goal, survival reason and reserve count.

## Supported sources and production

- Mature wheat, carrots, potatoes and beetroot on observed farmland. Registry
  age states determine maturity on native 1.21.4 and 26.3. Unknown or unripe
  blocks are preserved. Existing supported stances and bounded routes are used.
- Adult unnamed untamed cows, pigs, sheep, chickens and rabbits with observable
  adult metadata, supported land access and a carried weapon/tool. Hunting
  requires the actual entity-death event and expected raw-food inventory gain.
  Removal/despawn and an attempted attack are not kill or pickup receipts.
- Bread from held wheat and a verified crafting-table recipe.
- Cooked beef, porkchop, mutton, chicken, rabbit, cod and salmon; baked potatoes.
  Raw fish can be cooked when carried; underwater fishing is not implemented.
  The existing managed furnace supplies verified fuel, preserves unrelated
  contents, retrieves output and checks resulting inventory. Required tools,
  furnace and fuel can bootstrap through the existing make planner's steps
  without creating a second managed goal.

Harvesting records a planting obligation before digging. Pickup must be
observed. One planting item is reserved; carrot/potato planting supplies do not
count as usable reserve stock. Replanting requires live farmland, free space,
actual seed/item, a young crop block and an exact planting-item decrease.
Interrupted obligations resume at the same scoped position before accepting
an already-satisfied food target. A missing seed or obstructed plot is a clear
blockage; it is not silently marked maintained. Verified replanted patches are
remembered as hints and re-observed on later requests. Farm creation, irrigation,
breeding and forcing crops to grow are outside this first version.

## Coordination, recovery and limits

All actions retain the existing single physical owner. Food gathering runs as
`action:foodGoal`; it pauses for safety and replans from actual blocks and
inventory. While Survival owns recovery, a bounded food subtask can execute
inside that same owned action, preserving the original managed target and its
checkpoint. It starts only with fresh observations, no recent damage or hostile
within 24 blocks, and health at least 10. New danger cancels and settles the
food action. Existing emergency reactions retain priority. Survival completes
any food-subtask planting obligation before returning to the interrupted task.

Food tasks retain a five-minute work deadline and a 256-step limit through
automatic restart. Search charges up to six relocations within 64 blocks of
its original scoped area; each source/action also has finite navigation, combat
and observation limits. Two consecutive unverified steps block the task.
Explicit resume can grant a new bounded attempt while retaining a saved
planting obligation. A blocked automatic reserve waits for changed evidence
and its cooldown; it does not repeatedly restart the same failed task.

Persistent progress and reserve policy use the existing scoped JSON metadata
in SQLite. No schema migration, model change or dependency replacement is
required. Tests use isolated state; existing private configuration and memory
are excluded from the cumulative installer.

## Distribution and live acceptance

Build using `node scripts/build-food-installer.cjs`. The cumulative
`mia-food-foundation-update.cjs` supports `--check`, `--apply`, `--verify`,
`--test`, and exact-byte `--restore`. Stop Mia before applying it and preserve
her current world ID. Existing supported release compatibility and private
JSON/SQLite/sidecar/configuration preservation are covered by installer fixtures.

Live acceptance remains open: begin with no carried food, suitable reachable
mature crops or an adult food animal, and working tool/furnace conditions (or
reachable bootstrap supplies). Request `!foodGoal(4)`. Observe actual source
collection, replanting, cooking where necessary, retained food and released
ownership. Separately test reserve replenishment after food is consumed,
danger during harvest/cooking, a blocked/unloaded source, no planting supplies,
cancellation and restart. A controlled fixture replay is not a live pass.
