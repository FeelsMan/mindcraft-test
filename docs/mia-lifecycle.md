# Restart and collection cancellation fixes

This follow-up targets the log where Mia restored `!gatherGoal("oak_log", 32)`
and verified 32/32 logs, but printed listener warnings and restarted more than
once. The memory target restoration itself succeeded.

## Changes

- Repeated action interruption shares one pending cancellation per asynchronous
  plugin operation. In particular, collectblock's `cancelTask()` waits on
  `collectBlock_finished`/`error`; polling it every 25 ms previously accumulated
  listeners. Path stopping continues while the single cancellation settles.
  Listener limits are not raised and warnings are not suppressed.
- A dashboard/settings restart is registered with the parent process before
  requesting the agent's graceful exit. Manual restart and crash recovery can
  no longer both replace the same child. Concurrent pending restart requests
  share one operation. Connect leaves an already starting child alone.
- A child that does not exit is terminated before replacement. If exit still
  cannot be confirmed, the parent reports the failure and does not launch a
  second concurrent child. Stop cancels a pending replacement.
- Restart messages carry the agent's name. A stale previous socket cannot
  clear a newer connection, including while the replacement is logging in.
- The unstuck watchdog is cleared even if movement fails, and it can terminate
  only the action that created it. Shutdown reasons are printed to the console.
- Managed gathering/crafting failures use the action's returned diagnostic;
  `bot.output` has already been cleared by ActionManager. Specific resource/path
  failures now appear in the report and saved goal instead of being discarded.

These changes preserve the existing SQLite schema, world configuration,
inventory verification, and managed-goal checkpoint/replanning behavior. They
do not add autonomous resource exploration or new crafting/building targets.
The Node SQLite experimental warning on older supported Node releases is
unrelated to a collection listener warning.

## Install on an existing Mia installation

The standalone installer requires the native 26.3, station/tools, safe-mining,
and local-memory updates already installed. Stop Mindcraft and run from its
folder:

```powershell
node .\mia-lifecycle-fix.cjs --apply
node main.js --profiles .\andy.json
```

No npm reinstall or memory reset is needed. The installer validates known source
before writing, stores byte-exact rollback copies, and preserves settings,
profiles, keys, dependencies, memory files, and `memory-config.json`.
It supports `--check`, `--verify`, `--test`, and `--restore`.

## Retest

1. Run `!memory` and `!inventory`.
2. Set a log goal a few above the current inventory total near reachable trees.
3. Click dashboard Restart while collection is active. The parent should create
   one replacement; look for `[Mia memory] Restored ...` and the same target.
4. Allow an unstuck/combat interruption if one occurs naturally. Collection
   should resume without accumulating completion/error listeners.
5. Send `!endGoal`, restart, and confirm the target stays cancelled.

At the initial lifecycle revision, the regression suite had 86 passing tests, including actual collectblock
cancellation with 400 interrupt requests, slow ActionManager handoffs, watchdog
cleanup, socket ownership, parent restart races/escalation, and real Node child
process exits/restarts. Existing memory tests cover checkpoints, cancellation,
scope isolation, and cooldowns. Earlier controlled Java 26.3 checks covered
three-process memory recovery, exact remaining materials, and owned table reuse.

## Restart during initialization

The smelting follow-up also handles a dashboard restart before the Minecraft
bot exists. Shutdown coalesces repeated calls, stops new responses/startup work,
and skips chat until the client is in play state. History is saved only after
the initial history-loading stage has completed; an early restart therefore
preserves the existing file. Initialized history updates and saves are awaited
before closing SQLite and exiting. A report, save, chat or close failure is
reported without preventing exit.

This change is included in the current GitHub branch and in
`mia-smelting-command-fix.cjs`, which requires the smelting update first. See
[installation and tests](mia-smelting.md#command-routing-and-startup-restart-follow-up).
The current combined suite has 142 passing tests, including the early-restart
and cleanup-failure regressions.
