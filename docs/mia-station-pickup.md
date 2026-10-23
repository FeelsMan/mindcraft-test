# Crafting-table pickup recovery

Release: `mia-station-pickup-2026-10-23`.

A saved table pickup could remain pending after interruption/restart even when
the placed block was gone. Managed crafting treated that record as a reusable
station, tried to return to it, and stopped after two failed crafting steps.
Current world memory could correctly report the table missing while that old
pickup still blocked execution.

The fix distinguishes a placed station, an unverified pickup and an unrecovered
drop. A pending drop gets one bounded recovery attempt. If recovery fails and
loaded blocks confirm the table is missing/replaced, the pending task is retired
and the crafting planner can use a current table or obtain/put down a new one.
No table is added to inventory or reported recovered by retiring the task.
Its coordinates and failed recovery remain historical evidence.

A still-placed table whose break never happened becomes reusable directly;
crafting does not pack it first. Unloaded data remains unknown. A route failure
to an actually placed or unloaded station retains that station, and combat or
interruptions retain the pending pickup. A fresh failed pickup is retained for
its recovery opportunity. Player replacement blocks are never mined to force
pickup through.

## Install in an existing Mia folder

Stop Mindcraft and save `mia-station-pickup-fix.cjs` beside `main.js`:

```powershell
node .\mia-station-pickup-fix.cjs --check
node .\mia-station-pickup-fix.cjs --apply
node .\mia-station-pickup-fix.cjs --test
node main.js --profiles .\mia-qwen.json
```

Use `node .\mia-station-pickup-fix.cjs --restore` with Mindcraft stopped to
restore the exact previous source bytes. The installer preserves profiles,
settings, credentials, actual saved memory and world configuration. It accepts
the published live world-memory build and earlier supported patch versions,
with known-source checks, backups and rollback. No dependency/model download
or database schema migration is required. Fresh checkouts already contain the
fix and use `npm.cmd run test:goals`.

## Resume the reported test

After restarting Mia, send **`!resumeGoal`**. This retains the original total
target of **3 stone axes**. Repeating `!craftRecipe("stone_axe", 1)` requests
another additional recipe batch and is not necessary for resuming that target.

Expected sequence:

1. Replan from actual inventory; keep the cobblestone already gathered.
2. If the old drop is still pending, attempt its recovery once. A confirmed
   missing table with a failed approach/pickup retires that pickup task, with
   an explicit message that recovery was not verified.
3. Reuse an accessible current table or plan the missing table supplies and
   place a new one. A missing table does not count as a usable placed station.
4. Craft the one outstanding axe, verify **3/3** in inventory, keep it and stop.

`!memory` labels pending pickup receipts and retired pickups separately from
reusable station observations. An unloaded old location can still be unknown
without reviving a pickup that was already retired.

## Regression coverage

The tests reproduce the blocked three-axe goal and old `(16,89,17)` table
coordinate, restore the saved goal after reopening SQLite, and complete it
through the real managed planner, action manager and crafting-station lifecycle.
Movement/placement/inventory packet I/O is controlled. Other tests verify fresh
and recovered pickups, empty drops, actual still-placed tables, combat,
unloaded chunks, wrong dimensions, changed station ownership, historical
retirement persistence and honest model context. These complement the existing
native 1.21.4/26.3 placement, door, navigation and crafting regressions; the live
resume check remains necessary for a particular world.
