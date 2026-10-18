import test from 'node:test';
import assert from 'node:assert/strict';
import Vec3 from 'vec3';
import pf from 'mineflayer-pathfinder';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shelterWorld } from './helpers/shelter-world.js';
import { shelterRecord, shelterBlueprint } from '../src/agent/shelter_blueprint.js';
import { inspectShelter, findShelterSite, placeShelterBlock, clearShelterPlant, enterAndVerifyShelter, shelterDoor, prepareShelterTravel } from '../src/agent/shelter_building.js';
import { getManagedTravel } from '../src/agent/library/skills.js';
import { startShelterGoal } from '../src/agent/shelter_goal.js';
import { cancelGatherGoal } from '../src/agent/gather_goal.js';
import { modeAllowedDuringGoal, sleep } from '../src/agent/managed_goal.js';
import { supportedStationSpace } from '../src/agent/station_access.js';
import { installLocalMemory } from '../src/agent/memory_runtime.js';
import { safeMiningMovements } from '../src/agent/navigation_policy.js';

function memoryFixture(t, f, root = mkdtempSync(join(tmpdir(), 'mia-shelter-'))) {
    const connections = [];
    const connect = (world, instance = f) => {
        const memory = installLocalMemory(instance.agent, { root, config: { world_id: world, embeddings: false } });
        connections.push(memory); return memory;
    };
    t.after(() => { for (const db of connections) db?.close(); rmSync(root, { recursive: true, force: true }); });
    return { root, connect, memory: connect('shelter-test') };
}
async function start(f) {
    assert.match(await startShelterGoal(f.agent, f.api), /Shelter goal started/);
    const goal = f.agent.gather_goal; goal.resumeDelayMs = 0; return goal;
}
function built(f) {
    const plan = shelterBlueprint(f.record);
    for (const step of plan.blocks) f.set(step.position, step.item);
    f.set(plan.door, 'oak_door', { half: 'lower', open: false, facing: 'north', powered: false });
    f.set(plan.door.offset(0, 1, 0), 'oak_door', { half: 'upper', open: false, facing: 'north', powered: false });
    return plan;
}

test('fixed shelter has 55 shell/roof blocks plus three supported access steps, doorway and 3x3 interior', () => {
    const f = shelterWorld(), plan = shelterBlueprint(f.record), prior = new Set();
    assert.equal(plan.blocks.length, 58);
    for (const step of plan.blocks) {
        assert(!prior.has(step.position.toString()));
        const p = step.position;
        assert(p.y === 64 || prior.has(p.offset(0, -1, 0).toString()) ||
            [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => prior.has(p.offset(x, 0, z).toString())));
        prior.add(p.toString());
    }
    assert.equal(inspectShelter(f.bot, f.record).planks, 58);
    for (const value of [null, { version: 2, origin: f.record.origin }, { version: 1, origin: { x: 0.5, y: 64, z: 0 } },
        { version: 1, origin: { x: 0, y: 319, z: 0 } }]) assert.equal(shelterRecord(value), null);
});

test('site selection proves a real safe path and does not alter terrain', async () => {
    const f = shelterWorld();
    assert.deepEqual(await findShelterSite(f.bot, f.travel), f.record);
    assert.equal(f.calls.filter(c => ['dig', 'place', 'move'].includes(c[0])).length, 0);
});

test('footprints reject liquids, partial floors, decaying leaves, holes, ceilings and existing workstations', () => {
    for (const [p, name] of [[new Vec3(2, 63, 2), 'water'], [new Vec3(2, 63, 2), 'oak_slab'],
        [new Vec3(2, 63, 2), 'oak_leaves'], [new Vec3(2, 63, 2), 'air'], [new Vec3(2, 66, 2), 'stone'],
        [new Vec3(2, 64, 2), 'crafting_table'], [new Vec3(2, 64, -1), 'furnace'], [new Vec3(2, 63, 2), null]]) {
        const f = shelterWorld(); f.set(p, name);
        assert.throws(() => inspectShelter(f.bot, f.record), /floor|obstructed|support|unloaded/, String(name));
        assert.equal(f.calls.length, 0);
    }
});

for (const version of ['1.21.4', '26.3']) test(`complete survival build uses actual ${version} shapes, raycasts, door states, recipes and pathfinding`, async () => {
    const f = shelterWorld(version);
    // No memory is required for an uninterrupted build.
    const goal = await start(f);
    assert.match(await goal.done, /Shelter complete/);
    const state = inspectShelter(f.bot, goal.shelter);
    assert(state.structureComplete); assert.equal(state.doorState.open, false);
    assert(f.bot.entity.position.floored().equals(state.inside));
    assert.equal(f.calls.filter(c => c[0] === 'place' && c[1] === 'oak_planks').length, 58);
    assert.equal(f.calls.filter(c => c[0] === 'place' && c[1] === 'oak_door').length, 1);
    assert.equal(f.calls.filter(c => c[0] === 'gather').length, 16, '64 construction/crafting planks require 16 logs, not an arbitrary stack');
    assert.equal(f.stock.oak_planks, 0); assert.equal(f.stock.oak_door, 2, 'One vanilla door batch produces three doors');
    assert.deepEqual(f.calls.filter(c => c[0] === 'door').map(c => c[1]), [true, false]);
    assert.equal(f.bot.managedGoal, undefined); assert.equal(f.bot.listenerCount('death'), 0); assert.equal(f.bot.listenerCount('end'), 0);
    assert(f.policies.every(p => !p.canDig && !p.allow1by1towers && p.scafoldingBlocks.length === 0));
});

test('already-held supplies are reused with no log gathering or duplicate door crafting', async () => {
    const f = shelterWorld('1.21.4', { oak_planks: 58, oak_door: 1 });
    const goal = await start(f); assert.match(await goal.done, /Shelter complete/);
    assert.equal(f.calls.filter(c => c[0] === 'gather' || c[0] === 'craft').length, 0);
    assert.equal(f.stock.oak_planks, 0); assert.equal(f.stock.oak_door, 0);
});

test('table prerequisites are included while the building footprint remains reserved', async () => {
    const f = shelterWorld(); f.api.hasTable = () => false;
    const goal = await start(f); assert.match(await goal.done, /Shelter complete/);
    assert.equal(f.calls.filter(c => c[0] === 'gather').length, 17);
    assert.equal(f.stock.crafting_table, 1);
    f.bot.managedGoal = { active: true, kind: 'shelter', shelter: f.record };
    const elsewhere = new Vec3(6, 64, 0), reserved = new Vec3(2, 64, 2);
    // Use a fresh empty world to isolate placement reservation from the finished walls.
    const fresh = shelterWorld(); fresh.bot.managedGoal = f.bot.managedGoal;
    assert.equal(supportedStationSpace(fresh.bot, reserved), false);
    assert.equal(supportedStationSpace(fresh.bot, new Vec3(2, 64, -1)), false);
    assert(supportedStationSpace(fresh.bot, elsewhere));
});

test('small plants are cleared and observed as air without tunneling or removing solid blocks', async () => {
    const f = shelterWorld(), p = new Vec3(2, 64, 1); f.set(p, 'short_grass');
    const step = inspectShelter(f.bot, f.record).clear[0];
    assert(await clearShelterPlant(f.bot, f.record, step, f.travel, () => true, { verifyMs: 1 }));
    assert.equal(f.bot.blockAt(p).name, 'air');
    f.set(p, 'crafting_table');
    await assert.rejects(clearShelterPlant(f.bot, f.record, step, f.travel, () => true), /non-plant/);
    assert.equal(f.calls.filter(c => c[0] === 'dig').length, 1);
});

test('native placement returns do not count without the actual expected block update', async () => {
    const f = shelterWorld('1.21.4', { oak_planks: 1 }), step = shelterBlueprint(f.record).blocks[0];
    f.bot.placeBlock = async () => {};
    await assert.rejects(placeShelterBlock(f.bot, f.record, step, f.travel, () => true, { verifyMs: 1 }), /No verified/);
    assert.equal(inspectShelter(f.bot, f.record).planks, 58);
    assert.equal(f.controls.sneak, false);
});

test('late placement errors reconcile observed blocks and do not duplicate placement', async () => {
    const f = shelterWorld('1.21.4', { oak_planks: 2 }), step = shelterBlueprint(f.record).blocks[0], place = f.bot.placeBlock;
    f.bot.placeBlock = async (...args) => { await place(...args); throw new Error('Late acknowledgement'); };
    assert(await placeShelterBlock(f.bot, f.record, step, f.travel, () => true));
    assert(await placeShelterBlock(f.bot, f.record, step, f.travel, () => true));
    assert.equal(f.calls.filter(c => c[0] === 'place').length, 1); assert.equal(f.stock.oak_planks, 1);
});

test('interruption or a changed support before the packet prevents placement', async () => {
    for (const change of ['interrupt', 'support']) {
        const f = shelterWorld('1.21.4', { oak_planks: 1 }), step = shelterBlueprint(f.record).blocks[0];
        f.bot.lookAt = async () => {
            if (change === 'interrupt') f.bot.interrupt_code = true;
            else f.set(step.position.offset(0, -1, 0), 'air');
        };
        if (change === 'interrupt') assert.equal(await placeShelterBlock(f.bot, f.record, step, f.travel, () => !f.bot.interrupt_code), false);
        else await assert.rejects(placeShelterBlock(f.bot, f.record, step, f.travel, () => true), /support|Support|face|budget/);
        assert.equal(f.calls.filter(c => c[0] === 'place').length, 0); assert.equal(f.controls.sneak, false);
    }
});

test('a player occupying a planned cell is never walled in by placement', async () => {
    const f = shelterWorld('1.21.4', { oak_planks: 1 }), step = shelterBlueprint(f.record).blocks[0];
    f.bot.entities.player = { position: step.position.offset(0.5, 0, 0.5), width: 0.6, height: 1.8 };
    f.bot.entities.player.username = 'CaptainNeyo';
    await assert.rejects(placeShelterBlock(f.bot, f.record, step, f.travel, () => true), /occupied by CaptainNeyo/);
    assert.equal(f.calls.filter(c => c[0] === 'place').length, 0);
});

test('dropped seeds/items and experience do not falsely block a legal wall placement', async () => {
    const f = shelterWorld('1.21.4', { oak_planks: 1 }), step = shelterBlueprint(f.record).blocks[0];
    f.bot.entities.item = { name: 'item', position: step.position.offset(0.5, 0, 0.5), width: 0.25, height: 0.25 };
    f.bot.entities.orb = { type: 'orb', position: step.position.offset(0.5, 0, 0.5), width: 0.5, height: 0.5 };
    assert(await placeShelterBlock(f.bot, f.record, step, f.travel, () => true));
});

test('a partial or incorrectly oriented door cannot satisfy shelter completion', () => {
    const f = shelterWorld(), plan = built(f);
    f.set(plan.door.offset(0, 1, 0), 'air'); assert.equal(shelterDoor(f.bot, f.record).present, false);
    assert.throws(() => inspectShelter(f.bot, f.record), /obstructed/);
    built(f);
    for (const dy of [0, 1]) f.set(plan.door.offset(0, dy, 0), 'oak_door', { half: dy ? 'upper' : 'lower', facing: 'east', open: false });
    assert.equal(shelterDoor(f.bot, f.record).present, false);
});

test('the complete shell is not a completed goal until the door works and is closed', async () => {
    const f = shelterWorld(); built(f);
    f.bot.activateBlock = async () => {};
    assert.equal(await enterAndVerifyShelter(f.bot, f.record, f.travel, () => true, { verifyMs: 1 }), false);
});

test('combat interrupts a build, retains its site and resumes without replacing verified blocks', async () => {
    const f = shelterWorld('1.21.4', { oak_planks: 55, oak_door: 1 }); let combat;
    f.bot.afterPlace = async () => {
        if (combat) return;
        combat = f.agent.actions.runAction('mode:self_defense', async () => { await sleep(5); });
    };
    const goal = await start(f); assert.equal(modeAllowedDuringGoal(f.agent, 'item_collecting'), false);
    assert.match(await goal.done, /Shelter complete/); await combat;
    assert.equal(f.calls.filter(c => c[0] === 'place').length, 59);
});

test('explicit cancellation settles the current action and stays cancelled after restart', async t => {
    const f = shelterWorld('1.21.4', { oak_planks: 55, oak_door: 1 }), m = memoryFixture(t, f);
    let cancel;
    f.bot.afterPlace = async () => { cancel ??= cancelGatherGoal(f.agent); };
    const goal = await start(f); assert.match(await goal.done, /cancelled/); await cancel;
    assert.equal(m.memory.pendingGoal().status, 'cancelled');
    assert.equal(await m.memory.resume(async () => assert.fail('Cancelled goals cannot resume'), { manual: true }), false);
    assert.equal(f.calls.filter(c => c[0] === 'place').length, 1);
});

test('death and a new process re-observe partial blocks, reuse the same site and persist a verified home', async t => {
    const f = shelterWorld('1.21.4', { oak_planks: 55, oak_door: 1 }), m = memoryFixture(t, f);
    f.bot.afterPlace = async () => { if (f.calls.filter(c => c[0] === 'place').length === 8) f.bot.emit('death'); };
    const goal = await start(f); assert.match(await goal.done, /paused after death/);
    const saved = m.memory.pendingGoal(); assert.equal(saved.kind, 'shelter'); assert.equal(saved.status, 'paused');
    assert.deepEqual(saved.shelter, f.record);
    m.memory.close();
    const next = shelterWorld('1.21.4', f.stock);
    for (const [p, block] of f.blocks) next.blocks.set(p, block);
    const memory = m.connect('shelter-test', next);
    assert(await memory.resume(async command => {
        assert.equal(command, '!shelterGoal');
        return startShelterGoal(next.agent, next.api);
    }));
    const resumed = next.agent.gather_goal;
    assert.match(await resumed.done, /Shelter complete/);
    assert.equal(next.calls.filter(c => c[0] === 'place').length, 51);
    assert.deepEqual(memory.recallPlace('home'), { x: 2, y: 64, z: 2 });
    assert.equal(memory.pendingGoal().status, 'complete');
    assert.match((await memory.context('shelter')).toLowerCase(), /shelter/);
    assert.equal(await memory.resume(async () => assert.fail('Completed goal must not resume')), false);
});

test('saved sites and goals stay scoped to the world and dimension', async t => {
    const f = shelterWorld(), m = memoryFixture(t, f);
    m.memory.saveShelter(f.record); assert.deepEqual(m.memory.shelter(), f.record);
    f.bot.game.dimension = 'the_nether'; assert.equal(m.memory.shelter(), null);
    f.bot.game.dimension = 'overworld';
    const other = m.connect('another-world'); assert.equal(other.shelter(), null);
    assert.equal(other.recallPlace('home'), null);
});

test('two failures preserve the blueprint without a completion/home claim or an infinite retry', async t => {
    const f = shelterWorld('1.21.4', { oak_planks: 55, oak_door: 1 }), m = memoryFixture(t, f);
    f.bot.placeBlock = async () => {};
    const goal = await start(f); assert.match(await goal.done, /Could not verify shelter place/);
    assert.equal(m.memory.pendingGoal().status, 'blocked'); assert.equal(m.memory.recallPlace('home'), null);
    assert.deepEqual(m.memory.shelter(), f.record);
    assert.equal(f.agent.messages.some(x => /Shelter complete/.test(x)), false);
});

test('a changed dimension cannot confirm a placement or complete the shelter', async t => {
    const f = shelterWorld('1.21.4', { oak_planks: 55, oak_door: 1 }), m = memoryFixture(t, f);
    f.bot.afterPlace = async () => { f.bot.game.dimension = 'the_nether'; };
    const goal = await start(f); assert.match(await goal.done, /paused after dimension/);
    assert.equal(m.memory.recallPlace('home'), null);
    assert.equal(m.memory.pendingGoal().dimension, 'overworld'); assert.equal(m.memory.pendingGoal().status, 'paused');
});

test('an unavailable site blocks after bounded attempts without collecting or placing anything', async t => {
    const f = shelterWorld(), m = memoryFixture(t, f); let attempts = 0;
    f.api.building = { findSite: async () => { attempts++; return null; } };
    const goal = await start(f); assert.match(await goal.done, /No reachable clear, level/);
    assert.equal(attempts, 2); assert.equal(f.calls.length, 0);
    assert.equal(m.memory.pendingGoal().status, 'blocked'); assert.equal(m.memory.recallPlace('home'), null);
});

test('failed collection cannot count as material progress or start an undersupplied build', async t => {
    const f = shelterWorld(), m = memoryFixture(t, f); let attempts = 0;
    f.api.collect = async () => { attempts++; return true; };
    const goal = await start(f); assert.match(await goal.done, /Could not verify shelter gather/);
    assert.equal(attempts, 2); assert.equal(f.calls.filter(c => ['place', 'craft'].includes(c[0])).length, 0);
    assert.equal(m.memory.pendingGoal().status, 'blocked');
});

test('a mismatched block on a saved site blocks instead of griefing or silently moving the house', async t => {
    const f = shelterWorld('1.21.4', { oak_planks: 58, oak_door: 1 }), m = memoryFixture(t, f);
    m.memory.saveShelter(f.record); f.set(new Vec3(0, 64, 0), 'furnace');
    const goal = await start(f); assert.match(await goal.done, /obstructed/);
    assert.deepEqual(goal.shelter, f.record); assert.equal(f.calls.length, 0);
    assert.equal(f.bot.blockAt(new Vec3(0, 64, 0)).name, 'furnace');
});

test('reissuing a finished shelter goal verifies the same home without another building or extra supplies', async t => {
    const f = shelterWorld('1.21.4', { oak_planks: 58, oak_door: 1 }), m = memoryFixture(t, f);
    const first = await start(f); await first.done;
    const placed = f.calls.filter(c => c[0] === 'place').length;
    const second = await start(f); assert.match(await second.done, /Shelter complete/);
    assert.deepEqual(second.shelter, first.shelter);
    assert.equal(f.calls.filter(c => c[0] === 'place').length, placed);
    assert.equal(f.calls.filter(c => c[0] === 'gather').length, 0);
    assert.deepEqual(m.memory.recallPlace('home'), { x: 2, y: 64, z: 2 });
});

test('a damaged saved shelter replaces only the missing block and recalculates one plank', async t => {
    const f = shelterWorld(), m = memoryFixture(t, f), plan = built(f);
    m.memory.saveShelter(f.record); f.set(plan.blocks.at(-1).position, 'air');
    const goal = await start(f); assert.match(await goal.done, /Shelter complete/);
    assert.equal(f.calls.filter(c => c[0] === 'place').length, 1);
    assert.equal(f.calls.filter(c => c[0] === 'gather').length, 1);
    assert.equal(f.stock.oak_planks, 3);
});

test('the actual skill travel hook exits and returns through the owned door without mining the shelter', async () => {
    const f = shelterWorld(), plan = built(f);
    f.bot.shelterSite = { dimension: 'overworld', record: f.record };
    const api = getManagedTravel(f.bot);
    await api.prepareTravel(new Vec3(8, 64, 2));
    assert(f.bot.entity.position.floored().equals(plan.outside)); assert.equal(shelterDoor(f.bot, f.record).open, false);
    await api.prepareTravel(plan.inside);
    assert(f.bot.entity.position.floored().equals(plan.inside)); assert.equal(shelterDoor(f.bot, f.record).open, false);
    assert.equal(f.calls.filter(c => c[0] === 'dig' || c[0] === 'place').length, 0);
    assert.equal(f.bot.shelterCrossing, false);
});

test('normal pathfinding protects the shelter and natural floor but urgent escape can still act', () => {
    const f = shelterWorld(), plan = built(f); f.bot.shelterSite = { dimension: 'overworld', record: f.record };
    const movements = getManagedTravel(f.bot).movements();
    for (const step of plan.blocks) assert(movements.exclusionBreak(f.bot.blockAt(step.position)) >= 100);
    assert(movements.exclusionBreak(f.bot.blockAt(new Vec3(2, 63, 2))) >= 100);
    assert.equal(movements.exclusionBreak(f.bot.blockAt(new Vec3(7, 63, 2))), 0);
    f.bot.modes.getActiveModes = () => ['self_preservation'];
    assert.equal(getManagedTravel(f.bot).movements().exclusionBreak(f.bot.blockAt(new Vec3(2, 63, 2))), 0);
});

test('a broken owned doorway blocks crossing rather than destroying a replacement player block', async () => {
    const f = shelterWorld(), plan = built(f); f.bot.shelterSite = { dimension: 'overworld', record: f.record };
    f.set(plan.door.offset(0, 1, 0), 'stone');
    await assert.rejects(getManagedTravel(f.bot).prepareTravel(new Vec3(8, 64, 2)), /Could not open/);
    assert.equal(f.calls.filter(c => c[0] === 'dig').length, 0); assert.equal(f.bot.shelterCrossing, false);
});

test('interrupted door crossing settles immediately, retains the door and can be retried', async () => {
    const f = shelterWorld(), plan = built(f), activate = f.bot.activateBlock;
    f.bot.shelterSite = { dimension: 'overworld', record: f.record };
    f.bot.activateBlock = async block => { await activate(block); f.bot.interrupt_code = true; };
    await prepareShelterTravel(f.bot, plan.outside, f.travel, { verifyMs: 1 });
    assert.equal(f.bot.shelterCrossing, false); assert.equal(shelterDoor(f.bot, f.record).present, true);
    f.bot.interrupt_code = false; f.bot.activateBlock = activate;
    await prepareShelterTravel(f.bot, plan.outside, f.travel);
    assert(f.bot.entity.position.floored().equals(plan.outside)); assert.equal(shelterDoor(f.bot, f.record).open, false);
});

test('actual pathfinder descends one-block steps but rejects a two-block drop in a closed corridor', () => {
    for (const drop of [1, 2]) {
        const f = shelterWorld();
        const blockAt = p => {
            const cell = p.floored(), floor = cell.x === 0 ? 65 : 65 - drop;
            return f.make(cell, cell.z !== 0 || cell.x < 0 || cell.x > 1 || cell.y < floor ? 'stone' : 'air');
        };
        f.bot.blockAt = f.bot.world.getBlock = blockAt;
        f.bot.entity.position = new Vec3(0.5, 65, 0.5);
        const route = f.bot.pathfinder.getPathTo(safeMiningMovements(f.travel.movements()),
            new pf.goals.GoalBlock(1, 65 - drop, 0), 100);
        assert.equal(route.status, drop === 1 ? 'success' : 'noPath');
        if (drop === 1) {
            assert.deepEqual(route.path.map(n => [n.x, n.y, n.z]), [[1, 64, 0]]);
            assert(route.path.every(n => !n.toBreak.length && !n.toPlace.length));
        }
    }
});

test('an already-reached work cell with Mia leaning across its edge selects a clear approach', async () => {
    const f = shelterWorld('26.3', { oak_planks: 1 }), plan = shelterBlueprint(f.record);
    // Same prefix as the live failure, translated to a fixture origin.
    for (const step of plan.blocks.slice(0, 5)) f.set(step.position, step.item);
    const step = plan.blocks[5]; assert.deepEqual(step.position, new Vec3(3, 64, 0));
    f.bot.entity.position = new Vec3(2.9, 64, 0.5);
    assert(await placeShelterBlock(f.bot, f.record, step, f.travel, () => true));
    assert.equal(f.bot.blockAt(step.position).name, 'oak_planks');
    assert.equal(f.calls.filter(c => c[0] === 'place').length, 1);
    assert(f.calls.some(c => c[0] === 'move'), 'The body must move clear; a cell-only arrival is insufficient');
});

test('drift into a target while equipping triggers another approach before the single placement packet', async () => {
    const f = shelterWorld('1.21.4', { oak_planks: 1 }), step = shelterBlueprint(f.record).blocks[0];
    const equip = f.bot.equip, place = f.bot.placeBlock;
    let equips = 0, aimed = false;
    f.bot.equip = async item => {
        await equip(item);
        if (++equips === 1) f.bot.entity.position = step.position.offset(0.5, 0, 0.5);
    };
    f.bot.lookAt = async (at, force) => { assert.equal(force, true); f.bot.lastLook = at; aimed = true; };
    f.bot.placeBlock = async (...args) => { assert(aimed); return place(...args); };
    assert(await placeShelterBlock(f.bot, f.record, step, f.travel, () => true));
    assert.equal(equips, 2);
    assert.equal(f.calls.filter(c => c[0] === 'place').length, 1);
    assert(f.calls.some(c => c[0] === 'log' && /drifted/.test(c[1])));
});

test('a finished roof has a real safe descent to the entrance with no digging or scaffolding', async () => {
    const f = shelterWorld('26.3'); built(f);
    f.bot.entity.position = new Vec3(2.5, 67, 2.5);
    assert(await enterAndVerifyShelter(f.bot, f.record, f.travel, () => true));
    assert(f.bot.entity.position.floored().equals(shelterBlueprint(f.record).inside));
    assert.equal(f.calls.filter(c => c[0] === 'dig' || c[0] === 'place').length, 0);
});
