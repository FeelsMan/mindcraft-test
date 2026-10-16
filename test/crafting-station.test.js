import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CraftingStation } from '../src/agent/crafting_station.js';

function fixture() {
    const bot = new EventEmitter();
    const stock = {};
    const position = { x: 1, y: 64, z: 0 };
    let block = { name: 'crafting_table', position };
    bot.game = { dimension: 'overworld' };
    bot.entity = { position: { x: 0, y: 64, z: 0 } };
    bot.inventory = { items: () => Object.entries(stock).map(([name, count]) => ({ name, count })) };
    bot.modes = { getActiveModes: () => [] };
    const calls = [];
    const api = {
        blockAt: () => block,
        move: async p => { calls.push(['move', p]); bot.entity.position = { ...p }; return true; },
        break: async p => { calls.push(['break', p]); block = { name: 'air', position }; },
        pickup: async () => { calls.push(['pickup']); stock.crafting_table = (stock.crafting_table || 0) + 1; },
        canCarry: () => true
    };
    const station = new CraftingStation(bot, api, { verifyTimeoutMs: 5 });
    station.remember(block);
    return { bot, stock, api, station, calls, position, setBlock: value => { block = value; } };
}

test('nearby crafting leaves the owned table in place and later returns to the same coordinates', async () => {
    const f = fixture();
    await f.station.beforeTravel({ x: 20, y: 64, z: 0 });
    f.bot.entity.position.x = 20;
    assert.equal((await f.station.forCraft()).name, 'crafting_table');
    assert.deepEqual(f.calls, [['move', f.position]]);
    assert(f.station.available());
    assert.equal(f.stock.crafting_table, undefined);
});

test('a distant destination retrieves the exact owned table and verifies pickup before departure', async () => {
    const f = fixture();
    f.bot.entity.position.x = 20;
    await f.station.beforeTravel({ x: 50, y: 64, z: 0 });
    assert.deepEqual(f.calls.map(c => c[0]), ['move', 'break', 'pickup']);
    assert.deepEqual(f.calls[1][1], f.position);
    assert.equal(f.stock.crafting_table, 1);
    assert.equal(f.station.record, null);
});

test('unloaded station chunks are remembered and loaded by returning rather than discarded', async () => {
    const f = fixture();
    f.setBlock(null);
    f.bot.entity.position.x = 25;
    f.api.move = async p => {
        f.calls.push(['move', p]);
        f.bot.entity.position = { ...p };
        f.setBlock({ name: 'crafting_table', position: f.position });
        return true;
    };
    assert(f.station.available());
    assert.equal((await f.station.forCraft()).name, 'crafting_table');
    assert.equal(f.calls.length, 1);
});

test('a loaded missing/replaced table is forgotten without breaking a different block', async () => {
    const f = fixture();
    f.setBlock({ name: 'stone', position: f.position });
    await f.station.beforeTravel({ x: 70, y: 64, z: 0 });
    assert.equal(f.station.record, null);
    assert.equal(f.calls.length, 0);
});

test('combat and escape never detour to recover a station; recovery can happen after safety', async () => {
    const f = fixture();
    f.bot.modes.getActiveModes = () => ['self_defense'];
    await f.station.beforeTravel({ x: 70, y: 64, z: 0 });
    assert.equal(f.calls.length, 0);
    f.bot.modes.getActiveModes = () => [];
    await f.station.beforeTravel({ x: 70, y: 64, z: 0 });
    assert.equal(f.stock.crafting_table, 1);
});

test('interruption after breaking the table preserves the pending drop and resumes pickup without redigging', async () => {
    const f = fixture();
    const dig = f.api.break;
    f.api.break = async p => { await dig(p); f.bot.interrupt_code = true; };
    assert.equal(await f.station.pack(), false);
    assert(f.station.available());
    f.bot.interrupt_code = false;
    assert.equal(await f.station.pack(), true);
    assert.equal(f.calls.filter(c => c[0] === 'break').length, 1);
    assert.equal(f.stock.crafting_table, 1);
});

test('failed pickup stops travel, retains the drop record, and does not claim a packed table', async () => {
    const f = fixture();
    f.api.pickup = async () => {};
    await assert.rejects(f.station.beforeTravel({ x: 70, y: 64, z: 0 }), /Could not verify crafting table pickup/);
    assert(f.station.record);
    assert.equal(f.stock.crafting_table, undefined);
});

test('already completed pickup after combat does not walk back to the empty station', async () => {
    const f = fixture();
    const pickup = f.api.pickup;
    f.api.pickup = async () => { await pickup(); f.bot.interrupt_code = true; };
    assert.equal(await f.station.pack(), false);
    f.bot.entity.position.x = 50;
    f.bot.interrupt_code = false;
    const before = f.calls.length;
    assert.equal(await f.station.pack(), true);
    assert.equal(f.calls.length, before);
    assert.equal(f.station.record, null);
});

test('full inventory does not break the station or start a distant trip', async () => {
    const f = fixture();
    f.api.canCarry = () => false;
    await assert.rejects(f.station.beforeTravel({ x: 70, y: 64, z: 0 }), /inventory space/);
    assert.equal(f.calls.length, 0);
    assert(f.station.available());
});

test('unowned tables are never packed, and death or dimension changes clear ownership', async () => {
    const f = fixture();
    f.station.forget();
    await f.station.beforeTravel({ x: 70, y: 64, z: 0 });
    assert.equal(f.calls.length, 0);
    f.station.remember({ name: 'crafting_table', position: f.position });
    f.bot.emit('death');
    assert.equal(f.station.record, null);
    f.station.remember({ name: 'crafting_table', position: f.position });
    f.bot.game.dimension = 'the_nether';
    assert.equal(f.station.available(), false);
    assert.equal(f.calls.length, 0);
});

test('a nearby table without a usable face triggers an approach and retains ownership on failure', async () => {
    const f = fixture(); f.api.canUse = () => false; f.api.move = async () => false;
    await assert.rejects(f.station.forCraft(), /Could not reach my crafting table/);
    assert(f.station.available()); assert.equal(f.station.busy, false);
});

test('an API reporting arrival cannot bypass the final usable-position check', async () => {
    const f = fixture(); f.api.canUse = () => false;
    await assert.rejects(f.station.forCraft(), /verified work position/);
    assert(f.station.available()); assert.equal(f.calls.length, 1);
});

test('table placement persists intent before placement and remembers only a verified table', async () => {
    const f = fixture(); f.station.forget();
    let saved;
    f.bot.localMemory = { station: () => null, saveStation: record => { saved = { ...record }; } };
    f.api.place = async before => {
        before(f.position); assert.equal(saved.pendingPlacement, true);
        return { name: 'crafting_table', position: f.position };
    };
    assert.equal((await f.station.place()).name, 'crafting_table');
    assert.equal(saved.pendingPlacement, false); assert.equal(f.station.busy, false);
});

test('death during placement cannot install a stale owned table record', async () => {
    const f = fixture(); f.station.forget();
    f.api.place = async before => { before(f.position); f.bot.emit('death'); return { name: 'crafting_table', position: f.position }; };
    assert.equal(await f.station.place(), null);
    assert.equal(f.station.record, null); assert.equal(f.station.busy, false);
});
