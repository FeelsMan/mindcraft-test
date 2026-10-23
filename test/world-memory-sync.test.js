import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Vec3 from 'vec3';
import { installLocalMemory } from '../src/agent/memory_runtime.js';
import { MemoryBank } from '../src/agent/memory_bank.js';
import { CraftingStation, hasReusableTable } from '../src/agent/crafting_station.js';
import { ManagedFurnace } from '../src/agent/managed_smelting.js';
import { captureWorld, worldChanged, worldContext } from '../src/agent/live_inventory.js';
import { shelterBlueprint } from '../src/agent/shelter_blueprint.js';
import { ActionManager } from '../src/agent/action_manager.js';
import { startMakeGoal } from '../src/agent/make_goal.js';

const cleanup = new WeakMap();
function fixture(t, { root, unloaded = false, world = 'test-world' } = {}) {
    if (!cleanup.has(t)) {
        const resources = { roots: new Set(), memories: [] }; cleanup.set(t, resources);
        t.after(() => {
            for (const memory of resources.memories.reverse()) memory.close();
            for (const path of resources.roots) rmSync(path, { recursive: true, force: true });
        });
    }
    root ||= mkdtempSync(join(tmpdir(), 'mia-world-memory-')); cleanup.get(t).roots.add(root);
    const bot = new EventEmitter(), stock = {}, blocks = new Map(), absentChunks = new Set();
    bot.world = new EventEmitter(); bot.game = { dimension: 'overworld' };
    bot.entity = { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0 };
    bot.inventory = new EventEmitter();
    bot.inventory.items = () => Object.entries(stock).filter(([, n]) => n > 0).map(([name, count]) => ({ name, count }));
    bot.modes = { getActiveModes: () => [] }; bot.clearControlStates = () => {};
    bot.registry = { blocksByName: { crafting_table: { id: 1 }, furnace: { id: 2 }, iron_ore: { id: 3 }, oak_door: { id: 4 } } };
    const block = (name, p, properties = {}) => ({ name, position: new Vec3(p.x, p.y, p.z),
        boundingBox: ['air', 'cave_air'].includes(name) ? 'empty' : 'block',
        stateId: Object.values(bot.registry.blocksByName).find(b => b.name === name)?.id,
        getProperties: () => ({ ...properties }) });
    const key = p => `${bot.game.dimension}:${p.x},${p.y},${p.z}`;
    let allUnloaded = unloaded;
    bot.blockAt = p => allUnloaded || absentChunks.has(`${bot.game.dimension}:${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`) ? null :
        blocks.get(key(p)) || block('air', p);
    bot.findBlocks = ({ matching, count }) => [...blocks.values()].filter(b =>
        b.position.distanceTo(bot.entity.position) <= 12 && matching.some(id => bot.registry.blocksByName[b.name]?.id === id) &&
        bot.blockAt(b.position)?.name === b.name).slice(0, count).map(b => b.position);
    bot.blockAtCursor = () => bot.blockAt(new Vec3(3, 64, 0));
    const stops = [];
    const agent = { name: 'Mia', bot, memory_bank: new MemoryBank(), prompter: { profile: {} },
        actions: { executing: false, currentActionLabel: '', stop: async reason => stops.push(reason) },
        history: { save: async () => {} } };
    const memory = installLocalMemory(agent, { root, config: { world_id: world, embeddings: false }, worldSync: { flushMs: 60000 } });
    assert(memory?.enabled); cleanup.get(t).memories.push(memory);
    const set = (name, p = new Vec3(3, 64, 0), properties = {}, emit = true) => {
        const old = bot.blockAt(p), next = block(name, p, properties); blocks.set(key(p), next);
        if (emit) bot.world.emit('blockUpdate', old, next);
        return next;
    };
    const own = (name, p = new Vec3(3, 64, 0), metadata = {}) => {
        set(name, p);
        const record = { position: { x: p.x, y: p.y, z: p.z }, dimension: bot.game.dimension,
            pendingPlacement: false, ...(name === 'crafting_table' ? { pickupMinimum: null } : {}), ...metadata };
        if (name === 'crafting_table') {
            bot.craftingStation = new CraftingStation(bot, { blockAt: q => bot.blockAt(q) });
            bot.craftingStation.record = record; memory.saveStation(record);
        } else {
            bot.managedFurnace = new ManagedFurnace(bot, { blockAt: q => bot.blockAt(q) });
            bot.managedFurnace.record = record; memory.saveFurnace(record);
        }
        return record;
    };
    return { agent, bot, memory, sync: memory.worldSync, root, stock, blocks, set, own, stops,
        unload(p = new Vec3(0, 0, 0)) { absentChunks.add(`${bot.game.dimension}:${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`); bot.emit('chunkColumnUnload', p); },
        load(p = new Vec3(0, 0, 0)) { allUnloaded = false; absentChunks.delete(`${bot.game.dimension}:${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`); bot.emit('chunkColumnLoad', p); } };
}

test('breaking a loaded owned table invalidates it immediately and preserves verified history', t => {
    const f = fixture(t); f.own('crafting_table'); f.sync.flush();
    f.memory.record({ kind: 'craft', item: 'crafting_table', text: 'Verified table crafted earlier.', verified: true });
    const token = f.sync.token(); f.set('air');
    assert.equal(f.bot.craftingStation.record, null); assert.equal(f.memory.station(), null);
    assert(f.sync.decisionChanged(token));
    f.sync.flush();
    const saved = f.memory.store.getLocation(f.memory.world, 'overworld', 'owned:crafting_table');
    assert.equal(saved.metadata.owned, false); assert.equal(saved.metadata.observation.status, 'missing');
    const records = f.memory.store.candidates(f.memory.world, 'overworld', 'crafting_table');
    assert(records.some(r => r.kind === 'craft')); assert(records.some(r => r.kind === 'world_change'));
    assert.match(f.memory.summary(), /crafting_table.*missing/);
});

test('a removed furnace clears its cached contents and forces the retained goal to inspect again', t => {
    const f = fixture(t); f.own('furnace');
    f.bot.managedFurnace.snapshot = { input: { name: 'raw_iron', count: 8 }, output: { name: 'iron_ingot', count: 2 } };
    const goal = { kind: 'make', item: 'iron_ingot', target: 3, active: true, furnaceChecked: true };
    f.memory.beginGoal(goal); f.agent.gather_goal = goal;
    f.set('air');
    assert.equal(f.bot.managedFurnace.snapshot, null); assert.equal(f.bot.managedFurnace.record, null);
    assert.equal(f.memory.furnace(), null); assert.equal(goal.furnaceChecked, false);
    assert.equal(goal.cancelled, undefined); assert.equal(f.memory.pendingGoal().target, 3);
});

test('a player replacement at the old coordinate does not acquire ownership before or after the batched write', t => {
    const f = fixture(t); f.own('furnace'); f.sync.flush();
    f.set('air'); f.set('furnace');
    assert.equal(f.memory.furnace(), null);
    f.sync.flush(); assert.equal(f.memory.furnace(), null);
    assert.equal(f.sync.status('owned:furnace'), 'present', 'The block is visible without being owned');
    assert(f.sync.entries.get('seen:seen_station:3,64,0'));
});

test('closing the window of a destroyed furnace cannot resurrect its old input or output snapshot', async t => {
    const f = fixture(t); f.own('furnace');
    const furnace = f.bot.managedFurnace, window = new EventEmitter();
    Object.assign(window, { inputItem: () => ({ name: 'raw_iron', count: 3 }), fuelItem: () => null,
        outputItem: () => ({ name: 'iron_ingot', count: 2 }), close: () => { f.bot.currentWindow = null; window.emit('close'); } });
    Object.assign(furnace.api, { move: async () => true, open: async () => { f.bot.currentWindow = window; return window; } });
    furnace.settleMs = 0;
    await furnace.withWindow(false, async () => { f.set('air'); return false; });
    assert.equal(furnace.snapshot, null); assert.equal(furnace.windowContext, null); assert.equal(f.bot.currentWindow, null);
});

test('a queued invalidation cannot overwrite a newly saved station or resurrect a forgotten one', t => {
    const f = fixture(t); const old = f.own('furnace'); f.sync.flush(); f.set('air');
    const fresh = f.own('furnace', new Vec3(6, 64, 0)); f.sync.flush();
    assert.deepEqual(f.memory.furnace(), fresh); assert.notDeepEqual(f.memory.furnace(), old);
    f.set('air', new Vec3(6, 64, 0)); f.memory.forgetFurnace(fresh); f.sync.flush();
    assert.equal(f.memory.store.getLocation(f.memory.world, 'overworld', 'owned:furnace'), null);
});

test('owned table pickup remains pending until the actual inventory receipt arrives', t => {
    const f = fixture(t); const record = f.own('crafting_table', undefined, { pickupMinimum: 1 });
    f.set('air'); f.sync.flush();
    assert.equal(f.bot.craftingStation.record, record);
    assert.equal(f.memory.station().pickupMinimum, 1);
    assert.equal(f.stock.crafting_table, undefined);
    f.stock.crafting_table = 1; f.bot.inventory.emit('updateSlot', 10, null, { name: 'crafting_table', count: 1 });
    f.memory.forgetStation(record); f.sync.flush();
    assert.equal(f.memory.station(), null);
    assert.equal(f.memory.store.getLocation(f.memory.world, 'overworld', 'owned:crafting_table'), null);
});

test('placement intent is retained through air and unloaded observations and becomes usable on real placement', t => {
    const f = fixture(t), p = new Vec3(3, 64, 0);
    const record = { position: p, dimension: 'overworld', pendingPlacement: true, pickupMinimum: null };
    f.memory.saveStation(record); assert(f.memory.station());
    f.unload(); assert(f.memory.station());
    f.set('crafting_table', p, {}, false); f.load();
    const station = new CraftingStation(f.bot, { blockAt: q => f.bot.blockAt(q) });
    assert(station.available()); assert.equal(f.memory.station().pendingPlacement, false);
});

test('an unloaded chunk is unknown and a later loaded air block establishes actual absence', t => {
    const f = fixture(t); const record = f.own('furnace'); f.sync.flush();
    f.unload(); f.sync.flush();
    assert.equal(f.sync.status('owned:furnace'), 'unknown'); assert.deepEqual(f.memory.furnace(), record);
    f.set('air', new Vec3(3, 64, 0), {}, false); f.load();
    assert.equal(f.sync.status('owned:furnace'), 'missing'); assert.equal(f.memory.furnace(), null);
});

test('chunk notifications handle negative coordinates without invalidating another chunk', t => {
    const f = fixture(t); f.own('furnace', new Vec3(-1, 64, -1));
    f.unload(new Vec3(0, 0, 0)); assert.equal(f.sync.status('owned:furnace'), 'present');
    f.unload(new Vec3(-16, 0, -16)); assert.equal(f.sync.status('owned:furnace'), 'unknown');
});

test('depleting one observed ore block removes that exact hint while keeping other blocks and historical areas', t => {
    const f = fixture(t), a = new Vec3(3, 64, 0), b = new Vec3(5, 64, 0);
    f.set('iron_ore', a); f.set('deepslate_iron_ore', b); f.sync.flush();
    f.memory.store.putLocation(f.memory.world, 'overworld', 'resource:old-area', 'resource', new Vec3(20, 64, 0), { item: 'raw_iron' });
    f.set('air', a); f.sync.flush();
    const hints = f.memory.resourceLocations('raw_iron');
    assert(!hints.some(p => p.x === a.x)); assert(hints.some(p => p.x === b.x)); assert(hints.some(p => p.x === 20));
    f.set('iron_ore', a); f.sync.flush(); assert(f.memory.resourceLocations('raw_iron').some(p => p.x === a.x));
});

test('an actual resource change invalidates that resource failure cooldown without clearing unrelated failures', t => {
    const f = fixture(t); f.set('iron_ore');
    const goal = { kind: 'make', item: 'raw_iron', target: 1 }, step = { type: 'gather', item: 'raw_iron' };
    f.memory.beginGoal(goal); f.memory.beginStep(goal, step); f.memory.failStep(goal, step, 'No reachable ore');
    assert.throws(() => f.memory.beginStep(goal, step), /cooldown/);
    f.set('air'); f.set('iron_ore', new Vec3(6, 64, 0));
    assert.doesNotThrow(() => f.memory.beginStep(goal, step));
    assert(f.memory.store.activeFailures(f.memory.world, 'overworld').length > 0, 'The historical failure was not globally erased');
});

function shelter(f) {
    const record = { version: 1, origin: { x: 1, y: 64, z: 1 } }, plan = shelterBlueprint(record);
    for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) f.set('dirt', plan.origin.offset(x, -1, z), {}, false);
    f.set('dirt', plan.outside.offset(0, -1, 0), {}, false);
    for (const step of plan.blocks) f.set(step.item, step.position, {}, false);
    for (let y = 0; y < 2; y++) f.set('oak_door', plan.door.offset(0, y, 0), { half: y ? 'upper' : 'lower', facing: 'north', hinge: 'left', open: false }, false);
    f.memory.saveShelter(record); return plan;
}

test('shelter damage updates its current state while retaining the blueprint, home and completion history', t => {
    const f = fixture(t), plan = shelter(f); f.memory.rememberPlace('home', plan.inside);
    f.memory.record({ kind: 'goal_complete', item: 'shelter', text: 'Shelter verified previously.', verified: true });
    assert.equal(f.sync.status('owned:shelter'), 'present');
    f.set('air', plan.door); assert.equal(f.sync.status('owned:shelter'), 'changed');
    assert.deepEqual(f.memory.shelter(), plan.record); assert.deepEqual(f.memory.recallPlace('home'), { ...plan.inside });
    f.sync.flush();
    assert(f.memory.store.candidates(f.memory.world, 'overworld', 'shelter').some(r => r.kind === 'goal_complete'));
    assert.match(f.sync.lines().join('\n'), /entrance and safety require verification/);
});

test('door state changes invalidate an in-flight decision even when the block name remains oak_door', t => {
    const f = fixture(t), plan = shelter(f);
    f.bot.blockAtCursor = () => f.bot.blockAt(plan.door);
    const snapshot = captureWorld(f.bot);
    f.set('oak_door', plan.door, { half: 'lower', facing: 'north', hinge: 'left', open: true });
    assert(worldChanged(f.bot, snapshot));
    assert.match(worldContext(captureWorld(f.bot)), /"open":true/);
});

test('a route block changing state requests one replan with the same goal and movement policy', async t => {
    const f = fixture(t), goal = { target: 'inside' }, policy = { canDig: false, maxDropDown: 2 }, resets = [];
    f.bot.pathfinder = { goal, movements: policy, isMoving: () => true, isMining: () => false, isBuilding: () => false,
        setMovements: p => resets.push(p) };
    f.bot.emit('path_update', { path: [{ x: 3, y: 64, z: 0 }] });
    f.set('oak_door', undefined, { open: false }); f.set('oak_door', undefined, { open: true });
    await Promise.resolve();
    assert.deepEqual(resets, [policy]); assert.equal(f.bot.pathfinder.goal, goal);
    assert.equal(policy.canDig, false); assert.equal(policy.maxDropDown, 2);
});

test('a queued route replan cannot affect a stopped route or an action currently mining', async t => {
    const f = fixture(t), resets = [];
    f.bot.pathfinder = { goal: {}, movements: {}, isMoving: () => true, isMining: () => true,
        setMovements: p => resets.push(p) };
    f.bot.emit('path_update', { path: [{ x: 3, y: 64, z: 0 }] }); f.set('stone');
    await Promise.resolve(); assert.equal(resets.length, 0);
    f.bot.pathfinder.isMining = () => false;
    f.set('air'); f.bot.pathfinder.goal = null; f.bot.emit('path_stop');
    await Promise.resolve(); assert.equal(resets.length, 0);
});

test('a mining target removed by another player releases its route and leaves the managed goal intact', t => {
    const f = fixture(t), ore = f.set('iron_ore'), stopped = [];
    const goal = f.agent.gather_goal = { active: true, kind: 'make', item: 'raw_iron', target: 1 };
    f.bot.pathfinder = { goal: {}, isMining: () => false, isBuilding: () => false, setGoal: p => stopped.push(p) };
    const release = f.sync.watchTarget(ore, b => b?.name === 'iron_ore');
    f.set('air'); assert.deepEqual(stopped, [null]); assert.equal(goal.cancelled, undefined);
    release(); f.set('iron_ore'); f.set('air'); assert.equal(stopped.length, 1);
});

test('stale target and route notifications cannot stop or reset a newer action owner', async t => {
    const f = fixture(t), ore = f.set('iron_ore'), resets = [], stops = [];
    f.agent.actions.currentRun = {};
    f.bot.pathfinder = { goal: {}, movements: {}, isMoving: () => true, isMining: () => false, isBuilding: () => false,
        setMovements: p => resets.push(p), setGoal: p => stops.push(p) };
    const release = f.sync.watchTarget(ore, b => b?.name === 'iron_ore');
    f.agent.actions.currentRun = {}; f.agent.actions.currentActionLabel = 'mode:self_defense';
    f.set('air'); assert.equal(stops.length, 0); release();
    f.bot.emit('path_update', { path: [{ x: 3, y: 64, z: 0 }] });
    f.set('stone'); f.agent.actions.currentRun = {}; f.bot.pathfinder.goal = {};
    await Promise.resolve(); assert.equal(resets.length, 0);
});

test('ordinary movement and unrelated distant block updates do not starve a model decision or write history', t => {
    const f = fixture(t), token = f.sync.token();
    for (let i = 0; i < 500; i++) {
        f.bot.entity.position.x += 0.001; f.bot.emit('move');
        f.set('short_grass', new Vec3(30, 64, i));
    }
    assert.equal(f.sync.decisionChanged(token), false);
    assert.equal(f.sync.pending.size, 0); assert.equal(f.memory.store.stats(f.memory.world, 'overworld').experiences, 0);
});

test('inventory changes invalidate decisions but moving equal item totals between slots does not', t => {
    const f = fixture(t), token = f.sync.token();
    f.bot.inventory.emit('updateSlot', 10, null, null); assert.equal(f.sync.decisionChanged(token), false);
    f.stock.stick = 4; f.bot.inventory.emit('updateSlot', 10, null, { name: 'stick', count: 4 });
    assert(f.sync.decisionChanged(token)); assert.equal(f.sync.pending.size, 0);
});

test('teleport invalidates a decision and stops the stale action without cancelling its saved target', async t => {
    const f = fixture(t), goal = { kind: 'make', item: 'stone_axe', target: 1, active: true };
    f.memory.beginGoal(goal); f.agent.gather_goal = goal;
    f.agent.actions.executing = true; f.agent.actions.currentActionLabel = 'action:makeGoal';
    const token = f.sync.token(); f.bot.entity.position = new Vec3(20, 70, 20); f.bot.emit('forcedMove');
    await Promise.resolve();
    assert.deepEqual(f.stops, ['world_changed']); assert(f.sync.decisionChanged(token));
    assert.equal(f.sync.position.x, 20); assert.equal(f.memory.pendingGoal().item, 'stone_axe'); assert.equal(goal.cancelled, undefined);
    f.agent.actions.currentActionLabel = 'mode:self_defense'; f.bot.emit('forcedMove');
    assert.equal(f.stops.length, 1, 'Observation updates do not take ownership from combat');
});

test('dimensions and separate world IDs cannot reuse each other\'s station observations', t => {
    const f = fixture(t); f.own('furnace'); f.sync.flush();
    f.bot.game.dimension = 'the_nether'; f.bot.emit('game');
    assert.equal(f.memory.furnace(), null); assert.equal(f.sync.lines().length, 0);
    f.set('crafting_table'); assert.equal(f.memory.station(), null);
    f.bot.game.dimension = 'overworld'; f.bot.emit('game'); assert(f.memory.furnace());
    f.memory.close();
    const other = fixture(t, { root: f.root, world: 'other-world' }); assert.equal(other.memory.furnace(), null);
});

test('restart rechecks the current world and preserves unknown ownership until new loaded evidence arrives', t => {
    const f = fixture(t); f.own('furnace'); f.memory.close();
    const next = fixture(t, { root: f.root, unloaded: true });
    assert.equal(next.sync.status('owned:furnace'), 'unknown'); assert(next.memory.furnace());
    next.load(); assert.equal(next.sync.status('owned:furnace'), 'missing'); assert.equal(next.memory.furnace(), null);
});

test('block event bursts are coalesced and the cache stays bounded', t => {
    const f = fixture(t); f.own('furnace'); f.sync.flush();
    let writes = 0; const put = f.memory.store.putLocation.bind(f.memory.store);
    f.memory.store.putLocation = (...args) => { writes++; return put(...args); };
    for (let i = 0; i < 50; i++) f.set('furnace', undefined, { lit: Boolean(i % 2) });
    assert.equal(writes, 0); f.sync.flush(); assert(writes <= 2);
    for (let i = 0; i < 180; i++) f.sync.observe(f.set('iron_ore', new Vec3(i % 30, 63 + Math.floor(i / 30), 0), {}, false));
    assert(f.sync.entries.size <= 128); assert(f.sync.entries.has('owned:furnace'));
    f.sync.flush();
    const n = f.memory.store.db.prepare("SELECT COUNT(*) AS n FROM locations WHERE kind IN ('resource_block','seen_station')").get().n;
    assert(n <= 128);
});

test('world/inventory emitter replacement rebinds once and closing releases listeners and pending writes', t => {
    const f = fixture(t), oldWorld = f.bot.world, oldInventory = f.bot.inventory;
    const worldListeners = oldWorld.listenerCount('blockUpdate'), inventoryListeners = oldInventory.listenerCount('updateSlot');
    for (let i = 0; i < 20; i++) f.sync.refresh();
    assert.equal(oldWorld.listenerCount('blockUpdate'), worldListeners);
    assert.equal(oldInventory.listenerCount('updateSlot'), inventoryListeners);
    f.bot.world = new EventEmitter(); f.bot.inventory = Object.assign(new EventEmitter(), { items: () => [] }); f.sync.refresh();
    assert.equal(oldWorld.listenerCount('blockUpdate'), 0); assert.equal(oldInventory.listenerCount('updateSlot'), 0);
    assert.equal(f.bot.world.listenerCount('blockUpdate'), 1); assert.equal(f.bot.inventory.listenerCount('updateSlot'), 1);
    f.set('furnace'); const db = f.memory.store; f.memory.close();
    assert.equal(f.bot.world.listenerCount('blockUpdate'), 0); assert.equal(f.bot.inventory.listenerCount('updateSlot'), 0);
    assert.equal(f.sync.timer, null); assert.equal(db.db, null);
    assert.doesNotThrow(() => f.bot.world.emit('blockUpdate', null, null));
});

test('reinstalling the memory integration never accumulates lifecycle or block listeners', t => {
    const f = fixture(t), counts = ['death', 'end', 'game', 'spawn', 'forcedMove'].map(name => [name, f.bot.listenerCount(name)]);
    for (let i = 0; i < 15; i++) {
        const memory = installLocalMemory(f.agent, { root: f.root, config: { world_id: 'test-world', embeddings: false } });
        cleanup.get(t).memories.push(memory);
    }
    for (const [name, count] of counts) assert.equal(f.bot.listenerCount(name), count, name);
    assert.equal(f.bot.world.listenerCount('blockUpdate'), 1);
    f.agent.local_memory.close();
    for (const [name] of counts) assert.equal(f.bot.listenerCount(name), 0, name);
});

test('retiring an unrecovered loaded drop persists across restart without erasing its history or reporting an item', async t => {
    const f = fixture(t), record = f.own('crafting_table', undefined, { pickupMinimum: 1 });
    f.memory.record({ kind: 'craft', item: 'crafting_table', text: 'Verified original table crafted.', verified: true });
    f.set('air'); f.bot.entity.position = new Vec3(20, 64, 0);
    f.bot.craftingStation.api.move = async () => false;
    assert.equal(await f.bot.craftingStation.forCraft(), null); f.sync.flush();
    assert.equal(f.memory.station(), null); assert.equal(f.stock.crafting_table, undefined);
    const saved = f.memory.store.getLocation(f.memory.world, 'overworld', 'owned:crafting_table');
    assert.equal(saved.metadata.owned, false); assert.equal(saved.metadata.pickupMinimum, null);
    assert.equal(saved.metadata.pickupRecovery.status, 'unrecovered');
    assert.equal(saved.metadata.pickupRecovery.minimum, record.pickupMinimum);
    f.memory.close();
    const next = fixture(t, { root: f.root, unloaded: true });
    assert.equal(next.memory.station(), null, 'Unloading/restart cannot revive a retired drop task');
    const history = next.memory.store.candidates(next.memory.world, 'overworld', 'crafting_table');
    assert(history.some(row => row.kind === 'craft'));
    assert(history.some(row => row.kind === 'pickup_failed' && /no inventory gain or successful pickup was claimed/.test(row.text)));
    assert.match(next.memory.summary(), /crafting_table.*unknown/);
    assert.match(next.memory.summary(), /old pickup retired/);
});

test('retiring a pickup requires loaded absence and cannot overwrite another station or another dimension', t => {
    const f = fixture(t), old = f.own('crafting_table', undefined, { pickupMinimum: 1 });
    assert.equal(f.memory.retireStationPickup(old, 'Failed route'), false, 'The table is still placed');
    f.unload(); assert.equal(f.memory.retireStationPickup(old, 'Unloaded'), false);
    f.load(); f.set('air');
    const fresh = f.own('crafting_table', new Vec3(6, 64, 0));
    assert.equal(f.memory.retireStationPickup(old, 'Old callback'), false);
    assert.deepEqual(f.memory.station(), fresh);
    f.bot.game.dimension = 'the_nether';
    assert.equal(f.memory.retireStationPickup({ ...fresh, pickupMinimum: 1 }, 'Wrong dimension'), false);
});

test('the restored three-axe goal replans past an unreachable missing-table pickup and finishes without another command', async t => {
    const original = fixture(t), old = new Vec3(16, 89, 17);
    original.own('crafting_table', old, { pickupMinimum: 1 }); original.set('air', old);
    const savedGoal = { kind: 'make', item: 'stone_axe', target: 3 };
    original.memory.beginGoal(savedGoal); original.memory.checkpoint(savedGoal, 'blocked', 'Could not reach my crafting table');
    original.memory.close();
    const f = fixture(t, { root: original.root }), bot = f.bot, agent = f.agent, calls = [];
    bot.entity.position = new Vec3(30, 82, 20);
    Object.assign(f.stock, { stone_axe: 2, cobblestone: 3, stick: 2, oak_planks: 4 });
    const fresh = new Vec3(31, 82, 20);
    const station = bot.craftingStation = new CraftingStation(bot, {
        blockAt: p => bot.blockAt(p),
        move: async p => { calls.push(['move', p]); if (p.x === old.x && p.y === old.y) return false; bot.entity.position = new Vec3(p.x, p.y, p.z); return true; },
        place: async intent => { intent(fresh); f.stock.crafting_table--; return f.set('crafting_table', fresh); },
        break: async () => assert.fail('No placed old table exists to break'),
        pickup: async () => assert.fail('The old drop could not be reached'),
        log: text => calls.push(['log', text])
    }, { verifyTimeoutMs: 1 });
    agent.actions = new ActionManager(agent);
    agent.self_prompter = { stop: async () => {} };
    agent.requestInterrupt = () => { bot.interrupt_code = true; };
    agent.clearBotLogs = () => { bot.interrupt_code = false; bot.output = ''; };
    agent.cleanKill = reason => assert.fail(reason); agent.isIdle = () => !agent.actions.executing;
    agent.history.add = async () => {}; agent.openChat = () => {};
    const recipes = {
        crafting_table: [[{ oak_planks: 4 }, { craftedCount: 1 }]],
        stone_axe: [[{ cobblestone: 3, stick: 2 }, { craftedCount: 1 }]]
    };
    const api = {
        hasTable: () => hasReusableTable(bot), recipes: name => recipes[name], verifyTimeoutMs: 1,
        collect: async () => assert.fail('All necessary ingredients are already held'),
        craft: async (_bot, name) => {
            calls.push(['craft', name]);
            if (name === 'stone_axe') {
                let table = await station.forCraft();
                if (!table && f.stock.crafting_table > 0) table = await station.place();
                if (!table) return false;
                assert.equal(table.name, 'crafting_table');
            }
            for (const [item, count] of Object.entries(recipes[name][0][0])) { assert(f.stock[item] >= count); f.stock[item] -= count; }
            f.stock[name] = (f.stock[name] || 0) + 1; return true;
        }
    };
    assert(await f.memory.resume(async command => {
        assert.equal(command, '!makeGoal("stone_axe", 3)');
        return startMakeGoal(agent, 'stone_axe', 3, api);
    }, { manual: true }));
    assert.match(await agent.gather_goal.done, /Crafting complete: 3\/3 stone_axe/);
    assert.equal(f.stock.stone_axe, 3); assert.equal(f.stock.cobblestone, 0);
    assert.equal(calls.filter(c => c[0] === 'move' && c[1].x === old.x).length, 1);
    assert.equal(calls.filter(c => c[0] === 'craft' && c[1] === 'crafting_table').length, 1);
    assert.deepEqual(f.memory.station().position, { ...fresh });
    assert.equal(f.memory.pendingGoal().status, 'complete'); assert.equal(f.stock.crafting_table, 0, 'New station is placed, not a fabricated pickup');
});
