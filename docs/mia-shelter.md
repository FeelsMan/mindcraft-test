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

Stop Mindcraft, replace the previous standalone installer with the current
[`mia-crafting-reliability-fix.cjs`](../scripts/mia-crafting-reliability-fix.cjs),
and run it from `D:\mai\mindcraft`:

```powershell
node .\mia-crafting-reliability-fix.cjs --check
node .\mia-crafting-reliability-fix.cjs --apply
node .\mia-crafting-reliability-fix.cjs --test
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
start a second house.

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
  then use `!resumeGoal`; remembered failure cooldowns still apply. Existing
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
