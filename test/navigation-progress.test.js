import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Vec3 from 'vec3';
import pf from 'mineflayer-pathfinder';
import upstreamGoto from 'mineflayer-pathfinder/lib/goto.js';
import { NavigationProgress } from '../src/agent/navigation_progress.js';
import { gotoWithProgress, walkSafely } from '../src/agent/navigation_recovery.js';
import { safeMiningMovements } from '../src/agent/navigation_policy.js';
import { shelterWorld } from './helpers/shelter-world.js';
import { startMakeGoal } from '../src/agent/make_goal.js';
import { installLocalMemory } from '../src/agent/memory_runtime.js';
import { MemoryBank } from '../src/agent/memory_bank.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import minecraftData from 'minecraft-data';

// initBot normally initializes this process-global lookup when logging in.
// Supply the same pinned registry without opening a real server connection.
const originalMc = await import('../src/utils/mcdata.js');
mock.module(new URL('../src/utils/mcdata.js', import.meta.url).href, { namedExports: {
    ...originalMc, getBlockId: name => minecraftData('1.21.4').blocksByName[name]?.id
} });
const { goToGoal, goToPlayer } = await import('../src/agent/library/skills.js');

const at = (x, z = 0, y = 64) => new Vec3(x + 0.5, y, z + 0.5);
const options = { now: 0, stallMs: 100, progressMs: 50 };

test('back-and-forth movement is not useful progress even when the physical stall timer keeps resetting', () => {
    const progress = new NavigationProgress(at(0), 10, options);
    for (let time = 10; time <= 50; time += 10)
        assert.equal(progress.observe(at(time % 20 ? 1 : 0), time % 20 ? 9 : 10, time), null);
    assert.equal(progress.observe(at(0), 10, 60), 'no_progress');
});

test('a valid detour may move farther from the goal while physically reaching new route waypoints', () => {
    const progress = new NavigationProgress(at(0), 5, options);
    const route = [at(-1), at(-2), at(-2, 1), at(-2, 2), at(-1, 2), at(0, 2), at(1, 2)];
    progress.setPath(route);
    for (let i = 0; i < route.length; i++) assert.equal(progress.observe(route[i], 8, 30 * (i + 1)), null);
});

test('re-emitting and mutating the same path cannot manufacture progress in a loop', () => {
    const progress = new NavigationProgress(at(0), 10, options), route = [at(0), at(1), at(2)];
    progress.setPath(route); route.shift();
    assert.equal(progress.route.length, 3, 'The event path is a snapshot, not the array later shifted by pathfinder');
    for (let time = 10; time <= 50; time += 10) {
        progress.setPath([at(0), at(1), at(2)]);
        assert.equal(progress.observe(at(time % 20 ? 1 : 0), 10, time), null);
    }
    assert.equal(progress.observe(at(0), 10, 60), 'no_progress');
});

test('actual stillness and invalid coordinates have separate failure reasons', () => {
    const progress = new NavigationProgress(at(0), 10, { ...options, progressMs: 200 });
    assert.equal(progress.observe(at(0), 10, 100), 'physical_stall');
    assert.equal(progress.observe({ x: NaN, y: 64, z: 0 }, 10, 101), 'invalid_position');
});

test('progress toward the goal works when no path snapshot is available', () => {
    const progress = new NavigationProgress(at(0), 10, options);
    for (let i = 1; i < 8; i++) assert.equal(progress.observe(at(i), 10 - i, i * 40), null);
});

test('a real dig gets a finite allowance which repeated attempts at the same block cannot replenish', () => {
    const progress = new NavigationProgress(at(0), 10, options), work = { key: '1,64,0:1', duration: 150 };
    assert.equal(progress.observe(at(0), 10, 0, work), null);
    assert.equal(progress.observe(at(0), 10, 120, work), null);
    assert.equal(progress.observe(at(0), 10, 150, work), null);
    assert.equal(progress.observe(at(0), 10, 200, work), 'no_progress');
});

function fixture(t) {
    const bot = new EventEmitter(), timers = [], logs = [], controls = [], movements = [];
    bot.entity = { position: at(0) }; bot.game = { dimension: 'overworld' };
    bot.clearControlStates = () => controls.push('clear');
    bot.blockAt = () => null; // No speculative detour through unloaded geometry.
    bot.pathfinder = {
        setMovements(moves) { this.movements = moves; movements.push(moves); },
        setGoal(goal) { this.goal = goal; bot.emit('goal_updated', goal); },
        goto: goal => upstreamGoto(bot, goal),
        getPathTo: () => ({ status: 'success', path: [at(1), at(2), at(10)] })
    };
    t.after(() => { for (const timer of timers) { clearInterval(timer); clearTimeout(timer); } });
    return { bot, timers, logs, controls, movements, policy: () => ({ canDig: false, scafoldingBlocks: [] }),
        opts: { pollMs: 5, stallMs: 1000, progressMs: 40, deadline: Date.now() + 1000, log: message => logs.push(message) } };
}
function clean(bot) {
    assert.equal(bot.navigationRecovery, undefined);
    for (const event of ['path_update', 'goal_updated', 'goal_reached', 'path_stop', 'death', 'end', 'forcedMove'])
        assert.equal(bot.listenerCount(event), 0, event);
}

test('real upstream goto is cancelled during an oscillation and all route listeners are released', async t => {
    const f = fixture(t), route = [at(0), at(1), at(2), at(10)]; let tick = 0;
    f.timers.push(setInterval(() => {
        f.bot.entity.position = at(++tick % 2);
        f.bot.emit('path_update', { status: 'success', path: route });
    }, 5));
    const result = await gotoWithProgress(f.bot, new pf.goals.GoalBlock(10, 64, 0), f.policy(), f.opts);
    assert.equal(result.success, false); assert.equal(result.reason, 'no_progress');
    assert.match(f.logs.at(-1), /no useful progress/); assert.equal(f.bot.pathfinder.goal, null); clean(f.bot);
});

test('an empty upstream path resolution cannot claim actual arrival', async t => {
    const f = fixture(t);
    f.timers.push(setTimeout(() => f.bot.emit('path_update', { status: 'success', path: [] }), 5));
    const result = await gotoWithProgress(f.bot, new pf.goals.GoalBlock(10, 64, 0), f.policy(), f.opts);
    assert.equal(result.reason, 'arrival_unverified'); assert.equal(result.success, false); clean(f.bot);
});

test('stationary mining is given time to finish before walking resumes', async t => {
    const f = fixture(t), target = new pf.goals.GoalBlock(2, 64, 0);
    f.bot.targetDigBlock = { position: at(1), stateId: 1 }; f.bot.digTime = () => 80;
    f.timers.push(setTimeout(() => {
        f.bot.targetDigBlock = null; f.bot.entity.position = at(2); f.bot.emit('goal_reached', target);
    }, 80));
    const result = await gotoWithProgress(f.bot, target, { canDig: true }, { ...f.opts, stallMs: 20, progressMs: 25 });
    assert(result.success); clean(f.bot);
});

test('a progress observation error safely settles goto instead of escaping a timer and killing the process', async t => {
    const f = fixture(t);
    f.bot.targetDigBlock = { position: at(1), stateId: 1 };
    f.bot.digTime = () => { throw Error('World data changed during mining'); };
    const result = await gotoWithProgress(f.bot, new pf.goals.GoalBlock(10, 64, 0), { canDig: true }, f.opts);
    assert.equal(result.success, false); assert.equal(result.reason, 'watchdog_error');
    assert.match(f.logs[0], /World data changed/); clean(f.bot);
});

for (const event of ['death', 'end', 'forcedMove', 'dimension', 'combat']) test(`${event} ends the owned route without cancelling the managed target`, async t => {
    const f = fixture(t), goal = { active: true, item: 'stone_axe', target: 3 };
    f.bot.managedGoal = goal;
    f.timers.push(setTimeout(() => {
        if (event === 'dimension') f.bot.game.dimension = 'the_nether';
        else if (event === 'combat') f.bot.interrupt_code = true;
        else {
            if (event === 'forcedMove') {
                const before = f.bot.entity.position;
                f.bot.entity.position = at(20);
                f.bot.emit('move', before); // Native reply precedes forcedMove.
            }
            f.bot.emit(event);
        }
    }, 5));
    const result = await gotoWithProgress(f.bot, new pf.goals.GoalBlock(10, 64, 0), f.policy(), f.opts);
    assert.equal(result.success, false);
    assert.equal(result.reason, ({ end: 'disconnected', forcedMove: 'world_changed', dimension: 'dimension_changed', combat: 'interrupted' })[event] || event);
    assert.equal(f.bot.managedGoal, goal); assert.equal(goal.target, 3); assert.equal(goal.cancelled, undefined);
    assert.equal(f.bot.pathfinder.goal, null); clean(f.bot);
});

test('small native movement corrections retain the route and cannot replenish its no-progress budget', async t => {
    const f = fixture(t); let tick = 0;
    f.timers.push(setInterval(() => {
        const before = f.bot.entity.position;
        f.bot.entity.position = new Vec3(0.5 + (++tick % 2) * 0.1, 64, 0.5);
        f.bot.emit('move', before); f.bot.emit('forcedMove');
    }, 5));
    const result = await gotoWithProgress(f.bot, new pf.goals.GoalBlock(10, 64, 0), f.policy(), f.opts);
    assert.equal(result.reason, 'no_progress'); assert.equal(result.success, false);
    assert(tick > 1); clean(f.bot); assert.equal(f.bot.listenerCount('move'), 0);
});

test('a route keeps watching for a real relocation after a harmless correction', async t => {
    const f = fixture(t);
    f.timers.push(setTimeout(() => {
        f.bot.emit('move', f.bot.entity.position); f.bot.emit('forcedMove');
        const before = f.bot.entity.position;
        f.bot.entity.position = at(30); f.bot.emit('move', before); f.bot.emit('forcedMove');
    }, 5));
    const result = await gotoWithProgress(f.bot, new pf.goals.GoalBlock(10, 64, 0), f.policy(), f.opts);
    assert.equal(result.reason, 'world_changed'); clean(f.bot); assert.equal(f.bot.listenerCount('move'), 0);
});

test('an old route cannot clear a replacement action goal or its controls', async t => {
    const f = fixture(t), newer = new pf.goals.GoalBlock(20, 64, 0);
    f.timers.push(setTimeout(() => f.bot.pathfinder.setGoal(newer), 5));
    const result = await gotoWithProgress(f.bot, new pf.goals.GoalBlock(10, 64, 0), f.policy(), f.opts);
    assert.equal(result.success, false); assert.equal(f.bot.pathfinder.goal, newer);
    assert.equal(result.reason, 'goal_changed');
    assert.equal(f.controls.length, 0); clean(f.bot);
});

test('the outer recovery loop does not start a detour after another action replaces its goal', async t => {
    const f = fixture(t), newer = new pf.goals.GoalBlock(20, 64, 0), requests = [];
    f.bot.blockAt = p => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' });
    const set = f.bot.pathfinder.setGoal.bind(f.bot.pathfinder);
    f.bot.pathfinder.setGoal = goal => { requests.push(goal); set(goal); };
    f.timers.push(setTimeout(() => f.bot.pathfinder.setGoal(newer), 5));
    assert.equal(await walkSafely(f.bot, at(10), { movements: f.policy, pollMs: 5, progressMs: 40, timeoutMs: 500 }), false);
    assert.equal(f.bot.pathfinder.goal, newer); assert.equal(requests.length, 2);
    assert.equal(f.controls.length, 0); clean(f.bot);
});

test('an explicit upstream path stop ends recovery without starting a fresh route', async t => {
    const f = fixture(t);
    f.timers.push(setTimeout(() => f.bot.emit('path_stop'), 5));
    const result = await gotoWithProgress(f.bot, new pf.goals.GoalBlock(10, 64, 0), f.policy(), f.opts);
    assert.equal(result.reason, 'path_stopped'); assert.equal(result.success, false); clean(f.bot);
});

test('repeated route ownership releases watchdogs and preserves existing world-memory listeners', async t => {
    const f = fixture(t), permanent = () => {};
    f.bot.on('path_update', permanent);
    f.bot.pathfinder.goto = goal => {
        const promise = upstreamGoto(f.bot, goal);
        queueMicrotask(() => {
            f.bot.entity.position = at(goal.x, goal.z); f.bot.emit('goal_reached', goal);
        });
        return promise;
    };
    for (let i = 1; i <= 40; i++) {
        assert((await gotoWithProgress(f.bot, new pf.goals.GoalBlock(i, 64, 0), f.policy(),
            { ...f.opts, deadline: Date.now() + 1000 })).success);
        assert.equal(f.bot.listenerCount('path_update'), 1);
        assert.equal(f.bot.navigationRecovery, undefined);
    }
    f.bot.removeListener('path_update', permanent); clean(f.bot);
});

test('a stalled composite station approach selects another work position with the original face predicate', async t => {
    const f = fixture(t), first = new pf.goals.GoalBlock(8, 64, 0), other = new pf.goals.GoalBlock(8, 64, 2);
    const goal = new pf.goals.GoalCompositeAny([first, other]), originalEnd = goal.isEnd.bind(goal), attempts = [], selectedGoals = [];
    let valid = true;
    goal.isEnd = p => valid && originalEnd(p);
    f.bot.pathfinder.getPathTo = (_policy, selected) => ({ status: 'success', path: [selected.goals?.[0] || first] });
    f.bot.pathfinder.goto = async selected => {
        const p = selected.goals[0]; attempts.push(p); selectedGoals.push(selected);
        if (attempts.length === 1) return; // Upstream resolved without arrival.
        f.bot.entity.position = at(p.x, p.z);
    };
    assert(await walkSafely(f.bot, at(8), { goal, movements: f.policy }));
    assert.equal(attempts.length, 2); assert.equal(attempts[1], other); assert(goal.isEnd(f.bot.entity.position.floored()));
    assert(f.logs.length === 0); // No log callback was supplied in this invocation.
    valid = false; assert(!selectedGoals[1].isEnd(f.bot.entity.position.floored()), 'The alternate must retain current face/support verification'); clean(f.bot);
});

test('safe-route retries remain bounded when all movement merely resolves without arrival', async t => {
    const f = fixture(t); let attempts = 0;
    f.bot.pathfinder.goto = async () => { attempts++; };
    assert.equal(await walkSafely(f.bot, at(10), { movements: f.policy }), false);
    assert.equal(attempts, 1); clean(f.bot);
});

test('managed generic navigation retains the actual composite goal rather than substituting the current position', async () => {
    const f = shelterWorld('26.3');
    f.bot.managedGoal = { active: true, item: 'furnace', target: 1 };
    const goal = new pf.goals.GoalCompositeAny([new pf.goals.GoalBlock(8, 64, 2), new pf.goals.GoalBlock(8, 64, 3)]);
    assert(!goal.isEnd(f.bot.entity.position.floored()));
    assert(await goToGoal(f.bot, goal)); assert(goal.isEnd(f.bot.entity.position.floored()));
    assert(f.policies.every(p => !p.canDig && p.scafoldingBlocks.length === 0));
    assert.equal(f.bot.managedGoal.target, 1);
});

test('ordinary navigation verifies actual arrival and releases its progress owner', async () => {
    const f = shelterWorld('1.21.4'), goal = new pf.goals.GoalBlock(8, 64, 2);
    f.bot.pathfinder.bestHarvestTool = () => null;
    assert(await goToGoal(f.bot, goal)); assert(goal.isEnd(f.bot.entity.position.floored())); clean(f.bot);
});

test('a cancelled player approach cannot announce that the player was reached', async () => {
    const f = shelterWorld('26.3'); f.bot.username = 'Mia';
    f.bot.pathfinder.bestHarvestTool = () => null;
    f.bot.players = { CaptainNeyo: { entity: { position: new Vec3(10, 64, 2) } } };
    f.bot.modes.isOn = () => false; f.bot.modes.pause = () => {};
    f.bot.pathfinder.goto = async () => { f.bot.interrupt_code = true; };
    assert.equal(await goToPlayer(f.bot, 'CaptainNeyo', 3), false);
    assert.doesNotMatch(f.bot.output, /You have reached CaptainNeyo/); clean(f.bot);
});

for (const version of ['1.21.4', '26.3']) test(`actual ${version} A* waypoints allow a wall detour with real goto ownership`, async t => {
    const f = shelterWorld(version), goal = new pf.goals.GoalBlock(5, 64, 2), timers = [];
    t.after(() => timers.forEach(clearInterval));
    for (let z = 0; z <= 4; z++) for (const y of [64, 65, 66]) f.set(new Vec3(3, y, z), 'stone');
    const route = f.bot.pathfinder.getPathTo(safeMiningMovements(f.travel.movements()), goal, 500);
    assert.equal(route.status, 'success'); assert(route.path.length > 3);
    f.bot.pathfinder.setGoal = function(value) { this.goal = value; f.bot.emit('goal_updated', value); };
    f.bot.pathfinder.goto = value => {
        const promise = upstreamGoto(f.bot, value); let step = 0;
        f.bot.emit('path_update', route);
        const timer = setInterval(() => {
            const p = route.path[step++];
            if (!p) { clearInterval(timer); f.bot.emit('goal_reached', value); return; }
            f.bot.entity.position = at(p.x, p.z, p.y);
        }, 5); timers.push(timer); return promise;
    };
    assert(await walkSafely(f.bot, new Vec3(5, 64, 2), { ...f.travel, goal, pollMs: 5, stallMs: 200, progressMs: 200, timeoutMs: 3000 }));
    assert(goal.isEnd(f.bot.entity.position.floored())); clean(f.bot);
    assert(f.policies.every(p => !p.canDig && p.scafoldingBlocks.length === 0));
});

test('a failed route preserves the real SQLite crafting target; manual resume can finish after the obstruction changes', async t => {
    const f = shelterWorld('26.3', { stone_axe: 2, cobblestone: 3, stick: 2 });
    const root = mkdtempSync(join(tmpdir(), 'mia-navigation-goal-'));
    f.agent.memory_bank = new MemoryBank();
    const memory = installLocalMemory(f.agent, { root, config: { world_id: 'navigation-test', embeddings: false } });
    t.after(() => { memory.close(); rmSync(root, { recursive: true, force: true }); });
    // A real three-block-high enclosure prevents the pinned A* planner from
    // escaping without digging. Opening one side later provides a valid route.
    for (const x of [1, 2, 3]) for (const z of [1, 2, 3]) if (x !== 2 || z !== 2)
        for (const y of [64, 65, 66]) f.set(new Vec3(x, y, z), 'stone');
    const api = { hasTable: () => true, verifyTimeoutMs: 1,
        recipes: () => [[{ cobblestone: 3, stick: 2 }, { craftedCount: 1 }]],
        craft: async () => {
            if (!await walkSafely(f.bot, new Vec3(8, 64, 2), { ...f.travel, timeoutMs: 1000 }))
                throw Error('Navigation blocked; target retained.');
            f.stock.cobblestone -= 3; f.stock.stick -= 2; f.stock.stone_axe++;
        }
    };
    await startMakeGoal(f.agent, 'stone_axe', 3, api);
    assert.match(await f.agent.gather_goal.done, /Crafting stopped/);
    assert.equal(memory.pendingGoal().target, 3); assert.equal(memory.pendingGoal().status, 'blocked');
    assert.equal(f.stock.stone_axe, 2); assert.equal(f.stock.cobblestone, 3);
    for (const y of [64, 65, 66]) f.set(new Vec3(3, y, 2), 'air');
    assert(await memory.resume(async command => {
        assert.equal(command, '!makeGoal("stone_axe", 3)');
        return startMakeGoal(f.agent, 'stone_axe', 3, api);
    }, { manual: true }));
    assert.match(await f.agent.gather_goal.done, /Crafting complete: 3\/3/);
    assert.equal(f.stock.stone_axe, 3); assert.equal(memory.pendingGoal().status, 'complete');
});
