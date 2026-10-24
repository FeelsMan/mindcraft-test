import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MainSupervisor } from '../src/core/mainSupervisor.js';
import { installMainSupervisor } from '../src/adapters/minecraft/supervisor.js';
import { installLocalMemory } from '../src/agent/memory_runtime.js';
import { startShelterGoal } from '../src/agent/shelter_goal.js';
import { startMakeGoal } from '../src/agent/make_goal.js';
import { startGatherGoal, cancelGatherGoal } from '../src/agent/gather_goal.js';
import { finishManagedGoal } from '../src/agent/managed_goal.js';
import { inspectShelter } from '../src/agent/shelter_building.js';
import { shelterWorld } from './helpers/shelter-world.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check, message = 'Condition did not become true') {
    const deadline = Date.now() + 5000;
    while (!check()) { assert(Date.now() < deadline, message); await sleep(1); }
}
function supervise(f) {
    f.bot.health = 20; f.bot.food = 20;
    const supervisor = installMainSupervisor(f.agent, { pollMs: 1 });
    return supervisor;
}
function memories(t) {
    const root = mkdtempSync(join(tmpdir(), 'mia-supervisor-')), opened = [];
    t.after(() => { for (const memory of opened) memory.close(); rmSync(root, { recursive: true, force: true }); });
    return (f, world = 'supervisor-test') => {
        const memory = installLocalMemory(f.agent, { root, config: { world_id: world, embeddings: false } });
        opened.push(memory); return memory;
    };
}
function reserve(f, kind = 'make') {
    const goal = { kind, item: kind === 'shelter' ? 'shelter' : 'oak_log', target: 1,
        active: true, cancelled: false, status: 'running' };
    f.agent.gather_goal = f.bot.managedGoal = goal;
    f.agent.main_supervisor.beginGoal(goal);
    return goal;
}

test('portable world observations are fresh copies and never fabricate unavailable inventory or health', () => {
    let time = 1;
    const observed = { scope: { environment: 'other-game', world: 'one', dimension: 'room' },
        inventory: { wood: 2 }, interruptions: [], action: {} };
    const supervisor = new MainSupervisor({ observe: () => observed }, { clock: () => time });
    const a = supervisor.observe(); observed.inventory.wood = 7; time = 2;
    const b = supervisor.observe();
    assert.equal(a.inventory.wood, 2); assert.equal(b.inventory.wood, 7);
    assert.equal(a.observedAt, 1); assert.equal(b.observedAt, 2);
    assert.equal(b.health, null); observed.inventory = null;
    assert.equal(supervisor.observe().inventory, null);
});

for (const version of ['1.21.4', '26.3']) test(`native ${version} shelter hands control to combat, checks live condition and resumes the same verified build`, async t => {
    const f = shelterWorld(version, { oak_planks: 58, oak_door: 1 });
    const memory = memories(t)(f), supervisor = supervise(f), placed = deferred(), threat = deferred();
    let first = true, defending = false, placedDuringDefense = 0;
    f.bot.afterPlace = async () => {
        if (defending) placedDuringDefense++;
        if (!first) return;
        first = false; placed.resolve();
        await until(() => f.bot.interrupt_code, 'Combat never interrupted placement');
    };
    await startShelterGoal(f.agent, f.api);
    const goal = f.agent.gather_goal; goal.resumeDelayMs = 0;
    await placed.promise;
    f.bot.modes.getActiveModes = () => defending ? ['self_defense'] : [];
    defending = true;
    const combat = f.agent.actions.runAction('mode:self_defense', async () => {
        assert.equal(supervisor.view().owner.specialist, 'combat');
        assert.equal(memory.pendingGoal().status, 'paused');
        f.bot.health = 11; f.bot.food = 9;
        f.stock.oak_planks--; // Supplies changed while the original plan was paused.
        await threat.promise;
    });
    await until(() => supervisor.view().owner?.label === 'mode:self_defense');
    assert.equal(supervisor.view().goal.status, 'paused');
    const count = f.calls.filter(c => c[0] === 'place').length;
    await sleep(10);
    assert.equal(f.calls.filter(c => c[0] === 'place').length, count);
    threat.resolve(); await combat; defending = false;
    assert.match(await goal.done, /Shelter complete/);
    assert(inspectShelter(f.bot, goal.shelter).structureComplete);
    assert.equal(supervisor.view().goal.status, 'complete');
    assert.equal(supervisor.view().conditionCheck.health, 11);
    assert.equal(supervisor.view().conditionCheck.hunger, 9);
    assert.equal(supervisor.view().owner, null);
    assert.equal(memory.pendingGoal().status, 'complete');
    assert.equal(placedDuringDefense, 0);
    assert(f.calls.some(c => c[0] === 'gather'), 'Resume must obtain supplies lost during combat');
    const cells = f.calls.filter(c => c[0] === 'place').map(c => c[2].toString());
    assert.equal(cells.length, 59); assert.equal(new Set(cells).size, 59);
    assert(supervisor.transitions.some(event => event.status === 'paused'));
    assert.equal(supervisor.transitions.at(-1).status, 'complete');
});

test('explicit cancellation while combat owns the body prevents all later shelter placement and persisted resume', async t => {
    const f = shelterWorld('26.3', { oak_planks: 58, oak_door: 1 });
    const memory = memories(t)(f), supervisor = supervise(f), placed = deferred();
    f.bot.afterPlace = async () => { placed.resolve(); await until(() => f.bot.interrupt_code); };
    await startShelterGoal(f.agent, f.api); const goal = f.agent.gather_goal;
    await placed.promise;
    const combat = f.agent.actions.runAction('mode:self_defense', async () => {
        await until(() => f.bot.interrupt_code);
    });
    await until(() => supervisor.view().owner?.label === 'mode:self_defense');
    const count = f.calls.filter(c => c[0] === 'place').length;
    await cancelGatherGoal(f.agent); await combat;
    assert.equal(supervisor.view().goal.status, 'cancelled');
    assert.equal(memory.pendingGoal().status, 'cancelled');
    assert.equal(await memory.resume(() => assert.fail('Cancelled goal resumed'), { manual: true }), false);
    assert.equal(f.calls.filter(c => c[0] === 'place').length, count);
    assert.equal(supervisor.view().owner, null);
});

test('a managed action queued behind a slow stop cannot acquire the body after cancellation', async () => {
    const f = shelterWorld(), supervisor = supervise(f), gate = deferred(); let ran = 0;
    const old = f.agent.actions.runAction('action:followPlayer', () => gate.promise);
    await until(() => f.agent.actions.executing);
    const goal = reserve(f);
    const queued = f.agent.actions.runAction('action:makeGoal', async () => { ran++; }, { goal });
    await until(() => f.bot.interrupt_code);
    supervisor.cancelGoal(goal); goal.active = false; gate.resolve();
    await old; const result = await queued;
    assert.equal(result.deferred, true); assert.equal(ran, 0);
    assert.equal(supervisor.view().goal.status, 'cancelled'); assert.equal(supervisor.view().owner, null);
});

test('stale callbacks cannot finish, cancel or release a replacement goal/action owner', async () => {
    const f = shelterWorld(), supervisor = supervise(f), first = reserve(f);
    const oldRun = { label: 'action:makeGoal', priority: 50 };
    supervisor.actionStarted(oldRun); supervisor.cancelGoal(first); first.active = false;
    const second = reserve(f, 'gather'), newRun = { label: 'action:gatherGoal', priority: 50 };
    supervisor.actionStarted(newRun);
    supervisor.actionFinished(oldRun, { interrupted: true });
    supervisor.cancelGoal(first);
    supervisor.finishGoal(first, true, 'Old success');
    assert.equal(supervisor.view().owner.label, newRun.label);
    assert.equal(supervisor.view().goal.kind, 'gather'); assert.equal(second.cancelled, false);
});

test('the supervisor refuses an unverified success and cancellation beats a late success callback', async t => {
    const f = shelterWorld(), memory = memories(t)(f), supervisor = supervise(f), goal = reserve(f);
    memory.beginGoal(goal);
    const result = finishManagedGoal(f.agent, goal, true, 'Claimed complete');
    assert.equal(result.completed, false); assert.match(result.report, /verification failed/);
    assert.equal(supervisor.view().goal.status, 'blocked'); assert.equal(memory.pendingGoal().status, 'blocked');
    goal.active = false;
    const another = reserve(f); memory.beginGoal(another); f.stock.oak_log = 1;
    supervisor.cancelGoal(another);
    const cancelled = finishManagedGoal(f.agent, another, true, 'Late success');
    assert.equal(cancelled.completed, false); assert.match(cancelled.report, /cancelled/);
    assert.equal(memory.pendingGoal().status, 'cancelled');
});

test('bounded resource failures retain the exact target; concurrent memory resumes start only one replacement', async t => {
    const f = shelterWorld('26.3'), memory = memories(t)(f), supervisor = supervise(f);
    const api = { ...f.api, verifyTimeoutMs: 1, collect: async () => {} };
    await startMakeGoal(f.agent, 'oak_planks', 4, api);
    assert.match(await f.agent.gather_goal.done, /Crafting stopped/);
    assert.equal(supervisor.view().goal.status, 'blocked');
    assert.equal(memory.pendingGoal().target, 4);
    let starts = 0;
    const restore = valid => memory.resume(command => {
        assert(valid()); assert.equal(command, '!makeGoal("oak_planks", 4)'); starts++;
        return startMakeGoal(f.agent, 'oak_planks', 4, f.api);
    }, { manual: true });
    assert.deepEqual(await Promise.all([supervisor.resume(restore), supervisor.resume(restore)]), [true, true]);
    assert.equal(starts, 1);
    await f.agent.gather_goal.done;
    assert.equal(supervisor.view().goal.status, 'complete'); assert.equal(f.stock.oak_planks, 4);
});

test('a pending memory-restore callback is invalidated by stop and cannot restart work', async () => {
    const f = shelterWorld(), supervisor = supervise(f), gate = deferred(); let ran = 0;
    const restoring = supervisor.resume(async valid => { await gate.promise; if (valid()) ran++; return valid(); });
    await sleep(0); supervisor.cancelGoal(); gate.resolve();
    assert.equal(await restoring, false); assert.equal(ran, 0);
});

test('a verification error blocks completion and shutdown prevents a queued action from starting', async () => {
    const f = shelterWorld(), supervisor = supervise(f), goal = reserve(f);
    supervisor.adapter.verifyCompletion = () => { throw Error('Live observation unavailable'); };
    const result = supervisor.finishGoal(goal, true, 'Complete');
    assert.equal(result.completed, false); assert.match(result.report, /Live observation unavailable/);
    f.agent._shuttingDown = true;
    assert.equal((await f.agent.actions.runAction('action:makeGoal', () => assert.fail('Shutdown work started'), { goal })).deferred, true);
});

for (const kind of ['make', 'gather', 'shelter']) test(`stop during ${kind} startup is durable before the initial action has begun`, async t => {
    const f = shelterWorld('26.3'), memory = memories(t)(f), supervisor = supervise(f), gate = deferred();
    f.agent.self_prompter.stop = () => gate.promise;
    const starting = kind === 'shelter' ? startShelterGoal(f.agent, f.api) :
        kind === 'make' ? startMakeGoal(f.agent, 'oak_planks', 4, f.api) :
        startGatherGoal(f.agent, 'oak_log', 1, f.api.collect);
    assert.equal(memory.pendingGoal().status, 'running');
    const cancelling = cancelGatherGoal(f.agent);
    assert.equal(memory.pendingGoal().status, 'cancelled');
    gate.resolve(); await starting; await cancelling; await f.agent.gather_goal.done;
    assert.equal(memory.pendingGoal().status, 'cancelled');
    assert.equal(supervisor.view().goal.status, 'cancelled'); assert.equal(f.calls.length, 0);
});

test('restart restores the saved site and remaining materials through a new supervisor without duplicate placement', async t => {
    const connect = memories(t), a = shelterWorld('26.3', { oak_planks: 58, oak_door: 1 });
    const oldMemory = connect(a); supervise(a);
    let count = 0;
    a.bot.afterPlace = async () => { if (++count === 4) a.bot.emit('end'); };
    await startShelterGoal(a.agent, a.api); await a.agent.gather_goal.done;
    assert(oldMemory.closed);
    const b = shelterWorld('26.3', a.stock);
    for (const [key, block] of a.blocks) b.blocks.set(key, block);
    const memory = connect(b), supervisor = supervise(b);
    assert.equal(supervisor.view().goal.status, 'paused');
    const site = memory.pendingGoal().shelter;
    assert(await supervisor.resume(valid => memory.resume(() => valid() ? startShelterGoal(b.agent, b.api) : false)));
    await b.agent.gather_goal.done;
    assert.deepEqual(b.agent.gather_goal.shelter, site);
    assert.equal(supervisor.view().goal.status, 'complete');
    const places = [...a.calls, ...b.calls].filter(c => c[0] === 'place');
    assert.equal(places.length, 59); assert.equal(new Set(places.map(c => c[2].toString())).size, 59);
});

test('changed dimension pauses the goal before any new physical action', async t => {
    const f = shelterWorld(), memory = memories(t)(f), supervisor = supervise(f), goal = reserve(f);
    memory.beginGoal(goal); f.bot.game.dimension = 'the_nether';
    assert.equal(await supervisor.waitForTurn(goal), false);
    assert.equal(goal.cancelReason, 'dimension'); assert.equal(supervisor.view().goal.status, 'paused');
    assert.equal(memory.pendingGoal().dimension, 'overworld'); assert.equal(f.calls.length, 0);
});

test('managed log collection is supervised and a stop after completion preserves its verified outcome', async () => {
    const f = shelterWorld(), supervisor = supervise(f);
    await startGatherGoal(f.agent, 'oak_log', 2, f.api.collect, null, { requestContext: { requester: 'CaptainNeyo' } });
    assert.match(await f.agent.gather_goal.done, /Collection complete/);
    assert.equal(supervisor.view().goal.requester, 'CaptainNeyo');
    assert.equal(supervisor.view().goal.status, 'complete');
    await cancelGatherGoal(f.agent);
    assert.equal(supervisor.view().goal.status, 'complete');
});
