import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ActionManager } from '../src/agent/action_manager.js';
import { startMakeGoal, planMake } from '../src/agent/make_goal.js';
import { cancelGatherGoal } from '../src/agent/gather_goal.js';
import { modeAllowedDuringGoal, sleep } from '../src/agent/managed_goal.js';
import { serializePvpStop } from '../src/agent/pvp_lifecycle.js';

const recipes = {
    oak_planks: [[{ oak_log: 1 }, { craftedCount: 4 }]],
    stick: [[{ oak_planks: 2 }, { craftedCount: 4 }]],
    crafting_table: [[{ oak_planks: 4 }, { craftedCount: 1 }]],
    wooden_axe: [[{ oak_planks: 3, stick: 2 }, { craftedCount: 1 }]],
    wooden_pickaxe: [[{ oak_planks: 3, stick: 2 }, { craftedCount: 1 }]],
    stone_pickaxe: [[{ cobblestone: 3, stick: 2 }, { craftedCount: 1 }]],
    stone_axe: [[{ cobblestone: 3, stick: 2 }, { craftedCount: 1 }]],
    furnace: [[{ cobblestone: 8 }, { craftedCount: 1 }]]
};

function fixture(initial = {}) {
    const stock = { ...initial };
    const bot = new EventEmitter();
    bot.inventory = { items: () => Object.entries(stock).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) };
    bot.output = '';
    bot.modes = { getActiveModes: () => [] };
    const agent = {
        bot, stock, messages: [],
        history: { add: async () => {}, save: async () => {} },
        self_prompter: { stop: async () => {}, isActive: () => false },
        requestInterrupt: () => { bot.interrupt_code = true; },
        clearBotLogs: () => { bot.output = ''; bot.interrupt_code = false; },
        cleanKill: message => { throw new Error(message); },
        isIdle: () => !agent.actions.executing,
        openChat: message => agent.messages.push(message)
    };
    agent.actions = new ActionManager(agent);
    const calls = [];
    const api = {
        recipes: name => recipes[name] || [], hasTable: () => false, verifyTimeoutMs: 100,
        collect: async (_bot, name) => { calls.push('gather:' + name); stock[name] = (stock[name] || 0) + 1; return true; },
        craft: async (_bot, name) => {
            calls.push('craft:' + name);
            const [ingredients, result] = recipes[name][0];
            for (const [item, count] of Object.entries(ingredients)) {
                assert((stock[item] || 0) >= count, 'Missing ingredient ' + item);
                stock[item] -= count;
            }
            stock[name] = (stock[name] || 0) + result.craftedCount;
            return true;
        }
    };
    return { agent, stock, api, calls };
}

async function start(f, item = 'wooden_axe', count = 1) {
    await startMakeGoal(f.agent, item, count, f.api);
    f.agent.gather_goal.resumeDelayMs = 0;
    return f.agent.gather_goal;
}

test('planner reserves the table and recipe materials rather than gathering an arbitrary stack', () => {
    const p = planMake('wooden_axe', 1, {}, false, name => recipes[name]);
    assert.equal(p.filter(s => s.type === 'gather').reduce((n, s) => n + s.count, 0), 3);
    assert.equal(p.filter(s => s.item === 'crafting_table').length, 1);
});

test('stone pickaxe bootstraps a mining tool and reserves both recipes before gathering stone', () => {
    const p = planMake('stone_pickaxe', 1, {}, false, name => recipes[name]);
    const mining = p.findIndex(s => s.type === 'gather' && s.item === 'cobblestone');
    assert(p.findIndex(s => s.item === 'wooden_pickaxe') < mining);
    assert.equal(p[mining].count, 3);
    assert.equal(p.filter(s => s.type === 'gather' && s.item === 'oak_log').reduce((n, s) => n + s.count, 0), 3);
    assert.equal(p.filter(s => s.item === 'crafting_table').length, 1);
});

test('furnace with a reusable station and existing pickaxe needs exactly eight cobblestone', () => {
    const p = planMake('furnace', 1, { iron_pickaxe: 1 }, true, name => recipes[name]);
    assert.deepEqual(p, [
        { type: 'gather', item: 'cobblestone', count: 8 },
        { type: 'craft', item: 'furnace', batches: 1, output: 1 }
    ]);
});

test('requesting a table in inventory recovers the owned station instead of crafting a duplicate', async () => {
    const f = fixture();
    let owned = true, recovered = 0;
    f.api.hasTable = () => owned;
    f.api.hasOwnedTable = () => owned;
    f.api.recoverTable = async () => { recovered++; owned = false; f.stock.crafting_table = 1; };
    const goal = await start(f, 'crafting_table');
    assert.match(await goal.done, /Crafting complete/);
    assert.equal(recovered, 1);
    assert.equal(f.calls.length, 0);
});

test('stone tool and furnace goals reuse stock and verify the resulting inventory', async () => {
    const f = fixture({ wooden_pickaxe: 1, crafting_table: 1, stick: 2, cobblestone: 2 });
    f.api.collect = async (_bot, name) => {
        assert(f.stock.wooden_pickaxe > 0);
        f.calls.push('gather:' + name);
        f.stock[name] = (f.stock[name] || 0) + 1;
    };
    const axe = await start(f, 'stone_axe');
    assert.match(await axe.done, /Crafting complete/);
    assert.equal(f.calls.filter(s => s === 'gather:cobblestone').length, 1);
    const furnace = await start(f, 'furnace');
    assert.match(await furnace.done, /Crafting complete/);
    assert.equal(f.stock.furnace, 1);
    assert.equal(f.calls.filter(s => s.startsWith('craft:wooden')).length, 0);
    assert.equal(f.calls.filter(s => s === 'gather:cobblestone').length, 9);
});

test('combat after a stone pickup retains progress and does not overmine the furnace ingredients', async () => {
    const f = fixture({ wooden_pickaxe: 1, crafting_table: 1 });
    let combat;
    f.api.collect = async (bot, name) => {
        f.calls.push('gather:' + name);
        f.stock[name] = (f.stock[name] || 0) + 1;
        if (f.stock[name] === 1) {
            combat = f.agent.actions.runAction('mode:self_defense', async () => { await sleep(30); });
            while (!bot.interrupt_code) await sleep(1);
        }
    };
    const goal = await start(f, 'furnace');
    assert.match(await goal.done, /Crafting complete/);
    await combat;
    assert.equal(f.calls.filter(s => s === 'gather:cobblestone').length, 8);
    assert.equal(f.stock.furnace, 1);
});

test('delayed inventory delivery does not cause another log to be mined', async () => {
    const f = fixture();
    let collected = 0;
    f.api.collect = async () => { collected++; setTimeout(() => { f.stock.oak_log = 1; }, 60); return true; };
    const goal = await start(f, 'oak_planks', 4);
    assert.match(await goal.done, /Crafting complete/);
    assert.equal(collected, 1);
    assert.equal(f.stock.oak_planks, 4);
});

test('a false mining result is reconciled with actual dropped-item pickup', async () => {
    const f = fixture();
    let pickup = 0;
    f.api.verifyTimeoutMs = 10;
    f.api.collect = async () => false;
    f.api.pickup = async (_bot, name) => { pickup++; f.stock[name] = (f.stock[name] || 0) + 1; };
    const goal = await start(f, 'oak_planks', 4);
    assert.match(await goal.done, /Crafting complete/);
    assert.equal(pickup, 1);
});

test('combat retains the target and replans without repeating a completed table craft', async () => {
    const f = fixture({ oak_log: 3 });
    const craft = f.api.craft;
    let combat;
    let interrupted = false;
    f.api.craft = async (bot, name) => {
        await craft(bot, name);
        if (name === 'crafting_table' && !interrupted) {
            interrupted = true;
            combat = f.agent.actions.runAction('mode:self_defense', async () => {
                await sleep(60);
                // Inventory may change while the planner yields to safety.
                f.stock.oak_planks = Math.max(0, (f.stock.oak_planks || 0) - 1);
            });
            while (!bot.interrupt_code) await sleep(1);
        }
    };
    const goal = await start(f);
    const report = await goal.done;
    await combat;
    assert.match(report, /Crafting complete/);
    assert.equal(goal.item, 'wooden_axe');
    assert.equal(goal.target, 1);
    assert.equal(f.stock.wooden_axe, 1);
    assert.equal(f.calls.filter(c => c === 'craft:crafting_table').length, 1);
});

test('simultaneous handoffs never execute two owners and hunting cannot interrupt safety', async () => {
    const f = fixture();
    f.agent.gather_goal = { active: true };
    let running = 0, maximum = 0, huntingRan = false;
    const action = async () => {
        maximum = Math.max(maximum, ++running);
        for (let i = 0; i < 40 && !f.agent.bot.interrupt_code; i++) await sleep(2);
        running--;
    };
    const gather = f.agent.actions.runAction('action:makeGoal', action);
    await sleep(5);
    const defense = f.agent.actions.runAction('mode:self_defense', action);
    const preservation = f.agent.actions.runAction('mode:self_preservation', action);
    const hunt = f.agent.actions.runAction('mode:hunting', async () => { huntingRan = true; });
    const results = await Promise.all([gather, defense, preservation, hunt]);
    assert.equal(maximum, 1);
    assert.equal(huntingRan, false);
    assert.equal(results[3].deferred, true);
    assert.equal(results[2].interrupted, false);
});

test('no pickup or output stops after two failed attempts without claiming completion', async () => {
    const f = fixture();
    let attempts = 0;
    f.api.collect = async () => { attempts++; return false; };
    f.api.verifyTimeoutMs = 5;
    const goal = await start(f, 'oak_planks', 4);
    assert.match(await goal.done, /Could not verify oak_log/);
    assert.equal(attempts, 2);
    assert.equal(f.stock.oak_planks, undefined);
});

test('endGoal while paused prevents the saved target from resuming', async () => {
    const f = fixture();
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    f.api.collect = async bot => { started(); while (!bot.interrupt_code) await sleep(2); return false; };
    const goal = await start(f);
    await ready;
    const defense = f.agent.actions.runAction('mode:self_defense', async () => {
        while (!f.agent.bot.interrupt_code) await sleep(2);
    });
    await sleep(40);
    await cancelGatherGoal(f.agent);
    await defense;
    assert.match(await goal.done, /cancelled/);
    assert.equal(goal.active, false);
    assert.equal(f.calls.filter(c => c.startsWith('craft:')).length, 0);
});

test('death cancels the managed goal and clears its event listeners', async () => {
    const f = fixture();
    f.agent.bot.modes.getActiveModes = () => ['self_defense'];
    const goal = await start(f);
    f.agent.bot.emit('death');
    assert.match(await goal.done, /cancelled/);
    assert.equal(f.agent.bot.listenerCount('end'), 0);
    assert.equal(goal.active, false);
});

test('background modes yield throughout a managed goal; emergency modes remain available', () => {
    const f = fixture();
    f.agent.gather_goal = { active: true, status: 'paused' };
    for (const mode of ['hunting', 'item_collecting', 'torch_placing', 'elbow_room', 'idle_staring'])
        assert.equal(modeAllowedDuringGoal(f.agent, mode), false);
    for (const mode of ['self_preservation', 'self_defense', 'cowardice', 'unstuck'])
        assert.equal(modeAllowedDuringGoal(f.agent, mode), true);
});

test('all PvP stop callers await the same asynchronous path cleanup', async () => {
    let cleanups = 0;
    const pvp = { target: {}, async stop() {
        if (!this.target) return;
        this.target = null;
        await sleep(30);
        cleanups++;
    } };
    serializePvpStop(pvp);
    const first = pvp.stop();
    const second = pvp.stop();
    assert.equal(first, second);
    assert.equal(cleanups, 0);
    await second;
    assert.equal(cleanups, 1);
});
