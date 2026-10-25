import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { shelterWorld } from './helpers/shelter-world.js';
import { shelterBlueprint } from '../src/agent/shelter_blueprint.js';
import { installSurvivalSupervisor } from '../src/adapters/minecraft/survival.js';

const moves = [];
const world = await import('../src/agent/library/world.js');
mock.module(new URL('../src/agent/library/skills.js', import.meta.url).href, {
    namedExports: { moveAway: async (_bot, distance) => { moves.push(distance); } }
});
mock.module(new URL('../src/agent/library/world.js', import.meta.url).href, {
    namedExports: { ...world, getNearestBlock: () => null }
});
const { initModes } = await import('../src/agent/modes.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settled(f) {
    const end = Date.now() + 1000;
    while (f.agent.actions.executing || f.bot.modes.getActiveModes().length || f.agent.survival_supervisor?.flight) {
        assert(Date.now() < end, 'Expected mode action to settle'); await sleep(1);
    }
}
function fixture(version = '26.3') {
    const f = shelterWorld(version, { bread: 2 });
    f.agent.prompter.getInitModes = () => null;
    f.agent.self_prompter.stopLoop = () => {};
    f.bot.inventory.findInventoryItem = () => null;
    initModes(f.agent);
    for (const name of Object.keys(f.bot.modes.getJson())) f.bot.modes.setOn(name, name === 'self_preservation');
    f.bot.health = 4; f.bot.food = 8;
    f.bot.lastDamageTime = Date.now(); f.bot.lastDamageTaken = 4;
    return f;
}

for (const version of ['1.21.4', '26.3']) test(`native ${version} actual mode ticks hold sealed shelter and eat at critical health without legacy escape`, async () => {
    moves.length = 0;
    const f = fixture(version), plan = shelterBlueprint(f.record);
    for (const step of plan.blocks) f.set(step.position, step.item);
    for (const [dy, half] of [[0, 'lower'], [1, 'upper']])
        f.set(plan.door.offset(0, dy, 0), 'oak_door', { half, facing: 'north', hinge: 'left', open: false, powered: false });
    f.agent.local_memory = { world: 'survival-mode-test', shelter: () => f.record };
    f.bot.entities.zombie = { id: 1, name: 'zombie', position: plan.outside.offset(0.5, 0, 0.5) };
    f.bot.consume = async () => { f.stock.bread--; f.bot.food = 20; };
    const survival = installSurvivalSupervisor(f.agent, { verifyMs: 3, pollMs: 1 });
    await f.bot.modes.update(); await settled(f);
    assert.equal(survival.refuge?.kind, 'shelter');
    await f.bot.modes.update(); await settled(f);
    assert.equal(f.stock.bread, 1);
    for (let i = 0; i < 5; i++) { await f.bot.modes.update(); await settled(f); }
    assert.deepEqual(moves, [], 'Generic moveAway(20) must not pull her out of verified shelter');
    assert(f.bot.entity.position.floored().equals(plan.inside));
    assert.equal(survival.retreats, 1);
    assert.equal(survival.active, true, 'Nearby danger still holds recovery');
});

test('exhausted active Survival recovery cannot be bypassed by repeated legacy damage escapes', async () => {
    moves.length = 0;
    const f = fixture();
    f.bot.entities.zombie = { id: 1, name: 'zombie', position: f.bot.entity.position.offset(2, 0, 0) };
    const survival = installSurvivalSupervisor(f.agent, { maxRetreats: 0 });
    for (let i = 0; i < 5; i++) { await f.bot.modes.update(); await settled(f); }
    assert.equal(survival.status, 'blocked');
    assert.deepEqual(moves, []);
    assert.equal(f.agent.actions.executing, false);
});

test('immediate fire and suffocation responses can still preempt active recovery', async () => {
    for (const hazard of ['fire', 'gravel']) {
        moves.length = 0;
        const f = fixture();
        f.agent.survival_supervisor = { active: true, update() {} };
        f.set(f.bot.entity.position.offset(0, hazard === 'gravel' ? 1 : 0, 0), hazard);
        await f.bot.modes.update(); await settled(f);
        assert.deepEqual(moves, [hazard === 'gravel' ? 2 : 5]);
    }
});

test('legacy health escape queued before recovery cannot start after Survival acquires control', async () => {
    moves.length = 0;
    const f = fixture();
    let release;
    f.agent.actions.handoff = new Promise(resolve => { release = resolve; });
    await f.bot.modes.update();
    f.agent.survival_supervisor = { active: true, update() {} };
    release(); await settled(f);
    assert.deepEqual(moves, []);
});
