import test from 'node:test';
import assert from 'node:assert/strict';
import Vec3 from 'vec3';
import { protectCraftingMaterials, safeMiningMovements } from '../src/agent/navigation_policy.js';
import { stoneStandingPositions, findSafeStoneTargets, findSafeIronTargets, collectStoneFromSide, collectIronFromSide } from '../src/agent/safe_stone.js';

function navigationFixture() {
    const bot = { craftingGoal: { active: true, item: 'stone_pickaxe' },
        registry: { itemsByName: { dirt: { id: 1 }, cobblestone: { id: 2 }, oak_planks: { id: 3 } } },
        modes: { getActiveModes: () => [] } };
    const movements = () => ({ scafoldingBlocks: [1, 2, 3], allow1by1towers: true, canDig: true });
    return { bot, movements };
}

test('routine navigation and unstuck cannot spend reserved stone or planks on scaffolding', () => {
    const f = navigationFixture();
    for (const active of [[], ['unstuck']]) {
        f.bot.modes.getActiveModes = () => active;
        const moves = protectCraftingMaterials(f.bot, f.movements());
        assert.deepEqual(moves.scafoldingBlocks, [1]);
        assert.equal(moves.allow1by1towers, false);
    }
});

test('urgent safety and ordinary non-goal travel keep access to emergency building blocks', () => {
    const f = navigationFixture();
    for (const name of ['self_preservation', 'self_defense', 'cowardice']) {
        f.bot.modes.getActiveModes = () => [name];
        assert.deepEqual(protectCraftingMaterials(f.bot, f.movements()).scafoldingBlocks, [1, 2, 3]);
    }
    delete f.bot.craftingGoal;
    assert.deepEqual(protectCraftingMaterials(f.bot, f.movements()).scafoldingBlocks, [1, 2, 3]);
});

test('stone approaches cannot dig, pillar, bridge or drop more than one block', () => {
    const moves = safeMiningMovements(navigationFixture().movements());
    assert.equal(moves.canDig, false);
    assert.equal(moves.maxDropDown, 1);
    assert.equal(moves.allowParkour, false);
    assert.deepEqual(moves.scafoldingBlocks, []);
});

function stoneFixture() {
    const blocks = new Map();
    const makeBlock = (name, position) => ({ name, position, boundingBox: name === 'air' ? 'empty' : 'block', canHarvest: () => true });
    const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, heldItem: { type: 10 },
        blockAt: p => blocks.get(p.toString()) || makeBlock(p.y < 64 ? 'dirt' : 'air', p),
        tool: { equipForBlock: async () => {} } };
    const target = makeBlock('stone', new Vec3(2, 64, 0)); blocks.set(target.position.toString(), target);
    const digs = [], moves = [];
    bot.dig = async block => { digs.push(block.position); blocks.set(block.position.toString(), makeBlock('air', block.position)); };
    bot.pathfinder = {
        getPathTo: () => ({ status: 'success' }),
        setMovements: policy => moves.push(policy),
        goto: async goal => { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); }
    };
    const api = { movements: () => ({ scafoldingBlocks: [2], allow1by1towers: true }), canBreak: () => true };
    return { bot, blocks, target, digs, moves, makeBlock, api };
}

test('stone under the bot or underground with no standing space is not a mining target', () => {
    const f = stoneFixture();
    assert.deepEqual(stoneStandingPositions(f.bot, f.makeBlock('stone', new Vec3(0, 63, 0))), []);
    assert.deepEqual(stoneStandingPositions(f.bot, f.makeBlock('stone', new Vec3(2, 61, 0))), []);
    assert(stoneStandingPositions(f.bot, f.target).length > 0);
    f.blocks.set(f.target.position.offset(0, -1, 0).toString(), f.makeBlock('lava', f.target.position.offset(0, -1, 0)));
    assert.deepEqual(stoneStandingPositions(f.bot, f.target), []);
});

test('position-aware search filters exposure after palette matching', () => {
    const f = stoneFixture();
    f.bot.findBlocks = options => {
        assert(options.matching({ name: 'stone' }));
        assert(options.useExtraInfo(f.target));
        assert.equal(options.useExtraInfo(f.makeBlock('stone', new Vec3(0, 63, 0))), false);
        return [f.target.position];
    };
    assert.deepEqual(findSafeStoneTargets(f.bot, () => true), [f.target]);
});

test('floor iron beside the bot is found and mined from its existing safe position', async () => {
    const f = stoneFixture(), ore = f.makeBlock('iron_ore', new Vec3(1, 63, 0));
    f.blocks.set(ore.position.toString(), ore);
    f.bot.findBlocks = options => {
        assert(options.matching({ name: 'iron_ore' }));
        return options.useExtraInfo(ore) ? [ore.position] : [];
    };
    f.api.prepareTravel = async () => assert.fail('No return trip is needed before mining a block already in reach');
    f.bot.pathfinder.getPathTo = () => assert.fail('The bot already occupies a verified side position');
    const candidates = findSafeIronTargets(f.bot, () => true);
    assert.deepEqual(candidates, [ore]);
    assert.equal(await collectIronFromSide(f.bot, candidates, f.api), true);
    assert.deepEqual(f.digs, [ore.position]);
    assert(f.moves.every(policy => !policy.canDig && policy.scafoldingBlocks.length === 0));
    assert.equal(f.bot.blockAt(new Vec3(0, 63, 0)).name, 'dirt', 'Retain the bot\'s original support');
    assert.equal(f.bot.blockAt(new Vec3(1, 62, 0)).name, 'dirt', 'Retain the mined block\'s safe floor');
});

test('floor iron under the bot or over a hazardous drop is still rejected', () => {
    const f = stoneFixture();
    assert.deepEqual(stoneStandingPositions(f.bot, f.makeBlock('iron_ore', new Vec3(0, 63, 0))), []);
    const ore = f.makeBlock('iron_ore', new Vec3(1, 63, 0));
    f.blocks.set(new Vec3(1, 62, 0).toString(), f.makeBlock('lava', new Vec3(1, 62, 0)));
    assert.deepEqual(stoneStandingPositions(f.bot, ore), []);
});

test('stone mining navigates to a supported side and digs without spending building blocks', async () => {
    const f = stoneFixture();
    assert.equal(await collectStoneFromSide(f.bot, [f.target], f.api), true);
    assert.equal(f.digs.length, 1);
    // After digging from the side, pickup may step into the newly cleared
    // block because its floor remains intact and there is headroom.
    assert.equal(Math.floor(f.bot.entity.position.x), f.target.position.x);
    assert.equal(f.moves[0].canDig, false);
    assert.deepEqual(f.moves[0].scafoldingBlocks, []);
});

test('low-headroom stone pickup does not tunnel farther or remove its support', async () => {
    const f = stoneFixture();
    const ceiling = f.target.position.offset(0, 1, 0);
    f.blocks.set(ceiling.toString(), f.makeBlock('stone', ceiling));
    assert.equal(await collectStoneFromSide(f.bot, [f.target], f.api), true);
    assert.equal(f.digs.length, 1);
    assert.equal(f.bot.blockAt(ceiling).name, 'stone');
    assert.notEqual(Math.floor(f.bot.entity.position.x), f.target.position.x);
});

test('unreachable side positions and interrupted approaches do not dig a fallback hole', async () => {
    const f = stoneFixture();
    f.bot.pathfinder.getPathTo = () => ({ status: 'noPath' });
    assert.equal(await collectStoneFromSide(f.bot, [f.target], f.api), false);
    assert.equal(f.digs.length, 0);
    f.bot.pathfinder.getPathTo = () => ({ status: 'success' });
    f.api.prepareTravel = async () => { f.bot.interrupt_code = true; };
    assert.equal(await collectStoneFromSide(f.bot, [f.target], f.api), false);
    assert.equal(f.digs.length, 0);
});
