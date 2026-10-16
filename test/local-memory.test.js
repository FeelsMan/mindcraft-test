import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import Vec3 from 'vec3';
import { LocalMemoryStore } from '../src/agent/local_memory.js';
import { AgentMemory, installLocalMemory } from '../src/agent/memory_runtime.js';
import { MemoryBank } from '../src/agent/memory_bank.js';
import { CraftingStation } from '../src/agent/crafting_station.js';
import { ManagedFurnace } from '../src/agent/managed_smelting.js';
import { ActionManager } from '../src/agent/action_manager.js';
import { startMakeGoal } from '../src/agent/make_goal.js';
import { cancelGatherGoal, startGatherGoal } from '../src/agent/gather_goal.js';
const require = createRequire(import.meta.url);
const { configureMemory } = require('../scripts/configure-memory.cjs');

const recipes = {
    oak_planks: [[{ oak_log: 1 }, { craftedCount: 4 }]],
    stick: [[{ oak_planks: 2 }, { craftedCount: 4 }]],
    stone_pickaxe: [[{ stick: 2, cobblestone: 3 }, { craftedCount: 1 }]]
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function directory(t) {
    const root = mkdtempSync(join(tmpdir(), 'mia-memory-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}
function store(t, options) {
    const filename = join(directory(t), 'memory.sqlite');
    const db = new LocalMemoryStore(filename, options);
    t.after(() => db.close());
    return { db, filename };
}
function fixture(t, root = directory(t), initial = {}, options = {}) {
    const stock = { ...initial }, bot = new EventEmitter();
    bot.entity = { position: new Vec3(1, 64, 1) };
    bot.game = { dimension: 'overworld' };
    bot.registry = { blocksByName: { oak_log: {} }, itemsByName: { oak_log: {} } };
    bot.inventory = { items: () => Object.entries(stock).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) };
    bot.modes = { getActiveModes: () => [] };
    bot.output = '';
    bot.blockAt = () => ({ name: 'air' });
    const agent = {
        name: 'Mia', bot, memory_bank: new MemoryBank(), messages: [],
        prompter: { profile: {} },
        history: { add: async () => {}, save: async () => {} },
        self_prompter: { stop: async () => {}, isActive: () => false },
        requestInterrupt: () => { bot.interrupt_code = true; },
        clearBotLogs: () => { bot.interrupt_code = false; bot.output = ''; },
        cleanKill: message => { throw new Error(message); },
        isIdle: () => !agent.actions.executing,
        openChat: message => agent.messages.push(message)
    };
    agent.actions = new ActionManager(agent);
    installLocalMemory(agent, { root, settings: { host: '127.0.0.1', port: 12345 }, config: { world_id: 'test-world', embeddings: false }, ...options });
    t.after(() => agent.local_memory?.close());
    const calls = [];
    const api = {
        recipes: name => recipes[name] || [], hasTable: () => true, verifyTimeoutMs: 5,
        collect: async (_bot, name) => { calls.push('gather:' + name); stock[name] = (stock[name] || 0) + 1; },
        craft: async (_bot, name) => {
            calls.push('craft:' + name);
            const [ingredients, result] = recipes[name][0];
            for (const [item, n] of Object.entries(ingredients)) { assert((stock[item] || 0) >= n); stock[item] -= n; }
            stock[name] = (stock[name] || 0) + result.craftedCount;
        }
    };
    return { root, agent, bot, stock, api, calls, memory: agent.local_memory };
}
const record = (db, world = 'w', dimension = 'overworld', item = 'cobblestone') =>
    db.record(world, dimension, { kind: 'gather', item, text: `Verified gathering of ${item}`, position: { x: 1, y: 64, z: 1 }, verified: true });

test('SQLite persists verified evidence and FTS matches; proposed or assistant actions are excluded', t => {
    const { db, filename } = store(t);
    assert.equal(db.record('w', 'overworld', { kind: 'gather', item: 'diamond', text: 'I will get diamonds' }), null);
    assert.equal(db.record('w', 'overworld', { kind: 'assistant', item: 'diamond', text: 'I have diamonds', verified: true }), null);
    record(db); db.close();
    const reopened = new LocalMemoryStore(filename); t.after(() => reopened.close());
    assert.equal(reopened.stats('w', 'overworld').experiences, 1);
    assert.equal(reopened.candidates('w', 'overworld', 'cobblestone')[0].lexical, true);
});

test('world and dimension scope apply to evidence, locations and cooldowns', t => {
    const { db } = store(t);
    record(db, 'world-a'); record(db, 'world-b', 'the_nether', 'netherrack');
    db.putLocation('world-a', 'overworld', 'base', 'place', { x: 3, y: 64, z: 4 });
    db.fail('world-a', 'overworld', 'gather', 'fingerprint', 'No stone');
    assert.equal(db.getLocation('world-b', 'overworld', 'base'), null);
    assert.equal(db.getLocation('world-a', 'the_nether', 'base'), null);
    assert.equal(db.candidates('world-a', 'the_nether', 'cobblestone').length, 0);
    assert.equal(db.failure('world-b', 'overworld', 'gather', 'fingerprint'), null);
});

test('deduplication, pruning and vector cascade keep the database bounded', t => {
    const { db } = store(t, { maxRecords: 10 });
    const id = record(db); record(db);
    assert.equal(db.candidates('w', 'overworld', 'stone')[0].observations, 2);
    db.putVector(id, 'embeddinggemma', 'Verified gathering of cobblestone', [1, 0]);
    for (let i = 0; i < 35; i++) record(db, 'w', 'overworld', 'item_' + i);
    db.prune();
    assert.equal(db.stats('w', 'overworld').experiences, 10);
    assert.equal(db.getVector(id, 'embeddinggemma', 'Verified gathering of cobblestone'), null);
    assert.doesNotThrow(() => db.candidates('w', 'overworld', '" OR *); DROP TABLE experiences; --'));
});

test('world ID survives a LAN port change and separates different worlds', t => {
    const first = fixture(t);
    first.memory.rememberPlace('base', { x: 3, y: 64, z: 5 });
    first.memory.close();
    const next = fixture(t, first.root, {}, { settings: { host: 'localhost', port: 55916 } });
    assert.deepEqual(next.memory.recallPlace('base'), { x: 3, y: 64, z: 5 });
    next.memory.close();
    const other = fixture(t, first.root, {}, { config: { world_id: 'another-world' } });
    assert.equal(other.memory.recallPlace('base'), null);
});

test('resource hints use the current world/dimension and exact resource item', t => {
    const f = fixture(t);
    f.memory.store.putLocation(f.memory.world, 'overworld', 'resource:stone', 'resource', { x: 20, y: 64, z: 0 }, { item: 'cobblestone' });
    f.memory.store.putLocation(f.memory.world, 'overworld', 'resource:wood', 'resource', { x: 10, y: 64, z: 0 }, { item: 'oak_log' });
    f.memory.store.putLocation('other-world', 'overworld', 'resource:stone', 'resource', { x: 1, y: 64, z: 0 }, { item: 'cobblestone' });
    assert.deepEqual(f.memory.resourceLocations('cobblestone'), [{ x: 20, y: 64, z: 0 }]);
    f.bot.game.dimension = 'the_nether';
    assert.deepEqual(f.memory.resourceLocations('cobblestone'), []);
});

test('resource exploration budget survives automatic restart but explicit resume renews it', async t => {
    const f = fixture(t);
    const goal = { kind: 'make', item: 'stone_pickaxe', target: 1 };
    f.memory.beginGoal(goal);
    goal.resourceSearch = { cobblestone: { origin: { x: 1, y: 64, z: 1 }, attempts: 7, visited: [{ x: 17, y: 64, z: 1 }] } };
    f.memory.checkpoint(goal); f.memory.close();
    const next = fixture(t, f.root);
    let restored;
    assert(await next.memory.resume(async () => {
        restored = { kind: 'make', item: 'stone_pickaxe', target: 1 };
        next.memory.beginGoal(restored);
    }));
    assert.equal(restored.resourceSearch.cobblestone.attempts, 7);
    next.memory.checkpoint(restored, 'blocked');
    assert(await next.memory.resume(async () => {
        restored = { kind: 'make', item: 'stone_pickaxe', target: 1 };
        next.memory.beginGoal(restored);
    }, { manual: true }));
    assert.deepEqual(restored.resourceSearch, {});
});

test('a gather cooldown skips the failing area only when resource recovery is available', t => {
    const f = fixture(t), step = { type: 'gather', item: 'cobblestone' };
    const old = { kind: 'make', item: 'stone_pickaxe', target: 1 };
    f.memory.beginGoal(old); f.memory.beginStep(old, step); f.memory.failStep(old, step, 'No safe stone');
    assert.throws(() => f.memory.beginStep(old, step), /Remembered failure cooldown/);
    const goal = { ...old, resourceRecoveryEnabled: true };
    f.memory.beginStep(goal, step);
    assert.equal(goal.skipResourceArea, true);
    assert.equal(goal.memoryStep.item, 'cobblestone');
});

test('without a world ID, sessions never reuse historical coordinates or goals', t => {
    const first = fixture(t, undefined, {}, { config: {} });
    first.memory.rememberPlace('base', { x: 3, y: 64, z: 5 }); first.memory.close();
    const next = fixture(t, first.root, {}, { config: {} });
    assert.equal(next.memory.recallPlace('base'), null);
    assert.equal(next.memory.persistentWorld, false);
});

test('named places are dimension-aware and unscoped legacy places are retained but not trusted', t => {
    const f = fixture(t);
    f.agent.memory_bank.loadJson({ legacy_base: [999, 70, 999] });
    assert.equal(f.agent.memory_bank.recallPlace('legacy_base'), undefined);
    f.agent.memory_bank.rememberPlace('base', 1, 64, 2);
    assert.deepEqual(f.agent.memory_bank.recallPlace('base'), [1, 64, 2]);
    f.bot.game.dimension = 'the_nether';
    assert.equal(f.agent.memory_bank.recallPlace('base'), undefined);
    assert.deepEqual(f.agent.memory_bank.getJson(), { legacy_base: [999, 70, 999] });
});

test('owned station survives restart, preserves unloaded chunks and forgets a loaded missing table', t => {
    const f = fixture(t);
    const position = { x: 7, y: 64, z: 4 };
    new CraftingStation(f.bot, { blockAt: () => null }).remember({ name: 'crafting_table', position });
    f.memory.close();
    const next = fixture(t, f.root);
    let block = null;
    const station = new CraftingStation(next.bot, { blockAt: () => block });
    assert(station.available()); assert.deepEqual(station.record.position, position);
    block = { name: 'air' };
    assert.equal(station.available(), false); assert.equal(next.memory.station(), null);
    next.bot.game.dimension = 'the_nether'; assert.equal(station.available(), false);
});

test('owned furnace and placement intent persist, stay scoped, and recheck loaded blocks', t => {
    const f = fixture(t), record = { position: { x: 7, y: 64, z: 4 }, dimension: 'overworld', pendingPlacement: true };
    f.memory.saveFurnace(record); f.memory.close();
    const next = fixture(t, f.root);
    assert.deepEqual(next.memory.furnace(), record);
    let block = null;
    const furnace = new ManagedFurnace(next.bot, { blockAt: () => block });
    assert(furnace.available(), 'Unloaded chunks retain historical ownership');
    block = { name: 'furnace' }; assert(furnace.available());
    assert.equal(next.memory.furnace().pendingPlacement, false);
    next.bot.game.dimension = 'the_nether'; assert.equal(furnace.available(), false);
    next.bot.game.dimension = 'overworld'; assert(furnace.available());
    block = { name: 'air' }; assert.equal(furnace.available(), false); assert.equal(next.memory.furnace(), null);
});

test('table placement intent survives restart and is confirmed only against a live owned block', t => {
    const f = fixture(t), position = { x: 7, y: 64, z: 4 };
    f.memory.saveStation({ position, dimension: 'overworld', pickupMinimum: null, pendingPlacement: true });
    f.memory.close();
    const next = fixture(t, f.root); let block = null;
    const station = new CraftingStation(next.bot, { blockAt: () => block });
    assert(station.available()); assert.equal(station.record.pendingPlacement, true);
    block = { name: 'crafting_table', position };
    assert(station.available()); assert.equal(next.memory.station().pendingPlacement, false);
    block = { name: 'air', position };
    assert.equal(station.available(), false); assert.equal(next.memory.station(), null);
});

test('a verified smelt is retrievable evidence, while failed output is not recorded', t => {
    const f = fixture(t), goal = { kind: 'make', item: 'iron_ingot', target: 3 }, step = { type: 'smelt', item: 'iron_ingot' };
    f.memory.beginGoal(goal); f.memory.beginStep(goal, step);
    f.memory.stepResult(goal, step, false);
    assert.equal(f.memory.store.candidates(f.memory.world, f.memory.dimension, 'iron_ingot').length, 0);
    f.memory.stepResult(goal, step, true);
    assert.equal(f.memory.store.candidates(f.memory.world, f.memory.dimension, 'iron_ingot')[0].kind, 'smelt');
});

test('new live furnace output or cleared contents invalidates a smelting failure cooldown', t => {
    const f = fixture(t), goal = { kind: 'make', item: 'iron_ingot', target: 3 }, step = { type: 'smelt', item: 'iron_ingot' };
    f.bot.managedFurnace = { record: { position: { x: 3, y: 64, z: 1 } },
        snapshot: { input: { name: 'raw_iron', count: 3 }, fuel: null, output: null, burnTicks: 0 } };
    f.memory.beginGoal(goal); f.memory.beginStep(goal, step); f.memory.failStep(goal, step, 'No output');
    assert.throws(() => f.memory.beginStep(goal, step), /cooldown/);
    f.bot.managedFurnace.snapshot.output = { name: 'iron_ingot', count: 1 };
    assert.doesNotThrow(() => f.memory.beginStep(goal, step));
    f.bot.managedFurnace.snapshot.output = null; f.bot.managedFurnace.snapshot.input = null;
    assert.doesNotThrow(() => f.memory.beginStep(goal, step));
});

test('station ownership and position survive dimension changes without adopting player tables', t => {
    const f = fixture(t);
    const station = new CraftingStation(f.bot, { blockAt: () => ({ name: 'crafting_table' }) });
    assert.equal(station.available(), false);
    station.remember({ name: 'crafting_table', position: { x: 2, y: 64, z: 3 } });
    f.bot.game.dimension = 'the_nether'; assert.equal(station.available(), false);
    f.bot.game.dimension = 'overworld'; assert(station.available());
});

test('disconnect checkpoint resumes from real inventory, without repeating the completed mining step', async t => {
    const initial = { wooden_pickaxe: 1, stick: 2, cobblestone: 2 };
    const f = fixture(t, undefined, initial);
    const collect = f.api.collect;
    f.api.collect = async (...args) => { await collect(...args); f.bot.emit('end'); };
    await startMakeGoal(f.agent, 'stone_pickaxe', 1, f.api);
    await f.agent.gather_goal.done;
    const next = fixture(t, f.root, f.stock);
    assert.equal(next.memory.pendingGoal().status, 'paused');
    assert(await next.memory.resume(async () => startMakeGoal(next.agent, 'stone_pickaxe', 1, next.api)));
    await next.agent.gather_goal.done;
    assert.deepEqual(next.calls, ['craft:stone_pickaxe']);
    assert.equal(next.stock.stone_pickaxe, 1);
    assert.equal(next.memory.pendingGoal().status, 'complete');
});

test('a goal already fulfilled before a crash completes without crafting or gathering again', async t => {
    const f = fixture(t, undefined, { oak_planks: 4 });
    f.memory.beginGoal({ kind: 'make', item: 'oak_planks', target: 4 });
    f.memory.close();
    const next = fixture(t, f.root, f.stock);
    assert(await next.memory.resume(() => startMakeGoal(next.agent, 'oak_planks', 4, next.api)));
    await next.agent.gather_goal.done;
    assert.equal(next.calls.length, 0); assert.equal(next.memory.pendingGoal().status, 'complete');
    assert.equal(await next.memory.resume(() => assert.fail('Completed goal resumed')), false);
});

test('death retains the target and waits for recovery before replanning', async t => {
    const f = fixture(t, undefined, { oak_log: 1 });
    f.api.craft = async () => { f.bot.emit('death'); };
    await startMakeGoal(f.agent, 'oak_planks', 4, f.api); await f.agent.gather_goal.done;
    assert.equal(f.memory.pendingGoal().status, 'paused');
    f.agent.recovering_from_death = true;
    assert.equal(await f.memory.resume(() => assert.fail('Resumed before respawn')), false);
    f.agent.recovering_from_death = false;
    f.api.craft = async () => { f.stock.oak_log--; f.stock.oak_planks = 4; };
    assert(await f.memory.resume(() => startMakeGoal(f.agent, 'oak_planks', 4, f.api)));
    await f.agent.gather_goal.done;
    assert.equal(f.memory.pendingGoal().status, 'complete');
});

test('explicit stop persists cancellation even while an asynchronous action settles', async t => {
    const f = fixture(t);
    f.api.collect = async () => { while (!f.bot.interrupt_code) await sleep(1); };
    await startMakeGoal(f.agent, 'oak_planks', 4, f.api);
    while (!f.agent.actions.executing) await sleep(1);
    await cancelGatherGoal(f.agent);
    assert.equal(f.memory.pendingGoal().status, 'cancelled');
    assert.equal(await f.memory.resume(() => assert.fail('Cancelled goal resumed'), { manual: true }), false);
});

test('two deaths block automatic recovery instead of creating an endless death loop', async t => {
    const f = fixture(t, undefined, { oak_log: 1 });
    f.api.craft = async () => f.bot.emit('death');
    await startMakeGoal(f.agent, 'oak_planks', 4, f.api); await f.agent.gather_goal.done;
    assert.equal(f.memory.pendingGoal().deaths, 1);
    assert(await f.memory.resume(() => startMakeGoal(f.agent, 'oak_planks', 4, f.api)));
    await f.agent.gather_goal.done;
    assert.equal(f.memory.pendingGoal().deaths, 2);
    assert.equal(f.memory.pendingGoal().status, 'blocked');
    assert.equal(await f.memory.resume(() => assert.fail('Death loop restarted')), false);
});

test('repeated failed output is recorded and blocked; changing location permits a new attempt', async t => {
    const f = fixture(t, undefined, { oak_log: 1 });
    let attempts = 0;
    f.api.craft = async () => { attempts++; return false; };
    await startMakeGoal(f.agent, 'oak_planks', 4, f.api); await f.agent.gather_goal.done;
    assert.equal(attempts, 2); assert.equal(f.memory.pendingGoal().status, 'blocked');
    assert.equal(await f.memory.resume(() => assert.fail('Blocked goal automatically resumed')), false);
    await startMakeGoal(f.agent, 'oak_planks', 4, f.api);
    assert.match(await f.agent.gather_goal.done, /cooldown/); assert.equal(attempts, 2);
    f.bot.entity.position.x += 16;
    f.api.craft = async () => { f.stock.oak_log--; f.stock.oak_planks = 4; };
    await startMakeGoal(f.agent, 'oak_planks', 4, f.api); await f.agent.gather_goal.done;
    assert.equal(f.memory.pendingGoal().status, 'complete');
});

test('cooldowns survive restart and expire; inventory changes invalidate the old fingerprint', t => {
    let now = 1000;
    const f = fixture(t, undefined, {}, { clock: () => now });
    const goal = { kind: 'make', item: 'oak_planks', target: 4 };
    const step = { type: 'gather', item: 'oak_log' };
    f.memory.beginGoal(goal); f.memory.failStep(goal, step, 'No reachable logs'); f.memory.close();
    const next = fixture(t, f.root, {}, { clock: () => now });
    assert.throws(() => next.memory.beginStep(goal, step), /cooldown/);
    next.stock.wooden_axe = 1; assert.doesNotThrow(() => next.memory.beginStep(goal, step));
    delete next.stock.wooden_axe; now += 120001;
    assert.doesNotThrow(() => next.memory.beginStep(goal, step));
});

test('dimension changes suspend the goal and prevent cross-dimension resume', async t => {
    const f = fixture(t);
    f.api.collect = async () => { f.stock.oak_log = 1; f.bot.game.dimension = 'the_nether'; };
    await startMakeGoal(f.agent, 'oak_planks', 4, f.api); await f.agent.gather_goal.done;
    assert.equal(f.memory.pendingGoal().status, 'paused');
    assert.equal(await f.memory.resume(() => assert.fail('Wrong dimension resumed')), false);
    assert.equal(f.memory.store.stats(f.memory.world, 'the_nether').experiences, 0);
});

test('managed log collection records verified progress and resource areas', async t => {
    const f = fixture(t);
    await startGatherGoal(f.agent, 'oak_log', 2, f.api.collect);
    await f.agent.gather_goal.done;
    assert.equal(f.stock.oak_log, 2); assert.equal(f.memory.pendingGoal().status, 'complete');
    assert.equal(f.memory.store.locations(f.memory.world, 'overworld', 'resource').length, 1);
    const context = await f.memory.context('oak_log');
    assert.match(context, /Previously collected oak_log/);
});

test('failed log collection saves the actual skill diagnostic in the persistent goal', async t => {
    const f = fixture(t);
    const collect = async bot => { bot.output += 'No oak_log nearby to collect.\n'; return false; };
    await startGatherGoal(f.agent, 'oak_log', 2, collect);
    assert.match(await f.agent.gather_goal.done, /No oak_log nearby/);
    assert.match(f.memory.pendingGoal().reason, /No oak_log nearby/);
});

test('bounded retrieval uses local embeddings, caches vectors, and never leaks another world', async t => {
    let batches = 0;
    const f = fixture(t, undefined, {}, { config: { world_id: 'test-world', embeddings: true },
        embeddingBatch: async inputs => { batches++; return inputs.map(text => text.includes('cobblestone') ? [1, 0] : [0, 1]); } });
    for (let i = 0; i < 8; i++) f.memory.record({ kind: 'gather', item: 'cobblestone_' + i, text: 'Verified cobblestone collection', verified: true });
    record(f.memory.store, 'another-world', 'overworld', 'SECRET_OTHER_WORLD');
    const context = await f.memory.context('cobblestone');
    assert(context.length <= 1800); assert(context.split('\n').filter(s => s.startsWith('- ')).length <= 5);
    assert.equal(context.includes('SECRET_OTHER_WORLD'), false); assert.equal(batches, 1);
    const candidates = f.memory.store.candidates(f.memory.world, 'overworld', 'cobblestone');
    assert(candidates.some(r => f.memory.store.getVector(r.id, 'test', r.text)));
});

test('unavailable embeddings fall back to FTS within the time budget', async t => {
    const f = fixture(t, undefined, {}, { config: { world_id: 'test-world', embeddings: true },
        embeddingBatch: () => new Promise(() => {}), embeddingTimeoutMs: 20 });
    f.memory.record({ kind: 'gather', item: 'cobblestone', text: 'Verified cobblestone collection', verified: true });
    const started = performance.now();
    assert.match(await f.memory.context('cobblestone'), /Verified cobblestone/);
    assert(performance.now() - started < 300);
    assert(f.memory.embeddingBackoff > Date.now());
});

test('disabled or corrupt memory never crashes gameplay or trusts unscoped coordinates', t => {
    const f = fixture(t, undefined, {}, { config: { enabled: false } });
    assert.equal(f.memory.enabled, false); assert.doesNotThrow(() => f.memory.beginGoal({}));
    const root = directory(t), filename = join(root, 'bots/Mia/memory.sqlite');
    mkdirSync(join(root, 'bots/Mia'), { recursive: true }); writeFileSync(filename, 'this is not SQLite');
    const corrupt = fixture(t, root);
    assert.equal(corrupt.agent.local_memory, undefined);
    corrupt.agent.memory_bank.loadJson({ old_world: [1, 64, 1] });
    assert.equal(corrupt.agent.memory_bank.recallPlace('old_world'), undefined);
    assert.equal(readFileSync(filename, 'utf8'), 'this is not SQLite');
});

test('configuration preserves other options and rejects invalid IDs before writing', t => {
    const root = directory(t);
    const filename = configureMemory(root, 'Mia', 'world-one');
    const original = JSON.parse(readFileSync(filename)); original.resume_goals = false;
    writeFileSync(filename, JSON.stringify(original));
    configureMemory(root, 'Mia', 'world-two');
    assert.equal(JSON.parse(readFileSync(filename)).resume_goals, false);
    const before = readFileSync(filename);
    assert.throws(() => configureMemory(root, '../Mia', 'bad'));
    assert.throws(() => configureMemory(root, 'Mia', '../world'));
    assert.throws(() => configureMemory(root, 'Mia', undefined));
    assert.deepEqual(readFileSync(filename), before);
});
