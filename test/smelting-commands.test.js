import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ActionManager } from '../src/agent/action_manager.js';
import minecraftData from 'minecraft-data';

// Real parser, command catalog, planner, guard and action manager; replace only
// game I/O. The managed executor itself has separate native/fixture coverage.
const io = { smelts: [], legacy: [], collects: [] };
mock.module(new URL('../src/agent/library/skills.js', import.meta.url).href, { namedExports: {
    getCraftingStation: () => ({ available: () => true }),
    getManagedFurnace: () => ({ available: () => false, snapshot: null }),
    inspectManagedFurnace: async () => assert.fail('No owned furnace to inspect in this fixture'),
    smeltManaged: async (bot, step) => {
        io.smelts.push({ ...step });
        assert(bot.stock[step.input] > 0);
        bot.stock[step.input]--;
        bot.stock[step.item] = (bot.stock[step.item] || 0) + 1;
    },
    collectBlock: async (_bot, item, count) => { io.collects.push({ item, count }); assert.fail('No additional ingredients needed'); },
    pickupNearbyItems: async () => {},
    craftRecipe: async () => assert.fail('No crafting needed'),
    smeltItem: async (_bot, item, count) => { io.legacy.push({ item, count }); return false; }
} });
// Production data is initialized by Minecraft login. Supply the item/block
// lookup boundary here without connecting a real client for parser tests.
const mc = await import('../src/utils/mcdata.js');
const data = minecraftData('1.21.4');
mock.module(new URL('../src/utils/mcdata.js', import.meta.url).href, { namedExports: {
    ...mc, getItemId: name => data.itemsByName[name]?.id ?? null,
    getBlockId: name => data.blocksByName[name]?.id ?? null
} });
const { executeCommand, getCommandDocs, blacklistCommands } = await import('../src/agent/commands/index.js');

function fixture(stock) {
    io.smelts = []; io.legacy = []; io.collects = [];
    const bot = new EventEmitter();
    bot.stock = { furnace: 1, coal: 1, ...stock };
    bot.inventory = { items: () => Object.entries(bot.stock).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) };
    bot.output = ''; bot.modes = { getActiveModes: () => [] };
    const agent = {
        bot, blocked_actions: [],
        history: { add: async () => {}, save: async () => {} },
        self_prompter: { stop: async () => { assert.equal(agent.actions.executing, false, 'Goal startup must not own the action slot'); await agent.actions.stop(); } },
        requestInterrupt: () => { bot.interrupt_code = true; },
        clearBotLogs: () => { bot.output = ''; bot.interrupt_code = false; },
        cleanKill: message => assert.fail(message), isIdle: () => !agent.actions.executing,
        openChat: () => {}
    };
    agent.actions = new ActionManager(agent);
    return agent;
}

test('legacy iron request starts a real managed goal for additional ingots without restart or nesting', async () => {
    const agent = fixture({ iron_ingot: 2, raw_iron: 3 });
    assert.match(await executeCommand(agent, '!smeltItem("raw_iron", 3)'), /keep 5 iron_ingot total/);
    assert.match(await agent.gather_goal.done, /5\/5 iron_ingot/);
    assert.equal(agent.bot.stock.iron_ingot, 5);
    assert.equal(agent.bot.stock.raw_iron, 0);
    assert.equal(io.smelts.length, 3); assert.equal(io.legacy.length, 0);
    assert.equal(agent.gather_goal.kind, 'make');
});

test('oak log requests use the managed charcoal goal while preserving held charcoal', async () => {
    const agent = fixture({ charcoal: 1, oak_log: 2 });
    assert.match(await executeCommand(agent, '!smeltItem("oak_log", 2)'), /keep 3 charcoal total/);
    assert.match(await agent.gather_goal.done, /3\/3 charcoal/);
    assert.equal(agent.bot.stock.charcoal, 3); assert.equal(io.legacy.length, 0);
});

test('oversized additional requests are rejected before any goal or legacy action starts', async () => {
    const agent = fixture({ iron_ingot: 63, raw_iron: 2 });
    assert.match(await executeCommand(agent, '!smeltItem("raw_iron", 2)'), /at most 64 total/);
    assert.equal(agent.gather_goal, undefined);
    assert.equal(io.smelts.length + io.legacy.length, 0);
});

test('the active-goal guard also blocks old smeltItem commands', async () => {
    const agent = fixture({}); agent.gather_goal = { active: true };
    assert.match(await executeCommand(agent, '!smeltItem("raw_iron", 1)'), /managed goal is active/);
    assert.equal(io.smelts.length + io.legacy.length, 0);
});

test('other recipes retain their one-shot command and docs describe the additional-count conversion', async () => {
    const agent = fixture({});
    await executeCommand(agent, '!smeltItem("raw_gold", 2)');
    assert.deepEqual(io.legacy, [{ item: 'raw_gold', count: 2 }]);
    assert.equal(agent.gather_goal, undefined);
    assert.match(getCommandDocs(agent), /raw_iron and oak_log automatically use the verified managed/);
});

test('supported aliases cannot bypass an agent-specific makeGoal block', async () => {
    const agent = fixture({}); agent.blocked_actions = ['!makeGoal'];
    assert.match(await executeCommand(agent, '!smeltItem("raw_iron", 1)'), /!makeGoal is disabled/);
    assert.equal(agent.gather_goal, undefined);
});

test('supported aliases cannot bypass the global command blacklist', async () => {
    const agent = fixture({}); blacklistCommands(['!makeGoal']);
    assert.match(await executeCommand(agent, '!smeltItem("oak_log", 1)'), /!makeGoal is disabled/);
    assert.equal(agent.gather_goal, undefined);
});
