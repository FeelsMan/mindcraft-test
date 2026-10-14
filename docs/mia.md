# Mia: native 26.3 and managed crafting

This fork includes the previously tested experimental native Minecraft Java 26.3 runtime and Mia's managed gathering/crafting commands. It also includes the earlier memory, Ollama embedding and death-recovery changes used by Mia.

## Existing working installation

Use `mia-goal-recovery-fix.cjs` from this update in the existing Mindcraft folder. Stop Mindcraft first, then run:

```powershell
cd D:\mai\mindcraft
node .\mia-goal-recovery-fix.cjs --apply
node main.js
```

The patch updates source files only. It preserves connection settings, profiles, memories and the already installed native 26.3 dependencies. It checks the previous source before editing, retains rollback copies, and supports `--verify` and `--restore`.

The GitHub branch includes the complete native runtime setup. Avoid pulling it over an uncommitted locally patched working copy; the standalone patch is intended for that copy.

## Fresh clone

Use Node.js 22 or newer. Clone this fork's `develop` branch, run `npm install`, configure the actual server address/port and your model profile, then run `node main.js`. The postinstall script verifies the bundled native packages and installs the pinned 26.3 data overlay before applying the remaining Mindcraft patches. The overlay contains the exact dataset files referenced by the tested 26.3 build; the standard npm package supplies older datasets.

Authentication remains controlled by `settings.js`. An online-mode server requires `auth: "microsoft"` and a valid Minecraft Java account. To play alongside the bot, use a separate licensed account for it and match the profile's `name` to its Minecraft name. A private offline-mode server can use `auth: "offline"` and the name Mia.

## What changed

`!makeGoal("wooden_axe", 1)` retains the target quantity and checks actual inventory after every step. Supported targets remain oak planks, sticks, crafting tables and wooden tools. Recipes are planned from oak logs and inventory already on hand.

- Mining, dropped-item pickup and inventory verification run under one action owner. The planner waits for inventory updates and attempts targeted pickup before deciding an item was not obtained. A false skill return does not override verified inventory.
- Self-preservation, fleeing, combat and unstuck actions can preempt a managed goal. The goal waits for them to finish, then replans toward the same target using current inventory. It does not repeat a completed craft just because that action was interrupted.
- Hunting, incidental item collection, torch placement, idle staring and NPC routines yield while a managed goal is active. Action handoffs are serialized, and lower-priority callers cannot interrupt safety actions.
- PvP attack/stop promises are awaited. Concurrent stop requests share one pending cleanup, preventing a late PvP cleanup from clearing a later owner's movement goal.
- Disabled commands are removed from the model's command docs and rejected at execution. Two requests for the same unavailable command, or three unavailable requests in total, pause automatic commands and explain the limitation. Changing arguments or interleaving a valid command does not reset that budget. A new human instruction resets it.

Use `!inventory` and `!stats` during a managed goal. `!endGoal` or `!stop` cancels it, including while it is paused for safety. Death and disconnection cancel the managed goal; there is no automatic continuation across restart. Repeated lack of verified progress stops the goal with a report.

This update keeps code generation disabled when the existing setting disables it. It does not enable `allow_insecure_coding` or add a shelter-building command.

## Validation

Run the committed regression suite with:

```powershell
npm run test:goals
```

The tests cover delayed pickup, a false collection result followed by pickup, recipe resource reservations, completed-craft preservation across combat, inventory changes while paused, exclusive action handoffs, cancellation, death, shared PvP cleanup, capability filtering, and the actual `Agent.handleMessage` retry loop with model transport mocked.

The live integration check used a disposable local offline-mode official Java 26.3 server, the real `initBot`, native packages, collection/crafting skills, modes and PvP plugin. Mia gathered logs, made a table, was preempted by real zombie combat, resumed the same wooden-axe target, made sticks and produced a verified wooden axe without crafting another table. The controlled test supplied combat effects to keep the bot alive while exercising preemption. No external model/API was needed for that integration check.

The runtime remains experimental: new 26.3 recipes and some protocol/item-component codecs are incomplete upstream. Browser and screenshot vision are unavailable on protocol 777 in this build; use Minecraft spectator view. These checks do not establish full autonomous survival or every server/mod/plugin combination.

Pinned upstream revisions and checksums are recorded in `vendor/mia-26.3/manifest.json`. The npm archives retain their upstream sources/licenses, and the data notice is beside the data overlay.
