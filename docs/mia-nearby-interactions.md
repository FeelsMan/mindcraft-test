# Nearby ore and workstation access

This update fixes concrete cases where a nearby block was rejected before Mia
could use it. It changes the game interaction code, without changing the model,
profiles, connection settings or saved world memory.

- Exposed floor ore beside Mia is eligible for mining from a supported side.
  The block under Mia and ore above an unsafe drop remain excluded.
- Overhead ore and workstations use eye-to-face distance and actual raycasting.
  Reachable height differences and standing on a workstation no longer fail a
  fixed height/column filter. Walls and unloaded geometry still block access.
- If Mia already occupies a valid work or mining position, she can act there
  without first planning a return trip to pack a distant crafting table.
- Crafting can use an immediately reachable nearby table before trying to
  recover the remembered owned table. The borrowed table is never adopted or
  collected; ownership of the original table is retained.

Furnace ownership and preservation of furnace contents retain their existing
rules. This update does not automatically claim a player's furnace or permit
tunneling, scaffolding, unsupported standing positions or long drops.

## Install

Stop Mindcraft. Download the current `scripts/mia-crafting-reliability-fix.cjs`
from this repository into your Mindcraft folder and run:

```powershell
node .\mia-crafting-reliability-fix.cjs --check
node .\mia-crafting-reliability-fix.cjs --apply
node .\mia-crafting-reliability-fix.cjs --test
```

The installer accepts known earlier source versions, backs up exact original
bytes and refuses unrecognized edits. `--restore` restores the latest backup.
Profiles, settings, keys and bot memory are outside its update payload.

## Gameplay checks

1. Put Mia on a normal solid floor beside exposed iron ore in the floor. The
   ore must not be the block supporting Mia, and must have a safe block below
   it. Request one additional ingot with `!smeltItem("raw_iron", 1)`.
2. With her remembered furnace nearby, test access from a raised/lowered floor
   or while standing on top of it. Use `!resumeGoal` for a blocked ingot target
   instead of adding another additional-ingot request.
3. Leave her remembered crafting table farther away and put another table in
   clear reach. Request a missing tool or furnace. She should craft at the
   nearby table without packing it or losing the original owned location.

Automated regressions exercise real Prismarine block shapes and raycasts,
actual crafting skill selection, output verification, and installer upgrade
and rollback with profile/memory sentinels. These are not live gameplay tests.
