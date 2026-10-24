import test from 'node:test';
import assert from 'node:assert/strict';
import Vec3 from 'vec3';
import { MinecraftSurvivalAdapter, installSurvivalSupervisor } from '../src/adapters/minecraft/survival.js';
import { shelterBlueprint } from '../src/agent/shelter_blueprint.js';
import { shelterDoor } from '../src/agent/shelter_building.js';
import { shelterWorld } from './helpers/shelter-world.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
    const end = Date.now() + 1000;
    while (!check()) { assert(Date.now() < end, 'Expected consumption did not begin'); await sleep(1); }
}
function fixture(version = '26.3', stock = {}) {
    const f = shelterWorld(version, stock);
    f.bot.health = 12; f.bot.food = 8;
    f.agent.local_memory = { world: 'survival-adapter-test', shelter: () => null };
    f.bot.localMemory = f.agent.local_memory;
    const adapter = new MinecraftSurvivalAdapter(f.agent, { verifyMs: 3, pollMs: 1 });
    return { ...f, adapter };
}
function built(f) {
    const plan = shelterBlueprint(f.record);
    for (const step of plan.blocks) f.set(step.position, step.item);
    for (const [dy, half] of [[0, 'lower'], [1, 'upper']])
        f.set(plan.door.offset(0, dy, 0), 'oak_door', { half, facing: 'north', hinge: 'left', open: false, powered: false });
    f.agent.local_memory.shelter = () => f.bot.game.dimension === 'overworld' ? f.record : null;
    f.bot.shelterSite = { dimension: 'overworld', record: f.record };
    return plan;
}

test('live survival observations exclude passive mobs and reject missing hostile position or entity state', () => {
    const f = fixture('26.3', { bread: 1 });
    f.bot.entities = {
        cow: { id: 1, type: 'mob', name: 'cow', position: f.bot.entity.position.offset(1, 0, 0) },
        zombie: { id: 2, type: 'mob', name: 'zombie', position: f.bot.entity.position.offset(7, 0, 0) }
    };
    f.bot.lastDamageTime = 123; f.bot.lastDamageTaken = 4;
    const state = f.adapter.observe();
    assert.equal(state.available, true); assert.equal(state.foodAvailable, true);
    assert.equal(state.damageAt, 123); assert.equal(state.damageTaken, 4);
    assert.deepEqual(state.threats, [{ id: 2, name: 'zombie', distance: 7 }]);
    delete f.bot.entities.zombie.position;
    assert.equal(f.adapter.observe().available, false);
    delete f.bot.entities;
    assert.equal(f.adapter.observe().available, false);
});

for (const version of ['1.21.4', '26.3']) test(`native ${version} food is chosen from actual safe inventory and observed consumption is required`, async () => {
    const f = fixture(version, { bread: 2, rotten_flesh: 9, poisonous_potato: 4, suspicious_stew: 1 });
    f.bot.consume = async () => { f.stock.bread--; f.bot.food += 5; };
    const result = await f.adapter.eat(() => true);
    assert.equal(result.verified, true); assert.equal(result.item, 'bread');
    assert.equal(f.stock.bread, 1); assert.deepEqual(f.calls.filter(c => c[0] === 'equip'), [['equip', 'bread']]);
    assert.equal(f.stock.rotten_flesh, 9);
});

test('unverified consume return, hunger-only change and inventory-only change never claim successful food', async () => {
    for (const change of ['none', 'hunger', 'inventory']) {
        const f = fixture('26.3', { bread: 2 });
        f.bot.consume = async () => {
            if (change === 'hunger') f.bot.food += 5;
            if (change === 'inventory') f.stock.bread--;
        };
        assert.equal((await f.adapter.eat(() => true)).verified, false, change);
    }
});

test('food failures, unavailable inventory, unsafe foods and food disappearing during equip remain unverified', async () => {
    const unsafe = fixture('26.3', { rotten_flesh: 2, pufferfish: 1, suspicious_stew: 1, chorus_fruit: 1 });
    assert.equal(unsafe.adapter.observe().foodAvailable, false);
    assert.match((await unsafe.adapter.eat(() => true)).reason, /No suitable/);
    const failure = fixture('26.3', { bread: 1 });
    failure.bot.consume = async () => { throw Error('server rejected use'); };
    assert.match((await failure.adapter.eat(() => true)).reason, /server rejected use/);
    const lost = fixture('26.3', { bread: 1 });
    lost.bot.equip = async () => { lost.stock.bread = 0; };
    lost.bot.consume = () => assert.fail('Disappeared food must not be used');
    assert.equal((await lost.adapter.eat(() => true)).verified, false);
    delete lost.bot.inventory;
    assert.equal(lost.adapter.observe().available, false);
});

test('consumption cancellation deactivates use and awaits the physical promise before returning', async t => {
    const f = fixture('26.3', { bread: 1 });
    let settle, consuming = false, valid = true, returned = false, deactivated = 0;
    f.bot.consume = () => { consuming = true; return new Promise(resolve => { settle = resolve; }); };
    t.after(() => settle?.());
    f.bot.deactivateItem = () => { deactivated++; };
    const eating = f.adapter.eat(() => valid).then(value => { returned = true; return value; });
    await until(() => consuming);
    valid = false; await sleep(5);
    assert(deactivated > 0); assert.equal(returned, false, 'Pending consumption must retain ownership');
    f.stock.bread--; f.bot.food += 5; settle();
    assert.equal((await eating).verified, false);
});

test('dimension change or death during consumption cannot become verified after delayed inventory events', async () => {
    for (const change of ['dimension', 'death']) {
        const f = fixture('26.3', { bread: 1 });
        f.bot.consume = async () => {
            f.stock.bread--; f.bot.food += 5;
            if (change === 'dimension') f.bot.game.dimension = 'the_nether';
            else f.agent.death_epoch = 1;
        };
        assert.equal((await f.adapter.eat(() => true)).verified, false, change);
    }
});

test('a newly dangerous twenty-block threat during equip prevents unprotected consumption', async () => {
    const f = fixture('26.3', { bread: 1 });
    f.bot.health = 20;
    f.bot.equip = async () => {
        f.bot.health = 16;
        f.bot.entities.skeleton = { id: 1, name: 'skeleton', position: f.bot.entity.position.offset(20, 0, 0) };
    };
    f.bot.consume = () => assert.fail('Food must not be used after the risk envelope becomes unsafe');
    assert.equal((await f.adapter.eat(() => true)).verified, false);
    assert.equal(f.stock.bread, 1);
});

test('food use rechecks configurable coordinator danger during a pending consume promise', async t => {
    const f = fixture('26.3', { bread: 1 });
    const supervisor = installSurvivalSupervisor(f.agent, { clearRadius: 18, threatRadius: 28 });
    let settle, consuming = false, deactivated = 0;
    f.bot.health = 20;
    f.bot.consume = () => { consuming = true; return new Promise(resolve => { settle = resolve; }); };
    t.after(() => settle?.());
    f.bot.deactivateItem = () => { deactivated++; };
    const eating = f.adapter.eat(() => true);
    await until(() => consuming);
    f.bot.health = 16;
    f.bot.entities.skeleton = { id: 1, name: 'skeleton', position: f.bot.entity.position.offset(26, 0, 0) };
    assert.equal(supervisor.assess(f.adapter.observe()).danger, true);
    await sleep(5);
    assert(deactivated > 0, 'Use must stop when the configured danger envelope changes');
    f.stock.bread--; f.bot.food += 5; settle();
    assert.equal((await eating).verified, false);
});

for (const version of ['1.21.4', '26.3']) test(`native ${version} retreat proves the shelter route, operates its owned door and rechecks the sealed shell`, async () => {
    const f = fixture(version), plan = built(f);
    f.bot.entity.position = plan.outside.offset(0.5, 0, -2.5);
    f.bot.entities.zombie = { id: 1, name: 'zombie', position: new Vec3(9, 64, -8) };
    const result = await f.adapter.retreat(() => true);
    assert.equal(result.verified, true, result.reason); assert.equal(result.destination.kind, 'shelter');
    assert(f.bot.entity.position.floored().equals(plan.inside));
    assert.equal(shelterDoor(f.bot, f.record).sealed, true);
    assert(f.calls.some(c => c[0] === 'door'));
    assert.equal(f.calls.filter(c => ['dig', 'place'].includes(c[0])).length, 0);
    assert.equal(f.adapter.refugeValid(result.destination), true);
    f.set(plan.blocks[5].position, 'air');
    assert.equal(f.adapter.refugeValid(result.destination), false, 'Broken walls invalidate the refuge immediately');
});

test('broken, unloaded, wrong-dimension and unscoped remembered homes are never claimed as safe shelter', async () => {
    for (const change of ['broken', 'unloaded', 'dimension', 'world']) {
        const f = fixture(), plan = built(f);
        if (change === 'broken') f.set(plan.blocks[5].position, 'air');
        if (change === 'unloaded') f.set(plan.inside, null);
        if (change === 'dimension') f.bot.game.dimension = 'the_nether';
        if (change === 'world') f.agent.local_memory.world = null;
        const result = await f.adapter.retreat(() => true);
        assert.equal(result.verified, false, change);
        assert.equal(f.calls.filter(c => ['dig', 'place', 'move'].includes(c[0])).length, 0, change);
    }
});

test('observed full blocks provide cover while unloaded rays never become cover', () => {
    const f = fixture(), at = new Vec3(0, 64, 0);
    f.bot.entities.zombie = { id: 1, name: 'zombie', position: new Vec3(6.5, 64, 0.5) };
    for (const y of [64, 65]) f.set(new Vec3(2, y, 0), 'stone');
    assert.equal(f.adapter.covered(at, f.adapter.threats()), true);
    f.set(new Vec3(1, 65, 0), null);
    assert.equal(f.adapter.covered(at, f.adapter.threats()), false);
});

for (const version of ['1.21.4', '26.3']) test(`native ${version} an already-supported covered position can hold recovery without unnecessary travel`, async () => {
    const f = fixture(version);
    f.bot.entities.skeleton = { id: 1, name: 'skeleton', position: f.bot.entity.position.offset(4, 0, 0) };
    for (const y of [64, 65]) f.set(new Vec3(4, y, 2), 'stone');
    const result = await f.adapter.retreat(() => true);
    assert.equal(result.verified, true, result.reason); assert.equal(result.destination.kind, 'cover');
    assert.equal(f.adapter.refugeValid(result.destination), true);
    assert.equal(f.calls.filter(c => c[0] === 'move').length, 0);
    f.set(new Vec3(4, 65, 2), 'air');
    assert.equal(f.adapter.refugeValid(result.destination), false);
});

test('a hostile inside an intact sealed shelter invalidates it before retreat and before eating', async () => {
    const f = fixture('26.3', { bread: 1 }), plan = built(f);
    f.bot.entities.zombie = { id: 1, name: 'zombie', position: plan.inside.offset(1, 0, 0) };
    const refuge = { kind: 'shelter', x: plan.inside.x, y: plan.inside.y, z: plan.inside.z, scope: f.adapter.scope() };
    assert.equal(f.adapter.refugeValid(refuge), false);
    f.agent.survival_supervisor = { refuge };
    f.bot.consume = () => assert.fail('Unsafe consumption started');
    assert.equal((await f.adapter.eat(() => true)).verified, false);
    assert.equal(f.calls.filter(c => c[0] === 'equip').length, 0);
    f.bot.pathfinder.getPathFromTo = function* () { yield { result: { status: 'noPath' } }; };
    assert.equal((await f.adapter.retreat(() => true)).verified, false);
});

test('food can be consumed behind verified cover, while an unprotected escape near a hostile cannot authorize it', async () => {
    const f = fixture('26.3', { bread: 2 }), plan = built(f);
    const refuge = { kind: 'shelter', x: plan.inside.x, y: plan.inside.y, z: plan.inside.z, scope: f.adapter.scope() };
    f.agent.survival_supervisor = { refuge };
    f.bot.entities.zombie = { id: 1, name: 'zombie', position: plan.outside.offset(0.5, 0, 0.5) };
    f.bot.consume = async () => { f.stock.bread--; f.bot.food += 5; };
    assert.equal((await f.adapter.eat(() => true)).verified, true);
    refuge.kind = 'escape';
    assert.equal((await f.adapter.eat(() => true)).verified, false);
    assert.equal(f.stock.bread, 1);
});

for (const version of ['1.21.4', '26.3']) test(`native ${version} fallback escape reaches a supported farther position without digging or placing`, async () => {
    const f = fixture(version), original = f.bot.entity.position.clone();
    f.bot.entities.zombie = { id: 1, name: 'zombie', position: original.offset(2, 0, 0) };
    const result = await f.adapter.retreat(() => true);
    assert.equal(result.verified, true, result.reason); assert.equal(result.destination.kind, 'escape');
    assert(f.bot.entity.position.distanceTo(f.bot.entities.zombie.position) >= 8);
    assert(f.bot.entity.position.distanceTo(original) >= 3);
    assert.equal(f.calls.filter(c => ['dig', 'place'].includes(c[0])).length, 0);
    assert.equal(f.adapter.refugeValid(result.destination), true);
    f.bot.entities.zombie.position = f.bot.entity.position.offset(2, 0, 0);
    assert.equal(f.adapter.refugeValid(result.destination), false);
});

test('failed routes are bounded and never treated as successful escape', async () => {
    const f = fixture();
    f.bot.entities.zombie = { id: 1, name: 'zombie', position: f.bot.entity.position.offset(2, 0, 0) };
    let searches = 0;
    f.bot.pathfinder.getPathFromTo = function* () { searches++; yield { result: { status: 'noPath' } }; };
    const result = await f.adapter.retreat(() => true);
    assert.equal(result.verified, false); assert.match(result.reason, /No safe cover or escape/);
    assert(searches > 0 && searches <= 20, 'Finite route and detour attempts');
    assert.equal(f.calls.filter(c => c[0] === 'move').length, 0);
});

test('adapter delegates physical work with a supervisor identity validator', async () => {
    const f = fixture(); let observed;
    f.agent.survival_supervisor = { isCurrent: token => token === 3 };
    f.agent.actions.runAction = async (...args) => { observed = args; };
    const fn = () => {};
    await f.adapter.run(3, fn);
    assert.equal(observed[0], 'mode:survival'); assert.equal(observed[1], fn);
    assert.equal(observed[2].valid(), true); assert.equal(observed[2].timeout, 0.75);
    f.agent.survival_supervisor.isCurrent = () => false;
    assert.equal(observed[2].valid(), false);
});

test('installation disables independent automatic eating before any survival tick', () => {
    const f = fixture(); let disabled = 0;
    f.bot.autoEat = { disable: () => { disabled++; } };
    assert.equal(installSurvivalSupervisor(f.agent), f.agent.survival_supervisor);
    assert.equal(disabled, 1);
});
