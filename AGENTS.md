# AGENTS.md — M.I.A. development

## Start here

This repository develops M.I.A. (Memory, Identity & Agency), a local agent with persistent memory and developing identity. Minecraft is the first adapter. Codex helps develop the code; Mia continues running locally through Ollama.

- Read `MIA_PROJECT.md` before starting Mia work, then inspect only the source/docs relevant to the current request.
- Follow the current user request. The next milestone in the reference is context, not permission to implement unrelated work automatically.
- Check the actual working directory, branch, revision and local changes. Preserve existing user work; never reset or overwrite it to match an old snapshot. A Windows installer-based folder may have no `.git` history.
- Distinguish planned, implemented, automated-tested and live-tested behavior. The project reference and historical test counts are snapshots; current source and fresh observations govern implementation.
- Update `MIA_PROJECT.md` after a meaningful architecture change, patch, verified result or publication. Keep these instructions concise and durable; put release details in the project reference.

## Runtime and source map

- Repository: `https://github.com/FeelsMan/mindcraft-test`; integration branch: `develop`.
- Joe's runtime folder: `D:\mai\mindcraft`; profile: `mia-qwen.json`; model: `mia:qwen9b`; current world ID: `mia-survival-1`; Minecraft: native `26.3`.
- JavaScript uses ESM (`"type": "module"`); retain existing module/style conventions.
- Core: `src/core/mainSupervisor.js`, `src/core/worldState.js`.
- Minecraft bridge: `src/adapters/minecraft/supervisor.js`.
- Ownership/lifecycle: `src/agent/action_manager.js`, `src/agent/managed_goal.js`, `src/agent/modes.js`.
- Managed work: `src/agent/gather_goal.js`, `src/agent/make_goal.js`, `src/agent/managed_smelting.js`, `src/agent/shelter_goal.js`.
- Building/access: `src/agent/shelter_blueprint.js`, `src/agent/shelter_building.js`.
- Navigation/observations: `src/agent/navigation_*.js`, `src/agent/position_corrections.js`, `src/agent/live_inventory.js`, `src/agent/world_memory_sync.js`.
- Persistence: `src/agent/local_memory.js`, `src/agent/memory_runtime.js`.
- Startup memory default: `settings.js`, `src/mindcraft/mindcraft.js`, `src/process/agent_process.js`, `src/process/init_agent.js`. Installer users enable only the existing settings boolean with `scripts/configure-memory-default.cjs --enable`; never replace their settings wholesale.
- Relevant docs are in `docs/mia*.md`; regressions are in `test/`; CI is `.github/workflows/managed-goals.yml`.

The tree in `MIA_PROJECT.md` is the target architecture. Main Supervisor/world state/bridge and Survival Supervisor v1 exist; the other specialized supervisor modules, Personality Supervisor and Memory Manager abstraction remain planned. Survival uses `src/supervisors/survival.js` and `src/adapters/minecraft/survival.js` through the existing tick and ActionManager. Extend the existing `src/` tree incrementally; do not create a competing root `MIA/` runtime.

## Preserve Mia's state and working capabilities

- Preserve `bots/Mia/`, including `memory.json`, `memory.sqlite`, any SQLite sidecar files and `memory-config.json`; preserve profiles, settings, model configuration and world identity.
- Use isolated test fixtures. Do not run tests against, delete, reseed or replace Joe's live memory/world. Stop the running bot before applying runtime code changes.
- Back up affected persistent state before a necessary schema migration; preserve old data and provide a tested recovery path. Do not introduce a migration for documentation-only work.
- Keep world/dimension scope on remembered locations and checkpoints. A LAN port change does not create a new world; a different saved world needs a distinct ID.
- Keep secrets, credentials, private profiles and memory contents out of commits, logs and handoff files. Inspect staged files before committing.
- Preserve native 26.3 vendor packages, runtime patches, pinned compatibility dependencies and lockfile consistency. Do not replace them through blanket dependency upgrades or clean/reinstall commands for an unrelated fix.
- Mia stays on the existing Ollama model unless Joe requests a model change. Implementing a supervisor does not require switching model providers.

## Architecture and action rules

- Exactly one system owns physical actions. Reuse Main Supervisor and Action Manager priorities, identity tokens and handoff lifecycle; specialists execute and the Personality Supervisor advises.
- Do not add an independent background movement loop, a second action scheduler, or an always-running second LLM conversation.
- Live inventory, health/hunger, position and observed blocks override remembered/model-generated state. Unknown or unloaded state stays unknown, not air, missing, safe or complete.
- Verify action outcomes from resulting inventory/world state. An attempted command, an `undefined` return or an optimistic message is not success.
- Preserve the saved goal through temporary interruptions and replan from fresh observations after control returns. Coalesce duplicate resumes; prevent cancelled or superseded queued actions from starting.
- Explicit stop/cancellation remains cancelled across interruptions and restarts. A later explicit new request may start work again.
- Bound retries, route recovery and time without progress. Preserve progress and expose a clear blocked reason rather than resetting deadlines or retrying forever.
- Retain the shelter repair fixes: choose actual supported work positions, use one explicit controller for the owned door, and distinguish harmless local position corrections from real relocation/dimension changes.
- Keep environment-specific execution behind Minecraft adapters where practical; reuse current managed controllers before large refactors.

## Personality direction

Starting values: Curiosity **75**, Caution **45**, Sociability **55**, Independence **65**, Persistence **65**, all out of 100.

- Keep mood, learned preferences/habits and slowly changing core traits distinct.
- Require verified experiences and traceable evidence before identity updates. User-assigned task completion alone does not prove an autonomous preference.
- Technical failures, missing resources, parser errors and pathfinding bugs are debugging/recovery evidence, not reasons to erode personality traits.
- Personality cannot override live state, urgent survival, explicit cancellation or physical action ownership.
- The detailed learning cycle and tuning caps in `MIA_PROJECT.md` remain proposed until implemented and tested; do not report them as running features.

## Verification

Inspect the current `package.json` and CI before choosing commands. At this handoff CI pins Node **22.23.2** and exposes the following checks:

```text
node --version
npm run test:goals
node --test test/crafting-installer.test.cjs
node --test test/local-memory.test.js test/world-memory-sync.test.js
```

For focused supervisor/building regression work:

```text
node --experimental-test-module-mocks --test test/main-supervisor.test.js test/shelter-builder.test.js test/shelter-commands.test.js test/navigation-progress.test.js
```

The complete Windows interaction file list and native-runtime setup steps live in `.github/workflows/managed-goals.yml`. Use it when affected. The checked-in full dependency setup is `npm install --legacy-peer-deps`; do not reinstall a working checkout without a reason. `npm test` and a generic lint command are not defined scripts at this snapshot.

- Add meaningful regression coverage for changed lifecycle, ownership, safety, persistence and interruption behavior. Include cancellation races and failed/blocked outcomes when relevant.
- For runtime code changes, run the relevant focused checks and `npm run test:goals`; use the applicable Windows/native checks for affected behavior. Pure Markdown changes need content, path and command validation, not a new full gameplay suite.
- Keep automated coverage of both native 1.21.4 and 26.3 behavior where the existing affected tests use both.
- If Git-history-dependent installer checks skip, report the skips. A skipped test is not a pass; use a checkout with required history for upgrade/rollback claims.
- If changing installer-embedded files, follow the existing packaging mechanism and update/verify the current release payload. Test backup, exact rollback and preservation of private state. Do not leave a new installer carrying old source bytes.
- Report only checks actually run, their results and material limitations. Never reuse a historical passing count as a fresh result or call a controlled replay a live Minecraft test.

## Survival Supervisor and live acceptance

Survival Supervisor v1 implements earlier threat assessment, bounded sustained recovery, reachable verified shelter/cover, carried-food consumption verification, optional-mode suppression and resumption through Main Supervisor. Keep its configured thresholds and limits testable; initial defaults await live tuning. Retain immediate emergency reactions at higher priority and keep the independent auto-eat plugin disabled. `!supervisor` exposes survival status. Read `docs/mia-survival.md` for the current behavior and packaging command.

During active Survival, hostile damage escape belongs to Survival. Do not re-enable the legacy critical-health `moveAway(20)` path through its priority-100 label: it can pull her out of verified shelter and bypass bounded retreats. Fire, drowning and suffocation still need immediate environmental responses. Recheck cover after fresh damage; older damage before arrival does not invalidate a newly verified refuge. Keep human query results visible in the terminal.

The current outstanding live check is **active shelter repair → one hostile interruption → refreshed conditions → automatic same-site repair resumption → verified completion/released ownership**. It has automated coverage but no reported live pass. Keep the same map/home/world ID; a completed house going straight to `finish` does not test interruption. Separately check cancellation surviving restart. Do not claim any live acceptance passed without Joe's gameplay evidence or an actual observed run.

## GitHub publication and completion

Joe explicitly approved relevant, tested Mia updates to `FeelsMan/mindcraft-test` ("yes always") and confirmed merges/future tested updates to **`develop`** ("yes aswell") on October 24, 2026. This is standing authorization within the requested Mia task scope; do not ask for the same permission again. It does not extend to unrelated repositories, destructive operations or unrequested features.

- Check current remote/base state and preserve others' changes. Use the existing branch/PR workflow when appropriate; avoid force-pushing shared history.
- Complete applicable checks before publishing/merging. If a tooling or policy block occurs, describe the actual block and preserve completed work; do not invent a missing user approval.
- Keep the change scoped, update project context, review the diff for private files, then report the actual commit/PR/merge result.
- For code deliveries, state what changed, why, checks actually run, installation/restart requirements and the next live check. For document deliveries, provide the requested files without claiming they were installed or published unless that happened.
