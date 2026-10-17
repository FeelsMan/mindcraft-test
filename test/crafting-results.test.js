import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { craftItemCount, waitForCraftOutput, craftingReceipt } from '../src/agent/crafting_result.js';

const originalMc = await import('../src/utils/mcdata.js');
mock.module(new URL('../src/utils/mcdata.js', import.meta.url).href, { namedExports: {
    ...originalMc,
    getItemId: () => 1,
    getItemCraftingRecipes: name => name === 'stick'
        ? [[{ oak_planks: 2 }, { craftedCount: 4 }]] : null,
    ingredientsFromPrismarineRecipe: recipe => recipe.ingredientCounts
} });
const originalWorld = await import('../src/agent/library/world.js');
mock.module(new URL('../src/agent/library/world.js', import.meta.url).href, { namedExports: {
    ...originalWorld, getInventoryCounts: bot => ({ ...bot.stock })
} });
const { craftRecipe } = await import('../src/agent/library/skills.js');

function fixture(stock = { oak_planks: 3 }) {
    const calls = [];
    const recipe = { result: { id: 1, count: 4 }, ingredientCounts: { oak_planks: 2 } };
    const bot = {
        stock, output: '', interrupt_code: false,
        inventory: { items: () => Object.entries(stock).filter(([, count]) => count > 0)
            .map(([name, count]) => ({ name, count })) },
        craftingStation: {},
        recipesFor: () => [recipe],
        craft: async (_recipe, batches) => {
            calls.push(batches);
            stock.oak_planks -= batches * 2;
            stock.stick = (stock.stick || 0) + batches * 4;
        },
        armorManager: { equipAll() {} }
    };
    return { bot, stock, calls };
}

test('actual skill reports one executed batch as four sticks when ingredients limit a four-batch request', async () => {
    const f = fixture();
    assert.equal(await craftRecipe(f.bot, 'stick', 4), true);
    assert.deepEqual(f.calls, [1]);
    assert.equal(f.stock.stick, 4);
    assert.match(f.bot.output, /Recipe batches requested: 4; submitted to crafting: 1/);
    assert.match(f.bot.output, /Output per recipe batch: 4 stick item/);
    assert.match(f.bot.output, /Observed inventory gain: 4 stick item/);
    assert.match(f.bot.output, /Current carried inventory total: 4 stick/);
});

test('existing output is retained and reported separately from the new item gain', async () => {
    const f = fixture({ oak_planks: 4, stick: 4 });
    assert.equal(await craftRecipe(f.bot, 'stick', 2), true);
    assert.deepEqual(f.calls, [2]);
    assert.equal(f.stock.stick, 12);
    assert.match(f.bot.output, /Observed inventory gain: 8 stick/);
    assert.match(f.bot.output, /Current carried inventory total: 12 stick/);
});

test('API completion waits for the corresponding inventory update before claiming verified output', async () => {
    const f = fixture({ oak_planks: 2 });
    f.bot.craft = async () => {
        f.stock.oak_planks = 0;
        setTimeout(() => { f.stock.stick = 4; }, 20);
    };
    assert.equal(await craftRecipe(f.bot, 'stick', 1), true);
    assert.equal(f.stock.stick, 4);
    assert.match(f.bot.output, /Crafting output verified/);
});

test('an API return without any output is not successful crafting', async () => {
    const f = fixture({ oak_planks: 2 });
    f.bot.craft = async () => {};
    assert.equal(await craftRecipe(f.bot, 'stick', 1), false);
    assert.match(f.bot.output, /NOT fully verified/);
    assert.match(f.bot.output, /Observed inventory gain: 0 stick/);
    assert.match(f.bot.output, /Current carried inventory total: 0 stick/);
});

test('a failed multi-batch call preserves its exception while reporting partial inventory gain', async () => {
    const f = fixture({ oak_planks: 4 });
    const failure = Error('Second transaction rejected');
    f.bot.craft = async () => { f.stock.stick = 4; throw failure; };
    await assert.rejects(craftRecipe(f.bot, 'stick', 2), error => error === failure);
    assert.match(f.bot.output, /NOT fully verified/);
    assert.match(f.bot.output, /complete batch outputs observed: 1/);
    assert.match(f.bot.output, /Current carried inventory total: 4 stick/);
});

test('interruption during output verification returns false without claiming completion', async () => {
    const f = fixture({ oak_planks: 2 });
    f.bot.craft = async () => { f.bot.interrupt_code = true; };
    assert.equal(await craftRecipe(f.bot, 'stick', 1), false);
    assert.match(f.bot.output, /NOT fully verified/);
});

test('zero complete ingredient batches never call the craft API with zero', async () => {
    const f = fixture({ oak_planks: 1 });
    assert.equal(await craftRecipe(f.bot, 'stick', 1), false);
    assert.equal(f.calls.length, 0);
    assert.match(f.bot.output, /submitted to crafting: 0/);
});

test('unknown recipes and invalid batch counts return a clear failure', async () => {
    const f = fixture();
    assert.equal(await craftRecipe(f.bot, 'not_a_recipe', 1), false);
    assert.equal(await craftRecipe(f.bot, 'stick', 0), false);
    assert.equal(f.calls.length, 0);
});

test('unavailable counts and bounded verification timeouts never invent an item gain', async () => {
    assert.equal(craftItemCount({}, 'stick'), null);
    assert.deepEqual(await waitForCraftOutput({}, 'stick', 4, 1), { verified: false, count: null });
    const f = fixture({});
    assert.deepEqual(await waitForCraftOutput(f.bot, 'stick', 4, 1), { verified: false, count: 0 });
    assert.match(craftingReceipt({ item: 'stick', requested: 1, submitted: 1, outputPerBatch: 4,
        before: null, after: null, verified: false }), /Observed inventory gain: unavailable/);
});
