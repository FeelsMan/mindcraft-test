import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Vec3 from 'vec3';
import goto from 'mineflayer-pathfinder/lib/goto.js';
import { walkSafely, safeWaypoints, planSafePath } from '../src/agent/navigation_recovery.js';
import { collectWithRecovery, restoredResourceSearch, RESOURCE_SEARCH_LIMIT } from '../src/agent/resource_recovery.js';
import { logStandingPositions, findSafeLogTargets, collectLogFromSide } from '../src/agent/safe_stone.js';

const position = x => new Vec3(x, 64, 0);
function botFixture() {
    const bot = new EventEmitter(), stock = {}, blocks = new Map();
    bot.entity = { position: position(0) };
    bot.game = { dimension: 'overworld' };
    bot.inventory = { items: () => Object.entries(stock).map(([name, count]) => ({ name, count })) };
    const block = (name, p) => ({ name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', canHarvest: () => true });
    bot.blockAt = p => blocks.get(p.floored().toString()) || block(p.y < 64 ? 'dirt' : 'air', p.floored());
    bot.clearControlStates = () => {};
    const policies = [], moves = [];
    bot.pathfinder = {
        getPathTo: () => ({ status: 'success' }),
        setMovements: policy => policies.push(policy),
        setGoal(goal) { this.goal = goal; bot.emit('goal_updated', goal); },
        async goto(goal) { moves.push(goal); bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); }
    };
    const movements = () => ({ scafoldingBlocks: [1, 2], allow1by1towers: true, canDig: true });
    return { bot, stock, blocks, block, policies, moves, movements };
}

test('safe waypoints exclude unloaded cells, liquids, unsupported feet and low ceilings', () => {
    const f = botFixture();
    f.blocks.set(position(16).toString(), f.block('lava', position(16)));
    f.blocks.set(new Vec3(-16, 63, 0).toString(), f.block('air', new Vec3(-16, 63, 0)));
    const old = f.bot.blockAt;
    f.bot.blockAt = p => p.z === 16 ? null : old(p);
    const points = safeWaypoints(f.bot, { radii: [16] });
    assert(!points.some(p => p.equals(position(16))));
    assert(!points.some(p => p.equals(position(-16))));
    assert(!points.some(p => p.z === 16));
    assert(points.some(p => p.z === -16));
});

test('navigation proves arrival and always disables digging, scaffolding and long drops', async () => {
    const f = botFixture();
    assert(await walkSafely(f.bot, position(10), { movements: f.movements }));
    assert.equal(f.bot.navigationRecovery, undefined);
    assert(f.policies.every(p => p.canDig === false && p.maxDropDown === 2 && p.scafoldingBlocks.length === 0));
    f.bot.pathfinder.goto = async () => {}; // Upstream goto can resolve an empty path.
    assert.equal(await walkSafely(f.bot, position(40), { movements: f.movements }), false);
});

test('navigation tries a supported detour after a blocked route', async () => {
    const f = botFixture();
    f.bot.pathfinder.getPathTo = (_moves, goal) => ({ status:
        goal.x === 10 && f.bot.entity.position.x === 0 ? 'noPath' : 'success' });
    assert(await walkSafely(f.bot, position(10), { movements: f.movements }));
    assert(f.moves.length >= 2);
    assert.equal(f.moves.at(-1).x, 10);
});

test('a partial path-search slice continues to success within the planning budget', async () => {
    const f = botFixture(); let slices = 0, closed = false;
    f.bot.pathfinder.getPathFromTo = function* () {
        try {
            slices++; yield { result: { status: 'partial' } };
            slices++; yield { result: { status: 'success' } };
        } finally { closed = true; }
    };
    const result = await planSafePath(f.bot, f.movements(), {}, 100);
    assert.equal(result.status, 'success'); assert.equal(slices, 2); assert(closed);
});

test('path planning yields to cancellation and closes its search generator', async () => {
    const f = botFixture(); let closed = false;
    f.bot.pathfinder.getPathFromTo = function* () {
        try { f.bot.interrupt_code = true; yield { result: { status: 'partial' } }; }
        finally { closed = true; }
    };
    assert.equal((await planSafePath(f.bot, f.movements(), {})).status, 'interrupted');
    assert(closed);
});

test('a physical stall settles real pathfinder goto and releases all navigation listeners', async () => {
    const f = botFixture();
    f.bot.pathfinder.goto = goal => goto(f.bot, goal);
    const before = Date.now();
    assert.equal(await walkSafely(f.bot, position(10), {
        movements: f.movements, timeoutMs: 80, stallMs: 20, pollMs: 5
    }), false);
    assert(Date.now() - before < 500);
    for (const name of ['goal_reached', 'path_update', 'goal_updated', 'path_stop']) assert.equal(f.bot.listenerCount(name), 0);
    assert.equal(f.bot.pathfinder.goal, null);
});

test('combat interruption stops a managed path before another action can take ownership', async () => {
    const f = botFixture();
    f.bot.pathfinder.goto = goal => goto(f.bot, goal);
    const timer = setTimeout(() => { f.bot.interrupt_code = true; }, 10);
    try {
        assert.equal(await walkSafely(f.bot, position(10), { movements: f.movements, pollMs: 5 }), false);
        assert.equal(f.bot.pathfinder.goal, null);
        assert.equal(f.bot.listenerCount('goal_updated'), 0);
    } finally { clearTimeout(timer); }
});

function searchFixture() {
    const f = botFixture(), goal = { active: true, cancelled: false, item: 'furnace', target: 1 }, saved = [];
    f.bot.localMemory = { checkpoint: g => saved.push(JSON.parse(JSON.stringify(g.resourceSearch))) };
    const trips = [], messages = [];
    const api = {
        collect: async () => false, memories: () => [],
        waypoints: () => [position(f.bot.entity.position.x + 16)],
        move: async p => { trips.push(p); f.bot.entity.position = p; return true; },
        log: m => messages.push(m)
    };
    return { ...f, goal, saved, trips, messages, api };
}

test('resource recovery moves to another area, rescans and returns only a mined result', async () => {
    const f = searchFixture(); let scans = 0;
    f.api.collect = async () => {
        scans++;
        if (f.bot.entity.position.x < 16) return false;
        f.stock.cobblestone = 1; return true;
    };
    assert(await collectWithRecovery(f.bot, f.goal, 'cobblestone', f.api));
    assert.equal(scans, 2); assert.equal(f.trips.length, 1);
    assert.equal(f.goal.resourceSearch.cobblestone.attempts, 1);
    assert.equal(f.saved[1].cobblestone.attempts, 1, 'Attempt checkpoint precedes travel');
});

test('a stale remembered area is rechecked and exploration continues elsewhere', async () => {
    const f = searchFixture();
    f.api.memories = () => [position(16)];
    f.api.collect = async () => {
        if (f.bot.entity.position.x < 32) return false;
        f.stock.cobblestone = 1; return true;
    };
    assert(await collectWithRecovery(f.bot, f.goal, 'cobblestone', f.api));
    assert.deepEqual(f.trips.map(p => p.x), [16, 32]);
});

test('unavailable resources stop at the search limit without claiming travel as collection', async () => {
    const f = searchFixture();
    f.api.waypoints = () => [position(16), position(32), position(48), position(64), position(80), position(96),
        new Vec3(16, 64, 16), new Vec3(32, 64, 16)];
    assert.equal(await collectWithRecovery(f.bot, f.goal, 'cobblestone', f.api), false);
    assert.equal(f.trips.length, RESOURCE_SEARCH_LIMIT);
    assert.equal(f.stock.cobblestone, undefined);
    assert.match(f.messages.at(-1), /no verified cobblestone gain/);
    const resumed = { ...f.goal, resourceSearch: restoredResourceSearch(f.goal.resourceSearch) };
    await collectWithRecovery(f.bot, resumed, 'cobblestone', f.api);
    assert.equal(f.trips.length, RESOURCE_SEARCH_LIMIT, 'Restart cannot replenish the exploration budget');
});

test('resource recovery charges interrupted attempts and does not continue after cancellation', async () => {
    const f = searchFixture();
    f.api.move = async () => { f.goal.cancelled = true; return false; };
    assert.equal(await collectWithRecovery(f.bot, f.goal, 'oak_log', f.api), false);
    assert.equal(f.goal.resourceSearch.oak_log.attempts, 1);
    assert.equal(f.saved.at(-1).oak_log.attempts, 1);
});

test('partial movement rescans newly loaded surroundings instead of following stale waypoints', async () => {
    const f = searchFixture();
    f.api.move = async p => { f.trips.push(p); f.bot.entity.position = position(8); return false; };
    f.api.collect = async () => {
        if (f.bot.entity.position.x < 8) return false;
        f.stock.oak_log = 1; return true;
    };
    assert(await collectWithRecovery(f.bot, f.goal, 'oak_log', f.api));
    assert.equal(f.trips.length, 1);
});

test('a dimension change during exploration stops further gathering and travel', async () => {
    const f = searchFixture(); let scans = 0;
    f.api.collect = async () => { scans++; return false; };
    f.api.move = async () => { f.bot.game.dimension = 'the_nether'; return false; };
    assert.equal(await collectWithRecovery(f.bot, f.goal, 'oak_log', f.api), false);
    assert.equal(scans, 1);
    assert.equal(f.goal.resourceSearch.oak_log.attempts, 1);
});

test('resource recovery does not travel to far-away or invalid remembered coordinates', async () => {
    const f = searchFixture();
    f.api.memories = () => [position(300), { x: NaN, y: 64, z: 0 }];
    f.api.waypoints = () => [];
    assert.equal(await collectWithRecovery(f.bot, f.goal, 'oak_log', f.api), false);
    assert.equal(f.trips.length, 0);
});

test('a remembered local failure skips local mining and attempts a different area', async () => {
    const f = searchFixture(); f.goal.skipResourceArea = true;
    f.api.collect = async () => {
        assert(f.bot.entity.position.x >= 16); f.stock.oak_log = 1; return true;
    };
    assert(await collectWithRecovery(f.bot, f.goal, 'oak_log', f.api));
});

test('restored search data rejects malformed state and bounds saved locations', () => {
    assert.deepEqual(restoredResourceSearch({ oak_log: { origin: position(0), attempts: -1 } }), {});
    assert.deepEqual(restoredResourceSearch({ oak_log: { origin: position(0), attempts: 99 } }), {});
    const data = restoredResourceSearch({ oak_log: { origin: position(0), attempts: 1,
        visited: Array.from({ length: 100 }, (_, i) => position(i)) } });
    assert.equal(data.oak_log.visited.length, 20);
});

test('logs are gathered from reachable supported sides without collecting the support underneath', async () => {
    const f = botFixture(); const target = f.block('oak_log', position(2));
    f.blocks.set(target.position.toString(), target);
    assert(logStandingPositions(f.bot, target).length > 0);
    assert.deepEqual(logStandingPositions(f.bot, f.block('oak_log', new Vec3(0, 63, 0))), []);
    f.bot.findBlocks = opts => { assert(opts.useExtraInfo(target)); return [target.position]; };
    assert.deepEqual(findSafeLogTargets(f.bot, 'oak_log', () => true), [target]);
    f.bot.tool = { equipForBlock: async () => {} };
    f.bot.dig = async b => { f.blocks.set(b.position.toString(), f.block('air', b.position)); };
    assert(await collectLogFromSide(f.bot, [target], { movements: f.movements, canBreak: () => true }));
    assert(f.policies.every(p => p.scafoldingBlocks.length === 0));
});
