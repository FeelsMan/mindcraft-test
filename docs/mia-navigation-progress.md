# Navigation progress tracking

Release: `mia-navigation-progress-2026-10-23`.

The earlier route watchdog reset whenever Mia moved 0.2 blocks. Repeated
back-and-forth movement could therefore look healthy until the overall route
deadline, and a failed station approach could select the same work position.

The new tracker separates physical motion from useful route progress:

- A meaningful improvement toward the goal refreshes the progress timer.
- Physically reaching a new waypoint on the current path also counts, so a
  valid detour may initially move farther away from its destination.
- Repeated visits to the same waypoints and repeated path-update events do not
  earn progress again. Pathfinder's mutable path arrays are copied before use.
- Default walking limits are 2.5 seconds of physical stillness or 5 seconds
  without useful progress. Real pathfinder digging has one finite allowance
  per block/state based on the estimated dig time; repeating it cannot renew
  the allowance. The overall route deadline still applies.
- A failed composite station approach excludes that work position for this
  route attempt and selects another supported position with the original
  face/reach/support checks. Other routes can try bounded supported detours.
- Managed routes retain the existing no-dig/no-scaffold policy and target.
  Finite ordinary `goToGoal`/player/position travel also uses the progress
  watchdog and verifies actual arrival. Their movement permissions are retained.

The tracker owns its watchdog, cancellation, and listeners. Combat, death,
disconnect, teleport, dimension change, or another action replacing the goal
ends that route without allowing the old watchdog to clear the new action.
All safe alternatives exhausting their budget blocks the managed goal with its
original item/quantity saved for `!resumeGoal`. It never treats walking as
collection or crafting success.

Route-waypoint visits and excluded work positions are bounded session state,
not permanent world knowledge. A short-lived route failure does not erase an
owned station or permanently mark a place unreachable. Existing live-world
observation and saved-goal recovery continue to handle changed surroundings.
Continuous following and combat/fleeing controllers retain their existing loops;
this patch targets finite travel and managed crafting/gathering/building routes.

## Install

Stop Mindcraft and save `mia-navigation-progress-fix.cjs` beside `main.js`:

```powershell
node .\mia-navigation-progress-fix.cjs --apply
node .\mia-navigation-progress-fix.cjs --test
node main.js --profiles .\mia-qwen.json
```

`--check` previews source compatibility. `--verify` checks installed source.
`--restore`, with Mindcraft stopped, restores the exact previous source bytes.
The cumulative installer accepts the published station-pickup build and earlier
supported builds. It preserves profiles, settings, credentials, world IDs and
actual JSON/SQLite memory; no model/dependency download or schema migration is
needed. Fresh Git checkouts use `npm.cmd run test:goals`.

## Live tests

Test in daylight on supported ground, with enough food and a usable pickaxe.
Allow each task to finish before starting the next.

1. Send `!makeGoal("furnace", 1)` with the owned crafting table nearby and an
   accessible exposed stone face. If a furnace is already held, choose a total
   target one higher than the current inventory. Confirm the normal task still
   gathers only missing materials and verifies the target in inventory.
2. Put a two-block-high wall across the direct route while leaving a walkable
   way around it. Ask Mia to come to you across the wall. She should take a
   valid detour, verify arrival, and retain the shelter/stations.
3. During a managed goal, temporarily obstruct one approach to the crafting
   table while keeping a different supported visible work position accessible.
   If the first route stalls, expect a progress/stall report followed by a
   different supported work position or detour. Verify the original item target.
4. Fully obstruct the available approaches without damaging Mia. She should
   stop after bounded recovery and save the unfinished target. Clear the
   obstruction and send `!resumeGoal`; verify completion from actual supplies.
5. Use `!stop` or `!endGoal` during movement. Confirm the route ends and does
   not resume after cancellation. Test combat recovery separately once normal
   navigation passes.

Useful log messages include `Navigation made no useful progress`,
`Navigation physically stalled`, `selecting a different supported work
position`, and the existing verified completion report. A route that succeeds
normally need not print a recovery message.

## Automated verification

Replays test oscillation, repeated path events, legitimate detours, bounded
digging, empty-path false success, alternate work positions, interruptions and
listener cleanup. Native 1.21.4 and 26.3 fixtures use the pinned upstream A*
planner and actual block data with controlled movement I/O. A real SQLite test
keeps the three-axe target through a blocked route, opens the obstruction, and
manually resumes to a verified 3/3 total. These tests do not replace the live
world checks above.
