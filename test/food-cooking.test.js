import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import minecraftData from 'minecraft-data';
import Vec3 from 'vec3';
import { foodCookingRecipes, smeltingRecipes, fuelTicks } from '../src/agent/smelting_plan.js';
import { planMake, startMakeGoal, supportedItems } from '../src/agent/make_goal.js';
import { ManagedFurnace } from '../src/agent/managed_smelting.js';
import { ActionManager } from '../src/agent/action_manager.js';
import { cancelGatherGoal } from '../src/agent/gather_goal.js';
import { installMainSupervisor } from '../src/adapters/minecraft/supervisor.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check, message = 'Expected cooking state was not observed') {
    const deadline = Date.now() + 3000;
    while (!check()) { assert(Date.now() < deadline, message); await sleep(1); }
}
function recipesFor(data) {
    return name => (data.recipes[data.itemsByName[name]?.id] || []).map(recipe => {
        const ingredients = {};
        for (const id of recipe.ingredients || recipe.inShape?.flat() || []) {
            const item = data.items[id];
            if (item) ingredients[item.name] = (ingredients[item.name] || 0) + 1;
        }
        return [ingredients, { craftedCount: recipe.result.count }];
    });
}
const view = (input = null, output = null) => ({ input, output, fuel: null,
    burnTicks: 0, progressTicks: 0, observedAt: Date.now() });

for (const version of ['1.21.4', '26.3']) {
    const data = minecraftData(version), recipes = recipesFor(data);
    test(`native ${version} cooking plans use carried food inputs and keep all existing production outputs`, () => {
        assert.equal(smeltingRecipes.iron_ingot, 'raw_iron');
        assert.equal(smeltingRecipes.charcoal, 'oak_log');
        for (const [cooked, raw] of Object.entries(foodCookingRecipes)) {
            assert(data.itemsByName[raw]);
            assert(data.foodsByName[cooked]?.foodPoints > 0);
            const stock = { [raw]: 2, [cooked]: 1, furnace: 1, coal: 1 }, original = { ...stock };
            assert(supportedItems.has(cooked));
            assert.deepEqual(planMake(cooked, 3, stock, true, recipes),
                [{ type: 'smelt', item: cooked, input: raw, count: 2, output: 1 }]);
            assert.deepEqual(stock, original, 'The planner must not consume real inventory');
            assert.throws(() => planMake(cooked, 3, { ...stock, [raw]: 1 }, true, recipes),
                new RegExp('Food acquisition needed: missing 1 ' + raw));
            assert.deepEqual(planMake(cooked, 1, { [cooked]: 1 }, false, recipes), []);
        }
        assert.deepEqual(planMake('iron_ingot', 3, { iron_ingot: 2, raw_iron: 1, furnace: 1, coal: 1 }, true, recipes),
            [{ type: 'smelt', item: 'iron_ingot', input: 'raw_iron', count: 1, output: 1 }]);
        assert.deepEqual(planMake('charcoal', 2, { charcoal: 1, oak_log: 1, oak_planks: 1, furnace: 1 }, true, recipes),
            [{ type: 'smelt', item: 'charcoal', input: 'oak_log', count: 1, output: 1 }]);
    });

    test(`native ${version} queued food and ready output are inspected before obtaining duplicate raw supplies`, () => {
        const cooked = 'cooked_beef', raw = foodCookingRecipes[cooked];
        const queued = { ...view({ name: raw, count: 2 }), burnTicks: 500 };
        const ready = view(null, { name: cooked, count: 2 });
        for (const snapshot of [queued, ready]) assert.deepEqual(
            planMake(cooked, 2, {}, true, recipes, { furnace: true, snapshot }),
            [{ type: 'smelt', item: cooked, input: raw, count: 2, output: 1 }]);
        assert.throws(() => planMake(cooked, 2, {}, true, recipes,
            { furnace: true, snapshot: view({ name: 'raw_iron', count: 2 }) }), /another recipe/);
    });

    test(`native ${version} bread requires held wheat and a real crafting-table recipe`, () => {
        assert.deepEqual(planMake('bread', 3, { wheat: 6, bread: 1 }, true, recipes),
            [{ type: 'craft', item: 'bread', batches: 2, output: 1 }]);
        const steps = planMake('bread', 1, { wheat: 3, oak_planks: 4 }, false, recipes);
        assert.deepEqual(steps.map(step => step.item), ['crafting_table', 'bread']);
        assert.equal(steps.some(step => step.type === 'gather' && step.item === 'wheat'), false);
        assert.throws(() => planMake('bread', 2, { wheat: 3 }, true, recipes), /Food acquisition needed: missing 3 wheat/);
        assert.throws(() => planMake('bread', 1, { wheat: 3 }, true, () => []), /No supported wheat recipe/);
        assert.throws(() => planMake('bread', 1, { oak_planks: 3 }, true,
            () => [[{ oak_planks: 3 }, { craftedCount: 1 }]]), /No supported wheat recipe/);
    });

    test(`native ${version} cooking can bootstrap furnace and fuel without inventing raw food gathering`, () => {
        const steps = planMake('cooked_chicken', 2, { chicken: 2 }, false, recipes);
        assert(steps.some(step => step.type === 'craft' && step.item === 'furnace'));
        assert(steps.some(step => step.type === 'craft' && step.item === 'oak_planks'));
        assert(steps.filter(step => step.type === 'gather').every(step => ['oak_log', 'cobblestone'].includes(step.item)));
        assert.deepEqual(steps.at(-1), { type: 'smelt', item: 'cooked_chicken', input: 'chicken', count: 2, output: 1 });
    });
}

// Controlled server I/O with each supported native registry. The open window
// has current player slots while bot.inventory remains stale until close,
// matching the native inventory synchronization boundary.
function furnaceFixture(t, version = '26.3', initial = {}) {
    const data = minecraftData(version), stock = { ...initial }, bot = new EventEmitter();
    const state = { input: null, fuel: null, output: null, burn: 0, progress: 0,
        run: true, loaded: true, inputs: 0, fuelAdded: 0, opens: 0, closes: 0,
        onInput: null, onOutput: null, lie: false, receiptDelayMs: 0, delayWindowReceipt: false, pending: {} };
    let visible = { ...stock };
    const items = values => Object.entries(values).filter(([, count]) => count > 0)
        .map(([name, count]) => ({ name, count, type: data.itemsByName[name].id }));
    bot.registry = data; bot.output = ''; bot.interrupt_code = false;
    bot.entity = { position: new Vec3(0, 64, 0) }; bot.game = { dimension: 'overworld' };
    bot.health = 20; bot.food = 20; bot.modes = { getActiveModes: () => [] };
    bot.inventory = { items: () => items(bot.currentWindow ? visible : stock) };
    const timers = [];
    const timer = setInterval(() => {
        if (!state.run) return;
        if (state.input && state.burn <= 0 && state.fuel) {
            state.burn = fuelTicks(state.fuel.name);
            if (state.burn && --state.fuel.count === 0) state.fuel = null;
        }
        if (state.burn <= 0) return;
        state.burn = Math.max(0, state.burn - 20);
        if (!state.input) return;
        const cooked = Object.keys(smeltingRecipes).find(name => smeltingRecipes[name] === state.input.name);
        if (!cooked || state.output && state.output.name !== cooked) return;
        state.progress += 20;
        if (state.progress >= 200) {
            state.output = { name: cooked, count: (state.output?.count || 0) + 1 };
            if (--state.input.count === 0) state.input = null;
            state.progress = 0;
        }
    }, 1);
    t.after(() => { clearInterval(timer); for (const receiptTimer of timers) clearTimeout(receiptTimer); });
    const api = {
        blockAt: p => state.loaded ? { name: 'furnace', position: new Vec3(p.x, p.y, p.z) } : null,
        move: async () => true,
        place: async () => assert.fail('This fixture must reuse its owned furnace'),
        log: () => {},
        open: async () => {
            visible = { ...stock }; state.opens++;
            const window = new EventEmitter(); window.inventoryStart = 3; window.inventoryEnd = 39;
            Object.defineProperties(window, {
                slots: { get: () => {
                    const current = { ...stock };
                    if (!state.delayWindowReceipt) for (const [name, count] of Object.entries(state.pending))
                        current[name] = (current[name] || 0) + count;
                    return [state.input, state.fuel, state.output, ...items(current)];
                } },
                fuelSeconds: { get: () => state.burn / 20 }, progress: { get: () => state.progress / 200 }
            });
            window.inputItem = () => state.input; window.fuelItem = () => state.fuel; window.outputItem = () => state.output;
            window.putInput = async (id, _meta, count) => {
                const name = data.items[id].name; assert(stock[name] >= count);
                stock[name] -= count; state.inputs += count;
                state.input = { name, count: (state.input?.count || 0) + count };
                state.onInput?.();
            };
            window.putFuel = async (id, _meta, count) => {
                const name = data.items[id].name; assert(stock[name] >= count);
                stock[name] -= count; state.fuelAdded += count;
                state.fuel = { name, count: (state.fuel?.count || 0) + count };
            };
            window.takeInput = async () => {
                stock[state.input.name] = (stock[state.input.name] || 0) + state.input.count;
                state.input = null; state.progress = 0;
            };
            window.takeOutput = async () => {
                if (state.output && !state.lie) {
                    const target = state.receiptDelayMs ? state.pending : stock;
                    target[state.output.name] = (target[state.output.name] || 0) + state.output.count;
                }
                state.output = null; state.onOutput?.();
            };
            const listener = () => {};
            bot.on('craft_progress_bar', listener);
            window.once('close', () => bot.removeListener('craft_progress_bar', listener));
            window.close = async () => {
                state.closes++; bot.currentWindow = null; window.emit('close');
                const receipt = state.pending; state.pending = {};
                if (Object.keys(receipt).length) timers.push(setTimeout(() => {
                    for (const [name, count] of Object.entries(receipt)) stock[name] = (stock[name] || 0) + count;
                }, state.receiptDelayMs));
            };
            bot.currentWindow = window; return window;
        }
    };
    const manager = new ManagedFurnace(bot, api, { settleMs: 0, pollMs: 1, waitMs: 500, verifyMs: 20 });
    manager.record = { position: { x: 1, y: 64, z: 0 }, dimension: 'overworld', pendingPlacement: false };
    return { bot, stock, state, manager, api, data };
}
function managedAgent(f) {
    const events = [], agent = { bot: f.bot, history: { add: async () => {}, save: async () => {} },
        self_prompter: { stop: async () => {} }, openChat: () => {},
        requestInterrupt: () => { f.bot.interrupt_code = true; },
        clearBotLogs: () => { f.bot.interrupt_code = false; f.bot.output = ''; },
        cleanKill: message => assert.fail(message), isIdle: () => !agent.actions.executing,
        onManagedGoalCompleted: async event => events.push(event) };
    agent.actions = new ActionManager(agent);
    installMainSupervisor(agent, { pollMs: 1 });
    const api = { hasTable: () => true, recipes: recipesFor(f.data),
        hasFurnace: () => f.manager.available(), furnaceSnapshot: () => f.manager.snapshot,
        inspectFurnace: () => f.manager.inspect(), smelt: (_bot, step) => f.manager.smelt(step),
        collect: () => assert.fail('All raw food and fuel are carried'), verifyTimeoutMs: 100 };
    return { agent, api, events };
}

for (const version of ['1.21.4', '26.3']) {
    test(`native ${version} managed bread crafting verifies held wheat consumption and the total bread target`, async t => {
        const f = furnaceFixture(t, version, { wheat: 6, bread: 1 }), m = managedAgent(f);
        let batches = 0;
        m.api.craft = async (_bot, item, count) => {
            assert.equal(item, 'bread'); assert.equal(count, 1);
            const [ingredients, output] = m.api.recipes(item)[0];
            for (const [name, needed] of Object.entries(ingredients)) {
                assert(f.stock[name] >= needed); f.stock[name] -= needed;
            }
            f.stock.bread += output.craftedCount; batches++;
        };
        await startMakeGoal(m.agent, 'bread', 3, m.api);
        assert.match(await m.agent.gather_goal.done, /Crafting complete/);
        assert.equal(f.stock.bread, 3); assert.equal(f.stock.wheat, 0); assert.equal(batches, 2);
        assert.equal(m.events.length, 1); assert.equal(f.state.opens, 0);
        assert.equal(m.agent.main_supervisor.view().goal.status, 'complete');
        assert.equal(m.agent.main_supervisor.view().owner, null);
    });

    for (const [cooked, raw] of Object.entries(foodCookingRecipes))
        test(`native ${version} managed furnace verifies ${raw} consumption and ${cooked} inventory gain`, async t => {
            const f = furnaceFixture(t, version, { [raw]: 2, coal: 1, diamond: 3 });
            for (let action = 0; action < 4 && (f.stock[cooked] || 0) < 2; action++)
                assert(await f.manager.smelt({ item: cooked, count: 2 - (f.stock[cooked] || 0) }));
            assert.equal(f.stock[cooked], 2); assert.equal(f.stock[raw], 0);
            assert.equal(f.state.inputs, 2); assert.equal(f.state.fuelAdded, 1);
            assert.equal(f.stock.diamond, 3);
            assert.equal(f.state.opens, f.state.closes);
            assert.equal(f.bot.listenerCount('craft_progress_bar'), 0);
            assert.equal(f.bot.smeltingActivity, undefined);
        });

    test(`native ${version} hungry production is blocked without compatible fuel and retains queued food`, async t => {
        const f = furnaceFixture(t, version, { beef: 1 });
        await assert.rejects(() => f.manager.smelt({ item: 'cooked_beef', count: 1 }), /Insufficient compatible furnace fuel/);
        assert.deepEqual(f.state.input, { name: 'beef', count: 1 });
        assert.equal(f.stock.cooked_beef || 0, 0);
        assert.equal(f.state.fuelAdded, 0);
        assert.equal(f.bot.currentWindow, null);
    });

    test(`native ${version} wrong recipes and unloaded furnaces preserve unrelated contents and fuel`, async t => {
        const f = furnaceFixture(t, version, { beef: 1, coal: 1 }); f.state.run = false;
        f.state.input = { name: 'raw_iron', count: 3 };
        f.state.output = { name: 'iron_ingot', count: 2 }; f.state.fuel = { name: 'charcoal', count: 4 };
        const original = structuredClone({ input: f.state.input, output: f.state.output, fuel: f.state.fuel });
        await assert.rejects(() => f.manager.smelt({ item: 'cooked_beef', count: 1 }), /another recipe/);
        assert.deepEqual({ input: f.state.input, output: f.state.output, fuel: f.state.fuel }, original);
        assert.deepEqual(f.stock, { beef: 1, coal: 1 }); assert.equal(f.state.fuelAdded, 0);
        f.state.loaded = false;
        await assert.rejects(() => f.manager.smelt({ item: 'cooked_beef', count: 1 }), /missing or its chunk is not loaded/);
        assert.equal(f.state.opens, 1);
        assert.deepEqual({ input: f.state.input, output: f.state.output, fuel: f.state.fuel }, original);
    });

    test(`native ${version} interruption retains queued raw food and resumes without duplicate ingredients`, async t => {
        const f = furnaceFixture(t, version, { chicken: 3, coal: 1 }); f.state.run = false;
        f.state.onInput = () => { f.bot.interrupt_code = true; };
        assert.equal(await f.manager.smelt({ item: 'cooked_chicken', count: 3 }), false);
        assert.deepEqual(f.state.input, { name: 'chicken', count: 3 });
        assert.equal(f.state.inputs, 3);
        f.state.onInput = null; f.bot.interrupt_code = false; f.state.run = true;
        for (let action = 0; action < 4 && (f.stock.cooked_chicken || 0) < 3; action++)
            assert(await f.manager.smelt({ item: 'cooked_chicken', count: 3 - (f.stock.cooked_chicken || 0) }));
        assert.equal(f.stock.cooked_chicken, 3);
        assert.equal(f.state.inputs, 3); assert.equal(f.state.fuelAdded, 1);
    });

    test(`native ${version} successful output calls cannot substitute for observed cooked inventory`, async t => {
        const f = furnaceFixture(t, version, { beef: 1, coal: 1 });
        f.state.output = { name: 'cooked_beef', count: 1 }; f.state.lie = true;
        assert.equal(await f.manager.smelt({ item: 'cooked_beef', count: 1 }), false);
        assert.equal(f.stock.cooked_beef || 0, 0);
        assert.equal(f.stock.beef, 1); assert.equal(f.stock.coal, 1);
    });
}

test('a delayed cooked inventory receipt completes only after the managed controller observes it', async t => {
    const f = furnaceFixture(t, '26.3', { beef: 1, coal: 1 }), taken = deferred();
    const m = managedAgent(f); f.state.receiptDelayMs = 25; f.state.onOutput = () => taken.resolve();
    await startMakeGoal(m.agent, 'cooked_beef', 1, m.api);
    const goal = m.agent.gather_goal; goal.resumeDelayMs = 0;
    await taken.promise;
    assert.equal(f.stock.cooked_beef || 0, 0); assert.equal(m.events.length, 0);
    assert.match(await goal.done, /Crafting complete/);
    assert.equal(f.stock.cooked_beef, 1); assert.equal(m.events.length, 1);
    assert.equal(m.agent.main_supervisor.view().goal.status, 'complete');
    assert.equal(m.agent.main_supervisor.view().owner, null);
});

test('a delayed existing output receipt cannot load another raw batch while its inventory update is pending', async t => {
    const f = furnaceFixture(t, '26.3', { beef: 1, coal: 1 });
    f.state.output = { name: 'cooked_beef', count: 1 };
    f.state.receiptDelayMs = 25; f.state.delayWindowReceipt = true;
    assert.equal(await f.manager.smelt({ item: 'cooked_beef', count: 1 }), false);
    assert.equal(f.stock.cooked_beef || 0, 0);
    assert.equal(f.stock.beef, 1); assert.equal(f.stock.coal, 1);
    assert.equal(f.state.inputs, 0); assert.equal(f.state.fuelAdded, 0);
    await until(() => f.stock.cooked_beef === 1);
    assert.equal(f.state.inputs, 0);
});

test('cancellation during a delayed cooked receipt never reports goal completion after the item arrives', async t => {
    const f = furnaceFixture(t, '26.3', { beef: 1, coal: 1 }), taken = deferred();
    const m = managedAgent(f); f.state.receiptDelayMs = 25; f.state.onOutput = () => taken.resolve();
    await startMakeGoal(m.agent, 'cooked_beef', 1, m.api);
    const goal = m.agent.gather_goal;
    await taken.promise;
    await cancelGatherGoal(m.agent);
    assert.match(await goal.done, /cancelled/);
    await until(() => f.stock.cooked_beef === 1, 'The delayed server receipt never arrived');
    assert.equal(m.events.length, 0);
    assert.equal(m.agent.main_supervisor.view().goal.status, 'cancelled');
    assert.equal(m.agent.main_supervisor.view().owner, null);
});

test('a cooked-food action queued behind a slow stop cannot load the furnace after cancellation', async t => {
    const f = furnaceFixture(t, '26.3', { beef: 1, coal: 1 }), m = managedAgent(f), gate = deferred();
    const old = m.agent.actions.runAction('action:followPlayer', () => gate.promise, { timeout: 0 });
    await until(() => m.agent.actions.executing);
    const goal = { kind: 'make', item: 'cooked_beef', target: 1, active: true, cancelled: false };
    m.agent.gather_goal = goal; m.agent.main_supervisor.beginGoal(goal);
    const queued = m.agent.actions.runAction('action:makeGoal', () => f.manager.smelt({ item: 'cooked_beef', count: 1 }),
        { goal, timeout: 0 });
    await until(() => f.bot.interrupt_code);
    const cancellation = cancelGatherGoal(m.agent); gate.resolve();
    await old; const result = await queued; await cancellation;
    assert.equal(result.deferred, true);
    assert.equal(f.state.opens, 0); assert.equal(f.state.inputs, 0);
    assert.deepEqual(f.stock, { beef: 1, coal: 1 });
    assert.equal(m.agent.main_supervisor.view().owner, null);
});
