import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Vec3 from 'vec3';
import minecraftData from 'minecraft-data';
import prismarineBlock from 'prismarine-block';
import prismarineWorld from 'prismarine-world';
import goto from 'mineflayer-pathfinder/lib/goto.js';
import { stationWorkGoal, supportedStationSpace, approachStation, canUseStation, placeSupportedStation } from '../src/agent/station_access.js';
import { getNearestFreeSpace } from '../src/agent/library/world.js';
import { stoneStandingPositions } from '../src/agent/safe_stone.js';

// Use real block shapes, upstream raycasting and goal predicates. Replace only
// movement/packet I/O; the native 26.3 fixture exercises those boundaries too.
const data = minecraftData('1.21.4'), Block = prismarineBlock('1.21.4'), World = prismarineWorld('1.21.4');
function fixture() {
    const bot = new EventEmitter(), blocks = new Map(), calls = [], controls = {};
    const stock = { crafting_table: 1 };
    bot.entity = { position: new Vec3(0.5, 64, 0.5), height: 1.8 };
    bot.game = { dimension: 'overworld' }; bot.output = '';
    const make = (name, position) => {
        const block = Block.fromStateId(data.blocksByName[name].minStateId, 0);
        block.position = position.floored(); return block;
    };
    const set = (p, name) => blocks.set(p.floored().toString(), name === null ? null : make(name, p));
    bot.blockAt = p => blocks.has(p.floored().toString()) ? blocks.get(p.floored().toString()) : make(p.y < 64 ? 'stone' : 'air', p);
    bot.world = new World().sync; bot.world.getBlock = bot.blockAt;
    bot.inventory = { items: () => Object.entries(stock).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) };
    bot.clearControlStates = () => {};
    bot.setControlState = (name, value) => { controls[name] = value; };
    bot.getControlState = name => Boolean(controls[name]);
    bot.equip = async item => { calls.push(['equip', item.name]); };
    bot.lookAt = async () => {};
    bot.placeBlock = async (support, face) => {
        calls.push(['place', support.position.clone(), face.clone()]);
        const p = support.position.plus(face); set(p, 'crafting_table'); stock.crafting_table--;
    };
    const end = goal => (goal.goals || [goal]).map(g => new Vec3(g.x, g.y, g.z)).find(p => goal.isEnd(p));
    const policies = [];
    bot.pathfinder = {
        getPathTo: (_moves, goal) => ({ status: end(goal) ? 'success' : 'noPath' }),
        setMovements: policy => policies.push(policy),
        setGoal(goal) { this.goal = goal; bot.emit('goal_updated', goal); },
        async goto(goal) {
            const p = end(goal); assert(p);
            calls.push(['move', p]); bot.entity.position = p.offset(0.5, 0, 0.5);
        }
    };
    const candidates = [new Vec3(2, 64, 0)];
    bot.findBlocks = options => candidates.filter(p => options.matching(bot.blockAt(p)) &&
        (!options.useExtraInfo || options.useExtraInfo(bot.blockAt(p))));
    const api = { movements: () => ({ canDig: true, scafoldingBlocks: [1], allow1by1towers: true }), log: message => calls.push(['log', message]) };
    return { bot, stock, calls, set, candidates, policies, api, controls };
}

test('station support rejects plants, liquids, hazards, unloaded blocks and player overlap', () => {
    const f = fixture(), p = new Vec3(2, 64, 0);
    for (const name of ['poppy', 'water', 'lava', 'magma_block', 'campfire', null]) {
        f.set(p.offset(0, -1, 0), name);
        assert.equal(supportedStationSpace(f.bot, p), false, String(name));
    }
    f.set(p.offset(0, -1, 0), 'bedrock');
    assert(supportedStationSpace(f.bot, p), 'A solid floor need not be diggable or drop an item');
    assert.equal(supportedStationSpace(f.bot, new Vec3(0, 64, 0)), false);
    assert.equal(supportedStationSpace(f.bot, new Vec3(0, 65, 0)), false);
});

test('general free-space lookup requires an empty top and a genuinely solid floor', () => {
    const f = fixture(), bad = new Vec3(2, 64, 0), good = new Vec3(3, 64, 0);
    f.set(bad.offset(0, -1, 0), 'poppy');
    f.candidates.push(good);
    assert.deepEqual(getNearestFreeSpace(f.bot), good);
    f.set(good, 'stone');
    assert.equal(getNearestFreeSpace(f.bot), undefined);
});

test('underground cave air is a valid empty station space with supported, visible access', async () => {
    const f = fixture(), p = f.candidates[0]; f.set(p, 'cave_air');
    assert.deepEqual(getNearestFreeSpace(f.bot), p);
    const placed = await placeSupportedStation(f.bot, 'crafting_table', f.api);
    assert.deepEqual(placed.position, p); assert(canUseStation(f.bot, p));
});

test('a close station behind a wall requires a different visible supported work position', async () => {
    const f = fixture(), p = new Vec3(3, 64, 0);
    f.set(p, 'crafting_table');
    f.set(new Vec3(2, 64, 0), 'stone'); f.set(new Vec3(2, 65, 0), 'stone');
    f.bot.entity.position = new Vec3(1.5, 64, 0.5);
    assert.equal(canUseStation(f.bot, p), false);
    assert(await approachStation(f.bot, p, f.api));
    assert(canUseStation(f.bot, p));
    assert(f.calls.some(c => c[0] === 'move'));
    assert(f.policies.every(m => !m.canDig && !m.allow1by1towers && m.scafoldingBlocks.length === 0));
});

test('owned furnaces use the same actual face and work-position verification', async () => {
    const f = fixture(), p = new Vec3(8, 64, 0); f.set(p, 'furnace');
    assert.equal(canUseStation(f.bot, p), false);
    assert(await approachStation(f.bot, p, f.api));
    assert(canUseStation(f.bot, p));
});

test('standing on a furnace is a valid visible work position and needs no packing trip', async () => {
    const f = fixture(), p = new Vec3(0, 64, 0); f.set(p, 'furnace');
    f.bot.entity.position = new Vec3(0.5, 65, 0.5);
    f.api.prepareTravel = async () => assert.fail('Using the current position must not retrieve a distant table');
    assert(canUseStation(f.bot, p));
    assert(await approachStation(f.bot, p, f.api));
    assert.equal(f.calls.filter(c => c[0] === 'move').length, 0);
});

test('stations above or below the current floor use real face reach rather than a fixed height band', async () => {
    for (const y of [62, 66]) {
        const f = fixture(), p = new Vec3(2, y, 0); f.set(p, 'furnace');
        if (y === 62) {
            f.set(p.offset(0, 1, 0), 'air');
            f.set(new Vec3(1, 63, 0), 'air'); // An open view over the edge, retaining the bot's support.
        }
        f.api.prepareTravel = async () => assert.fail('The visible station is already in reach');
        assert(canUseStation(f.bot, p), String(y));
        assert(await approachStation(f.bot, p, f.api));
    }
});

test('expanded station heights still reject walls, missing support and out-of-reach blocks', () => {
    const f = fixture(), p = new Vec3(2, 66, 0); f.set(p, 'furnace');
    f.set(new Vec3(1, 65, 0), 'stone'); f.set(new Vec3(1, 66, 0), 'stone');
    assert.equal(canUseStation(f.bot, p), false);
    f.set(new Vec3(1, 65, 0), 'air'); f.set(new Vec3(1, 66, 0), 'air');
    f.set(new Vec3(0, 63, 0), null);
    assert.equal(canUseStation(f.bot, p), false);
    const distant = new Vec3(0, 72, 0); f.set(distant, 'furnace');
    assert.equal(canUseStation(f.bot, distant), false);
});

test('floor ore work positions respect actual raycasting and never mine the current support', () => {
    const f = fixture(), p = new Vec3(1, 63, 0); f.set(p, 'iron_ore');
    assert(stoneStandingPositions(f.bot, f.bot.blockAt(p)).some(at => at.equals(new Vec3(0, 64, 0))));
    assert.deepEqual(stoneStandingPositions(f.bot, f.bot.blockAt(new Vec3(0, 63, 0))), []);
});

test('overhead ore uses eye-to-face reach and rejects an intervening wall', () => {
    const f = fixture(), p = new Vec3(2, 66, 0); f.set(p, 'iron_ore');
    f.set(p.offset(0, -1, 0), 'stone');
    const current = new Vec3(1, 64, 0);
    assert(stoneStandingPositions(f.bot, f.bot.blockAt(p)).some(at => at.equals(current)));
    f.set(new Vec3(1, 66, 0), 'stone'); // Keep the standing cell/head clear; only obstruct the ray.
    assert.equal(stoneStandingPositions(f.bot, f.bot.blockAt(p)).some(at => at.equals(current)), false);
});

test('work positions reject low ceilings and unsupported ground; missing geometry is not usable', () => {
    const f = fixture(), p = new Vec3(3, 64, 0); f.set(p, 'crafting_table');
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (const y of [63, 64, 65])
        f.set(p.offset(x, y - 64, z), null);
    f.set(p, 'crafting_table');
    assert.equal(stationWorkGoal(f.bot, p), null);
    assert.equal(canUseStation(f.bot, p), false);
});

test('failed and falsely successful movement cannot claim station access', async () => {
    const f = fixture(), p = new Vec3(10, 64, 0); f.set(p, 'crafting_table');
    f.bot.pathfinder.goto = async () => {};
    assert.equal(await approachStation(f.bot, p, f.api, { timeoutMs: 50 }), false);
    assert.equal(canUseStation(f.bot, p), false);
    assert.equal(f.bot.navigationRecovery, undefined);
});

test('supported placement skips invalid ground, persists intent and verifies the actual block', async () => {
    const f = fixture(), bad = new Vec3(2, 64, 0), good = new Vec3(3, 64, 0);
    f.set(bad.offset(0, -1, 0), 'poppy'); f.candidates.push(good);
    let intent;
    const block = await placeSupportedStation(f.bot, 'crafting_table', f.api, p => { intent = p; assert.equal(f.calls.filter(c => c[0] === 'place').length, 0); });
    assert.deepEqual(intent, good); assert.deepEqual(block.position, good);
    assert.equal(f.stock.crafting_table, 0);
    assert.equal(f.calls.filter(c => c[0] === 'place').length, 1);
    assert.equal(f.controls.sneak, false);
    assert(canUseStation(f.bot, good));
});

test('a placement API return without a block update fails verification and preserves intent', async () => {
    const f = fixture(); let intent;
    f.bot.placeBlock = async () => {};
    await assert.rejects(placeSupportedStation(f.bot, 'crafting_table', f.api, p => { intent = p; }, { verifyMs: 1 }), /Could not verify/);
    assert(intent); assert.equal(f.stock.crafting_table, 1); assert.equal(f.controls.sneak, false);
});

test('a placement exception after the real block appears is reconciled; sneak state is restored', async () => {
    const f = fixture(), place = f.bot.placeBlock; f.controls.sneak = true;
    f.bot.placeBlock = async (...args) => { await place(...args); throw Error('Late packet response'); };
    assert.equal((await placeSupportedStation(f.bot, 'crafting_table', f.api)).name, 'crafting_table');
    assert.equal(f.controls.sneak, true);
});

test('an interruption before the packet prevents placement and ends movement ownership', async () => {
    const f = fixture(); f.bot.lookAt = async () => { f.bot.interrupt_code = true; };
    assert.equal(await placeSupportedStation(f.bot, 'crafting_table', f.api), null);
    assert.equal(f.calls.filter(c => c[0] === 'place').length, 0);
    assert.equal(f.controls.sneak, false); assert.equal(f.bot.navigationRecovery, undefined);
});

test('a dimension change during placement cannot confirm ownership in the new dimension', async () => {
    const f = fixture(); f.bot.placeBlock = async () => { f.bot.game.dimension = 'the_nether'; };
    assert.equal(await placeSupportedStation(f.bot, 'crafting_table', f.api), null);
});

test('changed support after equipping is rechecked before any placement packet or ownership intent', async () => {
    const f = fixture(); let intent = false;
    f.bot.equip = async () => { f.set(f.candidates[0].offset(0, -1, 0), 'air'); };
    assert.equal(await placeSupportedStation(f.bot, 'crafting_table', f.api, () => { intent = true; }), null);
    assert.equal(intent, false); assert.equal(f.calls.filter(c => c[0] === 'place').length, 0);
});

test('interrupted station access settles real goto and removes its navigation listeners', async () => {
    const f = fixture(), p = new Vec3(10, 64, 0); f.set(p, 'crafting_table');
    f.bot.pathfinder.goto = goal => goto(f.bot, goal);
    const timer = setTimeout(() => { f.bot.interrupt_code = true; }, 10);
    try {
        assert.equal(await approachStation(f.bot, p, f.api, { timeoutMs: 200 }), false);
        assert.equal(f.bot.navigationRecovery, undefined); assert.equal(f.bot.pathfinder.goal, null);
        for (const event of ['goal_reached', 'path_update', 'goal_updated', 'path_stop']) assert.equal(f.bot.listenerCount(event), 0);
    } finally { clearTimeout(timer); }
});
