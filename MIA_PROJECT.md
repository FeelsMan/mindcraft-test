# M.I.A. — Memory, Identity & Agency

Project owner: Joe
Last updated: 2026-11-05 (America/Phoenix)
Document status: shared project reference and Codex development handoff; implementation and live evidence separated

## Read this first

Canonical repository filenames: `MIA_PROJECT.md` for project context and `AGENTS.md` for concise coding instructions. Place both beside `package.json` and `main.js` in the Mindcraft repository. This reference supersedes older renamed copies such as `MIA_PROJECT-1.md`; preserve the existing project history when updating it.

### Food foundation implementation — November 5, 2026

The requested world-food abilities were implemented and verified in the isolated
`.mia-development/food-v1` checkout, based on `develop` at
`be563759d4b02bf84aac1281e62b760c732a44d3`, then installed into
`D:\mai\mindcraft` while Mia was stopped. Other unfinished furnishing work
and private runtime state were preserved. This delivery uses the existing
Main Supervisor, ActionManager, navigation, crafting and furnace controllers.
There is no new background movement/LLM loop or memory-schema migration.

`!foodGoal(8)` obtains a total prepared-food inventory target. It observes mature
wheat/carrots/potatoes/beetroot, verifies harvesting and pickup, retains and
verifies a same-site planting obligation, or hunts supported adult unnamed
land animals with both death and food-pickup receipts. Bread and eight cooked
food outputs use actual ingredients, tools, stations and fuel. Bootstrap work
executes as steps of the same managed goal. Raw meat/fish, raw potatoes, unsafe
foods and reserved planting supplies do not satisfy the prepared reserve.

`!foodReserve(8)` enables a persisted world/dimension-scoped reserve, assessed
from the existing agent tick when idle and safe. `!foodReserve(0)`, `!stop` and
`!endGoal` disable automatic reserve work. Existing saved user goals are retained.
When Survival has no carried food, bounded provisioning can use that same owned
action while conditions permit, keeping the original foreground target and
planting obligations through checkpoints. New danger interrupts and settles
food work; pending recovery planting prevents premature handback.
Standalone planting obligations also reload after restart when Mia is healthy
and no longer hungry. Survival reuses an interrupted food goal's own pending
plot and seed reservation rather than starting a competing food subtask.

Progress includes a five-minute deadline, a 256-step ceiling, bounded scoped
search and failed-source handling; explicit retry can renew a bounded attempt.
Reserve failures wait for changed evidence and cooldown. No fishing, breeding,
irrigation, new-farm construction or general autonomous project selection is
claimed. See `docs/mia-food.md` for exact commands, source coverage and limits.

Focused checks include controlled native 1.21.4/26.3 empty-food harvest/replant,
hunt-to-cooked-food chains, interruption/restart planting receipts, no-source
blockage, cancellation, scoped reserve policy and furnace receipts. Final
Windows interaction regressions passed **315/315**; SQLite/world-memory checks
passed **61/61**. `npm run test:goals` passed **535/535**, including Food and
Survival builder upgrade/rollback checks. Standalone
`node --test test/crafting-installer.test.cjs` passed **20/20**. All four final
runs had zero failures and zero skips, using Node **22.23.2**. Earlier attempts
with source changing during packaging checks were superseded by these frozen
source runs; no skipped history checks are represented as passes.

The cumulative installer applied **26** changed files, found **51** already
current and verified all **77** payload files. Exact original bytes were backed
up under `mia-goal-backups/crafting-reliability/2026-11-06T04-17-09-634Z-6b6f2e7c`.
Hashes confirmed **101** existing private/runtime-state files unchanged. The
runtime regression command also includes the four Food test files. Dependencies,
native packages, model, world ID and memory schema were retained. Mia remains
stopped; restart with `node main.js --profiles .\mia-qwen.json`.
The installed runtime's `node mia-food-foundation-update.cjs --test` run passed
**514** tests and skipped **19** history-dependent installer checks (zero failed).
The runtime's old Git history cannot establish those upgrade fixtures; the
separate full-history checkout's **535/535** and standalone **20/20** runs above
establish their automated upgrade/rollback evidence.

Published in [PR #5](https://github.com/FeelsMan/mindcraft-test/pull/5),
implementation commit `ac248c0560b31322384b13eb7a5f379e3df90c4d`, merged into
`develop` as `5696e907741b12109e85e57a8aff585848c3a9bd`. All four GitHub jobs
passed in [run 42161819258](https://github.com/FeelsMan/mindcraft-test/actions/runs/42161819258):
Linux full suite **535/535**, installer **20/20**, Windows memory **61/61** and
Windows interactions **315/315**, with zero failures or skips. The workflow
published the `mia-food-foundation-update` installer artifact. This final
publication record is a documentation-only follow-up to the tested code.

No live food-acquisition acceptance is established by these automated scenarios.
Next live check: empty carried food
to verified harvesting/hunting, preparation, same-site replanting and held
reserve; then danger interruption/resumption and cancellation/restart separately.

## Foundation planning and chat organization — October 26, 2026

This documentation update records the foundation checklist, component goals and chat organization developed with Joe. It adds no runtime functionality, new source audit, test run, installation confirmation or live acceptance result. The October 24 implementation history below remains the evidence baseline. Earlier dated snapshots are historical; use the latest recovery correction rather than older statements that Survival v1 is not implemented.

### Foundation versus supervisors

The foundation supplies observation, interaction, memory, verification and recovery. Supervisors coordinate those abilities. A planned specialist supervisor does not mean its underlying ability is missing: existing managed controllers already perform gathering, crafting, smelting and shelter work. Main Supervisor v1 is implemented and observed live coordinating managed goals. Survival Supervisor v1 and its recovery correction are implemented and automatically tested; latest correction installation and full live acceptance remain unconfirmed by this reference. Personality Supervisor, the shared Memory Manager abstraction and the other specialist supervisor modules remain planned.

The immediate planning priority is to identify small abilities individually, establish their evidence and address concrete gaps alongside incremental supervisor development. Do not require a new supervisor or model for every checklist row.

### Ability status definitions

| Status | Meaning |
| --- | --- |
| Dependable | Repeated independent live success within a stated scope, including relevant interruptions. This never implies universal reliability. |
| Conditional | Working implementation or demonstrated cases exist, but limitations or live acceptance remain open. Record automated and live evidence separately. |
| Unverified | This reference does not establish the general ability. Inspect code or test it before declaring it absent. |
| Planned | Explicitly future work; no implemented behavior is established here. |
| Confirmed absent | Relevant source inspection establishes the ability is missing. No row is assigned this status from documentation alone. |

These are initial documentation-based assessments, not a fresh audit of the running agent. No ability is promoted to Dependable merely because automated tests pass. Stable IDs should survive renaming and later chat splits.

### Foundation ability checklist

| ID | Ability / target | Initial assessment and evidence limit |
| --- | --- | --- |
| OBS-01 | Read current health, hunger, position and inventory | Conditional: implemented and visible in live logs. |
| OBS-02 | Detect nearby blocks, resources, stations and threats | Conditional: working examples; resources and stations have previously been overlooked. |
| OBS-03 | Distinguish fresh observations from remembered information | Conditional: fresh observations and scope checks exist; broad coverage remains open. |
| OBS-04 | Notice meaningful environmental changes | Conditional: change handling exists; movement corrections have required fixes. |
| OBS-05 | Identify suitable food sources and crop maturity | Conditional: live scoped discovery, registry crop maturity and supported animal eligibility implemented; automated native 1.21.4/26.3 coverage, live acceptance open. |
| REQ-01 | Execute a clear supported command | Conditional: managed gathering, crafting, smelting and shelter examples exist. |
| REQ-02 | Translate ordinary language into a complete task | Conditional: incomplete follow-through is a known issue. |
| REQ-03 | Clarify meaningful ambiguity before acting | Unverified as a consistent ability. |
| REQ-04 | Know available actions and their prerequisites | Conditional: command/parser feedback exists; general capability awareness remains unestablished. |
| ACT-01 | Move to a nearby target and stop | Conditional: working movement with terrain and access limitations. |
| ACT-02 | Approach and interact within usable reach | Conditional: ore and station fixes have working examples. |
| ACT-03 | Select and equip an appropriate tool or item | Unverified generally; task-specific use exists. |
| ACT-04 | Mine blocks and collect resulting resources | Conditional: verified gathering examples exist. |
| ACT-05 | Craft items and verify output | Conditional: verified live examples exist. |
| ACT-06 | Use a furnace, supply fuel and retrieve output | Conditional: verified live smelting examples exist. |
| ACT-07 | Place blocks and verify a structure | Conditional: starter shelter and repair work in demonstrated cases. |
| ACT-08 | Open, cross and close a doorway | Conditional: fixes implemented; broader live reliability remains open. |
| ACT-09 | Consume carried food and verify consumption | Conditional: implemented and automatically tested; latest live acceptance remains open. |
| ACT-10 | Inspect containers and deposit/retrieve specified items | Unverified in this reference. |
| ACT-11 | Follow, wait near, or give an item to a player | Unverified in this reference; split into separate IDs when individually assessed. |
| ACT-12 | Harvest mature food crops and verify collection | Conditional: bounded mature wheat/carrot/potato/beetroot harvesting with verified pickup implemented and automatically tested; live acceptance open. |
| ACT-13 | Hunt a supported food animal and verify food pickup | Conditional: managed adult unnamed untamed land-animal hunting requires observed death and raw-food inventory gain; automated coverage, live acceptance open. |
| ACT-14 | Cook supported raw food using actual fuel and verify output | Conditional: eight cooked food outputs and bread use managed production with verified supplies/output; automated coverage, live acceptance open. |
| ACT-15 | Plant/replant and maintain a food source | Conditional: same-site scoped planting obligations, verified young crop and seed use implemented, including interruption/restart; new-farm creation remains outside this version. |
| NAV-01 | Recognize movement that makes no useful progress | Conditional: bounded navigation-progress tracking exists. |
| NAV-02 | Recover from a blocked route or stuck position | Conditional: recovery exists; varied terrain remains challenging. |
| NAV-03 | Return to a remembered location and recheck access | Conditional: remembered returns exist; station access has caused failures. |
| NAV-04 | Search for something not currently visible | Conditional: resource search exists; broad systematic discovery remains unfinished. |
| GOAL-01 | Maintain a measurable target | Conditional: managed inventory and shelter targets exist. |
| GOAL-02 | Resolve prerequisites across multiple tasks | Conditional: some production/building chains exist; general planning remains unestablished. |
| GOAL-03 | Identify a need without a user command | Conditional: survival needs are assessed; broader needs remain future work. |
| GOAL-04 | Choose a useful next project independently | Planned: general autonomous project selection. |
| GOAL-05 | Obtain and replenish a carried food reserve | Conditional: managed food target and persisted opt-in reserve implemented through existing coordination, including Survival provisioning; automated coverage, live acceptance open. |
| CTRL-01 | Keep one owner of physical actions | Conditional: implemented and tested; full live interruption acceptance remains open. |
| CTRL-02 | Stop cancelled work and prevent automatic restart | Conditional: automated coverage exists; separate live restart acceptance remains open. |
| CTRL-03 | Pause for danger and resume the same unfinished task | Conditional: automatically tested; full live acceptance remains open. |
| CTRL-04 | Recover after death using actual new conditions | Conditional: death position and empty respawn inventory observed; broader recovery remains open. |
| CHECK-01 | Verify success using inventory or world changes | Conditional: established for managed tasks, not every interaction. |
| CHECK-02 | Stop retrying and identify a specific blocker | Conditional: bounded attempts and blocked reasons exist. |
| CHECK-03 | Choose a useful alternative or request specific help | Unverified as a consistent general ability. |
| MEM-01 | Preserve memories and unfinished goals across sessions | Conditional: SQLite/checkpoints and relevant automated coverage exist. |
| MEM-02 | Keep worlds and locations correctly scoped | Conditional: implemented and tested. |
| MEM-03 | Turn failures into reusable lessons that alter later behavior | Unverified as a general learning system. |
| COM-01 | Accurately report outcomes, uncertainty and remaining work | Conditional: supervisor status exists; natural-language reporting has known inaccuracies. |
| IDENT-01 | Develop preferences and identity from verified experience | Planned: design exists; runtime identity learning remains unimplemented. |

### Food acquisition foundation — October 29, 2026

Historical planning snapshot; the November 5 implementation record above supersedes its statements about missing managed food behavior.

Joe clarified that obtaining food from the world is a required base ability.
Eating carried food and retrieving food from a chest do not establish that
ability. The food milestone must work without a player handing Mia food or
pre-stocking a supply chest.

Read-only source inspection found older hunting, food-smelting and planting
helpers in `src/agent/library/skills.js`, plus animal/smelting methods in the
legacy NPC item planner. These are partial building blocks. The current managed
make planner has no food outputs, `src/agent/smelting_plan.js` supports only
iron ingots and charcoal, and Survival currently reports blocked when carried
food is missing. No dependable end-to-end food acquisition is established.

Prioritize one complete, bounded food chain: observe a reachable supported
world source, obtain food and verify pickup, cook it with verified supplies and
output when necessary, then retain the requested edible inventory target.
Extend this with maturity-aware crop harvesting/replanting and additional food
sources. Supply-chest retrieval can supplement world acquisition. Coordinate
through Main Supervisor and ActionManager, respect danger and cancellation,
retain interrupted work and report a specific blocker when no feasible source
can be reached. Do not start an independent hunting or farming loop.

Acceptance target: start with no carried food and obtain usable food from the
world without player-supplied food, verify the inventory gain and any cooking,
then verify consumption if hungry. Check bounded search, interruption/resumption
and cancellation separately. This is a proposed milestone, not an implemented
feature or a live pass. This update changes only the project reference; no
runtime installation or gameplay test was performed.

### Proposed component goal labels

These labels describe targets, not additional implementation claims. Link each future change to the relevant component goal and foundation IDs.

| Goal | Owner | First target |
| --- | --- | --- |
| MAIN-01 | Main Supervisor | Pause, hand off and resume the same goal without competing actions. |
| WORLD-01 | World State | Supply fresh observations and explicitly mark unknown information. |
| ACTION-01 | Action Manager | Enforce one physical owner and reliably invalidate cancelled work. |
| MEMORY-01 | Memory functions / planned Memory Manager | Preserve and retrieve scoped experiences and goal state; refresh remembered facts. Supports MEM-01 through MEM-03. |
| SURV-01 | Survival Supervisor | Coordinate verified safety/feeding and retain recovery until exit conditions hold. |
| NAVSYS-01 | Navigation functions / planned supervisor | Reach a verified destination or report a bounded blockage. Supports NAV-01 through NAV-04. |
| GATH-01 | Gathering functions / planned supervisor | Obtain a requested inventory target and verify collection. |
| CRAFT-01 | Crafting functions / planned supervisor | Coordinate prerequisites, stations, fuel and verified outputs. |
| BUILD-01 | Building functions / planned supervisor | Complete or repair the saved shelter from live blocks, including after interruption. |
| COMBAT-01 | Combat functions / planned supervisor | Respond to threats while respecting recovery and preserving interrupted work. |
| PERS-01 | Planned Personality Supervisor | Advise feasible choices using starting traits without owning physical actions. |
| ADAPT-01 | Environment adapter | Expose environment observations, capabilities and verified results consistently. |

Personality subgoals: IDENT-01 covers gradual evidence-backed identity development; IDENT-02 covers learned preferences and habits; IDENT-03 covers temporary mood responses that decay toward baseline; IDENT-04 covers deduplicated evaluation with an evidence trail; IDENT-05 covers a revisable self-model. Preserve the agreed starting traits and detailed rules later in this reference. These subgoals remain proposed, not implemented.

### Initial foundation audit scenarios — proposed, not passed

1. Move to a specified nearby location and wait. Verify arrival and no unintended continued movement.
2. Collect a specified amount of one resource. Record starting inventory, whether the target means total held or additional collection, and final inventory.
3. Craft one item from available materials. Verify the actual output and distinguish newly crafted items from those already held.
4. Deposit a specified item/count in a chest, then retrieve it. Verify both inventories and preserve unrelated contents. Establish supported capability before choosing commands.
5. Eat available suitable food. Verify consumption and the resulting food/inventory state.
6. Stop midway through a task and remain stopped. Separately restart and check cancellation remains respected.
7. Encounter a deliberate blockage, recognize no progress, report the cause and avoid endless retries.
8. Resume the same task after a controlled interruption, using fresh observations and releasing ownership after verified completion.

Use the detailed recovery and repair scenarios below for the shared milestone, **Recover and finish the same task**. Keep the existing map, house and memory; no need to reset the project. Keep this milestone open until actual live evidence supports it; it is not an approval gate for unrelated development.

Each ability/goal record should contain: stable ID; responsible module; trigger/request; scope and preconditions; dependencies; observable success; blocked/timeout behavior; cancellation and handoff behavior; implementation/revision evidence; automated evidence; independent live evidence; assistance required; unresolved failures; next action. Record trial counts and conditions rather than inventing a reliability percentage. A trial requiring manual assistance is assisted, not independent success.

### Chat organization

Organize chats by ongoing responsibility. These are suggested chat names, not a claim that chats have been created or renamed.

| Suggested chat | Scope |
| --- | --- |
| 00 — MIA Overview & Roadmap | Overall goals, architecture decisions, priorities and cross-chat summaries. This planning conversation fits here. |
| 01 — Foundation & Ability Checklist | Stable ability IDs, evidence, missing functions, limitations and audit results. |
| 02 — Supervisors & Coordination | Priorities, ownership, interruption, cancellation and resumption. |
| 03 — Minecraft Skills | Movement, resources, production, containers, building and combat; split a skill when substantial. |
| 04 — Memory & Learning | Persistence, retrieval, knowledge and learning from experience. |
| 05 — Personality & Identity | Traits, mood, preferences, experience evaluation and self-model. |
| 06 — Live Testing & Troubleshooting | Logs, screenshots, reproducible failures and acceptance results. |

Start with three active chats: Overview & Roadmap, Foundation & Ability Checklist, and Live Testing & Troubleshooting. Add specialist chats as work grows. Keep code work with its topic: doorway fixes with Minecraft Skills, cancellation fixes with Supervisors & Coordination. Cross-reference related ability IDs when a problem spans chats.

`MIA_PROJECT.md` remains the shared reference. The checklist is embedded here for now. `MIA_ABILITIES.md` is a proposed future extraction, not a file created by this update. If extracted later, designate it as the checklist authority and link it here rather than maintaining two competing copies.

At the end of a meaningful session, record: decision/change; affected IDs; evidence level (proposed, implemented, automatically tested, verified live); remaining issue; next action. Update the authoritative reference while preserving newer information from other work. Do not assume another chat has received a decision until its current reference has been checked.

Suggested opening instruction for a focused chat:

> Read the current MIA_PROJECT.md and its foundation checklist (or MIA_ABILITIES.md if explicitly extracted). This chat covers [topic]. Preserve existing decisions, distinguish plans from implementation and live evidence, use stable goal/ability IDs, and record reference updates after meaningful work.


### Current recovery correction — October 24, 2026

Joe's latest live log confirms Survival v1 reaches the observed intact shelter
and seals its entrance. It then reports no suitable carried food, uses its
retreat attempts, exhausts its recovery time and keeps a new `!shelterGoal`
paused for safety recovery. A dashboard restart is visible in the log; it is
not evidence of an unexplained crash. Record this as a blocked live run.

The correction in `mia/survival-recovery-2026-10-24`, based on published
`03e8ccc179030100a544cd3cb09de7fab82caa54`, separates bounded retreat from
bounded feeding. Safe verified consumption can occur after the movement
deadline when food arrives or threats clear. It does not renew retreat or
meal attempts, assume an old refuge is safe, or release the original goal
before observed exit conditions hold. A blocked/no-food intervention now
settles an incumbent physical action once through the existing ActionManager.
Cancellation still invalidates queued work and emergency priority is retained.

The installer builder extends the current Survival payload and reloads each
on-disk build so already-installed Survival files remain recognized through
successive updates. It retains historical source compatibility and exact
rollback. Release: `mia-survival-recovery-2026-10-24`; deliverable:
`mia-survival-recovery-update.cjs`. Profiles, world identity, JSON/SQLite memory,
dependencies and vendor packages are preserved. This cloud checkout cannot
apply runtime edits to Joe's Windows installation.

Fresh validation on Node **22.23.2**: **425/425** full regressions passed with
zero skips, including **49** focused Survival cases, the installed Survival v1
upgrade, exact rollback/private-state preservation and successive installer
rebuilds. The final cumulative installer verifies all **66** embedded files.
GitHub [workflow 40144250069](https://github.com/FeelsMan/mindcraft-test/actions/runs/40144250069)
passed **425/425** Linux regressions, **208/208** Windows interactions,
**61/61** Windows memory checks and **19/19** installer checks, all without skips.
The tested runtime source is `fd17b2e3a624a7e6a667d158f70f503d42d065f7`.
[PR #3](https://github.com/FeelsMan/mindcraft-test/pull/3) was merged into
`develop` at `009ad2c1548cecc8549b47740fe9ce31b4800ff2` on October 24, 2026,
after Joe explicitly approved the merge. Its final head,
`4e14ed3c4c741fd865e30762b8869a69193ebde4`, differs from the tested runtime
source only in this reference; all four jobs in
[workflow 40144606098](https://github.com/FeelsMan/mindcraft-test/actions/runs/40144606098)
also passed on that final head. The earlier automatic approval block is resolved.
The merge does not install the correction on Joe's Windows PC. Stop Mia,
apply the recovery installer and verify all 66 files before restarting, unless
that exact correction is already installed. Profiles and memories remain preserved.

Live acceptance remains open. First reproduce hungry/no-food recovery, request
`!shelterGoal` with a few missing wall blocks and adequate planks, wait at least
95 seconds from recovery entry, then supply bread directly to her inventory.
After nearby threats are cleared, confirm verified consumption, acceptable
health/hunger, sustained calm, and automatic completion of the same saved repair
without another goal command. Query `!supervisor` before and after recovery.
Then separately test active repair interrupted by one zombie, followed by
automatic same-site resumption and released ownership. Keep the door and escape
route usable; do not reset the house, map or memory. These are proposed live
tests, not reported passes.

### Previous Survival v1 implementation — October 24, 2026

Survival Supervisor v1 is now implemented locally in `src/supervisors/survival.js`
with `src/adapters/minecraft/survival.js`. It uses the existing agent tick,
Main Supervisor and ActionManager; it introduces no second movement loop or
memory schema. Mia was stopped before runtime edits. The local checkout was
found at upstream revision `5f3acc87b479864124173de444f31fa5538f94a6` with extensive
pre-existing changes and an upstream `mindcraft-bots/mindcraft` remote. These
were preserved. Publication work uses an isolated full checkout of
`FeelsMan/mindcraft-test` based on `develop` at
`e81fcab25d0f31fa0e1527b9a55ee4a7af2f8cec`.

Recovery recognizes health, recent damage and explicit hostile observations,
seeks live-verified scoped shelter/cover or bounded supported escape, verifies
carried-food consumption from inventory and hunger, suppresses optional modes,
and retains the interrupted managed goal until conditions improve. Immediate
self-preservation remains higher priority. `!supervisor` exposes recovery and
blocked reasons; stop invalidates queued survival actions. The independent
auto-eat plugin is disabled to preserve one physical owner. Missing food and
exhausted recovery attempts report blocked rather than hunting during danger.
Defaults and limits are documented in `docs/mia-survival.md`; they are initial
tested implementation choices, not established live tuning.

Fresh local validation on Node **22.23.2**: `npm run test:goals` in the isolated
full-history checkout passed **416/416**, with no skipped tests, including the
installer upgrade/rollback cases. The applicable Windows interaction command
passed **201/201** and the Windows memory command passed **61/61**. Focused
Survival coverage passed **42/42**, including native 1.21.4/26.3 controlled
same-site repair replays, scoped/intact-door refuge checks, failed and verified
consumption, bounded attempts, unknown observations, cancellation races and
recovery release hysteresis. An initial sandbox run hit a temporary-file rename
restriction in a memory fixture; the unrestricted isolated reruns passed.
The cumulative installer embeds **66** current files and retains compatibility
hashes across the **12** historical baselines audited. Private-state fixtures
include JSON/SQLite memory, WAL/SHM sidecars, configuration and profiles.
Dependencies, vendor packages and lockfile were unchanged. Publication is
tracked in [PR #2](https://github.com/FeelsMan/mindcraft-test/pull/2), targeting
`develop`; its checks identify the tested source revision. Final review also
verified actual retreat at health 16 with a hostile 20 blocks away, and shared
the same configurable danger assessment with feeding throughout equip/use.
The installed runtime source matches all 66 installer files; restart is needed.

Publication completed on October 24, 2026: [PR #2](https://github.com/FeelsMan/mindcraft-test/pull/2)
merged into `develop` at `ee746b70fa9d1831c7bfe631aac57f22bab271c7`.
The tested head is `629d0dda3cc009f393dafcd09b6cd9afd9b82f81`.
[GitHub workflow 40142116428](https://github.com/FeelsMan/mindcraft-test/actions/runs/40142116428)
passed all four jobs: **416/416** Linux regressions, **201/201** Windows
interactions, **61/61** Windows memory checks and **18/18** installer checks,
all with zero skipped tests. The final documentation record changes no runtime
or installer bytes. Mia remains stopped; start with
`node main.js --profiles .\mia-qwen.json` when ready for the live checks below.
No live Survival acceptance is claimed. The active repair → hostile
interruption → same-site automatic completion scenario and cancellation across
restart remain outstanding live checks. Mia must restart to load this code.

### Previous handoff snapshot — October 24, 2026

- **Repository:** https://github.com/FeelsMan/mindcraft-test; target branch `develop`.
- **Fresh GitHub check for this handoff:** `develop` resolves to `e81fcab25d0f31fa0e1527b9a55ee4a7af2f8cec`, the merged shelter-repair fix. Check again before starting later implementation; a recorded revision is a snapshot.
- **Implemented:** Main Supervisor v1, fresh world-state bridge, managed gathering/crafting/smelting/shelter controllers, SQLite checkpoints, shelter door-routing and movement-correction fixes.
- **Latest live result:** Joe reports the shelter repair worked after the fix. Crafting and shelter completion/released ownership are also visible in earlier live logs.
- **Still awaiting a live result:** repair in progress → hostile interruption → refreshed conditions → automatic resumption of the same repair. Earlier combat happened after the shelter was already complete.
- **Next code update:** Survival Supervisor v1, integrated through the existing Main Supervisor and Action Manager. It is not implemented yet.
- **Next live test:** same map and house, several missing wall blocks, enough replacement planks, `!shelterGoal`, one hostile interruption during active repair, then `!supervisor` to inspect handoff/resumption.
- **Runtime stays local:** Mia continues using Ollama and `mia:qwen9b`; Codex is a development tool, not a replacement for her runtime model or memory.
- **Standing publication authorization:** Joe has approved relevant, tested Mia updates to this repository and to `develop`. Preserve that scope and follow the current requested task without repeatedly asking for the same approval.
- **Documentation-only handoff:** these two Markdown files do not install code, establish a new gameplay pass, or prove that the Windows checkout matches GitHub. No regression suite was rerun merely to prepare the handoff.


Use this file as the shared starting reference for the mia project. Read the relevant current code and recent logs before making implementation decisions. Update this reference when a decision, installed version, or verified result changes.

The architecture is being introduced incrementally. Main Supervisor v1, its fresh world-state view and its Minecraft supervisor adapter are implemented in release `mia-main-supervisor-v1-2026-10-23`. Existing managed controllers perform the work. Survival Supervisor v1 is implemented locally as described above. The Personality Supervisor, Memory Manager abstraction and five other specialized supervisor modules remain planned.

Live logs confirm Main Supervisor v1 is running, recording crafting and shelter completion and returning action ownership to none. The October 24 shelter-repair fix was tested at `1d228684a8b2c5be7aeafdf90d6a9c3651df71f8`, with all four GitHub CI jobs passed. Joe subsequently reported that the live repair worked and supplied a screenshot of the repaired shelter. [Pull request #1](https://github.com/FeelsMan/mindcraft-test/pull/1) is now merged into `develop` at `e81fcab25d0f31fa0e1527b9a55ee4a7af2f8cec`. Joe explicitly authorized this merge and future tested Mia updates to `develop` on October 24, 2026. Keep installed code, published revision and live evidence distinct.

## Purpose and longer-term direction

M.I.A. is a local AI agent project centered on persistent memory, a developing identity, and independent goal-directed activity.

Minecraft is the first environment. The eventual design should retain Mia's identity, memories, preferences, and higher-level goals when adding other game or computer adapters.

The intended progression is:

1. Reliably observe, act, verify outcomes, and recover from interruptions.
2. Coordinate survival, gathering, crafting, navigation, building, and combat.
3. Notice needs, choose useful projects, and continue without an instruction for every action.
4. Develop evidence-backed preferences, habits, and personality gradually through experience.
5. Progress toward broader Minecraft survival and eventually completing the game.

Broader autonomy and operation outside Minecraft are future goals. Successful individual commands do not establish full unattended survival.

## Agreed design principles

- Live inventory, health, position, observed blocks, and verified tool results take precedence over historical memory or model-generated descriptions.
- Record outcomes only after checking the resulting inventory or world state.
- Remembered locations are hints to recheck; an unloaded or unseen location is unknown.
- Preserve the current goal through combat, temporary interruptions, and restart when appropriate.
- Explicit stop or cancellation remains cancelled.
- Keep retries and exploration bounded. Repeated failed actions should trigger recovery or a clear blocked state.
- Use one owner for physical actions so supervisors do not issue competing movement, mining, or interaction commands.
- Keep environment-specific observations and actions behind adapters.
- Preserve working capabilities while introducing supervisors incrementally.
- Separate proposed behavior, implemented behavior, automated test results, and observed live gameplay.
- Let personality shape feasible priorities and expression, never override verified world state, explicit cancellation, or safety and action ownership.

## Target architecture — implementation has begun

### Core

| Proposed file | Responsibility |
| --- | --- |
| core/mainSupervisor.js | **v1 implemented as src/core/mainSupervisor.js:** coordinate one foreground managed goal, control handoffs, interruption/resumption, lifecycle reasons and final live verification. Broader goal selection remains future work. |
| core/personalitySupervisor.js | Parallel advisory supervisor for developing identity: provide preference context and proposed goals; evaluate significant, verified experiences without owning physical actions. |
| core/memoryManager.js | Present a shared interface for experiences, knowledge, identity, locations, and goal checkpoints. Build on existing persistence. |
| core/worldState.js | **v1 implemented as src/core/worldState.js:** fresh, timestamped adapter observations of scope, inventory, health/hunger, current actions and interruptions; unavailable observations remain unknown. |

The Main Supervisor should coordinate the specialists. Recipes, route execution, mining, and block placement remain in their relevant modules. Use ordinary code for control ownership, lifecycle rules, priorities, and verification; the language model can propose broader goals and explain choices.

The Personality Supervisor runs alongside task coordination. It influences choices and expression without creating a second movement or action loop. It should use a compact structured exchange with the Main Supervisor rather than an always-running second LLM conversation.

### Personality components

| Proposed file | Responsibility |
| --- | --- |
| personality/traits.json | Slowly changing core trait values. |
| personality/preferences.json | Preferences and habits supported by experience. |
| personality/mood.json | Temporary state that can change more quickly. |
| personality/experienceEvaluator.js | Evaluate verified experiences and propose gradual, traceable updates. |

These files describe the intended design. No trait evolution implementation is established by this reference.

### Specialized supervisors

| Proposed file | Responsibility |
| --- | --- |
| supervisors/survival.js | **v1 implemented as src/supervisors/survival.js:** assess live danger/hunger, hold bounded recovery and coordinate verified retreat/feeding through ActionManager. |
| supervisors/crafting.js | Plan and verify crafting and smelting through the existing managed systems. |
| supervisors/gathering.js | Obtain resources, verify collection, and handle resource-search recovery. |
| supervisors/navigation.js | Reach destinations, detect blocked or stalled routes, and manage recovery. |
| supervisors/building.js | Plan supplies, build, verify placement, and resume structures from live blocks. |
| supervisors/combat.js | Handle immediate threats and return control after the interruption resolves. |

Survival identifies a need. The relevant specialist performs the work. For example, hunger without food can produce a gathering or cooking goal.

Use consistent goal status and handoff behavior across specialists. The exact interface has not yet been finalized.

### Adapters

The first bridge is implemented as `src/adapters/minecraft/supervisor.js`, connecting fresh observations, final outcome checks and existing scoped checkpoints to the core. Broader adapters/minecraft/ wrappers for movement, mining, crafting, combat and block interactions remain incremental work.

Expose useful capabilities to the core through the adapter. Keep Minecraft-specific block names, protocol details, and physical execution within the environment layer where practical. Existing game-oriented specialists can be adapted or replaced when another environment is introduced.

## Personality and identity development — agreed direction, proposed v1 rules

### Starting temperament — agreed

Mia begins with a small, recognizable temperament rather than a fully written character. These are **initial values**, not permanent instructions or claims about conscious feelings.

| Trait | Initial value | Starting tendency |
| --- | ---: | --- |
| Curiosity | 75/100 | Explore, investigate, and experiment when reasonable. |
| Caution | 45/100 | Accept some risk without ignoring danger or safety checks. |
| Sociability | 55/100 | Engage with people, but not constantly. |
| Independence | 65/100 | Initiate tasks and suggest personal goals. |
| Persistence | 65/100 | Work through setbacks, changing tactics when needed. |

Do **not** predetermine hobbies, favorite locations, humor style, preferred building aesthetic, or a rigid social persona. Let these become evidence-backed preferences and habits. Curiosity gives Mia a reason to learn and explore; it does not prescribe what she will like.

### Separate three speeds of change

| Layer | Typical changes | Rule |
| --- | --- | --- |
| Mood / immediate reaction | Temporary excitement, frustration, confidence, apprehension | Respond to meaningful recent events; decay toward baseline with time and context. These are simulated state variables, not a claim of human emotion. |
| Preferences, habits, situational confidence | Enjoying building; avoiding creepers; liking particular locations; learning a route or recovery habit | Accumulate evidence across multiple events, including *voluntary* follow-up choices. Adapt faster than core traits. |
| Core temperament | Curiosity, Caution, Sociability, Independence, Persistence | Change very slowly, based on consistent patterns across different contexts, not one dramatic event. |

An event may change mood without changing a preference; a preference may develop without changing a global trait. Learning that creepers are dangerous should usually improve a *situational safety strategy*, not automatically turn Mia into a generally cautious character.

### Direction of influence for the five traits

These are hypotheses to evaluate, **not automatic score-change triggers**:

| Trait | Evidence that might raise it | Evidence that might lower it |
| --- | --- | --- |
| Curiosity | Repeatedly rewarding discoveries or experiments | Sustained disinterest in exploration after repeated opportunities |
| Caution | Near misses, successful planning, and demonstrated risks | Safe outcomes from controlled risk-taking and increased competence |
| Sociability | Positive, welcome interaction or cooperation | Repeated unwanted or unproductive interaction |
| Independence | Successfully choosing and completing self-directed goals | Repeated preference for collaboration or delegated decisions |
| Persistence | Recovering from setbacks using improved plans | Learning that abandoning an unproductive approach is better |

Ask *why* an action happened. Completing a user-ordered house is evidence of task execution, **not** proof that Mia enjoys building. If she voluntarily decorates it later, returns to it, or proposes another build when she has alternatives, those choices support a building preference. Similarly, successfully asking for help is not automatically a loss of independence, and deciding to stop a futile action is not automatically a loss of persistence.

### Experience → identity learning cycle

The Personality Supervisor is a **side supervisor** alongside the Main Supervisor, not a replacement for it. It provides preference context, proposes goals, and evaluates experiences. It does not control Minecraft actions or issue conflicting movement/mining commands.

1. **Observe:** Receive significant events from the current adapter and verified action results (e.g., a discovered structure, successful build, death, interrupted goal, conversation, or a self-chosen activity).
2. **Record:** Save the factual event to memory with environment/world ID, timestamp or order, goal, whether it was user-assigned or self-initiated, observed outcome, and confidence/verification. Unverified events remain tentative.
3. **Evaluate:** `personality/experienceEvaluator.js` estimates temporary mood impact, potential preference evidence, situational learning, and (rarely) broader trait evidence. It can use an LLM to suggest an interpretation but must not fabricate events.
4. **Compare:** Check against prior experiences and alternatives; distinguish real preferences from urgency, survival necessity, forced actions, environmental limits, and execution bugs.
5. **Update selectively:** Save justified mood, preference, habit, or self-model changes with reason, supporting event IDs, old/new value, and evaluation version. Do not silently rewrite identity.
6. **Influence future choices:** At a meaningful decision boundary, the Main Supervisor requests or receives a compact personality summary. Personality can bias priorities, suggested projects, style, and dialogue within live-world constraints.
7. **Reflect occasionally:** Review repeated patterns and update the self-model. Reflection should summarize evidence, not create imagined autobiographical history.

Example: Building a required shelter creates a verified episodic memory but little preference evidence. Voluntary decoration, revisiting the shelter, or independently proposing a second build increases support for liking building. Mia might then suggest a creative project herself, if survival priorities allow.

### Proposed v1 tuning parameters — **not yet implemented or validated**

These are conservative *test settings* from the design discussion, not locked final numbers:

- Reassess core traits after roughly **10 significant, verified experiences**; a review need not produce any change.
- Cap each trait movement to **1 point per review** in v1, with repeated cross-context evidence required.
- During initial testing, keep each trait within **±10 points of its agreed starting value**; revise only after observing behavior.
- Mood shifts can be immediate but should fade; preferences require multiple pieces of evidence and should have confidence/strength rather than binary liked/disliked labels.
- Persist the original starting values separately from current trait values, and maintain a reversible/auditable change history. Prefer an event log with materialized current state over opaque rewrites.
- Bound reflection frequency, event volume, and LLM calls; ordinary mining ticks and routine movement should not trigger full personality analysis.
- Do not count failed pathfinding, parser mistakes, missing materials, timeout loops, or stale-world assumptions as personality evidence. Expose those to debugging/recovery instead.

The threshold for a *significant experience*, weighting, confidence calculation, mood decay, preference decay, and exact review schedule still need design and tests. Protect existing SQLite world-memory content before migrations.

### Memory categories and self-model

- **Episodic memory:** What Mia did or witnessed (e.g., "I built my first shelter near a river"). Include verified outcome and scope.
- **Knowledge memory:** Facts and lessons about the environment (e.g., "creepers can damage buildings"). Refresh uncertain information from live observation.
- **Identity memory / Self-Model:** A cautious summary of who Mia appears to be becoming (e.g., "I have repeatedly chosen building projects"). Every claim should be supported by stored experiences and be revisable.

The proposed **Self-Model** should answer: What am I good at? What do I tend to choose? What have I learned? Which places and projects matter to me? Which goals did I choose myself? How have my patterns changed? It is a computational self-description, **not a claim of consciousness or human-like self-awareness**.

### Ownership, storage, and integration

- Keep **one owner of physical actions**. Main Supervisor decides task ownership and interrupts/resumes; specialists execute; Personality Supervisor only advises, learns, and suggests.
- Main Supervisor may request structured preference context at decision points. Personality should affect *which feasible goal* or *which acceptable strategy* Mia prefers, **not** bypass urgent survival priorities, explicit user instructions, hard cancellation, verifiers, or safety constraints.
- `core/memoryManager.js` should expose the durable event history and identity summaries; reuse existing per-world SQLite persistence and existing JSON history. Proposed personality JSON files can start as configuration/defaults, but must not become a second conflicting source of truth for evolving live state.
- `personality/traits.json` supplies initial temperament; `preferences.json` holds preference defaults/schema; `mood.json` defines short-term state defaults; `experienceEvaluator.js` contains evaluation code. Exact schemas and persistence adapters are not yet settled.
- Personality stays **game-independent**: Minecraft facts arrive through `adapters/minecraft/`; another adapter should retain Mia's general temperament and portable memories while isolating environment-specific knowledge.
- Keep the personality model interpretably bounded and testable. Use deterministic rules for caps, deduplication, verification and audit trails; allow Ollama/LLM interpretation only for higher-level meaning where useful.

### First personality-system acceptance tests — planned

1. A user-assigned shelter completion does **not** instantly become a strong building preference.
2. Multiple verified, self-initiated building choices produce a growing building preference and a traceable evidence log.
3. A creeper surprise creates a temporary mood/risk response and a situational memory, without a large general Caution jump.
4. Repeated navigation or crafting failures produce recovery/debug signals, **not** arbitrary personality erosion.
5. Reflection with no new significant evidence makes **no** trait change.
6. Restart/load preserves identity and world scope; cancellation and survival interruption still take priority over personality suggestions.

This is a **design specification**, not evidence these behaviors, files, or tests already exist in the running installation.

## Running setup — last reported

These details describe the reported setup, not a fresh audit of the Windows machine.

| Item | Last reported value |
| --- | --- |
| Source repository | https://github.com/FeelsMan/mindcraft-test |
| Development branch | develop |
| Windows project directory | D:\mai\mindcraft |
| Minecraft version | 26.3 |
| Agent name | Mia |
| Player name used in tests | CaptainNeyo |
| Local model | mia:qwen9b |
| Profile | mia-qwen.json |
| Memory world ID | mia-survival-1 |
| Persistent memory | Local SQLite plus existing JSON history under bots/Mia/ |
| Recent CI Node version | 22.23.2; confirm the installed version with node --version |
| Last reported installation | Main Supervisor v1 is visible in live logs. Joe reports the October 24 shelter-repair update worked in live gameplay; full Windows source bytes have not been freshly audited. |
| Main Supervisor release | mia-main-supervisor-v1-2026-10-23; installer mia-main-supervisor-update.cjs |
| Shelter-repair release | mia-shelter-repair-2026-10-24; installer mia-shelter-repair-update.cjs |
| Published fix revision | 1d228684a8b2c5be7aeafdf90d6a9c3651df71f8, merged via https://github.com/FeelsMan/mindcraft-test/pull/1 |
| Current develop revision | e81fcab25d0f31fa0e1527b9a55ee4a7af2f8cec; PR #1 merged on October 24, 2026 after passing checks. |
| Next architectural work | Survival Supervisor v1; keep the outstanding live building/combat/resume scenario tracked separately. |

Launch from the Windows project directory:

    node main.js --profiles .\mia-qwen.json

Memory-related files include bots/Mia/memory.json, bots/Mia/memory.sqlite, and bots/Mia/memory-config.json. Preserve their identity and existing contents during code updates.

Keep the same world ID for the same saved Minecraft world, including when a LAN port changes. Use a different ID for a different world.

The assistant's accessible checkout is not a live view of D:\mai\mindcraft. A reported GitHub publication does not prove that the same patch is installed locally.

## Implementation and verification snapshot

Main Supervisor v1 passed 365 local regressions and GitHub workflow 40060110231, including 153 Windows interaction tests. The October 24 shelter-repair fix passed 373 local regressions on Node 24.22.1. For the published fix revision, [GitHub workflow 40129814983](https://github.com/FeelsMan/mindcraft-test/actions/runs/40129814983) passed all 373 regressions on Node 22.23.2, all 159 Windows interaction tests, all 61 Windows memory tests and all 17 installer backup/rollback tests, with no failures or skipped tests in those runs. No assistant-controlled live Minecraft run was performed. Joe supplied the gameplay evidence below, including a later report that the repaired version worked.

| Area | Evidence available | Remaining qualification |
| --- | --- | --- |
| Managed resource gathering | Live logs show collection and inventory verification for cobblestone and raw iron. A raw-iron goal resumed after an unstuck interruption. | Broad resource discovery and terrain coverage remain ongoing work. |
| Managed crafting | Live logs show stone-axe crafting, total-target verification, keeping the item, and stopping. | Correct execution of a direct command does not guarantee every natural-language request is interpreted correctly. |
| Managed smelting | Live logs show raw iron converted into verified inventory targets. A nearby furnace test completed without reach errors. | Station recovery and access still need observation in varied terrain and after relocation. |
| Local memory and goal recovery | SQLite startup is visible in logs; earlier tests and reports cover checkpoints, world scope, cancellation, and restart recovery. | Historical facts must be refreshed against current observations. |
| Nearby ore and station interaction | Floor/overhead targeting and reach fixes were reported and tested. Later ore, furnace, and crafting runs completed. | These successes do not establish universal navigation or targeting correctness. |
| Starter shelter | Live logs verify the existing 58-block shell/roof/steps and door, entrance testing, sealing and home at (25, 88, 10). The first east-wall repair required manual door assistance. After the repair update, Joe reported that it worked and supplied a screenshot showing the completed shell/roof with Mia inside. | Record the updated repair as a user-reported live success. The screenshot alone does not establish every door action or interruption/resumption step; the latter remains a separate live check. |
| World awareness and navigation recovery | Present in the verified baseline and cumulative installer; the prior source includes current world-memory synchronization, station pickup recovery and bounded useful-navigation-progress tracking. | Retest varied terrain and the partial shelter in the live world. |
| Main Supervisor v1 | Implemented core coordinator, fresh state view, Minecraft bridge, action identity checks and read-only !supervisor query. Automated native 1.21.4/26.3 replays cover shelter → combat → fresh condition/supply check → same shelter completion, cancellation, scoped restart recovery, and coalesced resumes. | Live status confirms three-axe completion and shelter completion with action ownership released. A later defense → self-preservation handoff occurred, followed by death and an empty-inventory check. Shelter was complete before combat, so building interruption/resume remains untested live. No autonomous task backlog or full Survival/Personality Supervisor yet. |
| Personality development | Five starting traits agreed; learning-cycle design and conservative v1 test parameters specified in this reference. | No verified evaluator, trait updates, runtime tests, or persistence migration yet. |

The shelter version discussed uses 58 oak planks plus one oak door, clear level ground around the build, and the existing ground as its floor. Beds and lighting were deferred. The initial site guidance was a clear 7×7 area.

Shelter progress is intended to resume at the saved site from observed blocks. The home waypoint is saved after verification; it does not set a bed or Minecraft respawn point.

### Known issues and observations

- Nearby ore, furnaces, and crafting tables have previously been overlooked or rejected. Patches addressed specific causes; keep concrete failing scenarios and logs if they recur.
- Returning to remembered stations can fail because of route or interaction access. Avoid treating repeated cooldown retries as a resolution.
- Natural-language requests can produce incomplete follow-through or imprecise reporting even when direct managed commands succeed.
- The local model has emitted commands with missing string quotes and then corrected them after parser feedback.
- Reporting should distinguish an item already held, an item crafted earlier, and an item newly crafted for the current request.
- Treat the available source files and recent logs as evidence. Avoid reconstructing the current installation from an old patch filename or an old passing test count.

### Relevant existing documentation

The accessible Mindcraft checkout includes:

- docs/mia.md
- docs/mia-memory.md
- docs/mia-lifecycle.md
- docs/mia-resource-recovery.md
- docs/mia-crafting-reliability.md
- docs/mia-crafting-stations.md
- docs/mia-station-access.md
- docs/mia-main-supervisor.md
- docs/mia-navigation-progress.md
- docs/mia-station-pickup.md
- docs/mia-world-memory.md
- docs/mia-nearby-interactions.md
- docs/mia-smelting.md
- docs/mia-shelter.md
- docs/mia-shelter-repair.md

Some documents describe earlier milestones. Check their statements against the relevant current source and revision.

## Implemented coordination: Main Supervisor v1

Release: `mia-main-supervisor-v1-2026-10-23`. Revision: `2633247ae8515d35cc08308eefce7728ae29a742`.

Implemented behavior:

1. Track one foreground managed goal and running, paused, blocked, complete or cancelled state, with a reason.
2. Track the current specialist and action owner, using existing Action Manager priorities and stopping/handoff behavior.
3. Validate goal identity before and after a prior action settles, so cancelled or superseded queued actions cannot start.
4. Pause for existing defense, retreat, self-preservation and unstuck modes. Read current conditions after calm, then let the original controller replan from live supplies and blocks.
5. Require the controller's completion checks plus a final live inventory or shelter/door check.
6. Preserve the original target through existing scoped SQLite checkpoints. Stop remains cancelled; concurrent restores share one operation.
7. Expose `!supervisor` during managed work, with goal, specialist, owner, reason and fresh health/hunger.

The core has no competing background action/LLM loop. Fresh snapshots and a bounded transition buffer are session state; durable goals remain in existing SQLite. No memory schema migration, model download or dependency update is required.

Stop Mia, save `mia-main-supervisor-update.cjs` beside `main.js` in `D:\mai\mindcraft`, then run:

```powershell
node .\mia-main-supervisor-update.cjs --check
node .\mia-main-supervisor-update.cjs --apply
node .\mia-main-supervisor-update.cjs --verify
node .\mia-main-supervisor-update.cjs --test
node main.js --profiles .\mia-qwen.json
```

Verification prints the distinct release ID and **all 58 files match**. The cumulative installer validates supported source before writing and preserves profiles, settings, credentials and JSON/SQLite memories. `--restore` restores the exact previous source bytes.

## Current update: shelter repair and movement corrections

Release: `mia-shelter-repair-2026-10-24`. Installer: `mia-shelter-repair-update.cjs`.
Tested fix: `1d228684a8b2c5be7aeafdf90d6a9c3651df71f8` on `mia/shelter-repair-2026-10-24`, based on `2633247ae8515d35cc08308eefce7728ae29a742`. [Pull request #1](https://github.com/FeelsMan/mindcraft-test/pull/1) was merged into `develop` on October 24, 2026 at `e81fcab25d0f31fa0e1527b9a55ee4a7af2f8cec`. All four test-branch CI jobs and the pull-request workflow passed before merging. Joe's explicit authorization to merge and publish future tested updates to `develop` resolved the earlier approval blocker. The installer contents are unchanged by the merge; no additional installation is required for the already-applied shelter-repair update.

October 24 live observations:

- A managed make goal verified 3/3 stone axes, stopped and released action ownership.
- Reissuing the existing shelter went directly to final entrance verification, sealed the door and saved home at `(25, 88, 10)`.
- Combat occurred after completion and a travel request. Defense yielded to self-preservation, but Mia repeatedly fought pillagers, retreated and died. Death position was saved and the empty respawn inventory was checked. The `!consume("honey_bottle")` result was `undefined`; successful consumption is not established.
- Joe removed part of the house and requested repair. Repeated `world_changed` interruptions restarted log gathering. A placement at `(27, 88, 9)` reported feet at `(25.49988236803626, 88, 8.5125)`. The house ultimately verified complete only after Joe operated the door repeatedly. Treat that as assisted completion.
- After receiving the shelter-repair update, Joe reported "it worked" and supplied a screenshot showing the repaired plank shell/roof and Mia inside. This is a reported live repair success; a new detailed completion log was not supplied.

Implemented repair changes:

1. Select actual supported work positions before deciding which side of the door Mia must reach. A wall/roof target coordinate is not her standing position.
2. Give the owned entrance one explicit crossing controller; ordinary A* and the fallback door-opening interval cannot retoggle it.
3. If she is pressed against the panel inside the doorway cell, open the passage before trying to walk to a stance across it.
4. Distinguish local server corrections from relocation using the pre-reply `move(oldPosition)` observation. Corrections up to one block refresh decisions without cancelling physical work. Larger/unknown relocations and dimension changes still invalidate stale routes.
5. Keep the existing stall/no-progress budgets through small corrections, and retain placement, cancellation, memory and final-verification rules.

Validation: **373/373 local regressions passed** on Node **24.22.1**, including native 1.21.4/26.3 work-position/door cases, all 15 east-wall cells repaired after supply collection, the reported doorway position with repeated corrections, real relocation after harmless corrections, and installer upgrade/rollback preserving private state. GitHub workflow **40129814983** passed **373/373** regressions on pinned Node **22.23.2**, **159/159** Windows interaction tests, **61/61** Windows memory tests and **17/17** installer tests. Automated movement uses real block shapes and A* with controlled I/O; Joe's subsequent successful live repair report is separate gameplay evidence.

Stop Mia and place the new installer beside `main.js`, then run:

```powershell
node .\mia-shelter-repair-update.cjs --check
node .\mia-shelter-repair-update.cjs --apply
node .\mia-shelter-repair-update.cjs --verify
node .\mia-shelter-repair-update.cjs --test
node main.js --profiles .\mia-qwen.json
```

`--verify` should report the distinct shelter-repair release and **all 60 files match**. The cumulative package preserves profiles, world ID and existing JSON/SQLite memory. It does not implement Survival Supervisor.

## Next milestone and live tests

Joe reports that the shelter-repair update worked at the existing house. Keep the same map, saved site and memory world ID. The remaining live Main Supervisor acceptance scenario is:

1. Start with full health and hunger at the existing house. Remove several wall blocks, retain the saved shelter record, and give Mia enough replacement planks. Stand clear of her work positions.
2. Query `!supervisor`, then send `!shelterGoal` to repair the saved site. Use `!resumeGoal` for a paused managed goal as appropriate. Confirm she is actually working; an already-complete structure will go directly to final verification and cannot test interruption of construction.
3. During active repair, introduce one ordinary zombie so the interruption is easy to interpret. Observe that construction pauses and defense/retreat takes control. Capture `!supervisor` and the console log.
4. Once the threat is gone, observe whether she checks current conditions and automatically resumes the same repair from live blocks and inventory, without a second build command or manual door operation.
5. Pass: only missing blocks are replaced, entrance verification completes, the goal is complete, and action ownership returns to none. Record a stall, death, repeated control switching, duplicate work, or required manual assistance as an unresolved result, with logs.
6. Separately test `!endGoal` while work is active, restart Mia, and confirm the cancelled goal does not resume automatically. A later explicit new request may start work again.

The scenario passed automated native 1.21.4/26.3 replays; record the live outcome separately.

**Survival Supervisor v1** is now implemented in `src/supervisors/survival.js` within the existing source layout, with a Minecraft adapter and Main Supervisor recovery hold. Existing emergency modes retain immediate reactions. See the current implementation and validation record above and `docs/mia-survival.md`; live tuning and acceptance remain outstanding.

### Survival Supervisor v1 — agreed priorities

The pillager encounter supplies the main failure case: Mia repeatedly defended herself, retreated late, returned to fighting and died. In the current `src/agent/modes.js`, the recent-damage emergency branch includes `bot.health < 5` or a potentially lethal recent hit; its fallback is `moveAway(bot, 20)`, not verified cover selection. Other emergency branches cover fire, drowning and suffocation. The new supervisor should improve coordination while retaining those immediate reactions.

1. **Assess danger before the existing last-resort threshold:** consider current health, hunger, recent damage, observed hostile proximity and available equipment/food. Final thresholds remain configurable implementation choices to be tested, not agreed numbers.
2. **Hold a recovery state:** use explicit entry/exit conditions so a retreat does not immediately hand control back to fighting or construction while danger remains. Re-evaluate from fresh observations and keep one physical-action owner.
3. **Select a reachable recovery destination:** prefer a still-valid shelter or appropriate observed cover when access is verified. Reuse the owned door-crossing logic. A saved home coordinate alone is not proof of a safe route or intact shelter. Bound fallback escape attempts and report blocked routes instead of retrying forever.
4. **Consume suitable food from live inventory:** verify completion from inventory/food state, handle interruption or failure without claiming success, and choose a bounded next step if food is unavailable. The earlier `undefined` honey-bottle result does not prove consumption.
5. **Suspend optional distractions during danger/recovery:** prevent item collection, optional hunting and nonessential work from competing with retreat or healing. Coordinate existing modes instead of creating a second movement loop.
6. **Return control deliberately:** after observed conditions improve, resume the saved goal with fresh supplies, position, scope and block checks. Honour explicit cancellation; handle death/respawn from actual post-respawn inventory and surroundings.
7. **Expose the decision:** use supervisor status/reasons to explain danger, the selected response, recovery, a blocked action, and return of control. Choose any new command names during implementation; none are established by this plan.

Survival Supervisor identifies needs; existing gathering, crafting, smelting, navigation and building controllers perform the requested work. General self-directed project selection, the remaining specialist refactor, and Personality Supervisor remain later work. The outstanding live combat/resume test remains open while development proceeds; do not silently mark it passed or turn it into an unrequested approval gate.

### Survival live acceptance

| Scenario | Expected verified behavior |
| --- | --- |
| Hungry with edible food carried, no danger | Select actual available food, consume it, confirm the result, and return control. |
| Hungry with no food | State the need and request feasible bounded food work through the coordinator, or report why it is blocked. Do not consume nonexistent items. |
| Damage/threat during active repair | Pause the same repair, retreat early enough for the configured case, maintain recovery while unsafe, then resume only when the exit conditions hold. |
| Remembered home blocked, broken, unloaded or in another scope | Recheck access and scope; use a verified alternative or report blocked recovery. Do not assume the remembered destination is safe. |
| Dropped loot visible during danger | Keep survival in control; optional item collection must not interrupt it. |
| Stop or death during recovery | Respect cancellation and current scope; after respawn use actual inventory/state, never continue an old physical action blindly. |

Add meaningful automated coverage for these transitions, interruption/cancellation races, failed consumption, unreachable shelter and the existing native 1.21.4/26.3 behavior. Record automated and live outcomes separately.

## Codex development handoff

Joe requested an up-to-date `MIA_PROJECT.md` and an `AGENTS.md` after discussing moving development to Codex. These files prepare that handoff; they do not assert that a particular Codex client is already connected to the repository or to the Windows machine.

Recommended workflow:

1. Open the real Mindcraft checkout in local Codex (`D:\mai\mindcraft`), or use a separate Git checkout connected to the repository. Inspect the actual branch, revision and working changes before editing; installer-based Windows folders may not contain Git history.
2. Put these canonical files at the checkout root. `AGENTS.md` tells Codex to read this reference and relevant source. Keep only one maintained project reference there so dated duplicate files do not compete.
3. Verify runtime, dependency pins and test commands from the checkout. Do not infer them solely from this handoff or assume a cloud checkout can see the running Minecraft world.
4. Keep development changes and private live runtime state separate. Stop Mia before applying runtime code changes. Preserve profiles, SQLite/JSON memories and the current world ID; validate in a test world or isolated fixtures as appropriate.
5. Record the actual changed files, checks, revision/publication result and remaining live acceptance work after a meaningful update. Codex development does not replace Mia's Ollama runtime or migrate her memory.

### Current source and verification map

Paths below exist in the checked implementation; planned supervisor modules should be added incrementally under `src/` rather than creating a second parallel `MIA/` runtime.

| Concern | Current paths |
| --- | --- |
| Coordinator and fresh snapshot | `src/core/mainSupervisor.js`, `src/core/worldState.js` |
| Minecraft supervisor bridge | `src/adapters/minecraft/supervisor.js` |
| Physical ownership and immediate reactions | `src/agent/action_manager.js`, `src/agent/managed_goal.js`, `src/agent/modes.js` |
| Managed goals | `src/agent/gather_goal.js`, `src/agent/make_goal.js`, `src/agent/managed_smelting.js`, `src/agent/shelter_goal.js` |
| Shelter and doors | `src/agent/shelter_blueprint.js`, `src/agent/shelter_building.js` |
| Navigation and movement corrections | `src/agent/navigation_policy.js`, `src/agent/navigation_recovery.js`, `src/agent/navigation_progress.js`, `src/agent/position_corrections.js` |
| Live observations and persistence | `src/agent/live_inventory.js`, `src/agent/world_memory_sync.js`, `src/agent/local_memory.js`, `src/agent/memory_runtime.js` |
| Checked-in validation | `package.json` (`test:goals`), `.github/workflows/managed-goals.yml`, `test/main-supervisor.test.js`, `test/shelter-builder.test.js` |

Verified current full-suite command: `npm run test:goals`. The current CI pins Node `22.23.2`; use the checked-in workflow for the Windows interaction and SQLite commands. There is no generic `npm test` or lint script established by the current `package.json`.

Keep native Minecraft 26.3 vendor packages, patches, `minecraft-data` and the lockfile consistent. Preserve JSON/SQLite memory across any upgrade. No model, dependency or memory-schema migration is required merely to adopt these Markdown instructions.

## Working rules for future project chats

- Read this reference and inspect the code relevant to the current task.
- Verify the target branch, revision, and installation before issuing an update.
- Joe explicitly authorized publishing this fix and future Mia updates to `FeelsMan/mindcraft-test` on October 24, 2026 ("yes always"). When asked specifically to merge this fix and publish future tested Mia updates to `develop`, Joe confirmed "yes aswell". This is standing authorization to publish and merge relevant, tested Mia updates into `develop` within the agreed task scope without repeatedly asking. It does not authorize unrelated repositories or projects.
- PR #1 is merged into `develop` at `e81fcab25d0f31fa0e1527b9a55ee4a7af2f8cec`; the prior branch-authorization blocker is resolved. Continue to check the current branch revision, complete relevant checks, and record the actual publication result.
- Preserve memories, profiles, model configuration, world identity, and working capabilities.
- Reuse the managed systems incrementally when adding supervisors.
- Maintain the distinction between agreed trait baselines, proposed tuning rules, and implemented personality behavior. Record evidence behind identity changes.
- Prefer functional progress and verified outcomes over repeated polishing of conversational wording.
- State what changed, why, how it was checked, and what still needs a live test.
- Update this file after a meaningful patch or architecture decision. Record the revision, test command/result, gameplay observation, and unresolved issues separately.
- If another chat has changed the file, read its latest contents and preserve newer information before editing.
- Keep credentials and private keys out of this reference.

## Making this reference available across chats

For Codex, keep `MIA_PROJECT.md` and `AGENTS.md` in the repository root and maintain them with the code. For the mia ChatGPT project, add or replace the project reference in Sources/shared project files as needed. A saved/downloaded document is not proof that it has been copied into the Windows checkout or attached to every project chat. This handoff creates the documents; it does not claim those separate placement steps happened.

Suggested project instruction:

> Read MIA_PROJECT.md before continuing development. Treat its architecture as planned unless implementation is explicitly verified. Check current code and live state, preserve Mia's memories and profiles, and update the reference after meaningful changes.

Official OpenAI project guidance: https://learn.chatgpt.com/docs/projects
