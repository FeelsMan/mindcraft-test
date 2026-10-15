# Mia — a Mindcraft survival fork

A fork of [Mindcraft](https://github.com/mindcraft-bots/mindcraft) focused on making **Mia, a local LLM Minecraft companion, complete small survival tasks reliably**.

The focus is practical: calculate the materials, execute one step, check the actual inventory, and recover when the job is interrupted. This branch includes experimental native **Minecraft Java 26.3** support, managed gathering and crafting, reusable crafting stations, safer cobblestone collection, and local SQLite memory.

[Quick start](#quick-start-with-local-ollama) · [Commands](#try-the-managed-goals) · [Memory](docs/mia-memory.md) · [Current limits](#current-limits) · [Runtime notes](docs/mia.md) · [Crafting and stations](docs/mia-crafting-stations.md)

## What this fork adds

Mia builds on Mindcraft's existing LLM interfaces, Mineflayer skills, profiles, and web UI. The changes here concentrate on how those parts execute and verify tasks.

| Addition | Behavior in this fork |
| --- | --- |
| Native Java 26.3 runtime | Bundled, pinned protocol, data, chunk, physics, and Mineflayer changes connect directly to 26.3. This remains experimental. |
| Managed gathering and crafting | `!gatherGoal` and `!makeGoal` target a **total inventory quantity**, reuse supplies already on hand, and verify pickup/crafting before reporting completion. |
| Combat interruption and recovery | Safety actions take priority. A managed goal retains its target, waits, then replans from the surviving inventory. Background hunting and incidental actions yield during the goal. |
| Reusable crafting stations | Mia remembers a table she placed, returns to craft there, and retrieves it before normal travel beyond **32 blocks**. Pickup is verified. Tables belonging to other players are not claimed or retrieved. |
| Crafting material protection | Routine navigation preserves recipe ingredients instead of spending crafting cobblestone on scaffolding. Wooden prerequisites are obtained before stone. Urgent safety actions can still use blocks when needed. |
| Safer stone collection | Managed cobblestone collection uses reachable, supported side positions. Its approach cannot dig a shaft, build a pillar, or bridge a gap. |
| Bounded unavailable-command retries | Disabled commands are filtered from the model's available tools and rejected at execution. Repeated unavailable requests pause automatic commands with a report. |
| Recovery and evidence checks | Action handoffs and PvP cleanup are coordinated; death recovery records the actual death position. Live inventory and tool results take precedence over old conversation claims. |
| Local retrieval memory | SQLite stores verified outcomes, resource areas, named places, owned stations, and failure cooldowns. Optional loopback Ollama embeddings supplement keyword retrieval within a bounded prompt budget. |
| Persistent managed targets | A configured world ID lets unfinished crafting/collection goals replan after restart or respawn. Explicit cancellation persists; blocked/completed goals do not automatically restart. |

The work changes the agent's runtime and control logic. It uses existing LLMs, including Andy through Ollama; it does not introduce a new trained Andy model.

## Quick start with local Ollama

### Requirements

- **Minecraft Java Edition 26.3**, the experimental target exercised by this branch.
- **Node.js 22.13 or newer** with built-in SQLite (22.23 is a compatible Windows baseline), and Git or a ZIP download.
- [Ollama](https://ollama.com/) running locally for the profile below. Hosted model providers are also available through the existing profiles.
- A Minecraft world/server the bot can join, with its actual address, port, and authentication mode.

The commands below use Windows PowerShell. On Linux/macOS, use `npm` in place of `npm.cmd`.

### 1. Install this fork

```powershell
git clone --branch develop https://github.com/FeelsMan/mindcraft-test.git
cd mindcraft-test
npm.cmd install
```

Alternatively, download the [develop branch ZIP](https://github.com/FeelsMan/mindcraft-test/archive/refs/heads/develop.zip), extract it, and run `npm.cmd install` inside that folder.

The postinstall step verifies the bundled native packages, installs the 26.3 data overlay, and applies the remaining dependency patches. The current branch already includes the Mia changes described here.

### 2. Download the local models

```powershell
ollama pull sweaterdog/andy-4:micro-q8_0
ollama pull embeddinggemma
```

Keep Ollama running. The profile below expects it at `http://127.0.0.1:11434`.

### 3. Configure Mia's profile

For a fresh clone, replace `andy.json` with:

```json
{
  "name": "Mia",
  "model": {
    "api": "ollama",
    "model": "sweaterdog/andy-4:micro-q8_0",
    "url": "http://127.0.0.1:11434"
  },
  "embedding": {
    "api": "ollama",
    "model": "embeddinggemma",
    "url": "http://127.0.0.1:11434"
  },
  "speak_model": "system"
}
```

**The checked-in `andy.json` still selects an OpenAI model.** Changing it is an explicit setup step; the Ollama configuration above needs no OpenAI API key. For an existing installation, preserve your other custom profile fields when changing these model settings.

Other model/provider examples are in [profiles](profiles). Hosted providers require their corresponding credentials through `keys.json` or environment variables; see [keys.example.json](keys.example.json).

### 4. Set the Minecraft connection

Edit the relevant fields in [settings.js](settings.js):

```javascript
"minecraft_version": "26.3",
"host": "127.0.0.1",
"port": 55916,
"auth": "offline",

"allow_insecure_coding": false,
"allow_vision": false,
"render_bot_view": false,
```

These are fields inside the existing settings object, not a replacement for the whole file. Open a world to LAN or start a server, then use the **port actually shown by that world/server**. `55916` is an example, not a required port.

Use `auth: "offline"` only when the server accepts offline profiles. An online-mode server requires `auth: "microsoft"` and a valid Minecraft Java account; match the profile's `name` to that account's Minecraft name. Playing alongside the bot on an online-mode server requires a separate account for it.

The managed goals work with code generation disabled. Enabling `allow_insecure_coding` permits `!newAction` to execute model-generated JavaScript on the machine; it is optional for the workflow described here.

### 5. Start Mia

```powershell
node main.js --profiles .\andy.json
```

Open the Mindcraft dashboard at [http://localhost:8080](http://localhost:8080), unless you changed `mindserver_port`. The explicit `--profiles` argument selects the profile you just configured.

`init_message` is a startup prompt. Use the managed commands below for a specific gathering or crafting task.

## Try the managed goals

Configure local memory once for the current world, with Mia stopped:

```powershell
node scripts/configure-memory.cjs --world-id mia-survival-1 --bot Mia
```

Keep that ID for the same world when its LAN port changes. Configure a different
ID before joining a different world. Memory works independently of the legacy
`load_memory` setting. See [local memory setup and recovery](docs/mia-memory.md).

Send these through Minecraft chat or the dashboard **one at a time**, allowing each goal to finish:

```text
!gatherGoal("oak_log", 4)
!makeGoal("wooden_pickaxe", 1)
!makeGoal("stone_pickaxe", 1)
!makeGoal("stone_axe", 1)
!makeGoal("furnace", 1)
```

Counts mean **the total to keep in inventory**, from 1 to 64. If Mia already has three oak logs, `!gatherGoal("oak_log", 4)` needs one more. A make goal calculates prerequisites from installed recipe data and current inventory, then verifies each result.

| Command | Supported targets |
| --- | --- |
| `!gatherGoal(item, count)` | Log blocks, such as `oak_log` and `spruce_log`. |
| `!makeGoal(item, count)` | `oak_planks`, `stick`, `crafting_table`, `cobblestone`, and `furnace`; wooden and stone axes, pickaxes, shovels, hoes, and swords. The crafting path currently uses oak and cobblestone. |

During a managed goal:

| Command | Effect |
| --- | --- |
| `!inventory` | Check the actual inventory. |
| `!stats` | Check health, hunger, location, and other current stats. |
| `!memory` | Inspect the current world's historical outcomes, locations, and saved goal. |
| `!endGoal` or `!stop` | Cancel the goal, including while it is paused for combat. |

Mia stops after verified completion. Combat and escape can interrupt her, after which she resumes the same target. With a world ID configured, death/restart can restore the target and replan from current inventory. Repeated failures block the goal; two deaths prevent automatic continuation. Use `!resumeGoal` after addressing a blockage. `!stop` and `!endGoal` persist cancellation.

### How the crafting table behaves

Mia leaves her table placed while working nearby and returns to its remembered coordinates for later crafts. Before normal travel beyond 32 blocks, she retrieves that exact table, verifies it is in inventory, and continues. Nearby player tables may be used without being claimed as hers.

To bring her own placed table back into inventory explicitly:

```text
!makeGoal("crafting_table", 1)
```

That retrieves the owned station instead of crafting a duplicate. Configured local memory retains her historical station across restarts, scoped by world and dimension, and checks loaded blocks before use. See [crafting station details](docs/mia-crafting-stations.md).

## Current limits

- **26.3 support is experimental.** The pinned runtime includes compatibility fixes, but all new recipes, item components, and server/mod/plugin combinations have not been validated.
- **Stone needs a safe existing approach.** Move Mia near exposed stone or an accessible cave if collection stops. Autonomous staircase/shaft mining is not implemented.
- **The verified planner currently ends at wooden/stone tools and furnaces.** Smelting/iron progression and a material-counted shelter workflow are future extensions; making a furnace does not automatically start smelting.
- **Cross-session recovery requires the correct world ID.** Only managed crafting/collection targets are checkpointed; a general survival/base-building goal manager is not implemented.
- **Browser rendering and screenshot vision are disabled for protocol 777 in this build.** Use Minecraft's spectator view to watch Mia's perspective.
- **Memory supplies historical evidence.** Resource areas can be depleted, structures can change, and the language model still needs reliable skills and planning. Memory does not train or replace the model.

## Validation

Run the committed regression suite:

```powershell
npm.cmd run test:goals
```

The current gameplay revision has **66 passing regression tests**, covering inventory verification, resource planning, combat handoffs, cancellation, station ownership/recovery, navigation protections, unavailable-command retries, real SQLite persistence/scoping/cooldowns, restart/death goal recovery, bounded retrieval, and actual prompt/command entry points. See [test](test).

Additional local checks used a real Java 26.3 server and the actual Mineflayer skills and safety modes. They exercised stone tools, furnace crafting, real combat interruption/resume, table reuse and retrieval, and uneven terrain with no cobblestone scaffolding or support-block digs. Starting tools and controlled combat effects were supplied to isolate these behaviors. Full autonomous survival remains unverified.

The memory integration check also terminated a bot process after two verified
stone pickups, reopened its SQLite database in a new process, and completed the
furnace with exactly six more cobblestone using the original placed table. It
checked live table removal, world isolation, and cancellation across another
process restart. No LLM was used for that controlled recovery check.

Runtime revisions, package hashes, and data provenance are recorded in [the native runtime manifest](vendor/mia-26.3/manifest.json). See [Mia runtime and recovery notes](docs/mia.md) for more detail.

## Next steps

- [x] Local SQLite memory for verified outcomes, world-specific locations, and repeated-failure cooldowns.
- [ ] General survival goal hierarchy with verified construction and food/base maintenance.
- [ ] Safe staircase mining and more general resource acquisition.
- [ ] Verified smelting and iron progression.
- [ ] Shelter planning with calculated materials and checked placement.

## Project links and credits

- [Mia runtime and recovery notes](docs/mia.md)
- [Crafting, stations, and mining details](docs/mia-crafting-stations.md)
- [Local memory and persistent managed goals](docs/mia-memory.md)
- [General Mindcraft FAQ](FAQ.md) and [MineCollab task instructions](minecollab.md)
- [Upstream Mindcraft](https://github.com/mindcraft-bots/mindcraft) and its [model/configuration reference](https://github.com/mindcraft-bots/mindcraft#configuration)
- [Mineflayer and PrismarineJS](https://github.com/PrismarineJS/mineflayer)

Original Mindcraft work by Kolby Nottingham and the Mindcraft contributors, with the PrismarineJS ecosystem providing the Minecraft client foundation. The existing [MIT license](LICENSE) and third-party notices are retained; native data attribution is in [DATA-NOTICE.md](vendor/mia-26.3/DATA-NOTICE.md).
