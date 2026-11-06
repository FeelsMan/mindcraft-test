import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FoodReserve } from '../src/agent/food_reserve.js';
import { foodContext } from '../src/agent/food_goal.js';
import { countFood } from '../src/agent/food_policy.js';
import { SurvivalSupervisor } from '../src/supervisors/survival.js';
import { installMainSupervisor } from '../src/adapters/minecraft/supervisor.js';
import { installLocalMemory } from '../src/agent/memory_runtime.js';
import { cancelGatherGoal } from '../src/agent/gather_goal.js';
import { shelterWorld } from './helpers/shelter-world.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const threat = () => [{ id: 7, name: 'pillager', distance: 3 }];
function sessions(t) {
    const root = mkdtempSync(join(tmpdir(), 'mia-food-reserve-')), all = [];
    t.after(async () => {
        for (const f of all) {
            const goal = f.agent.gather_goal;
            if (goal?.active) {
                goal.cancelled = true; f.bot.interrupt_code = true;
                if (goal.done) await goal.done;
                goal.active = false;
            }
            f.memory.close();
        }
        rmSync(root, { recursive: true, force: true });
    });
    return ({ initial = {}, dimension = 'overworld', world = 'food-reserve-test' } = {}) => {
        const f = shelterWorld('26.3', initial);
        f.bot.game.dimension = dimension; f.bot.health = 20; f.bot.food = 20;
        f.memory = installLocalMemory(f.agent, { root, config: { world_id: world, embeddings: false } });
        f.main = installMainSupervisor(f.agent, { pollMs: 1 });
        f.risk = { threats: [], recent: false, available: true };
        f.scope = () => ({ environment: 'minecraft', world: f.memory.world, dimension: f.bot.game.dimension });
        f.source = () => ({ kind: 'harvest', block: 'carrots', item: 'carrot', seed: 'carrot',
            position: { x: 4, y: 64, z: 2 }, scope: f.scope() });
        f.foodCalls = []; f.sources = [];
        f.foodAPI = {
            ...f.api, hasTable: () => true, hasFurnace: () => false,
            food: {
                discover: async () => { f.foodCalls.push('discover'); return { crops: f.sources, animals: [] }; },
                harvest: async (source, valid, context) => {
                    assert(valid()); f.foodCalls.push('harvest');
                    context.replantPending = { ...source, kind: 'replant' };
                    await context.checkpoint?.();
                    f.stock.carrot = (f.stock.carrot || 0) + 3;
                    return { verified: true, reason: 'Crop removal and three received carrots observed' };
                },
                replant: async (source, valid) => {
                    assert(valid()); assert.equal(source.scope.world, f.memory.world);
                    assert.equal(source.scope.dimension, f.bot.game.dimension);
                    assert(f.stock.carrot > 0); f.stock.carrot--; f.foodCalls.push('replant');
                    return { verified: true, reason: 'Young crop and seed decrease observed' };
                },
                search: async () => { f.foodCalls.push('search'); return { verified: false, blocked: true, reason: 'No safe food source found' }; }
            }
        };
        const adapter = {
            observe: () => ({ available: f.risk.available, scope: f.scope(), health: f.bot.health,
                hunger: f.bot.food, position: f.bot.entity.position, threats: f.risk.threats,
                damageAt: f.risk.recent ? Date.now() : 0, damageTaken: 4,
                foodAvailable: countFood(f.bot, f.agent.food_reserve?.context()) > 0 }),
            run: (token, action, valid = () => true) => f.agent.actions.runAction('mode:survival', action,
                { timeout: 0, valid: () => f.survival.isCurrent(token) && valid() }),
            canProvision: () => f.reserve.canProvision(), provision: valid => f.reserve.provision(valid),
            pendingFoodWork: () => f.reserve.pendingRecovery(),
            retreat: async () => assert.fail('No threat requires retreat in this provision fixture'),
            eat: async valid => {
                assert(valid()); assert(f.stock.carrot > 0);
                f.stock.carrot--; f.bot.food = 20; return { verified: true };
            }
        };
        f.survival = f.agent.survival_supervisor = new SurvivalSupervisor(adapter, { calmMs: 0 });
        f.reserve = f.agent.food_reserve = new FoodReserve(f.agent, f.foodAPI);
        all.push(f); return f;
    };
}
function foreground(f, restored = null) {
    const goal = { kind: 'shelter', item: 'shelter', target: 1, shelter: f.record,
        active: true, cancelled: false, status: 'running' };
    f.agent.gather_goal = f.bot.managedGoal = goal;
    f.memory.restoringGoal = restored;
    f.main.beginGoal(goal); f.memory.beginGoal(goal);
    f.memory.restoringGoal = null;
    return goal;
}
async function provision(f) {
    let outcome;
    await f.agent.actions.runAction('mode:survival', async () => {
        outcome = await f.reserve.provision(() => !f.bot.interrupt_code);
    }, { timeout: 0 });
    return outcome;
}

test('a persisted reserve reloads after restart when the initially unknown dimension becomes known', async t => {
    const session = sessions(t), original = session({ initial: { carrot: 8 } });
    original.reserve.configure(8); original.memory.close();
    const restarted = session({ dimension: 'unknown', initial: { carrot: 8 } });
    assert.equal(restarted.reserve.view().target, 0);
    restarted.bot.game.dimension = 'overworld'; restarted.reserve.update();
    assert.equal(restarted.reserve.view().target, 8);
    assert.equal(restarted.reserve.flight, null);
    assert.equal(restarted.memory.foodReserve().target, 8);
});

test('reserve policy and in-memory recovery remain scoped across dimensions and distinct saved worlds', async t => {
    const session = sessions(t), f = session({ initial: { carrot: 64 } });
    f.reserve.configure(4); f.reserve.recovery = { ...foodContext(), foodActions: 9 };
    const epoch = f.reserve.epoch;
    f.bot.game.dimension = 'the_nether'; f.reserve.update();
    assert.equal(f.reserve.view().target, 0); assert.equal(f.reserve.recovery, null);
    assert(f.reserve.epoch > epoch);
    f.reserve.configure(2);
    f.bot.game.dimension = 'overworld'; f.reserve.update();
    assert.equal(f.reserve.view().target, 4);
    const otherWorld = session({ world: 'different-food-world', initial: { carrot: 64 } });
    assert.equal(otherWorld.reserve.view().target, 0);
});

test('the stop cancellation path disables the persisted reserve and standalone provisioning across restart', async t => {
    const session = sessions(t), f = session();
    f.reserve.configure(6);
    f.memory.saveFoodRecovery({ ...foodContext(), foodActions: 8, replantPending: f.source() });
    await cancelGatherGoal(f.agent); // Used by both !stop and !endGoal.
    assert.equal(f.reserve.view().target, 0);
    assert.equal(f.memory.foodRecovery().replantPending, undefined);
    f.memory.close();
    const restarted = session(); restarted.reserve.update();
    assert.equal(restarted.reserve.view().target, 0);
    assert.equal(restarted.reserve.flight, null);
    assert.equal(restarted.memory.foodRecovery().replantPending, undefined);
});

test('a queued automatic reserve request cannot start after explicit cancellation', async t => {
    const f = sessions(t)(); f.reserve.configure(2); f.sources = [f.source()];
    f.reserve.update(); const queued = f.reserve.flight;
    assert(queued);
    await cancelGatherGoal(f.agent); await queued;
    assert.equal(f.agent.gather_goal, undefined);
    assert.deepEqual(f.foodCalls, []);
    assert.equal(f.memory.pendingGoal(), null);
    assert.equal(f.reserve.view().target, 0);
});

test('automatic reserve work preserves an unfinished saved unrelated goal, including a blocked one', async t => {
    const f = sessions(t)(); f.reserve.configure(2); f.sources = [f.source()];
    for (const status of ['running', 'paused', 'blocked']) {
        const saved = { id: 'original-task', kind: 'make', item: 'stone_axe', target: 1,
            dimension: 'overworld', status, reason: 'Original task still needs attention' };
        f.memory.store.setGoal(f.memory.world, saved);
        f.reserve.update(); if (f.reserve.flight) await f.reserve.flight;
        assert.deepEqual(f.memory.pendingGoal(), saved, status);
        assert.deepEqual(f.foodCalls, [], status);
    }
});

test('queued automatic food work rechecks danger, recent damage and current inventory before acceptance', async t => {
    const session = sessions(t);
    for (const change of [f => { f.risk.threats = threat(); }, f => { f.risk.recent = true; },
        f => { f.stock.carrot = 2; }]) {
        const f = session({ world: 'queued-condition-' + sessionCounter++ });
        f.reserve.configure(2); f.sources = [f.source()];
        f.reserve.update(); const queued = f.reserve.flight; assert(queued);
        change(f); await queued;
        assert.equal(f.agent.gather_goal, undefined);
        assert.deepEqual(f.foodCalls, []);
        assert.equal(f.memory.pendingGoal(), null);
    }
});
let sessionCounter = 0;

test('an unrelated saved goal appearing after reserve scheduling is preserved by the queued request', async t => {
    const f = sessions(t)(); f.reserve.configure(2); f.sources = [f.source()];
    f.reserve.update(); const queued = f.reserve.flight; assert(queued);
    const saved = { id: 'restored-while-queued', kind: 'make', item: 'stone_axe', target: 1,
        dimension: 'overworld', status: 'paused', reason: 'Awaiting safe restore' };
    f.memory.store.setGoal(f.memory.world, saved);
    await queued;
    assert.deepEqual(f.memory.pendingGoal(), saved);
    assert.deepEqual(f.foodCalls, []);
});

test('new user work arriving after reserve scheduling takes precedence over the automatic request', async t => {
    const session = sessions(t);
    for (const change of [f => { f.agent.self_prompter.isActive = () => true; },
        f => { f.agent.instruction_epoch = (f.agent.instruction_epoch || 0) + 1; }]) {
        const f = session({ world: 'new-user-work-' + sessionCounter++ });
        f.reserve.configure(2); f.sources = [f.source()];
        f.reserve.update(); const queued = f.reserve.flight; assert(queued);
        change(f); await queued;
        assert.equal(f.agent.gather_goal, undefined);
        assert.deepEqual(f.foodCalls, []);
        assert.equal(f.memory.pendingGoal(), null);
    }
});

test('a safe automatic reserve finishes verified harvest and replant through one managed goal', async t => {
    const f = sessions(t)({ initial: { diamond: 2 } });
    f.reserve.configure(2); f.sources = [f.source()];
    f.reserve.update(); await f.reserve.flight;
    assert.equal(countFood(f.bot), 2);
    assert.equal(f.stock.diamond, 2);
    assert.deepEqual(f.foodCalls, ['discover', 'harvest', 'replant']);
    assert.equal(f.memory.pendingGoal().kind, 'food');
    assert.equal(f.memory.pendingGoal().status, 'complete');
    assert.equal(f.main.view().owner, null);
    assert.equal(f.reserve.view().target, 2);
});

test('survival provisioning checkpoints the original task and restores pending replant without a second harvest', async t => {
    const session = sessions(t), f = session(), goal = foreground(f);
    f.sources = [f.source()];
    const epoch = f.agent.gather_epoch, memoryId = goal.memoryId;
    const harvested = await provision(f);
    assert.equal(harvested.verified, true);
    assert.equal(f.agent.gather_goal, goal); assert.equal(f.agent.gather_epoch, epoch);
    const saved = f.memory.pendingGoal();
    assert.equal(saved.id, memoryId); assert.equal(saved.kind, 'shelter'); assert.equal(saved.target, 1);
    assert.deepEqual(saved.shelter, f.record);
    assert.equal(saved.status, 'paused');
    assert(saved.foodRecovery.replantPending);
    assert.equal(saved.foodRecovery.foodActions, 1);
    assert.equal(countFood(f.bot, goal.foodRecovery), 2);
    goal.active = false; f.memory.close();

    const restarted = session({ initial: { carrot: 3 } }), resumed = foreground(restarted, saved);
    assert(resumed.foodRecovery.replantPending);
    assert.equal(resumed.foodRecovery.foodActions, 1);
    const replanted = await provision(restarted);
    assert.equal(replanted.verified, true);
    assert.deepEqual(restarted.foodCalls, ['replant']);
    assert.equal(restarted.stock.carrot, 2);
    assert.equal(restarted.agent.gather_goal, resumed); assert.equal(resumed.active, true);
    assert.equal(resumed.foodRecovery, undefined);
    assert.equal(restarted.memory.pendingGoal().kind, 'shelter');
    assert.equal(restarted.memory.pendingGoal().foodRecovery, undefined);
    assert.equal(restarted.main.view().owner, null);
});

test('survival completes a pending farm obligation before releasing a now-fed original task', async t => {
    const f = sessions(t)(), goal = foreground(f);
    f.bot.food = 10; f.sources = [f.source()];
    f.survival.update(); await f.survival.flight;
    assert(goal.foodRecovery?.replantPending);
    assert.equal(f.survival.active, true);
    f.bot.food = 20; // A meal receipt arrived while planting was still pending.
    f.survival.update();
    assert.equal(f.survival.active, true);
    await f.survival.flight;
    assert.deepEqual(f.foodCalls, ['discover', 'harvest', 'replant']);
    assert.equal(goal.foodRecovery, undefined);
    f.survival.update(); if (f.survival.flight) await f.survival.flight;
    assert.equal(f.survival.active, false);
    assert.equal(f.agent.gather_goal, goal); assert.equal(goal.active, true);
    assert.equal(f.memory.pendingGoal().kind, 'shelter');
    assert.equal(f.main.view().owner, null);
});

test('survival provisioning cannot renew exhausted action, failure or time budgets of its foreground task', async t => {
    const session = sessions(t);
    for (const data of [{ foodActions: 256 }, { foodFailures: 2 }, { foodDeadline: Date.now() - 1 }]) {
        const f = session({ world: 'budget-' + sessionCounter++ }), goal = foreground(f);
        f.sources = [f.source()];
        goal.foodRecovery = { ...foodContext(), target: 1, ...data };
        const original = { ...goal.foodRecovery };
        for (let attempt = 0; attempt < 3; attempt++) {
            const outcome = await provision(f);
            assert.equal(outcome.verified, false); assert.equal(outcome.blocked, true);
        }
        assert.deepEqual(f.foodCalls, []);
        assert.deepEqual(goal.foodRecovery.foodActions, original.foodActions);
        assert.equal(goal.foodRecovery.foodDeadline, original.foodDeadline);
        assert.equal(f.agent.gather_goal, goal); assert.equal(goal.active, true);
        assert.equal(f.memory.pendingGoal().kind, 'shelter');
    }
});

test('a standalone provisioning budget remains exhausted after reopening scoped memory', async t => {
    const session = sessions(t), first = session();
    first.memory.saveFoodRecovery({ ...foodContext(), foodActions: 256 }); first.memory.close();
    const restarted = session(); restarted.sources = [restarted.source()];
    const outcome = await provision(restarted);
    assert.equal(outcome.blocked, true); assert.match(outcome.reason, /action budget exhausted/);
    assert.deepEqual(restarted.foodCalls, []);
    assert.equal(restarted.reserve.recovery.foodActions, 256);
});

test('a provisioning deadline that expires during discovery prevents harvest from starting afterward', async t => {
    const f = sessions(t)(), goal = foreground(f), gate = deferred(), entered = deferred();
    goal.foodRecovery = { ...foodContext(), target: 1 };
    f.foodAPI.food.discover = async () => { entered.resolve(); await gate.promise; return { crops: [f.source()], animals: [] }; };
    const work = provision(f); await entered.promise;
    goal.foodRecovery.foodDeadline = Date.now() - 1; gate.resolve();
    assert.equal((await work).verified, false);
    assert.equal(f.stock.carrot || 0, 0); assert.deepEqual(f.foodCalls, []);
    assert.equal(goal.foodRecovery.foodActions, 0);
    const exhausted = await provision(f);
    assert.equal(exhausted.blocked, true); assert.match(exhausted.reason, /time budget exhausted/);
});

test('an explicit food retry renews bounded provisioning while preserving a saved planting obligation', async t => {
    const session = sessions(t), f = session({ initial: { carrot: 1 } });
    f.memory.saveFoodRecovery({ ...foodContext(), foodActions: 256, foodFailures: 2,
        foodDeadline: Date.now() - 1, replantPending: { ...f.source(), kind: 'replant' } });
    f.survival.provisions = 64;
    f.reserve.retry();
    assert.equal(f.reserve.recovery.foodActions, 0); assert.equal(f.reserve.recovery.foodFailures, 0);
    assert.equal(f.survival.provisions, 0); assert(f.reserve.recovery.foodDeadline > Date.now());
    assert(f.memory.foodRecovery().replantPending, 'Explicit retry retains the farm obligation');
    assert.equal((await provision(f)).verified, true);
    assert.deepEqual(f.foodCalls, ['replant']);
    assert.equal(f.reserve.recovery?.replantPending, undefined);
});

test('a healthy full-hunger restart restores standalone planting before returning control', async t => {
    const session = sessions(t), first = session({ initial: { carrot: 1 } });
    first.memory.saveFoodRecovery({ ...foodContext(), foodActions: 1,
        replantPending: { ...first.source(), kind: 'replant' } });
    first.memory.close();
    const restarted = session({ dimension: 'unknown', initial: { carrot: 1 } });
    assert.equal(restarted.reserve.pendingRecovery(), false);
    restarted.bot.game.dimension = 'overworld';
    assert.equal(restarted.reserve.pendingRecovery(), true);
    assert.equal(countFood(restarted.bot, restarted.reserve.context()), 0, 'The sole saved seed stays reserved');
    restarted.survival.update(); await restarted.survival.flight;
    assert.deepEqual(restarted.foodCalls, ['replant']);
    assert.equal(restarted.stock.carrot, 0);
    assert.equal(restarted.reserve.pendingRecovery(), false);
    assert.equal(restarted.memory.foodRecovery().replantPending, undefined);
    restarted.survival.update();
    assert.equal(restarted.survival.active, false);
    assert.equal(restarted.main.view().owner, null);
});

test('survival reuses the interrupted food goal planting obligation instead of counting its reserved seed', async t => {
    const f = sessions(t)({ initial: { carrot: 1 } });
    const goal = { ...foodContext(), target: 8, active: true, cancelled: false,
        replantPending: { ...f.source(), kind: 'replant' } };
    f.agent.gather_goal = f.bot.managedGoal = goal;
    f.main.beginGoal(goal); f.memory.beginGoal(goal);
    f.bot.food = 10;
    assert.equal(f.reserve.pendingRecovery(), true);
    assert.equal(countFood(f.bot, f.reserve.context()), 0);
    f.survival.update(); await f.survival.flight;
    assert.deepEqual(f.foodCalls, ['replant']);
    assert.equal(goal.replantPending, undefined);
    assert.equal(goal.foodRecovery, undefined);
    assert.equal(f.stock.carrot, 0);
    assert.equal(f.memory.pendingGoal().replantPending, undefined);
    assert.equal(f.agent.gather_goal, goal);
    assert.equal(goal.active, true);
    assert.equal(f.main.view().owner, null);
});
