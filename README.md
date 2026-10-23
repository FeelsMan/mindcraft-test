# Mia — a Mindcraft survival fork

A fork of [Mindcraft](https://github.com/mindcraft-bots/mindcraft) focused on making **Mia, a local LLM Minecraft companion, complete small survival tasks reliably**.

The focus is practical: calculate the materials, execute one step, check the actual inventory or world blocks, and recover when the job is interrupted. This branch includes experimental native **Minecraft Java 26.3** support, managed gathering/crafting and starter shelter construction, reusable crafting stations, bounded resource finding, safe navigation recovery, and local SQLite memory.

[Quick start](#quick-start-with-local-ollama) · [Commands](#try-the-managed-goals) · [Memory](docs/mia-memory.md) · [Current limits](#current-limits) · [Runtime notes](docs/mia.md) · [Crafting and stations](docs/mia-crafting-stations.md)

## What this fork adds

Mia builds on Mindcraft's existing LLM interfaces, Mineflayer skills, profiles, and web UI. The changes here concentrate on how those parts execute and verify tasks.

| Addition | Behavior in this fork |
| --- | --- |
| Native Java 26.3 runtime | Bundled, pinned protocol, data, chunk, physics, and Mineflayer changes connect directly to 26.3. This remains experimental. |
| Fresh world state for model decisions | Each request receives carried inventory, exact position/dimension, health/hunger, aim and a bounded nearby workstation/ore scan after historical chat. Inventory/dimension changes discard stale decisions; ordinary movement does not starve generation. Custom profiles receive the same grounding. |
| Managed gathering and crafting | `!gatherGoal` and `!makeGoal` target a **total inventory quantity**, reuse supplies already on hand, and verify pickup/crafting before reporting completion. |
| Verified starter shelter | `!shelterGoal` selects level ground, gathers calculated oak supplies, places a fixed 5×5 shelter and outside access steps, verifies actual blocks, tests the door, and remembers home. Partial builds resume at the same site. See [shelter building](docs/mia-shelter.md). |
| Crafting quantities and final reports | Supported legacy recipe commands route through managed crafting while preserving additional batch counts. Skill receipts distinguish batches, output gains and held totals; verified completion produces one final report without starting another action loop. See [crafting reliability](docs/mia-crafting-reliability.md). |
| Combat interruption and recovery | Safety actions take priority. A managed goal retains its target, waits, then replans from the surviving inventory. Background hunting and incidental actions yield during the goal. |
| Reusable crafting stations | Mia chooses supported placement and a reachable work position with a visible block face, remembers a table she placed, returns to craft there, and retrieves it before normal travel beyond **32 blocks**. Pickup is verified. Tables belonging to other players are not claimed or retrieved. See [station access](docs/mia-station-access.md). |
| Crafting material protection | Routine navigation preserves recipe ingredients instead of spending crafting cobblestone on scaffolding. Wooden prerequisites are obtained before stone. Urgent safety actions can still use blocks when needed. |
| Safer stone collection | Managed cobblestone collection uses reachable, supported side positions. Its approach cannot dig a shaft, build a pillar, or bridge a gap. |
| Resource finding and route recovery | Managed goals recheck remembered resource areas and explore supported waypoints when local collection stalls. Searches and route retries are bounded, checkpointed, and verified against live blocks/inventory. See [resource recovery](docs/mia-resource-recovery.md). |
| Verified iron/charcoal smelting | `!makeGoal` calculates ore/tools/fuel, reuses an owned furnace and its live queued contents, verifies output in inventory, and resumes after interruptions. Older `!smeltItem` requests for raw iron or oak logs also use this planner. See [smelting](docs/mia-smelting.md). |
| Bounded unavailable-command retries | Disabled commands are filtered from the model's available tools and rejected at execution. Repeated unavailable requests pause automatic commands with a report. |
| Recovery and evidence checks | Action handoffs and PvP cleanup are coordinated; death recovery records the actual death position. Live inventory and tool results take precedence over old conversation claims. |
| Local retrieval memory | SQLite stores verified outcomes, resource areas, named places, owned stations, and failure cooldowns. Optional loopback Ollama embeddings supplement keyword retrieval within a bounded prompt budget. |
| Live world-to-memory synchronization | Received block/chunk updates refresh remembered stations, exact observed resource blocks and the saved shelter. Removed stations invalidate cached contents; changed targets/routes are rechecked; relevant changes discard stale model decisions. History remains separate. See [world memory](docs/mia-world-memory.md). |
| Persistent managed targets | A configured world ID lets unfinished crafting/collection goals replan after restart or respawn. Explicit cancellation persists; blocked/completed goals do not automatically restart. |
| Coordinated process restart and cancellation | Pending dashboard restarts share one replacement, stale sockets cannot clear the new connection, and repeated collection interrupts share one cancellation instead of accumulating listeners. |

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
!makeGoal("iron_ingot", 3)
!makeGoal("charcoal", 2)
!shelterGoal
```

Counts mean **the total to keep in inventory**, from 1 to 64. If Mia already has three oak logs, `!gatherGoal("oak_log", 4)` needs one more. A make goal calculates prerequisites from installed recipe data and current inventory, then verifies each result.

The separate `!shelterGoal` builds a fixed starter shelter in the Overworld. Start near a level, clear **7×7** work area and reachable oak logs. Its 5×5 shell has a 3×3 interior, two-block headroom, roof, door and outside roof-access steps. It needs **58 oak planks and one oak door**; crafting a vanilla door batch takes six more planks and yields three doors. With a usable table, an empty inventory therefore needs **16 oak logs**; making a table adds one log. Existing supplies and verified partial construction reduce that deficit. The existing ground is the floor. See [construction and interruption tests](docs/mia-shelter.md).

Older examples may select `!smeltItem("raw_iron", 3)` or `!smeltItem("oak_log", 2)`.
These now start the same managed iron/charcoal planner, preserving the old command's
**additional quantity**: two held ingots plus a request to smelt three means five
total ingots. The resulting total must be at most 64. Other smelting inputs still
use the original one-shot skill.

Supported oak/wooden/stone `!craftRecipe` requests also use the managed planner.
Their count remains **additional recipe batches**: `!craftRecipe("stick", 1)`
produces four additional sticks. Use `!makeGoal("stick", 4)` to keep four total.
See [inventory grounding, quantities and completion reports](docs/mia-crafting-reliability.md).
Existing Mia folders can use the [current reversible source installer](scripts/mia-live-world-memory-fix.cjs); installation, rollback and live tests are in the [world memory guide](docs/mia-world-memory.md).

| Command | Supported targets |
| --- | --- |
| `!gatherGoal(item, count)` | Log blocks, such as `oak_log` and `spruce_log`. |
| `!makeGoal(item, count)` | `oak_planks`, `oak_door`, `stick`, `crafting_table`, `cobblestone`, `furnace`, `raw_iron`, `iron_ingot`, `charcoal`; wooden and stone axes, pickaxes, shovels, hoes, and swords. The crafting path uses oak/cobblestone and smelting uses an owned furnace. |
| `!shelterGoal` | One fixed oak starter shelter. Reuses its saved site and rechecks already placed blocks. |
| `!resetShelter` | Abandon this world's current shelter site; keep the physical blocks and history. Clears only its matching home waypoint. |

During a managed goal:

| Command | Effect |
| --- | --- |
| `!inventory` | Check the actual inventory. |
| `!stats` | Check health, hunger, location, and other current stats. |
| `!memory` | Inspect this world's historical outcomes, saved goal and current observed station/shelter states. |
| `!endGoal` or `!stop` | Cancel the goal, including while it is paused for combat. |

Mia stops after verified completion. Combat and escape can interrupt her, after which she resumes the same target. With a world ID configured, death/restart can restore the target and replan from current inventory. Repeated failures block the goal; two deaths prevent automatic continuation. Use `!resumeGoal` after addressing a blockage; explicit resume renews the first blocked step's bounded attempt. Automatic recovery still observes cooldowns. Use `!resetShelter` only when abandoning the saved building site. `!stop` and `!endGoal` persist cancellation.

### How the crafting table behaves

Mia leaves her table placed while working nearby and returns to its remembered coordinates for later crafts. Before normal travel beyond 32 blocks, she retrieves that exact table, verifies it is in inventory, and continues. Nearby player tables may be used without being claimed as hers.

To bring her own placed table back into inventory explicitly:

```text
!makeGoal("crafting_table", 1)
```

That retrieves the owned station instead of crafting a duplicate. Configured local memory retains her historical station across restarts, scoped by world and dimension, and checks loaded blocks before use. See [crafting station details](docs/mia-crafting-stations.md).

## Current limits

- **26.3 support is experimental.** The pinned runtime includes compatibility fixes, but all new recipes, item components, and server/mod/plugin combinations have not been validated.
- **Resources need a safe existing approach.** Managed goals search nearby areas with at most eight relocation attempts per resource within 96 blocks of its starting area. They can still block on cliffs, water, dense obstacles, or an unreachable owned table. Autonomous staircase/shaft mining is not implemented.
- **The verified planner supports wooden/stone tools, oak doors, furnaces, raw iron, iron ingots and charcoal.** Iron equipment and food cooking remain future extensions.
- **Shelter building uses one fixed oak blueprint and an existing level floor.** It clears small plants, but does not excavate, flatten hills, fill holes, add lighting/beds, set a respawn point, or design arbitrary buildings. A blocked site is retained for inspection rather than silently relocated.
- **Cross-session recovery requires the correct world ID.** Managed crafting/collection and shelter goals are checkpointed; a general survival/base-building goal manager is not implemented.
- **Browser rendering and screenshot vision are disabled for protocol 777 in this build.** Use Minecraft's spectator view to watch Mia's perspective.
- **Memory supplies historical evidence.** Resource areas can be depleted, structures can change, and the language model still needs reliable skills and planning. Memory does not train or replace the model.

## Validation

Run the committed regression suite:

```powershell
npm.cmd run test:goals
```

The world-awareness update fixes off-center placement stalls and a pathfinder setting that accidentally forbade ordinary one-block steps down. Tests include real upstream descent off a finished roof, rejection of two-block drops, live position/block refresh, manual retry limits and site reset without erasing history.

The regression suite covers crafting/navigation/memory, supported station placement and visible access, verified smelting, legacy command routing, fresh inventory decisions, process restart/cancellation, and installer backup/rollback. Shelter tests use actual block shapes, raycasting, recipes and pathfinding for **1.21.4 and native 26.3**, replacing network/physics execution with controlled I/O. They exercise the complete blueprint, outside roof access, door traversal, calculated materials, combat/death recovery, explicit cancellation and SQLite world scoping. These automated checks do not substitute for live shelter gameplay testing. See [test](test) and [shelter validation](docs/mia-shelter.md).

Additional local checks used a real Java 26.3 server and the actual Mineflayer skills and safety modes. They exercised stone tools, furnace crafting, real combat interruption/resume, table reuse and retrieval, and uneven terrain with no cobblestone scaffolding or support-block digs. Starting tools and controlled combat effects were supplied to isolate these behaviors. Full autonomous survival remains unverified.

The resource-recovery fixture started empty-handed, found wood and stone beyond
the initial local search, and completed a furnace without human relocation or
manual resumes. It rechecked stale collection-area hints, packed and reused one
owned table, and stopped on a deliberately sealed table without restarting the
process or losing recipe ingredients. See [test conditions and limits](docs/mia-resource-recovery.md).

A separate empty-inventory 26.3 smelting run verified three iron ingots using
exactly two planks, reused the furnace for charcoal, and recovered a loaded
furnace across process exit/restart to reach six total ingots without obtaining
duplicate ore. See [smelting validation and limits](docs/mia-smelting.md).

The memory integration check also terminated a bot process after two verified
stone pickups, reopened its SQLite database in a new process, and completed the
furnace with exactly six more cobblestone using the original placed table. It
checked live table removal, world isolation, and cancellation across another
process restart. No LLM was used for that controlled recovery check.

Runtime revisions, package hashes, and data provenance are recorded in [the native runtime manifest](vendor/mia-26.3/manifest.json). See [Mia runtime and recovery notes](docs/mia.md) for more detail.

## Next steps

- [x] Local SQLite memory for verified outcomes, world-specific locations, and repeated-failure cooldowns.
- [x] Bounded resource relocation and non-destructive managed navigation recovery.
- [ ] General survival goal hierarchy with verified construction and food/base maintenance.
- [ ] Safe staircase mining and more general resource acquisition.
- [x] Verified iron/charcoal smelting with owned-furnace and queued-input recovery.
- [ ] Iron equipment and broader survival progression.
- [ ] Shelter planning with calculated materials and checked placement.

## Project links and credits

- [Mia runtime and recovery notes](docs/mia.md)
- [Crafting, stations, and mining details](docs/mia-crafting-stations.md)
- [Local memory and persistent managed goals](docs/mia-memory.md)
- [Restart and collection cancellation fixes](docs/mia-lifecycle.md)
- [General Mindcraft FAQ](FAQ.md) and [MineCollab task instructions](minecollab.md)
- [Upstream Mindcraft](https://github.com/mindcraft-bots/mindcraft) and its [model/configuration reference](https://github.com/mindcraft-bots/mindcraft#configuration)
- [Mineflayer and PrismarineJS](https://github.com/PrismarineJS/mineflayer)

Original Mindcraft work by Kolby Nottingham and the Mindcraft contributors, with the PrismarineJS ecosystem providing the Minecraft client foundation. The existing [MIT license](LICENSE) and third-party notices are retained; native data attribution is in [DATA-NOTICE.md](vendor/mia-26.3/DATA-NOTICE.md).
