import test from 'node:test';
import assert from 'node:assert/strict';
import Vec3 from 'vec3';
import { MinecraftFoodAdapter, createFoodAPI } from '../src/adapters/minecraft/food.js';
import { shelterWorld } from './helpers/shelter-world.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
    const end = Date.now() + 1500;
    while (!check()) { assert(Date.now() < end, 'Condition did not settle'); await sleep(1); }
}
const cropSpec = { carrots: ['carrot', 'carrot'], potatoes: ['potato', 'potato'],
    wheat: ['wheat', 'wheat_seeds'], beetroots: ['beetroot', 'beetroot_seeds'] };

function fixture(version = '26.3', stock = {}) {
    const f = shelterWorld(version, stock), checkpoints = [], pickupNames = [];
    f.bot.health = 20; f.bot.food = 18;
    f.agent.local_memory = { world: 'food-world-test', checkpoint: goal => checkpoints.push(JSON.parse(JSON.stringify(goal))) };
    f.bot.localMemory = f.agent.local_memory;
    f.bot.inventory.emptySlotCount = () => 30;
    f.bot.findBlocks = ({ matching, maxDistance, count }) => [...f.blocks.values()]
        .filter(b => b && matching.includes(b.type) && b.position.distanceTo(f.bot.entity.position) <= maxDistance)
        .slice(0, count).map(b => b.position.clone());
    const drops = {};
    f.bot.dig = async block => {
        f.calls.push(['dig', block.name, block.position.clone()]);
        f.set(block.position, 'air');
        const [item, seed] = cropSpec[block.name] || [];
        if (item) { drops[item] = (drops[item] || 0) + 3; if (seed !== item) drops[seed] = (drops[seed] || 0) + 2; }
        await f.afterDig?.(block);
    };
    f.bot.placeBlock = async (support, face) => {
        const at = support.position.plus(face), held = f.bot.heldItem;
        const block = Object.keys(cropSpec).find(name => cropSpec[name][1] === held.name);
        assert.equal(support.name, 'farmland'); assert.equal(f.bot.blockAt(at).name, 'air');
        assert(f.stock[held.name] > 0); assert(block);
        f.calls.push(['plant', held.name, at.clone()]);
        if (!f.omitPlantWorld) f.set(at, block, { age: 0 });
        if (!f.omitPlantReceipt) f.stock[held.name]--;
        await f.afterPlant?.();
    };
    const skills = {
        pickup: async (_bot, name) => {
            pickupNames.push(name);
            if (!f.omitPickup && drops[name]) { f.stock[name] = (f.stock[name] || 0) + drops[name]; drops[name] = 0; }
        }
    };
    const adapter = new MinecraftFoodAdapter(f.agent, skills, { verifyMs: 5, pollMs: 1, huntMs: 30, routeMs: 800, actionMs: 2500 });
    const goal = { memoryId: 'fixture-food', active: true };
    const crop = (name = 'carrots', at = new Vec3(5, 64, 2), age = adapter.maxAge(name)) => {
        f.set(at.offset(0, -1, 0), 'farmland'); f.set(at, name, { age }); return at;
    };
    const animal = (name = 'cow', id = 51, at = new Vec3(6.5, 64, 2.5)) => {
        const metadata = [], keys = f.data.entitiesByName[name].metadataKeys;
        metadata[keys.indexOf('baby')] = false; metadata[keys.indexOf('custom_name')] = null;
        const entity = { id, name, metadata, position: at, isValid: true, width: 0.9, height: 1.4 };
        f.bot.entities[id] = entity;
        return entity;
    };
    f.bot.pvp = { attack: async entity => {
        f.calls.push(['attack', entity.id]); f.bot.emit('entityDead', entity);
        delete f.bot.entities[entity.id]; f.stock.beef = (f.stock.beef || 0) + 2;
    }, stop: async () => { f.calls.push(['combatStop']); } };
    return Object.assign(f, { adapter, goal, crop, animal, checkpoints, pickupNames, drops, skills });
}

for (const version of ['1.21.4', '26.3']) test(`native ${version} registry crop ages select only mature supported loaded sources`, async () => {
    const f = fixture(version);
    const mature = f.crop('carrots', new Vec3(5, 64, 2));
    f.crop('wheat', new Vec3(7, 64, 2), 6);
    f.crop('beetroots', new Vec3(9, 64, 2), 2);
    f.crop('potatoes', new Vec3(11, 64, 2)); f.set(new Vec3(11, 63, 2), null);
    const result = await f.adapter.discover(() => true);
    assert.equal(result.crops.length, 1); assert.equal(result.crops[0].item, 'carrot');
    assert.deepEqual(result.crops[0].position, { x: mature.x, y: mature.y, z: mature.z });
    assert.equal(f.adapter.maxAge('beetroots'), 3); assert.equal(f.adapter.maxAge('wheat'), 7);
    assert.equal(f.calls.filter(c => c[0] === 'move').length, 0, 'Discovery does not acquire physical ownership');
});

for (const version of ['1.21.4', '26.3']) for (const crop of Object.keys(cropSpec))
    test(`native ${version} ${crop} harvest/replant has crop, pickup and planting receipts`, async () => {
        const f = fixture(version), at = f.crop(crop), source = (await f.adapter.discover(() => true)).crops[0];
        const result = await f.adapter.harvest(source, () => true, f.goal);
        assert.equal(result.verified, true, result.reason);
        assert(f.checkpoints.some(checkpoint => checkpoint.replantPending?.block === crop));
        assert.equal(f.bot.blockAt(at).name, 'air'); assert(f.adapter.count(source.item) > 0);
        assert(f.pickupNames.every(name => [source.item, source.seed].includes(name)), 'Only expected food/seeds are requested');
        const before = f.adapter.count(source.seed);
        const replanted = await f.adapter.replant({ ...f.goal.replantPending, type: 'replant', item: source.seed }, () => true);
        assert.equal(replanted.verified, true, replanted.reason);
        assert.equal(f.bot.blockAt(at).name, crop); assert.equal(Number(f.bot.blockAt(at).getProperties().age), 0);
        assert.equal(f.adapter.count(source.seed), before - 1);
        assert.equal(f.calls.filter(c => c[0] === 'dig').length, 1);
        assert.equal(f.calls.filter(c => c[0] === 'plant').length, 1);
    });

test('unknown remembered farm blocks are hints and never mature-food observations', async () => {
    const f = fixture();
    f.agent.local_memory.safe = fn => fn();
    f.agent.local_memory.store = { locations: () => [{ position: { x: 5, y: 64, z: 2 }, metadata: { block: 'carrots' } }] };
    f.set(new Vec3(5, 64, 2), null);
    assert.deepEqual((await f.adapter.discover(() => true)).crops, []);
});

test('unripe or unloaded crops after discovery and failed supported routes never get dug', async () => {
    for (const change of ['unripe', 'unloaded', 'route']) {
        const f = fixture(), at = f.crop(), source = (await f.adapter.discover(() => true)).crops[0];
        if (change === 'unripe') f.set(at, 'carrots', { age: 0 });
        if (change === 'unloaded') f.set(at, null);
        if (change === 'route') f.bot.pathfinder.getPathFromTo = function* () { yield { result: { status: 'noPath' } }; };
        assert.equal((await f.adapter.harvest(source, () => true, f.goal)).verified, false, change);
        assert.equal(f.calls.filter(c => c[0] === 'dig').length, 0, change);
        assert.equal(f.goal.replantPending, undefined, change);
    }
});

test('crop maturity is rechecked after a proved route and full inventory blocks harvest before destruction', async () => {
    for (const change of ['maturity', 'inventory']) {
        const f = fixture(), at = f.crop('wheat'), source = (await f.adapter.discover(() => true)).crops[0];
        if (change === 'inventory') f.bot.inventory.emptySlotCount = () => 0;
        else {
            const goto = f.bot.pathfinder.goto;
            f.bot.pathfinder.goto = async function (goal) { await goto.call(this, goal); f.set(at, 'wheat', { age: 1 }); };
        }
        assert.equal((await f.adapter.harvest(source, () => true, f.goal)).verified, false, change);
        assert.equal(f.calls.filter(c => c[0] === 'dig').length, 0);
        assert.equal(f.goal.replantPending, undefined);
    }
});

test('harvest cannot claim food from a dig callback or world change without actual pickup', async () => {
    const f = fixture(), at = f.crop(), source = (await f.adapter.discover(() => true)).crops[0];
    f.omitPickup = true;
    assert.equal((await f.adapter.harvest(source, () => true, f.goal)).verified, false);
    assert.equal(f.bot.blockAt(at).name, 'air'); assert(f.goal.replantPending);
    assert.equal(f.adapter.count('carrot'), 0);
});

test('world-state verification is required even when an unrelated inventory event adds food', async () => {
    const f = fixture(), at = f.crop(), source = (await f.adapter.discover(() => true)).crops[0];
    f.bot.dig = async () => { f.stock.carrot = 3; };
    assert.equal((await f.adapter.harvest(source, () => true, f.goal)).verified, false);
    assert.equal(f.bot.blockAt(at).name, 'carrots'); assert(f.goal.replantPending);
});

test('durable replant intent precedes dig and cancellation before dig preserves the existing crop', async () => {
    const f = fixture(), at = f.crop(), source = (await f.adapter.discover(() => true)).crops[0];
    let valid = true;
    f.goal.checkpoint = async () => { assert(f.goal.replantPending); valid = false; };
    const result = await f.adapter.harvest(source, () => valid, f.goal);
    assert.equal(result.verified, false); assert(f.goal.replantPending);
    assert.equal(f.calls.filter(c => c[0] === 'dig').length, 0);
    f.bot.interrupt_code = false;
    assert.equal((await f.adapter.replant(f.goal.replantPending, () => true)).verified, true);
    assert.equal(f.bot.blockAt(at).name, 'carrots'); assert.equal(f.calls.filter(c => c[0] === 'plant').length, 0);
});

test('interrupted dig keeps a serializable planting obligation that a new adapter can finish', async () => {
    const f = fixture(), at = f.crop(), source = (await f.adapter.discover(() => true)).crops[0];
    let valid = true;
    f.afterDig = () => { valid = false; f.stock.carrot = 3; };
    assert.equal((await f.adapter.harvest(source, () => valid, f.goal)).verified, false);
    const saved = JSON.parse(JSON.stringify(f.goal.replantPending));
    f.bot.interrupt_code = false;
    const restored = new MinecraftFoodAdapter(f.agent, f.skills, { verifyMs: 5, pollMs: 1 });
    assert.equal((await restored.replant(saved, () => true)).verified, true);
    assert.equal(f.bot.blockAt(at).name, 'carrots');
});

test('replanting rejects blocked/unloaded farmland, missing seed and incomplete placement receipts', async () => {
    for (const change of ['blocked', 'unloaded', 'seed', 'world', 'receipt']) {
        const f = fixture(), at = f.crop(), source = (await f.adapter.discover(() => true)).crops[0];
        assert.equal((await f.adapter.harvest(source, () => true, f.goal)).verified, true);
        if (change === 'blocked') f.set(at, 'stone');
        if (change === 'unloaded') f.set(at.offset(0, -1, 0), null);
        if (change === 'seed') f.stock.carrot = 0;
        if (change === 'world') f.omitPlantWorld = true;
        if (change === 'receipt') f.omitPlantReceipt = true;
        assert.equal((await f.adapter.replant(f.goal.replantPending, () => true)).verified, false, change);
    }
});

test('scope changes and cancellation during equip prevent planting', async () => {
    for (const change of ['dimension', 'world', 'cancel']) {
        const f = fixture(), at = f.crop(), source = (await f.adapter.discover(() => true)).crops[0];
        assert.equal((await f.adapter.harvest(source, () => true, f.goal)).verified, true);
        let valid = true;
        const equip = f.bot.equip;
        f.bot.equip = async item => {
            await equip(item);
            if (change === 'dimension') f.bot.game.dimension = 'the_nether';
            if (change === 'world') f.agent.local_memory.world = 'another-world';
            if (change === 'cancel') valid = false;
        };
        assert.equal((await f.adapter.replant(f.goal.replantPending, () => valid)).verified, false, change);
        assert.equal(f.bot.blockAt(at).name, 'air'); assert.equal(f.calls.filter(c => c[0] === 'plant').length, 0);
    }
});

for (const version of ['1.21.4', '26.3']) test(`native ${version} animal discovery excludes babies, names, tamed animals, water and unknown age`, async () => {
    const f = fixture(version);
    const adult = f.animal('cow', 1), baby = f.animal('pig', 2, new Vec3(7, 64, 3));
    baby.metadata[f.data.entitiesByName.pig.metadataKeys.indexOf('baby')] = true;
    const named = f.animal('sheep', 3, new Vec3(8, 64, 3)); named.metadata[2] = 'Player pet';
    f.animal('chicken', 4, new Vec3(9, 64, 3)).isTamed = true;
    const water = f.animal('rabbit', 5, new Vec3(10, 64, 3)); f.set(water.position, 'water');
    const unknown = f.animal('cow', 6, new Vec3(11, 64, 3)); unknown.metadata = [];
    const result = await f.adapter.discover(() => true);
    assert.deepEqual(result.animals.map(a => a.entityId), [adult.id]);
});

for (const version of ['1.21.4', '26.3']) for (const [name, food] of Object.entries({ cow: 'beef', pig: 'porkchop', sheep: 'mutton', chicken: 'chicken', rabbit: 'rabbit' }))
test(`native ${version} bounded ${name} hunt verifies exact death and expected food pickup`, async () => {
    const f = fixture(version, { wooden_sword: 1 }); f.animal(name);
    f.bot.pvp.attack = async entity => {
        f.calls.push(['attack', entity.id]); f.bot.emit('entityDead', entity);
        delete f.bot.entities[entity.id]; f.stock[food] = 2;
    };
    const source = (await f.adapter.discover(() => true)).animals[0];
    const result = await f.adapter.hunt(source, () => true);
    assert.equal(result.verified, true, result.reason); assert.equal(f.stock[food], 2);
    assert.equal(f.calls.filter(c => c[0] === 'attack').length, 1);
    assert.equal(f.calls.filter(c => c[0] === 'combatStop').length, 1);
    assert(f.policies.every(p => !p.canDig && p.scafoldingBlocks.length === 0));
    assert.equal(f.bot.listenerCount('entityDead'), 0);
});

test('despawn, death without food, unsafe pursuit and missing weapon never claim successful hunt', async () => {
    for (const change of ['despawn', 'food', 'water', 'weapon']) {
        const f = fixture('26.3', change === 'weapon' ? {} : { wooden_sword: 1 }), animal = f.animal();
        const source = (await f.adapter.discover(() => true)).animals[0];
        f.bot.pvp.attack = async entity => {
            if (change === 'despawn') { delete f.bot.entities[entity.id]; f.stock.beef = 3; }
            if (change === 'food') { f.bot.emit('entityDead', entity); delete f.bot.entities[entity.id]; }
            if (change === 'water') f.set(animal.position, 'water');
        };
        assert.equal((await f.adapter.hunt(source, () => true)).verified, false, change);
        assert.equal(f.bot.listenerCount('entityDead'), 0);
    }
});

test('the PVP plugin receives a land-only non-destructive policy and its original policy is restored', async () => {
    const f = fixture('26.3', { wooden_sword: 1 }); f.animal();
    const source = (await f.adapter.discover(() => true)).animals[0], original = { userPolicy: true };
    f.bot.pvp.movements = original;
    f.bot.pvp.attack = async entity => {
        const policy = f.bot.pvp.movements;
        assert.notEqual(policy, original); assert.equal(policy.canDig, false);
        assert.equal(policy.scafoldingBlocks.length, 0); assert(policy.blocksToAvoid.has(f.data.blocksByName.water.id));
        // Match PVP.attack's real replacement of the pathfinder policy.
        f.bot.pathfinder.setMovements(policy);
        f.bot.emit('entityDead', entity); delete f.bot.entities[entity.id]; f.stock.beef = 2;
    };
    assert.equal((await f.adapter.hunt(source, () => true)).verified, true);
    assert.equal(f.bot.pvp.movements, original);
});

test('combat cancellation and timeout await stop instead of releasing the body over a pending stop promise', async t => {
    for (const change of ['cancel', 'timeout']) {
        const f = fixture('26.3', { wooden_sword: 1 }); f.animal();
        const source = (await f.adapter.discover(() => true)).animals[0];
        let valid = true, attack = false, stopping = false, release, returned = false;
        f.bot.pvp.attack = async () => { attack = true; if (change === 'cancel') valid = false; };
        f.bot.pvp.stop = () => { stopping = true; return new Promise(resolve => { release = resolve; }); };
        t.after(() => release?.());
        const hunting = f.adapter.hunt(source, () => valid).then(value => { returned = true; return value; });
        await until(() => attack && stopping);
        assert.equal(returned, false); release();
        assert.equal((await hunting).verified, false, change);
        assert.equal(f.bot.listenerCount('entityDead'), 0);
    }
});

test('an animal becoming named during approach/equip is never attacked', async () => {
    const f = fixture('26.3', { wooden_sword: 1 }), animal = f.animal();
    const source = (await f.adapter.discover(() => true)).animals[0];
    f.bot.equip = async () => { animal.metadata[2] = 'New name'; };
    assert.equal((await f.adapter.hunt(source, () => true)).verified, false);
    assert.equal(f.calls.filter(c => c[0] === 'attack').length, 0);
});

test('successful replant remembers a scoped farm hint and failed planting does not record a new patch', async () => {
    for (const receipt of [true, false]) {
        const f = fixture(), at = f.crop(), source = (await f.adapter.discover(() => true)).crops[0], saved = [];
        f.agent.local_memory.safe = fn => fn();
        f.agent.local_memory.store = { putLocation: (...args) => saved.push(args) };
        assert.equal((await f.adapter.harvest(source, () => true, f.goal)).verified, true);
        f.omitPlantReceipt = !receipt;
        assert.equal((await f.adapter.replant(f.goal.replantPending, () => true)).verified, receipt);
        assert.equal(saved.length, receipt ? 1 : 0);
        if (receipt) {
            assert.deepEqual(saved[0].slice(0, 2), ['food-world-test', 'overworld']);
            assert.equal(saved[0][3], 'food_patch'); assert.deepEqual(saved[0][4], { x: at.x, y: at.y, z: at.z });
        }
    }
});

test('danger invalidation interrupts a pending owned route and waits for its promise to settle', async t => {
    const f = fixture(), source = { kind: 'hunt', name: 'cow', item: 'beef', entityId: 51,
        position: { x: 6, y: 64, z: 2 }, scope: f.adapter.scope() };
    f.animal();
    let valid = true, moving = false, release, returned = false;
    f.bot.pathfinder.goto = () => { moving = true; return new Promise(resolve => { release = resolve; }); };
    t.after(() => release?.());
    const hunting = f.adapter.hunt(source, () => valid).then(result => { returned = true; return result; });
    await until(() => moving); valid = false;
    await until(() => f.bot.interrupt_code);
    assert.equal(returned, false); release();
    assert.equal((await hunting).verified, false);
    assert.equal(f.calls.filter(c => c[0] === 'attack').length, 0);
});

test('search charges its persisted bounded attempt before movement and a restored exhausted budget does not roam', async () => {
    const f = fixture(); let observed = 0;
    f.goal.checkpoint = () => { observed++; assert(f.goal.foodSearch.attempts > 0); };
    const result = await f.adapter.search(() => true, f.goal);
    assert.equal(result.progressed, true, result.reason); assert(observed > 0);
    const restored = JSON.parse(JSON.stringify(f.goal.foodSearch)); restored.attempts = 6;
    const count = f.calls.filter(c => c[0] === 'move').length;
    assert.equal((await f.adapter.search(() => true, { foodSearch: restored })).progressed, false);
    assert.equal(f.calls.filter(c => c[0] === 'move').length, count);
    restored.attempts = 1; restored.world = 'another-world';
    assert.equal((await f.adapter.search(() => true, { foodSearch: restored })).progressed, false);
});

test('factory returns bound operations usable by the managed food controller', async () => {
    const f = fixture(), api = createFoodAPI(f.agent, f.skills), { discover } = api;
    assert.deepEqual(Object.keys(api), ['discover', 'harvest', 'replant', 'hunt', 'search']);
    assert.deepEqual(await discover(() => true), { crops: [], animals: [] });
});
