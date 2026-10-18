# Verified starter shelter

`!shelterGoal` builds one fixed oak starter shelter in the Overworld using normal
survival crafting and placement. No generated JavaScript or cheat placement is
needed. The same command finishes or repairs Mia's saved site when reissued.

The 5×5 shell encloses a 3×3 interior with two blocks of headroom. The existing
level ground is its floor. Two layers of perimeter walls leave a two-block
doorway in the north side, and a full roof covers the footprint. Three full
plank blocks form outside access steps at the northwest corner, giving the
builder one-block rises to the roof and a safe route back down.

| Requirement | Quantity |
| --- | ---: |
| Wall and roof oak planks | 55 |
| Outside access-step oak planks | 3 |
| Oak door placed | 1 |
| Additional planks to craft a door batch if no door is held | 6 |
| Logs from an empty inventory, with a usable table | 16 |
| Logs from an empty inventory, also making a table | 17 |

A vanilla door recipe produces three doors; Mia uses one and keeps the two
extras. Already held supplies and confirmed blocks reduce the deficit. Each
gathering/crafting result is checked against inventory; each construction result
is checked against the actual block at its blueprint coordinate. A native
placement call returning successfully is not sufficient evidence.

## Install in an existing Mia folder

Stop Mindcraft and download the distinctly named current installer,
[`mia-world-awareness-fix.cjs`](../scripts/mia-world-awareness-fix.cjs),
and run it from `D:\mai\mindcraft`:

```powershell
node .\mia-world-awareness-fix.cjs --check
node .\mia-world-awareness-fix.cjs --apply
node .\mia-world-awareness-fix.cjs --test
node main.js --profiles .\mia-qwen.json
```

The installer checks known source versions before writing, backs up the changed
files, and preserves profiles, model settings, credentials and actual saved bot
memory. `--restore` rolls back the most recent application. No new dependencies
or model download are required. Fresh repository clones already contain this
code and use `npm.cmd run test:goals` for the complete suite.

## First live test

1. Use a test area with a level, clear **7×7** patch and reachable oak trees.
   Full solid ground is required; holes, liquids, slabs and decaying leaves are
   rejected. Small grass/fern plants and snow layers can be cleared. Existing
   player blocks are not excavated or replaced.
2. To isolate building from resource collection on the first run, give Mia
   **58 oak planks and one oak door**, then send `!shelterGoal`.
3. Watch the outside steps, walls, roof and door. She should use supported work
   positions, cross the open doorway outside and back inside, close the door,
   verify the whole structure, then save the interior as `home` and stop.
4. Reissue `!shelterGoal`. It should verify that same structure and entrance;
   it should not gather supplies or build another house.

Next, repeat in a separate test world/world ID from an empty inventory to test
the complete collection/crafting path. The saved site is intentionally reused
in the same world; moving Mia and sending the command again is not a request to
start a second house. To abandon a bad site, send `!resetShelter`, move to another
level area, then send `!shelterGoal`. Reset cancels a current shelter build and
removes only its working site and matching `home` waypoint in this world and
dimension. Placed blocks, other waypoints, stations and experience history remain.

## Interruptions and honest failures

- Combat and urgent safety actions take priority; building waits and recomputes
  its next step afterward. Routine movement cannot spend the reserved materials
  on scaffolding. Dropped items and experience do not block legal placements.
- Subsequent managed gathering and normal coordinate/player travel use the
  remembered entrance when crossing the shelter boundary, then close its door.
  Routine pathfinding protects the shell, steps and natural floor from being
  mined as a shortcut or resource. Urgent escape can still override preservation.
- A configured stable local-memory world ID retains the blueprint across death
  and restart. No progress counter can invent missing world blocks. Two deaths
  block automatic restoration under the existing memory policy.
- `!endGoal` or `!stop` cancels the saved goal and current action. Placed blocks
  remain; cancellation does not dismantle a partial house or automatically resume.
- Unknown/unloaded ground, blocked routes, insufficient resource progress or two
  unverified attempts stop the goal with its site retained. Address the cause,
  then use `!resumeGoal`. An explicit resume renews the first blocked step's
  bounded attempt; automatic restart/recovery still observes failure cooldowns. Existing
  mismatched blocks are not demolished to force the blueprint through.
- A complete shell is insufficient if the door is partial, incorrectly oriented,
  cannot be opened/crossed, or cannot be closed. `home` is recorded only after
  final live checks. It is a named waypoint, not a bed or respawn setting.

The first version does not flatten terrain, fill foundations, select other
materials, add lighting or beds, furnish the interior, or design custom houses.
Shelter completion alone does not establish autonomous long-term survival.

## Regression coverage

The automated shelter suite runs complete builds with real **1.21.4 and 26.3**
block shapes, raycasting, recipe data, door states and upstream pathfinding.
Only server/physics I/O is simulated. Additional tests cover live inventory
verification, partial builds, changed support, player overlap, small plants,
world/dimension scoping, combat interruption, cancellation and SQLite restart.
Windows runs the interaction and shelter tests using Node **22.23.2**.

Live Minecraft building remains the final check for server timing, physics and
terrain variations. Start with the supplied-material test above, then test
resource gathering and restarting during a partial build.

## Placement and awareness update

Work positions allow for real arrivals near block edges rather than assuming
Mia is centered. Body overlap, other entities, visibility and support are checked
again after moving/equipping/aiming. Up to three alternate approaches share a
15-second budget; after a placement packet, the builder waits for observed blocks
instead of blindly sending another packet. Failures include the target, actual
feet position and the failed guard. Completed cells are re-read on resume.

The safe movement policy now permits actual one-block steps down. Upstream
pathfinder counts to the support block: a setting of 1 accidentally prevented
ordinary cardinal descents. The corrected setting is tested against a two-block
drop that must still be rejected, and against descent from a finished roof.

Each model decision now includes native position, dimension, health/hunger,
yaw/pitch, the aimed-at block within four blocks and a bounded sample of loaded
workstations/ores within twelve blocks. These are current observations, not
screenshot vision. Nearby does not imply reachable. Ordinary movement during
model generation does not cause retry starvation; an inventory or dimension
change does discard the stale decision. Actions verify their world state again.

For the first live retry, keep the partial site and use `!resumeGoal`. Only use
`!resetShelter` if you want to abandon that site. The automatic tests simulate
packet/physics I/O; server timing and live movement still need this gameplay check.
