import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Vec3 from 'vec3';
import { planMake, startMakeGoal } from '../src/agent/make_goal.js';
import { ManagedFurnace, openManagedFurnace } from '../src/agent/managed_smelting.js';
import { furnaceEnergy, reserveFuel } from '../src/agent/smelting_plan.js';
import { ActionManager } from '../src/agent/action_manager.js';
import { findSafeIronTargets, collectIronFromSide } from '../src/agent/safe_stone.js';

const recipes = {
    oak_planks: [[{ oak_log: 1 }, { craftedCount: 4 }]], stick: [[{ oak_planks: 2 }, { craftedCount: 4 }]],
    crafting_table: [[{ oak_planks: 4 }, { craftedCount: 1 }]], furnace: [[{ cobblestone: 8 }, { craftedCount: 1 }]],
    wooden_pickaxe: [[{ oak_planks: 3, stick: 2 }, { craftedCount: 1 }]], stone_pickaxe: [[{ cobblestone: 3, stick: 2 }, { craftedCount: 1 }]]
};
const plan = (target, stock, context = {}, item = 'iron_ingot') => planMake(item, target, stock, true, n => recipes[n] || [], context);
const snapshot = (input = null, output = null, burnTicks = 0, fuel = null) =>
    ({ input, output, fuel, burnTicks, progressTicks: 0, observedAt: Date.now() });

test('iron plan bootstraps a stone pickaxe before ore and reserves furnace and fuel ingredients', () => {
    const steps = planMake('iron_ingot', 3, {}, false, n => recipes[n] || []);
    assert(steps.findIndex(s => s.item === 'stone_pickaxe') < steps.findIndex(s => s.item === 'raw_iron'));
    assert.equal(steps.filter(s => s.item === 'cobblestone').reduce((n, s) => n + (s.count || 0), 0), 11);
    assert.equal(steps.filter(s => s.item === 'raw_iron').reduce((n, s) => n + s.count, 0), 3);
    assert.equal(steps.filter(s => s.item === 'furnace').length, 1);
    assert.equal(steps.at(-1).type, 'smelt');
});

test('a partial ingot target reuses existing ore, furnace and coal without gathering extra', () => {
    assert.deepEqual(plan(3, { iron_ingot: 2, raw_iron: 1, furnace: 1, coal: 1 }),
        [{ type: 'smelt', item: 'iron_ingot', input: 'raw_iron', count: 1, output: 1 }]);
});

test('native 26.3 copper pickaxes are reused for iron instead of crafting a stone replacement', () => {
    const steps = plan(3, { copper_pickaxe: 1, furnace: 1, coal: 1 });
    assert.deepEqual(steps.map(s => [s.type, s.item]), [['gather', 'raw_iron'], ['smelt', 'iron_ingot']]);
});

test('three ingots need two planks, while existing charcoal supplies eight smelts', () => {
    assert.equal(plan(3, { raw_iron: 3, furnace: 1, oak_planks: 2 }).length, 1);
    assert.equal(plan(8, { raw_iron: 8, furnace: 1, charcoal: 1 }).length, 1);
    assert(plan(4, { raw_iron: 4, furnace: 1, oak_planks: 2 }).some(s => s.type === 'gather' && s.item === 'oak_log'));
});

test('charcoal planning reserves its input log and never burns the requested charcoal output', () => {
    assert.equal(plan(2, { charcoal: 1, oak_log: 1, oak_planks: 1, furnace: 1 }, {}, 'charcoal').length, 1);
    const stock = { charcoal: 4 };
    assert.equal(reserveFuel(stock, 200, 'charcoal'), 1);
    assert.equal(stock.charcoal, 4);
});

test('furnace input and already produced output are rechecked before obtaining duplicate ore', () => {
    const state = snapshot({ name: 'raw_iron', count: 3 }, null, 650);
    assert.equal(plan(3, {}, { furnace: true, snapshot: state }).length, 1);
    const ready = snapshot(null, { name: 'iron_ingot', count: 3 });
    assert.equal(plan(3, {}, { furnace: true, snapshot: ready }).length, 1);
    assert.throws(() => plan(3, {}, { furnace: true, snapshot: snapshot({ name: 'oak_log', count: 1 }) }), /another recipe/);
});

test('old burning-fuel observations do not remain fully credited forever', () => {
    const state = { ...snapshot(null, null, 300), observedAt: 1000 };
    assert.equal(furnaceEnergy(state, 11000), 100);
    assert.equal(furnaceEnergy(state, 21000), 0);
});

test('one-tick progress packet skew and an aging active queue do not cause extra fuel gathering', () => {
    const state = snapshot({ name: 'raw_iron', count: 2 }, null, 99, { name: 'oak_planks', count: 1 });
    assert.equal(plan(3, { iron_ingot: 1 }, { furnace: true, snapshot: state }).length, 1);
    state.burnTicks = 100; state.observedAt -= 2000;
    assert.equal(plan(3, { iron_ingot: 1 }, { furnace: true, snapshot: state }).length, 1);
});

test('initial furnace bars bundled with window opening are captured and all listeners released', async () => {
    const client = new EventEmitter(), window = new EventEmitter(); window.id = 7;
    const bot = { _client: client, openFurnace: async () => {
        for (const [property, value] of [[0, 900], [1, 1600], [2, 80], [3, 200]])
            client.emit('craft_progress_bar', { windowId: 7, property, value });
        window.fuelSeconds = null; window.totalFuel = null; window.progress = null;
        return window;
    } };
    assert.equal(await openManagedFurnace(bot, {}), window);
    assert.equal(window.fuelSeconds, 45); assert.equal(window.progress, 0.4);
    client.emit('craft_progress_bar', { windowId: 8, property: 0, value: 1 });
    assert.equal(window.fuelSeconds, 45);
    client.emit('craft_progress_bar', { windowId: 7, property: 0, value: 880 });
    assert.equal(window.fuelSeconds, 44);
    window.emit('close'); assert.equal(client.listenerCount('craft_progress_bar'), 0);
});

test('failed furnace opening removes the temporary progress listener', async () => {
    const bot = { _client: new EventEmitter(), openFurnace: async () => { throw new Error('Blocked window'); } };
    await assert.rejects(() => openManagedFurnace(bot, {}), /Blocked window/);
    assert.equal(bot._client.listenerCount('craft_progress_bar'), 0);
});

function fixture(t, initial = { raw_iron: 3, oak_planks: 2 }) {
    const stock = { ...initial }, bot = new EventEmitter();
    const registry = Object.fromEntries(['furnace', 'raw_iron', 'iron_ingot', 'oak_planks', 'oak_log', 'charcoal', 'coal'].map((name, id) => [name, { id: id + 1 }]));
    const names = Object.fromEntries(Object.entries(registry).map(([name, data]) => [data.id, name]));
    bot.registry = { itemsByName: registry };
    bot.entity = { position: new Vec3(0, 64, 0) }; bot.game = { dimension: 'overworld' };
    let visible = { ...stock };
    bot.inventory = { items: () => Object.entries(bot.currentWindow ? visible : stock).filter(([, n]) => n > 0)
        .map(([name, count]) => ({ name, count, type: registry[name]?.id })) };
    const state = { input: null, fuel: null, output: null, burn: 0, progress: 0,
        run: true, inputs: 0, fuelAdded: 0, closes: 0, opens: 0, placed: 0, onInput: null, lie: false };
    const timer = setInterval(() => {
        if (!state.run) return;
        if (state.input && state.burn <= 0 && state.fuel) {
            state.burn = state.fuel.name === 'coal' || state.fuel.name === 'charcoal' ? 1600 : 300;
            if (--state.fuel.count === 0) state.fuel = null;
        }
        if (state.burn > 0) {
            state.burn = Math.max(0, state.burn - 20);
            if (state.input) {
                state.progress += 20;
                if (state.progress >= 200) {
                    const name = state.input.name === 'oak_log' ? 'charcoal' : 'iron_ingot';
                    state.output = { name, count: (state.output?.count || 0) + 1 };
                    if (--state.input.count === 0) state.input = null;
                    state.progress = 0;
                }
            }
        }
    }, 1);
    t.after(() => clearInterval(timer));
    const api = {
        blockAt: p => ({ name: 'furnace', position: new Vec3(p.x, p.y, p.z) }),
        move: async () => true, freeSpace: () => new Vec3(1, 64, 0), place: async () => { state.placed++; stock.furnace--; },
        log: () => {},
        open: async () => {
            visible = { ...stock }; state.opens++;
            const window = new EventEmitter(); window.inventoryStart = 3; window.inventoryEnd = 39;
            Object.defineProperties(window, {
                slots: { get: () => [state.input, state.fuel, state.output, ...Object.entries(stock).filter(([, n]) => n > 0)
                    .map(([name, count]) => ({ name, count, type: registry[name]?.id }))] },
                fuelSeconds: { get: () => state.burn / 20 }, progress: { get: () => state.progress / 200 }
            });
            window.inputItem = () => state.input; window.fuelItem = () => state.fuel; window.outputItem = () => state.output;
            window.putInput = async (id, _meta, count) => {
                const name = names[id]; assert(stock[name] >= count); stock[name] -= count; state.inputs += count;
                state.input = { name, count: (state.input?.count || 0) + count };
                state.onInput?.();
            };
            window.putFuel = async (id, _meta, count) => {
                const name = names[id]; assert(stock[name] >= count); stock[name] -= count; state.fuelAdded += count;
                state.fuel = { name, count: (state.fuel?.count || 0) + count };
            };
            window.takeInput = async () => { stock[state.input.name] = (stock[state.input.name] || 0) + state.input.count; state.input = null; state.progress = 0; };
            window.takeOutput = async () => {
                if (state.output && !state.lie) stock[state.output.name] = (stock[state.output.name] || 0) + state.output.count;
                state.output = null;
            };
            const listener = () => {};
            bot.on('craft_progress_bar', listener); window.once('close', () => bot.removeListener('craft_progress_bar', listener));
            window.close = async () => { state.closes++; bot.currentWindow = null; window.emit('close'); };
            bot.currentWindow = window;
            return window;
        }
    };
    const manager = new ManagedFurnace(bot, api, { settleMs: 0, pollMs: 1, waitMs: 200, verifyMs: 20 });
    manager.record = { position: { x: 1, y: 64, z: 0 }, dimension: 'overworld', pendingPlacement: false };
    return { stock, bot, state, manager, api };
}

test('smelting verifies inventory after window close and uses exactly two planks for three ingots', async t => {
    const f = fixture(t);
    while ((f.stock.iron_ingot || 0) < 3) assert(await f.manager.smelt({ item: 'iron_ingot', count: 3 - (f.stock.iron_ingot || 0) }));
    assert.equal(f.stock.iron_ingot, 3); assert.equal(f.state.inputs, 3); assert.equal(f.state.fuelAdded, 2);
    assert.equal(f.state.opens, f.state.closes); assert.equal(f.bot.listenerCount('craft_progress_bar'), 0);
    assert.equal(f.bot.smeltingActivity, undefined);
});

test('a successful takeOutput return cannot replace an actual inventory increase', async t => {
    const f = fixture(t); f.state.output = { name: 'iron_ingot', count: 1 }; f.state.lie = true;
    assert.equal(await f.manager.smelt({ item: 'iron_ingot', count: 1 }), false);
    assert.equal(f.stock.iron_ingot || 0, 0);
});

test('interruption leaves queued input intact and resume consumes no duplicate ore', async t => {
    const f = fixture(t, { raw_iron: 3, coal: 1 }); f.state.run = false;
    f.state.onInput = () => { f.bot.interrupt_code = true; };
    assert.equal(await f.manager.smelt({ item: 'iron_ingot', count: 3 }), false);
    assert.equal(f.state.input.count, 3); assert.equal(f.state.inputs, 3); assert.equal(f.bot.currentWindow, null);
    f.state.onInput = null; f.bot.interrupt_code = false; f.state.run = true;
    while ((f.stock.iron_ingot || 0) < 3) assert(await f.manager.smelt({ item: 'iron_ingot', count: 3 - (f.stock.iron_ingot || 0) }));
    assert.equal(f.state.inputs, 3); assert.equal(f.state.fuelAdded, 1);
});

test('an unproductive furnace times out with input/fuel preserved and listeners removed', async t => {
    const f = fixture(t); f.state.run = false; f.manager.waitMs = 10;
    await assert.rejects(() => f.manager.smelt({ item: 'iron_ingot', count: 3 }), /deadline/);
    assert.equal(f.state.input.count, 3); assert.equal(f.state.fuel.count, 2);
    assert.equal(f.bot.currentWindow, null); assert.equal(f.bot.listenerCount('craft_progress_bar'), 0);
});

test('unrelated furnace contents are preserved and no fuel is inserted', async t => {
    const f = fixture(t); f.state.run = false; f.state.input = { name: 'oak_log', count: 1 };
    await assert.rejects(() => f.manager.smelt({ item: 'iron_ingot', count: 3 }), /another recipe/);
    assert.equal(f.state.input.count, 1); assert.equal(f.state.fuelAdded, 0);
});

test('runtime never burns charcoal when charcoal is the requested output', async t => {
    const f = fixture(t, { oak_log: 1, charcoal: 1 }); f.state.run = false;
    await assert.rejects(() => f.manager.smelt({ item: 'charcoal', count: 1 }), /Insufficient compatible/);
    assert.equal(f.stock.charcoal, 1); assert.equal(f.state.fuelAdded, 0);
});

test('failed output transfer retains output, closes the window, and releases progress listeners', async t => {
    const f = fixture(t); f.state.run = false; f.state.output = { name: 'iron_ingot', count: 1 };
    const open = f.api.open;
    f.api.open = async () => { const window = await open(); window.takeOutput = async () => { throw new Error('Inventory full'); }; return window; };
    await assert.rejects(() => f.manager.smelt({ item: 'iron_ingot', count: 1 }), /Inventory full/);
    assert.equal(f.state.output.count, 1); assert.equal(f.bot.currentWindow, null);
    assert.equal(f.bot.listenerCount('craft_progress_bar'), 0);
});

test('a new smaller target trims an old oversized input queue before fueling', async t => {
    const f = fixture(t, { coal: 1 }); f.state.run = false; f.state.input = { name: 'raw_iron', count: 8 };
    f.state.onInput = () => { f.bot.interrupt_code = true; };
    assert.equal(await f.manager.smelt({ item: 'iron_ingot', count: 3 }), false);
    assert.equal(f.state.input.count, 3); assert.equal(f.stock.raw_iron, 5);
});

test('only remembered or newly placed furnaces are used; arbitrary nearby furnaces are not adopted', async t => {
    const f = fixture(t, { furnace: 1, raw_iron: 1, coal: 1 }); f.manager.record = null;
    assert.equal(await f.manager.inspect(), false); assert.equal(f.state.opens, 0);
    assert(await f.manager.smelt({ item: 'iron_ingot', count: 1 }));
    assert.equal(f.state.placed, 1); assert(f.manager.available());
});

test('placement intent survives an interrupted placement and is verified against the loaded furnace', async t => {
    const f = fixture(t, { furnace: 1 }); const saved = [];
    f.bot.localMemory = { furnace: () => null, saveFurnace: r => saved.push(structuredClone(r)) };
    f.manager.record = null; f.api.place = async () => { f.bot.interrupt_code = true; };
    assert.equal(await f.manager.obtain(), null); assert.equal(saved[0].pendingPlacement, true);
    f.bot.interrupt_code = false; assert(f.manager.available()); assert.equal(f.manager.record.pendingPlacement, false);
});

test('managed smelting yields to combat, resumes the same target and verifies its final inventory', async t => {
    const f = fixture(t, { raw_iron: 3, coal: 1 }); let safety;
    f.bot.output = ''; f.bot.modes = { getActiveModes: () => [] };
    const agent = { bot: f.bot, history: { add: async () => {}, save: async () => {} },
        self_prompter: { stop: async () => {} }, openChat: () => {},
        clearBotLogs: () => { f.bot.interrupt_code = false; f.bot.output = ''; },
        requestInterrupt: () => { f.bot.interrupt_code = true; },
        cleanKill: message => assert.fail(message), isIdle: () => !agent.actions.executing };
    agent.actions = new ActionManager(agent);
    f.state.onInput = () => {
        f.state.onInput = null;
        safety = agent.actions.runAction('mode:self_defense', async () => {});
    };
    await startMakeGoal(agent, 'iron_ingot', 3, {
        hasTable: () => true, recipes: n => recipes[n], hasFurnace: () => f.manager.available(),
        furnaceSnapshot: () => f.manager.snapshot, inspectFurnace: () => f.manager.inspect(),
        smelt: (_bot, step) => f.manager.smelt(step), collect: () => assert.fail('No new ore needed'), verifyTimeoutMs: 10
    });
    agent.gather_goal.resumeDelayMs = 0;
    assert.match(await agent.gather_goal.done, /Crafting complete/); await safety;
    assert.equal(f.stock.iron_ingot, 3); assert.equal(f.state.inputs, 3);
});

test('new goals inspect live contents before rejecting a stale cached recipe', async t => {
    const f = fixture(t, { raw_iron: 1, coal: 1 });
    f.manager.snapshot = snapshot({ name: 'oak_log', count: 4 });
    f.bot.output = ''; f.bot.modes = { getActiveModes: () => [] };
    const agent = { bot: f.bot, history: { add: async () => {}, save: async () => {} }, self_prompter: { stop: async () => {} },
        openChat: () => {}, requestInterrupt: () => { f.bot.interrupt_code = true; },
        clearBotLogs: () => { f.bot.interrupt_code = false; f.bot.output = ''; }, cleanKill: message => assert.fail(message),
        isIdle: () => !agent.actions.executing };
    agent.actions = new ActionManager(agent);
    await startMakeGoal(agent, 'iron_ingot', 1, { hasTable: () => true, recipes: n => recipes[n],
        hasFurnace: () => f.manager.available(), furnaceSnapshot: () => f.manager.snapshot,
        inspectFurnace: () => f.manager.inspect(), smelt: (_bot, step) => f.manager.smelt(step), verifyTimeoutMs: 10 });
    assert.match(await agent.gather_goal.done, /Crafting complete/);
    assert.equal(f.stock.iron_ingot, 1);
});

test('raw iron candidates use exposed supported sides and do not remove the support below the bot', async () => {
    const f = { bot: { entity: { position: new Vec3(0.5, 64, 0.5) } } };
    const block = (name, p) => ({ name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', canHarvest: () => true });
    const ore = block('iron_ore', new Vec3(2, 64, 0)); let removed = false;
    f.bot.blockAt = p => p.equals(ore.position) && !removed ? ore : block(p.y < 64 ? 'dirt' : 'air', p);
    f.bot.findBlocks = options => { assert(options.matching(ore)); assert(options.useExtraInfo(ore)); return [ore.position]; };
    assert.deepEqual(findSafeIronTargets(f.bot, () => true), [ore]);
    f.bot.tool = { equipForBlock: async () => {} }; f.bot.heldItem = { type: 1 };
    f.bot.pathfinder = { getPathTo: () => ({ status: 'success' }), setMovements: () => {},
        goto: async g => { f.bot.entity.position = new Vec3(g.x + 0.5, g.y, g.z + 0.5); } };
    f.bot.dig = async b => { assert.equal(b.name, 'iron_ore'); removed = true; };
    assert(await collectIronFromSide(f.bot, [ore], { movements: () => ({}), canBreak: () => true }));
});
