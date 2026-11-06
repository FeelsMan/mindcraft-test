import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Vec3 from 'vec3';
import { EventEmitter } from 'node:events';
import { shelterWorld } from './helpers/shelter-world.js';
import { createFoodAPI } from '../src/adapters/minecraft/food.js';
import { installMainSupervisor } from '../src/adapters/minecraft/supervisor.js';
import { installLocalMemory } from '../src/agent/memory_runtime.js';
import { startFoodGoal, planFoodStep, foodContext, runFoodWork } from '../src/agent/food_goal.js';
import { countFood, foodItems, restoreFoodProgress } from '../src/agent/food_policy.js';
import { cancelGatherGoal } from '../src/agent/gather_goal.js';
import { ManagedFurnace } from '../src/agent/managed_smelting.js';
import { walkSafely } from '../src/agent/navigation_recovery.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(check) {
    const deadline = Date.now() + 4000;
    while (!check()) { assert(Date.now() < deadline, 'Expected food lifecycle event'); await sleep(1); }
}
function rootFor(t) {
    const root = mkdtempSync(join(tmpdir(), 'mia-food-goal-'));
    const memories = [];
    t.after(() => { memories.forEach(m => m.close()); rmSync(root, { recursive: true, force: true }); });
    return f => { const m = installLocalMemory(f.agent, { root, config: { world_id: 'food-fixture', embeddings: false } }); memories.push(m); return m; };
}
function fixture(version = '26.3', stock = {}) {
    const f = shelterWorld(version, stock);
    f.bot.health = 20; f.bot.food = 20;
    f.agent.routeResponse = async (_who, message) => f.agent.messages.push(message);
    installMainSupervisor(f.agent, { pollMs: 1 });
    f.api.hasFurnace = () => false;
    f.api.food = { discover: async () => ({ crops: [], animals: [] }), search: async () => ({ verified: false, reason: 'No reachable world food source.' }) };
    return f;
}
function farm(f) {
    const positions = [new Vec3(4, 64, 2), new Vec3(4, 64, 4)];
    for (const at of positions) { f.set(at.offset(0, -1, 0), 'farmland'); f.set(at, 'carrots', { age: 7 }); }
    f.bot.findBlocks = ({ matching }) => positions.filter(p => matching.includes(f.bot.blockAt(p)?.type));
    const dig = f.bot.dig, place = f.bot.placeBlock;
    f.bot.dig = async block => {
        await dig(block); f.stock.carrot = (f.stock.carrot || 0) + 3;
        await f.afterHarvest?.();
    };
    f.bot.placeBlock = async (block, face) => {
        if (f.bot.heldItem.name !== 'carrot') return place(block, face);
        assert(f.stock.carrot > 0); f.stock.carrot--; f.set(block.position.plus(face), 'carrots', { age: 0 });
        f.calls.push(['replant', block.position.plus(face)]);
    };
    f.api.food = createFoodAPI(f.agent, { navigation: () => f.travel, pickup: async () => {} }, { verifyMs: 5, pollMs: 1 });
    return positions;
}

for (const version of ['1.21.4', '26.3']) test(`native ${version} empty inventory obtains the total food reserve from real mature crops and replants every harvested plot`, async t => {
    const f = fixture(version), memory = rootFor(t)(f), positions = farm(f);
    assert.equal(countFood(f.bot), 0);
    assert.match(await startFoodGoal(f.agent, 4, f.api), /started/);
    const goal = f.agent.gather_goal;
    assert.match(await goal.done, /Food goal complete/);
    assert.equal(countFood(f.bot), 4); assert.equal(goal.status, 'complete');
    assert.equal(goal.replantPending, undefined);
    for (const at of positions) assert.equal(Number(f.bot.blockAt(at).getProperties().age), 0);
    assert.equal(f.calls.filter(c => c[0] === 'dig').length, 2);
    assert.equal(f.calls.filter(c => c[0] === 'replant').length, 2);
    assert.equal(f.agent.main_supervisor.view().owner, null);
    assert.equal(memory.pendingGoal().status, 'complete');
    assert.equal(f.agent.main_supervisor.adapter.verifyCompletion(goal).verified, true);
    f.stock.carrot = 0;
    assert.equal(f.agent.main_supervisor.adapter.verifyCompletion(goal).verified, false, 'Final verification must use live inventory');
});

for (const version of ['1.21.4', '26.3']) test(`native ${version} interrupted harvest restores its same-site planting obligation before accepting already-held food`, async t => {
    const install = rootFor(t), f = fixture(version), memory = install(f), positions = farm(f), gate = deferred(), entered = deferred();
    f.afterHarvest = async () => { entered.resolve(); await gate.promise; };
    await startFoodGoal(f.agent, 2, f.api); const first = f.agent.gather_goal;
    await entered.promise;
    assert(memory.pendingGoal().replantPending, 'Planting intent must be durable before interruption');
    f.bot.emit('end'); f.bot.interrupt_code = true; gate.resolve();
    assert.match(await first.done, /paused/);
    memory.close();
    const restored = fixture(version, { carrot: 3 });
    const nextMemory = install(restored); farm(restored); restored.set(positions[0], 'air');
    assert.equal(nextMemory.pendingGoal().status, 'paused');
    assert.equal(await nextMemory.resume(() => startFoodGoal(restored.agent, 2, restored.api)), true);
    const goal = restored.agent.gather_goal;
    assert.match(await goal.done, /Food goal complete/);
    assert.equal(restored.stock.carrot, 2);
    assert.equal(restored.calls.filter(c => c[0] === 'dig').length, 0, 'Resume must replant, not harvest a new plot');
    assert.equal(restored.calls.filter(c => c[0] === 'replant').length, 1);
    assert.equal(Number(restored.bot.blockAt(positions[0]).getProperties().age), 0);
});

for (const version of ['1.21.4', '26.3']) test(`native ${version} no carried food becomes verified hunted meat then cooked food through the same managed goal`, async t => {
    const f = fixture(version, { wooden_sword: 1, coal: 1 }), memory = rootFor(t)(f);
    const at = new Vec3(8, 64, 2); f.set(at, 'furnace');
    let input = null, fuel = null, output = null;
    const window = new EventEmitter();
    window.inputItem = () => input; window.fuelItem = () => fuel; window.outputItem = () => output;
    window.putInput = async (_type, _meta, n) => { assert(f.stock.beef >= n); f.stock.beef -= n; input = { name: 'beef', count: n }; };
    window.putFuel = async (_type, _meta, n) => {
        assert.equal(n, 1); assert.equal(f.stock.coal, 1); f.stock.coal--;
        fuel = { name: 'coal', count: 1 }; window.fuelSeconds = 80;
        output = { name: 'cooked_beef', count: input.count }; input = null;
    };
    window.takeOutput = async () => { assert(output); f.stock.cooked_beef = (f.stock.cooked_beef || 0) + output.count; output = null; };
    window.takeInput = async () => { f.stock.beef += input.count; input = null; };
    window.close = async () => { f.bot.currentWindow = null; window.emit('close'); };
    const furnace = new ManagedFurnace(f.bot, {
        blockAt: p => f.bot.blockAt(new Vec3(p.x, p.y, p.z)),
        move: p => walkSafely(f.bot, new Vec3(p.x, p.y, p.z - 1), f.travel),
        open: async () => { f.bot.currentWindow = window; return window; }
    }, { settleMs: 0, pollMs: 1, waitMs: 100, verifyMs: 5 });
    furnace.record = { dimension: 'overworld', position: { x: at.x, y: at.y, z: at.z } };
    f.api.hasFurnace = () => true; f.api.furnaceSnapshot = () => furnace.snapshot;
    f.api.inspectFurnace = () => furnace.inspect(); f.api.smelt = (_bot, step) => furnace.smelt(step);
    const metadata = []; metadata[f.data.entitiesByName.cow.metadataKeys.indexOf('baby')] = false;
    const cow = { id: 19, name: 'cow', position: new Vec3(8.5, 64, 5.5), metadata, isValid: true };
    f.bot.entities[cow.id] = cow; f.bot.findBlocks = () => [];
    f.bot.pvp = { movements: f.travel.movements(), attack: async target => {
        assert.equal(target.id, cow.id); f.bot.emit('entityDead', target); delete f.bot.entities[cow.id]; f.stock.beef = 2;
    }, stop: async () => {} };
    f.api.food = createFoodAPI(f.agent, { navigation: () => f.travel, pickup: async () => {} }, { pollMs: 1, verifyMs: 5 });
    await startFoodGoal(f.agent, 2, f.api); const goal = f.agent.gather_goal;
    assert.match(await goal.done, /Food goal complete/);
    assert.equal(f.stock.beef, 0); assert.equal(f.stock.cooked_beef, 2); assert.equal(f.stock.coal, 0);
    assert.equal(countFood(f.bot), 2); assert.equal(memory.pendingGoal().status, 'complete');
    assert.equal(f.agent.main_supervisor.view().owner, null);
});

test('no reachable source produces a bounded specific blocked result with released ownership', async t => {
    const f = fixture(), memory = rootFor(t)(f); let searches = 0;
    f.api.food.search = async () => { searches++; return { verified: false, reason: 'No reachable mature crop or supported land animal.' }; };
    await startFoodGoal(f.agent, 8, f.api); const goal = f.agent.gather_goal;
    assert.match(await goal.done, /No reachable mature crop/);
    assert.equal(goal.status, 'blocked'); assert.equal(searches, 2);
    assert.equal(countFood(f.bot), 0); assert.equal(memory.pendingGoal().status, 'blocked');
    assert.equal(f.agent.actions.executing, false);
});

test('explicit cancellation while startup awaits an old action never harvests and stays cancelled after restart', async t => {
    const install = rootFor(t), f = fixture(), memory = install(f), gate = deferred(); let starts = 0;
    const old = f.agent.actions.runAction('action:followPlayer', () => gate.promise, { timeout: 0 });
    await until(() => f.agent.actions.executing);
    f.api.food.discover = async () => { starts++; return { crops: [], animals: [] }; };
    const starting = startFoodGoal(f.agent, 4, f.api);
    await until(() => f.bot.interrupt_code);
    const cancel = cancelGatherGoal(f.agent); gate.resolve();
    await old; await cancel; await starting;
    await f.agent.gather_goal.done;
    assert.equal(starts, 0); assert.equal(memory.pendingGoal().status, 'cancelled'); memory.close();
    const next = fixture(), nextMemory = install(next);
    assert.equal(await nextMemory.resume(() => assert.fail('Cancelled food restarted'), { manual: true }), false);
});

test('failed startup finishes its checkpoint as blocked rather than leaving resumable running work', async t => {
    const f = fixture(), memory = rootFor(t)(f);
    f.agent.history.save = async () => { throw Error('history unavailable'); };
    await assert.rejects(startFoodGoal(f.agent, 4, f.api), /history unavailable/);
    assert.equal(memory.pendingGoal().status, 'blocked');
    assert.equal(f.agent.main_supervisor.view().goal.status, 'blocked');
    assert.equal(f.agent.gather_goal.active, false); assert.equal(f.bot.managedGoal, undefined);
});

test('pending planting supplies are excluded from the edible total and raw/unsafe food does not satisfy a prepared reserve', () => {
    const f = fixture('26.3', { carrot: 1, beef: 4, chicken: 2, potato: 2, poisonous_potato: 3 });
    const context = { replantPending: { seed: 'carrot' } };
    assert.equal(countFood(f.bot, context), 0); assert.equal(foodItems(f.bot, context).length, 0);
    f.stock.carrot = 4;
    assert.equal(countFood(f.bot, context), 3); assert.equal(foodItems(f.bot, context)[0].name, 'carrot');
    f.stock.cooked_beef = 2; assert.equal(countFood(f.bot, context), 5);
});

test('pending replant is planned before an already satisfied inventory target and rejected sources are skipped', async () => {
    const f = fixture('26.3', { carrot: 4 });
    const context = { ...foodContext(), target: 2, replantPending: { kind: 'replant', seed: 'carrot', item: 'carrot' } };
    assert.equal((await planFoodStep(f.agent, context, f.api)).type, 'replant');
    delete context.replantPending; f.stock.carrot = 0;
    f.api.food.discover = async () => ({ crops: [1, 2].map(x => ({ kind: 'harvest', item: 'carrot', position: { x, y: 64, z: 0 } })), animals: [] });
    context.foodRejected = ['harvest:1,64,0'];
    assert.equal((await planFoodStep(f.agent, context, f.api)).position.x, 2);
});

test('food progress restoration validates scope and preserves charged attempts without accepting malformed planting records', () => {
    const progress = restoreFoodProgress({ foodActions: 9, foodFailures: 1,
        foodSearch: { world: 'one', dimension: 'overworld', origin: { x: 0, y: 64, z: 0 }, attempts: 2, visited: [{ x: 8, y: 64, z: 0 }, null] },
        replantPending: { block: 'carrots', seed: 'carrot', item: 'carrot', position: { x: 4, y: 64, z: 0 }, scope: { world: 'one', dimension: 'overworld' } } });
    assert.equal(progress.foodActions, 9); assert.equal(progress.foodSearch.attempts, 2);
    assert.equal(progress.foodSearch.visited.length, 1); assert.equal(progress.replantPending.seed, 'carrot');
    assert.equal(restoreFoodProgress({ replantPending: { ...progress.replantPending, block: 'chest' } }).replantPending, undefined);
});

test('subtask work has a bounded persisted action/deadline budget and never reports attempted work as complete', async () => {
    const f = fixture(), context = { ...foodContext(), target: 1, foodActions: 256 };
    assert.equal((await runFoodWork(f.agent, context, f.api, () => true)).blocked, true);
    context.foodActions = 0; context.foodDeadline = Date.now() - 1;
    assert.match((await runFoodWork(f.agent, context, f.api, () => true)).reason, /time budget/);
});
