import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import Vec3 from 'vec3';
import minecraftData from 'minecraft-data';
import prismarineBlock from 'prismarine-block';
import prismarineWorld from 'prismarine-world';
import { craftItemCount, waitForCraftOutput, craftingReceipt } from '../src/agent/crafting_result.js';

const originalMc = await import('../src/utils/mcdata.js');
mock.module(new URL('../src/utils/mcdata.js', import.meta.url).href, { namedExports: {
    ...originalMc,
    getItemId: () => 1,
    getItemCraftingRecipes: name => name === 'stick'
        ? [[{ oak_planks: 2 }, { craftedCount: 4 }]] : name === 'furnace'
        ? [[{ cobblestone: 8 }, { craftedCount: 1 }]] : null,
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

test('actual crafting uses a visible nearby table before attempting to recover a distant owned table', async () => {
    const f = fixture({ cobblestone: 8 });
    const data = minecraftData('1.21.4'), Block = prismarineBlock('1.21.4'), World = prismarineWorld('1.21.4');
    const hidden = new Vec3(0, 64, 2), usable = new Vec3(2, 64, 0);
    const owned = { position: new Vec3(100, 64, 0), dimension: 'overworld' };
    f.bot.entity = { position: new Vec3(0.5, 64, 0.5) };
    f.bot.blockAt = p => {
        const at = p.floored();
        const name = at.equals(hidden) || at.equals(usable) ? 'crafting_table' :
            at.x === 0 && at.z === 1 && [64, 65].includes(at.y) || at.y < 64 ? 'stone' : 'air';
        const block = Block.fromStateId(data.blocksByName[name].minStateId, 0);
        block.position = at; return block;
    };
    f.bot.world = new World().sync; f.bot.world.getBlock = f.bot.blockAt;
    f.bot.findBlocks = () => [hidden, usable];
    f.bot.craftingStation = { record: owned,
        forCraft: async () => assert.fail('Do not attempt the unreachable owned table first'),
        beforeTravel: async () => assert.fail('Using a nearby table needs no departure or pickup') };
    const recipe = { result: { id: 1, count: 1 }, ingredientCounts: { cobblestone: 8 } };
    f.bot.recipesFor = (_id, _meta, _count, table) => table ? [recipe] : [];
    f.bot.craft = async (_recipe, count, table) => {
        assert.equal(count, 1); assert(table.position.equals(usable));
        f.stock.cobblestone -= 8; f.stock.furnace = 1;
    };
    assert.equal(await craftRecipe(f.bot, 'furnace', 1), true);
    assert.equal(f.stock.furnace, 1);
    assert.equal(f.bot.craftingStation.record, owned, 'Borrowing never transfers ownership or forgets the old station');
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
