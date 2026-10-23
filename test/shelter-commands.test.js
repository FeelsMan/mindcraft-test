import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { shelterWorld } from './helpers/shelter-world.js';

// Exercise the real parser/catalog/controller. Only Minecraft skill I/O and
// the login-initialized recipe lookup are supplied by the world fixture.
let fixture;
mock.module(new URL('../src/agent/library/skills.js', import.meta.url).href, { namedExports: {
    getCraftingStation: () => ({ available: () => true }),
    getManagedTravel: () => fixture.travel,
    collectBlock: (...args) => fixture.api.collect(...args),
    craftRecipe: (...args) => fixture.api.craft(...args),
    pickupNearbyItems: async () => {}
} });
const mc = await import('../src/utils/mcdata.js');
mock.module(new URL('../src/utils/mcdata.js', import.meta.url).href, { namedExports: {
    ...mc, getItemCraftingRecipes: name => fixture.api.recipes(name)
} });
const { executeCommand, getCommandDocs } = await import('../src/agent/commands/index.js');

test('shelter command starts without owning its own action slot and routes one verified completion to the requester', async () => {
    fixture = shelterWorld('1.21.4', { oak_planks: 58, oak_door: 1 });
    const deliveries = [];
    fixture.agent.instruction_epoch = 7;
    fixture.agent.routeResponse = (requester, message) => deliveries.push({ requester, message });
    assert.match(await executeCommand(fixture.agent, '!shelterGoal', { requester: 'CaptainNeyo', instructionEpoch: 7 }), /Shelter goal started/);
    assert.match(await fixture.agent.gather_goal.done, /Shelter complete/);
    assert.equal(deliveries.length, 1); assert.equal(deliveries[0].requester, 'CaptainNeyo');
    assert.match(deliveries[0].message, /Entrance tested, doorway closed/);
    assert.match(getCommandDocs(fixture.agent), /!shelterGoal/);
});

test('disabled shelter commands are unavailable in docs and cannot start a goal', async () => {
    fixture = shelterWorld(); fixture.agent.blocked_actions = ['!shelterGoal'];
    assert.match(await executeCommand(fixture.agent, '!shelterGoal'), /disabled/);
    assert.equal(fixture.agent.gather_goal, undefined);
    assert.equal(getCommandDocs(fixture.agent).includes('!shelterGoal'), false);
});

test('an existing managed goal and extraneous blueprint arguments are rejected', async () => {
    fixture = shelterWorld(); fixture.agent.gather_goal = { active: true };
    assert.match(await executeCommand(fixture.agent, '!shelterGoal'), /managed goal is active/);
    delete fixture.agent.gather_goal;
    assert.match(await executeCommand(fixture.agent, '!shelterGoal("mansion")'), /requires 0 args/);
    assert.equal(fixture.agent.gather_goal, undefined);
});

test('an unsupported dimension cannot start construction', async () => {
    fixture = shelterWorld(); fixture.bot.game.dimension = 'the_nether';
    assert.match(await executeCommand(fixture.agent, '!shelterGoal'), /Overworld only/);
    assert.equal(fixture.agent.gather_goal, undefined);
});

test('reset command cancels an in-flight shelter action, clears the working site and leaves existing blocks', async () => {
    fixture = shelterWorld();
    fixture.bot.shelterSite = { dimension: 'overworld', record: fixture.record };
    fixture.set(fixture.bot.entity.position.offset(5, 0, 0), 'oak_planks');
    assert.match(await executeCommand(fixture.agent, '!shelterGoal'), /Shelter goal started/);
    while (!fixture.agent.actions.executing) await new Promise(resolve => setTimeout(resolve, 1));
    assert.match(await executeCommand(fixture.agent, '!resetShelter'), /Shelter site reset/);
    assert.equal(fixture.agent.gather_goal.active, false);
    assert.equal(fixture.bot.shelterSite, undefined);
    assert.equal(fixture.calls.filter(c => c[0] === 'dig' || c[0] === 'place').length, 0);
    assert.equal(fixture.bot.blockAt(fixture.bot.entity.position.offset(5, 0, 0)).name, 'oak_planks');
    assert.match(getCommandDocs(fixture.agent), /!resetShelter/);
});

test('reset cannot interrupt a different managed goal or accept unintended arguments', async () => {
    fixture = shelterWorld();
    fixture.agent.gather_goal = { active: true, kind: 'make' };
    assert.match(await executeCommand(fixture.agent, '!resetShelter'), /managed goal is active/);
    assert.equal(fixture.agent.gather_goal.active, true);
    delete fixture.agent.gather_goal;
    assert.match(await executeCommand(fixture.agent, '!resetShelter("all memory")'), /requires 0 args/);
});
