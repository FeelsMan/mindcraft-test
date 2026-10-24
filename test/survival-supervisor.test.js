import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SurvivalSupervisor, survivalDefaults } from '../src/supervisors/survival.js';
import { installMainSupervisor } from '../src/adapters/minecraft/supervisor.js';
import { installLocalMemory } from '../src/agent/memory_runtime.js';
import { startShelterGoal } from '../src/agent/shelter_goal.js';
import { shelterBlueprint } from '../src/agent/shelter_blueprint.js';
import { inspectShelter } from '../src/agent/shelter_building.js';
import { modeAllowedDuringGoal } from '../src/agent/managed_goal.js';
import { shelterWorld } from './helpers/shelter-world.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check, message = 'Condition did not become true') {
    const deadline = Date.now() + 5000;
    while (!check()) { assert(Date.now() < deadline, message); await sleep(1); }
}
const scope = () => ({ environment: 'minecraft', world: 'survival-fixture', dimension: 'overworld' });
const hostile = (distance = 10) => ({ id: 7, name: 'pillager', distance });

function fixture(config = {}) {
    let now = 100000;
    const calls = [], state = { available: true, scope: scope(), health: 20, hunger: 20,
        position: { x: 2, y: 64, z: 2 }, damageAt: 0, damageTaken: 0,
        threats: [], foodAvailable: false };
    const refuge = { kind: 'cover', scope: scope(), position: { x: 8, y: 64, z: 8 } };
    const adapter = {
        observe: () => state,
        run: (_token, action) => action(),
        retreat: async valid => { assert(valid()); calls.push('retreat'); return { verified: true, destination: refuge }; },
        eat: async valid => { assert(valid()); calls.push('eat'); state.hunger = 20; return { verified: true }; },
        refugeValid: destination => destination === refuge
    };
    const supervisor = new SurvivalSupervisor(adapter, { clock: () => now, calmMs: 100, ...config });
    return { supervisor, adapter, state, calls, refuge, advance: ms => { now += ms; }, now: () => now };
}
async function tick(f) { f.supervisor.update(); if (f.supervisor.flight) await f.supervisor.flight; }

test('danger is recognized before emergency health, using proximity, health and recent damage', () => {
    const f = fixture();
    const cases = [
        { health: 16, threats: [hostile(20)] },
        { health: 20, threats: [hostile(3)] },
        { health: 15, damageAt: f.now() - 1, damageTaken: 3 },
        { health: 18, damageAt: f.now() - 1, damageTaken: 18 },
        { health: survivalDefaults.lowHealth, threats: [] }
    ];
    for (const values of cases) {
        const state = { ...f.state, ...values };
        assert.equal(f.supervisor.assess(state).danger, true, JSON.stringify(values));
        assert(state.health >= 5, 'The intervention should precede the existing last-resort threshold');
    }
    assert.equal(f.supervisor.assess({ ...f.state, threats: [hostile(30)] }).danger, false);
    assert.equal(f.supervisor.assess({ ...f.state, damageAt: f.now() - survivalDefaults.damageWindowMs - 1 }).recent, false);
    assert.equal(f.supervisor.assess({ ...f.state, damageAt: f.now() + 1 }).recent, false);
});

test('verified retreat holds recovery through threats and recent damage, then requires sustained calm', async () => {
    const f = fixture();
    Object.assign(f.state, { health: 16, threats: [hostile()], damageAt: f.now(), damageTaken: 4 });
    await tick(f);
    assert.equal(f.supervisor.view().retreatAttempts, 1);
    assert.equal(f.supervisor.refuge, f.refuge);
    f.advance(200);
    await tick(f);
    assert.equal(f.supervisor.active, true);
    assert.deepEqual(f.calls, ['retreat']);
    f.state.threats = [];
    await tick(f);
    assert.equal(f.supervisor.active, true, 'Recent damage must prevent immediate handback');
    f.advance(survivalDefaults.damageWindowMs);
    await tick(f);
    f.advance(99); await tick(f);
    assert.equal(f.supervisor.active, true);
    f.state.threats = [hostile(8)]; await tick(f);
    f.state.threats = []; await tick(f);
    f.advance(99); await tick(f);
    assert.equal(f.supervisor.active, true, 'An approaching threat must restart the calm interval');
    f.advance(1); await tick(f);
    assert.equal(f.supervisor.view().status, 'idle');
    assert.equal(f.supervisor.active, false);
});

test('an unchanged threat that triggered early intervention cannot repeatedly release and reacquire control', async () => {
    const f = fixture();
    Object.assign(f.state, { health: 16, threats: [hostile(20)] });
    assert.equal(f.supervisor.assess(f.state).danger, true);
    await tick(f); f.advance(200); await tick(f);
    assert.equal(f.supervisor.active, true, 'The original early-danger condition still holds');
    f.state.health = 20;
    await tick(f); f.advance(100); await tick(f);
    assert.equal(f.supervisor.active, false, 'Observed recovery can release control with the distant threat unchanged');
    await tick(f);
    assert.equal(f.supervisor.active, false, 'The same state must not immediately trigger another intervention');
});

test('low health without visible hostiles holds recovery and eats when fresh carried food is available', async () => {
    const f = fixture();
    Object.assign(f.state, { health: 10, hunger: 10, foodAvailable: true });
    await tick(f);
    assert.deepEqual(f.calls, ['eat']);
    assert.equal(f.supervisor.active, true);
    f.advance(1000); await tick(f);
    assert.equal(f.supervisor.active, true, 'A meal alone cannot establish recovered health');
    f.state.health = 16;
    await tick(f); f.advance(100); await tick(f);
    assert.equal(f.supervisor.active, false);
});

test('hunger without live suitable food is blocked without attempting consumption or inventing supplies', async () => {
    const f = fixture(); f.state.hunger = 8;
    await tick(f);
    assert.equal(f.supervisor.view().status, 'blocked');
    assert.match(f.supervisor.view().reason, /No suitable food in live inventory/);
    assert.equal(f.supervisor.active, true);
    assert.deepEqual(f.calls, []);
    f.state.foodAvailable = true;
    await tick(f);
    assert.deepEqual(f.calls, ['eat']);
    assert.equal(f.supervisor.view().foodAttempts, 1);
    await tick(f); f.advance(100); await tick(f);
    assert.equal(f.supervisor.active, false);
});

test('unverified or thrown food attempts are bounded and never release a hungry task', async () => {
    for (const throwing of [false, true]) {
        const f = fixture({ maxMeals: 2 });
        Object.assign(f.state, { hunger: 8, foodAvailable: true });
        f.adapter.eat = async () => {
            f.calls.push('eat');
            if (throwing) throw new Error('Consumption interrupted');
            return undefined;
        };
        for (let i = 0; i < 8; i++) await tick(f);
        assert.equal(f.supervisor.active, true);
        assert.equal(f.state.hunger, 8);
        assert.equal(f.supervisor.view().foodAttempts, 2);
        assert.deepEqual(f.calls, ['eat', 'eat']);
        assert.match(f.supervisor.view().reason, /Food attempt budget exhausted/);
    }
});

test('failed retreat and invalidated refuge do not reset the bounded attempt count', async () => {
    const f = fixture({ maxRetreats: 2 });
    Object.assign(f.state, { health: 16, threats: [hostile()] });
    await tick(f);
    f.adapter.refugeValid = () => false;
    f.adapter.retreat = async () => { f.calls.push('retreat'); return { verified: false, reason: 'Route blocked' }; };
    for (let i = 0; i < 8; i++) {
        f.state.threats[0].distance = 8 + i % 2;
        await tick(f);
    }
    assert.equal(f.supervisor.refuge, null);
    assert.equal(f.supervisor.view().retreatAttempts, 2);
    assert.equal(f.calls.length, 2);
    assert.equal(f.supervisor.view().status, 'blocked');
    assert.match(f.supervisor.view().reason, /No verified reachable refuge/);
    assert.equal(f.supervisor.active, true);
});

test('a safer escape position within threat range cannot establish protected cover for eating', async () => {
    const f = fixture({ maxRetreats: 2 });
    Object.assign(f.state, { health: 16, hunger: 8, foodAvailable: true, threats: [hostile()] });
    f.refuge.kind = 'escape';
    for (let i = 0; i < 5; i++) await tick(f);
    assert.deepEqual(f.calls, ['retreat', 'retreat']);
    assert.equal(f.supervisor.view().retreatAttempts, 2);
    assert.equal(f.supervisor.view().foodAttempts, 0);
    assert.equal(f.supervisor.view().status, 'blocked');
    f.state.threats = [];
    await tick(f);
    assert.deepEqual(f.calls, ['retreat', 'retreat', 'eat']);
});

test('the overall time budget holds a blocked task and still permits release after observed improvement', async () => {
    const f = fixture({ budgetMs: 10 });
    Object.assign(f.state, { health: 16, threats: [hostile()] });
    f.adapter.retreat = async () => { f.calls.push('retreat'); return { verified: false }; };
    await tick(f);
    f.advance(10);
    for (let i = 0; i < 3; i++) await tick(f);
    assert.equal(f.supervisor.view().status, 'blocked');
    assert.match(f.supervisor.view().reason, /Recovery budget exhausted/);
    assert.deepEqual(f.calls, ['retreat']);
    assert.equal(f.supervisor.active, true);
    f.state.threats = [];
    await tick(f); f.advance(100); await tick(f);
    assert.equal(f.supervisor.active, false);
    assert.equal(f.supervisor.view().status, 'idle');
});

test('unknown observations, death and scope changes invalidate in-flight survival outcomes', async () => {
    for (const [invalidate, held] of [
        [state => { state.available = false; }, true],
        [state => { state.health = undefined; }, true],
        [state => { state.health = 0; }, false],
        [state => { state.scope = { ...state.scope, dimension: 'the_nether' }; }, false]
    ]) {
        const f = fixture(), entered = deferred(), gate = deferred();
        Object.assign(f.state, { health: 16, threats: [hostile()] });
        let actionValid;
        f.adapter.retreat = async valid => {
            actionValid = valid; entered.resolve(); await gate.promise;
            return { verified: true, destination: f.refuge };
        };
        f.supervisor.update(); await entered.promise;
        invalidate(f.state); f.supervisor.update();
        assert.equal(f.supervisor.active, held);
        assert.equal(f.supervisor.view().status, held ? 'blocked' : 'paused');
        assert.equal(actionValid(), false);
        gate.resolve(); await f.supervisor.flight;
        assert.equal(f.supervisor.refuge, null, 'An old environment cannot establish a current refuge');
        assert.equal(f.supervisor.view().status, held ? 'blocked' : 'paused');
    }
});

test('incomplete fresh observations never start food or movement', async () => {
    for (const missing of ['health', 'hunger', 'position', 'threats']) {
        const f = fixture();
        Object.assign(f.state, { health: 10, hunger: 8, threats: [hostile(2)], foodAvailable: true });
        delete f.state[missing];
        await tick(f);
        assert.equal(f.supervisor.active, false, missing);
        assert.deepEqual(f.calls, []);
    }
});

test('time spent without observations cannot satisfy the sustained-calm release interval', async () => {
    const f = fixture();
    Object.assign(f.state, { health: 16, threats: [hostile()] });
    await tick(f);
    f.state.threats = []; await tick(f);
    f.advance(50); f.state.hunger = undefined; await tick(f);
    f.advance(200); f.state.hunger = 20; await tick(f);
    assert.equal(f.supervisor.active, true, 'Unknown time must not count as verified calm');
    f.advance(99); await tick(f);
    assert.equal(f.supervisor.active, true);
    f.advance(1); await tick(f);
    assert.equal(f.supervisor.active, false);
});

test('explicit cancellation suppresses the same recovery request and ignores a late verified result', async () => {
    const f = fixture(), entered = deferred(), gate = deferred();
    Object.assign(f.state, { health: 16, threats: [hostile()] });
    f.adapter.retreat = async valid => {
        entered.resolve(); await gate.promise;
        assert.equal(valid(), false);
        return { verified: true, destination: f.refuge };
    };
    f.supervisor.update(); await entered.promise;
    f.supervisor.cancel(); gate.resolve(); await f.supervisor.flight;
    for (let i = 0; i < 3; i++) await tick(f);
    assert.equal(f.supervisor.view().status, 'cancelled');
    assert.equal(f.supervisor.active, false);
    assert.equal(f.supervisor.refuge, null);
    assert.equal(f.supervisor.view().retreatAttempts, 1);
    f.adapter.retreat = async () => ({ verified: false });
    f.state.health = 15;
    await tick(f);
    assert.equal(f.supervisor.active, true, 'A new observed danger may initiate a fresh bounded intervention');
});

function ownedFixture() {
    const f = shelterWorld(); f.bot.health = 20; f.bot.food = 20;
    const main = installMainSupervisor(f.agent, { pollMs: 1 });
    const survival = fixture();
    survival.adapter.observe = () => ({ ...survival.state,
        health: f.bot.health, hunger: f.bot.food, scope: main.observe().scope });
    f.agent.survival_supervisor = survival.supervisor;
    survival.adapter.run = (token, action) => f.agent.actions.runAction('mode:survival', action,
        { timeout: 0, valid: () => survival.supervisor.isCurrent(token) });
    return { ...f, main, survival };
}

test('a survival request queued behind a slow action stop cannot acquire ownership after cancellation', async () => {
    const f = ownedFixture(), gate = deferred();
    const old = f.agent.actions.runAction('action:followPlayer', () => gate.promise, { timeout: 0 });
    await until(() => f.agent.actions.executing);
    f.bot.health = 16; f.survival.state.threats = [hostile()];
    f.survival.supervisor.update();
    await until(() => f.bot.interrupt_code);
    assert.equal(f.main.view().owner.label, 'action:followPlayer');
    f.survival.supervisor.cancel(); gate.resolve();
    await old; await f.survival.supervisor.flight;
    assert.deepEqual(f.survival.calls, []);
    assert.equal(f.survival.supervisor.view().retreatAttempts, 0);
    assert.equal(f.survival.supervisor.view().status, 'cancelled');
    assert.equal(f.main.view().owner, null);
});

test('a queued survival request rechecks complete live observations before acquiring the body', async () => {
    const f = ownedFixture(), gate = deferred();
    const old = f.agent.actions.runAction('action:followPlayer', () => gate.promise, { timeout: 0 });
    await until(() => f.agent.actions.executing);
    f.bot.health = 16; f.survival.state.threats = [hostile()];
    f.survival.supervisor.update();
    await until(() => f.bot.interrupt_code);
    f.bot.food = undefined; // The queued handoff must check again before the next update tick.
    gate.resolve(); await old; await f.survival.supervisor.flight;
    assert.deepEqual(f.survival.calls, []);
    assert.equal(f.survival.supervisor.view().retreatAttempts, 0);
    assert.equal(f.main.view().owner, null);
});

test('the recovery time budget also expires while survival is queued behind another action', async () => {
    const f = ownedFixture(), gate = deferred();
    const old = f.agent.actions.runAction('action:followPlayer', () => gate.promise, { timeout: 0 });
    await until(() => f.agent.actions.executing);
    f.bot.health = 16; f.survival.state.threats = [hostile()];
    f.survival.supervisor.update();
    await until(() => f.bot.interrupt_code);
    f.survival.advance(survivalDefaults.budgetMs + 1);
    gate.resolve(); await old; await f.survival.supervisor.flight;
    assert.deepEqual(f.survival.calls, []);
    assert.equal(f.survival.supervisor.view().retreatAttempts, 0);
    await tick(f.survival);
    assert.equal(f.survival.supervisor.view().status, 'blocked');
    assert.match(f.survival.supervisor.view().reason, /Recovery budget exhausted/);
    assert.equal(f.main.view().owner, null);
});

test('recovery gaps deny optional and managed actions while immediate self-preservation can preempt survival', async () => {
    const f = ownedFixture(), entered = deferred(), gate = deferred();
    f.bot.health = 16; f.survival.state.threats = [hostile()];
    f.survival.adapter.retreat = async valid => {
        entered.resolve(); await until(() => f.bot.interrupt_code);
        return { verified: valid() && !f.bot.interrupt_code, reason: 'Emergency interrupted retreat' };
    };
    f.survival.supervisor.update(); await entered.promise;
    assert.equal(f.main.view().owner.label, 'mode:survival');
    const emergency = f.agent.actions.runAction('mode:self_preservation', () => gate.promise, { timeout: 0 });
    await until(() => f.main.view().owner?.label === 'mode:self_preservation');
    assert.equal(f.main.view().owner.priority, 100);
    gate.resolve(); await emergency; await f.survival.supervisor.flight;
    assert.equal(f.survival.supervisor.active, true);
    assert.equal(f.agent.actions.executing, false);
    for (const mode of ['item_collecting', 'self_defense', 'cowardice', 'hunting'])
        assert.equal(modeAllowedDuringGoal(f.agent, mode), false, mode);
    assert.equal(modeAllowedDuringGoal(f.agent, 'self_preservation'), true);
    let started = 0;
    const goal = { kind: 'shelter', item: 'shelter', target: 1, active: true, cancelled: false };
    f.agent.gather_goal = goal; f.main.beginGoal(goal);
    for (const label of ['mode:item_collecting', 'mode:self_defense', 'action:shelterGoal']) {
        const result = await f.agent.actions.runAction(label, async () => { started++; }, { timeout: 0, goal });
        assert.equal(result.deferred, true, label);
        assert.match(result.message, /Survival recovery/);
    }
    assert.equal(started, 0);
    assert.equal(f.main.view().owner, null);
});

for (const version of ['1.21.4', '26.3']) test(`native ${version} active same-site repair survives recovery and replans from fresh supplies`, async t => {
    const f = shelterWorld(version, { oak_planks: 4, bread: 1 });
    f.bot.health = 20; f.bot.food = 20;
    const root = mkdtempSync(join(tmpdir(), 'mia-survival-'));
    const memory = installLocalMemory(f.agent, { root, config: { world_id: 'survival-test', embeddings: false } });
    t.after(async () => {
        const goal = f.agent.gather_goal;
        if (goal?.active) {
            goal.cancelled = true; f.bot.interrupt_code = true;
            f.agent.survival_supervisor?.cancel();
            await goal.done;
        }
        memory.close(); rmSync(root, { recursive: true, force: true });
    });
    memory.saveShelter(f.record);
    const blueprint = shelterBlueprint(f.record);
    for (const block of blueprint.blocks) f.set(block.position, block.item);
    f.set(blueprint.door, 'oak_door', { half: 'lower', open: false, facing: 'north', powered: false });
    f.set(blueprint.door.offset(0, 1, 0), 'oak_door', { half: 'upper', open: false, facing: 'north', powered: false });
    const holes = blueprint.blocks.filter(block => block.position.x === 0 && block.position.y < 66 &&
        [1, 2].includes(block.position.z));
    assert.equal(holes.length, 4);
    for (const block of holes) f.set(block.position, 'air');
    const main = installMainSupervisor(f.agent, { pollMs: 1 });
    let now = 100000, threats = [], damageAt = 0;
    const placed = deferred(); let first = true, placedDuringRecovery = 0;
    f.bot.afterPlace = async () => {
        if (f.agent.survival_supervisor?.active) placedDuringRecovery++;
        if (!first) return;
        first = false; placed.resolve();
        await until(() => f.bot.interrupt_code, 'Survival never interrupted active shelter repair');
    };
    const refuge = { kind: 'cover', scope: main.observe().scope, position: { x: 8, y: 64, z: 8 } };
    const adapter = {
        observe: () => ({ available: true, scope: main.observe().scope,
            health: f.bot.health, hunger: f.bot.food, position: f.bot.entity.position,
            threats, damageAt, damageTaken: damageAt ? 4 : 0, foodAvailable: f.stock.bread > 0 }),
        run: (token, action) => f.agent.actions.runAction('mode:survival', action,
            { timeout: 0, valid: () => survival.isCurrent(token) }),
        retreat: async valid => {
            assert(valid()); assert.equal(main.view().owner.label, 'mode:survival');
            assert.equal(memory.pendingGoal().status, 'paused');
            f.stock.oak_planks--; // Inventory changed while the saved repair was interrupted.
            return { verified: true, destination: refuge };
        },
        eat: async valid => {
            assert(valid()); assert(f.stock.bread > 0);
            f.stock.bread--; f.bot.food = 20;
            return { verified: true, reason: 'Inventory decreased and hunger improved' };
        },
        refugeValid: destination => destination === refuge
    };
    const survival = f.agent.survival_supervisor = new SurvivalSupervisor(adapter, { clock: () => now, calmMs: 100 });
    await startShelterGoal(f.agent, f.api);
    const goal = f.agent.gather_goal; goal.resumeDelayMs = 0;
    await placed.promise;
    assert.equal(inspectShelter(f.bot, goal.shelter).structureComplete, false);
    f.bot.health = 16; f.bot.food = 10; threats = [hostile()]; damageAt = now;
    survival.update(); await survival.flight;
    assert.equal(goal.cancelled, false);
    assert.equal(survival.view().retreatAttempts, 1);
    survival.update(); await survival.flight;
    assert.equal(survival.view().foodAttempts, 1);
    assert.equal(f.stock.bread, 0);
    assert.equal(f.bot.food, 20);
    const repairCount = f.calls.filter(call => call[0] === 'place').length;
    await sleep(10);
    assert.equal(f.calls.filter(call => call[0] === 'place').length, repairCount);
    assert.equal(main.view().goal.status, 'paused');
    assert.equal(main.view().owner, null, 'Recovery must hold between physical actions');
    threats = []; damageAt = 0;
    survival.update(); now += 100; survival.update();
    assert.equal(survival.active, false);
    assert.match(await goal.done, /Shelter complete/);
    assert.deepEqual(goal.shelter, f.record);
    assert(inspectShelter(f.bot, goal.shelter).structureComplete);
    assert.equal(main.view().goal.status, 'complete');
    assert.equal(main.view().owner, null);
    assert.equal(main.view().conditionCheck.health, 16);
    assert.equal(main.view().conditionCheck.hunger, 20);
    assert.equal(memory.pendingGoal().status, 'complete');
    assert(f.calls.some(call => call[0] === 'gather'), 'Fresh supplies must replace inventory lost in recovery');
    const positions = f.calls.filter(call => call[0] === 'place').map(call => call[2].toString());
    assert.equal(positions.length, holes.length);
    assert.equal(new Set(positions).size, holes.length);
    assert.equal(placedDuringRecovery, 0);
});
