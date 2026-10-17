import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ActionManager } from '../src/agent/action_manager.js';
import minecraftData from 'minecraft-data';

const recipes = {
    oak_planks: [[{ oak_log: 1 }, { craftedCount: 4 }]],
    stick: [[{ oak_planks: 2 }, { craftedCount: 4 }]],
    stone_axe: [[{ cobblestone: 3, stick: 2 }, { craftedCount: 1 }]]
};
let crafts, collections, legacy;
mock.module(new URL('../src/agent/library/skills.js', import.meta.url).href, { namedExports: {
    getCraftingStation: () => ({ available: () => true }),
    getManagedFurnace: () => ({ available: () => false, snapshot: null }),
    inspectManagedFurnace: async () => assert.fail('No furnace required'),
    smeltManaged: async () => assert.fail('No smelting required'),
    pickupNearbyItems: async () => {},
    collectBlock: async (bot, block, count) => {
        collections.push({ block, count });
        const item = block === 'stone' ? 'cobblestone' : block;
        bot.stock[item] = (bot.stock[item] || 0) + count;
    },
    craftRecipe: async (bot, item, batches) => {
        if (!recipes[item]) { legacy.push({ item, batches }); return; }
        crafts.push({ item, batches });
        const [ingredients, result] = recipes[item][0];
        for (const [name, n] of Object.entries(ingredients)) {
            assert((bot.stock[name] || 0) >= n * batches);
            bot.stock[name] -= n * batches;
        }
        bot.stock[item] = (bot.stock[item] || 0) + result.craftedCount * batches;
    },
    smeltItem: async () => assert.fail('Not a smelting request')
} });
const mc = await import('../src/utils/mcdata.js');
const data = minecraftData('1.21.4');
mock.module(new URL('../src/utils/mcdata.js', import.meta.url).href, { namedExports: {
    ...mc,
    getItemId: name => data.itemsByName[name]?.id ?? null,
    getBlockId: name => data.blocksByName[name]?.id ?? null,
    getItemCraftingRecipes: name => recipes[name] || null
} });
const { executeCommand, getCommandDocs } = await import('../src/agent/commands/index.js');

function fixture(stock) {
    crafts = []; collections = []; legacy = [];
    const bot = new EventEmitter();
    bot.stock = { ...stock };
    bot.inventory = { items: () => Object.entries(bot.stock).filter(([, n]) => n > 0)
        .map(([name, count]) => ({ name, count })) };
    bot.output = ''; bot.modes = { getActiveModes: () => [] };
    const agent = {
        bot, blocked_actions: [],
        history: { add: async () => {}, save: async () => {} },
        self_prompter: { stop: async () => {
            assert.equal(agent.actions.executing, false, 'Managed startup must not own an action slot');
            await agent.actions.stop();
        } },
        requestInterrupt: () => { bot.interrupt_code = true; },
        clearBotLogs: () => { bot.output = ''; bot.interrupt_code = false; },
        cleanKill: message => assert.fail(message),
        isIdle: () => !agent.actions.executing,
        openChat: () => {}
    };
    agent.actions = new ActionManager(agent);
    return agent;
}

test('a legacy stick request means one batch of four items and starts outside the action slot', async () => {
    const agent = fixture({ oak_planks: 2 });
    assert.match(await executeCommand(agent, '!craftRecipe("stick", 1)'), /keep 4 stick total/);
    assert.match(await agent.gather_goal.done, /4\/4 stick/);
    assert.equal(agent.bot.stock.stick, 4);
    assert.deepEqual(crafts, [{ item: 'stick', batches: 1 }]);
    assert.equal(collections.length + legacy.length, 0);
});

test('legacy batch requests remain additional to already-held items', async () => {
    const agent = fixture({ stick: 4, oak_planks: 2 });
    assert.match(await executeCommand(agent, '!craftRecipe("stick", 1)'), /keep 8 stick total/);
    await agent.gather_goal.done;
    assert.equal(agent.bot.stock.stick, 8);
    assert.equal(agent.bot.stock.oak_planks, 0);
});

test('a stone axe alias delegates its missing sticks and cobblestone to the verified planner', async () => {
    const agent = fixture({ oak_planks: 2, cobblestone: 1, wooden_pickaxe: 1 });
    assert.match(await executeCommand(agent, '!craftRecipe("stone_axe", 1)'), /keep 1 stone_axe total/);
    assert.match(await agent.gather_goal.done, /1\/1 stone_axe/);
    assert.equal(agent.bot.stock.stone_axe, 1);
    assert.equal(agent.bot.stock.stick, 2, 'One batch produced four sticks; the axe consumed two');
    assert.equal(crafts.filter(x => x.item === 'stick').length, 1);
    assert.equal(collections.reduce((n, x) => n + x.count, 0), 2);
    assert.equal(legacy.length, 0);
});

test('the total-target command does not create a duplicate axe already in inventory', async () => {
    const agent = fixture({ stone_axe: 1 });
    assert.match(await executeCommand(agent, '!makeGoal("stone_axe", 1)'), /keep 1 stone_axe total/);
    await agent.gather_goal.done;
    assert.equal(agent.bot.stock.stone_axe, 1);
    assert.equal(crafts.length + collections.length + legacy.length, 0);
});

test('oversized batch output is rejected before starting any action', async () => {
    const agent = fixture({ stick: 63, oak_planks: 2 });
    assert.match(await executeCommand(agent, '!craftRecipe("stick", 1)'), /at most 64 total/);
    assert.equal(agent.gather_goal, undefined);
    assert.equal(crafts.length + collections.length + legacy.length, 0);
});

test('a legacy crafting alias cannot bypass a disabled makeGoal command', async () => {
    const agent = fixture({ oak_planks: 2 }); agent.blocked_actions = ['!makeGoal'];
    assert.match(await executeCommand(agent, '!craftRecipe("stick", 1)'), /!makeGoal is disabled/);
    assert.equal(agent.gather_goal, undefined);
});

test('active managed goals reject legacy crafting actions', async () => {
    const agent = fixture({ oak_planks: 2 }); agent.gather_goal = { active: true };
    assert.match(await executeCommand(agent, '!craftRecipe("stick", 1)'), /managed goal is active/);
    assert.equal(crafts.length + collections.length + legacy.length, 0);
});

test('unsupported recipes keep one-shot batch behavior and docs explain quantity semantics', async () => {
    const agent = fixture({});
    await executeCommand(agent, '!craftRecipe("chest", 2)');
    assert.deepEqual(legacy, [{ item: 'chest', batches: 2 }]);
    assert.equal(agent.gather_goal, undefined);
    assert.match(getCommandDocs(agent), /ADDITIONAL recipe BATCHES/);
});

test('requester and instruction context reaches the managed completion callback', async () => {
    const agent = fixture({ stone_axe: 1 });
    let event;
    agent.onManagedGoalCompleted = async e => { event = e; };
    await executeCommand(agent, '!makeGoal("stone_axe", 1)', {
        requester: 'CaptainNeyo', instructionEpoch: 12
    });
    await agent.gather_goal.done;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(event?.requester, 'CaptainNeyo');
    assert.equal(event?.instructionEpoch, 12);
    assert.equal(event?.initialHeld, 1);
});
