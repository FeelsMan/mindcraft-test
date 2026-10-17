import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startMakeGoal } from '../src/agent/make_goal.js';

function fixture(stock = { stone_axe: 1 }) {
    const events = [], chats = [], saved = [];
    const bot = new EventEmitter();
    bot.stock = stock;
    bot.inventory = { items: () => Object.entries(stock).filter(([, count]) => count > 0)
        .map(([name, count]) => ({ name, count })) };
    bot.modes = { getActiveModes: () => [] };
    const agent = {
        bot, instruction_epoch: 7,
        actions: { executing: false, cancelResume() {},
            runAction: async (_name, action) => { await action(); return { success: true }; } },
        self_prompter: { stop: async () => {} },
        history: { add: async (...args) => saved.push(args), save: async () => {} },
        openChat: message => chats.push(message),
        onManagedGoalCompleted: async event => {
            assert.equal(agent.gather_goal.active, false);
            assert.equal(event.goalEpoch, agent.gather_epoch, 'Use terminal epoch after cleanup');
            events.push(event);
        }
    };
    const api = {
        requestContext: { requester: 'CaptainNeyo', instructionEpoch: 7 },
        hasTable: () => true,
        recipes: name => name === 'stone_axe' ? [[{ cobblestone: 3, stick: 2 }, { craftedCount: 1 }]] : null,
        craft: async () => { stock.stone_axe = (stock.stone_axe || 0) + 1; },
        collect: async () => assert.fail('No gathering needed'), verifyTimeoutMs: 1
    };
    return { agent, api, stock, events, chats, saved };
}

test('an already-satisfied target emits one verified event after persistence and cleanup', async () => {
    const f = fixture();
    await startMakeGoal(f.agent, 'stone_axe', 1, f.api);
    assert.match(await f.agent.gather_goal.done, /1\/1 stone_axe/);
    assert.equal(f.events.length, 1);
    assert.deepEqual(f.events[0], {
        item: 'stone_axe', target: 1, held: 1, initialHeld: 1,
        goalEpoch: f.agent.gather_epoch, requester: 'CaptainNeyo', instructionEpoch: 7
    });
    assert.equal(f.chats.length, 0, 'Callback owns success delivery; no duplicate openChat');
    assert.match(f.saved[0][1], /Crafting complete/);
});

test('the completion event waits for real inventory gain and retains its original requester', async () => {
    const f = fixture({ cobblestone: 3, stick: 2 });
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    f.api.craft = async () => {
        entered();
        await new Promise(resolve => { release = resolve; });
        f.stock.stone_axe = 1;
    };
    const start = startMakeGoal(f.agent, 'stone_axe', 1, f.api);
    await started; await start;
    assert.equal(f.events.length, 0);
    release(); await f.agent.gather_goal.done;
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].initialHeld, 0);
    assert.equal(f.events[0].held, 1);
    assert.equal(f.events[0].requester, 'CaptainNeyo');
});

test('unverified output blocks the goal without a success callback', async () => {
    const f = fixture({ cobblestone: 3, stick: 2 });
    f.api.craft = async () => {};
    await startMakeGoal(f.agent, 'stone_axe', 1, f.api);
    assert.match(await f.agent.gather_goal.done, /Could not verify stone_axe output/);
    assert.equal(f.events.length, 0);
});

test('death during a pending crafting action never emits completion', async () => {
    const f = fixture({ cobblestone: 3, stick: 2 });
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    f.api.craft = async () => {
        entered();
        await new Promise(resolve => { release = resolve; });
    };
    const start = startMakeGoal(f.agent, 'stone_axe', 1, f.api);
    await started; await start;
    f.agent.bot.emit('death'); release();
    assert.match(await f.agent.gather_goal.done, /cancelled/);
    assert.equal(f.events.length, 0);
    assert.equal(f.chats.length, 0);
});

test('a newer goal during terminal persistence invalidates the older completion event', async () => {
    const f = fixture();
    let saves = 0;
    f.agent.history.save = async () => {
        saves++;
        if (saves === 2) f.agent.gather_epoch++;
    };
    await startMakeGoal(f.agent, 'stone_axe', 1, f.api);
    await f.agent.gather_goal.done;
    assert.equal(f.events.length + f.chats.length, 0);
});

test('completion callback failure does not turn a verified completed goal into an action failure', async () => {
    const f = fixture();
    f.agent.onManagedGoalCompleted = async () => { throw Error('Chat disconnected'); };
    await startMakeGoal(f.agent, 'stone_axe', 1, f.api);
    assert.match(await f.agent.gather_goal.done, /Crafting complete/);
    assert.equal(f.agent.gather_goal.active, false);
});
