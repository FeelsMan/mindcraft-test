import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { captureInventory, captureWorld, inventoryContext, worldContext, groundInventory, inventoryChanged } from '../src/agent/live_inventory.js';
import { reportManagedGoal } from '../src/agent/managed_goal_report.js';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Vec3 from 'vec3';
import { installLocalMemory } from '../src/agent/memory_runtime.js';
import { MemoryBank } from '../src/agent/memory_bank.js';

mock.module(new URL('../src/models/_model_map.js', import.meta.url).href, {
    namedExports: { selectAPI() {}, createModel() {} }
});
const { Prompter } = await import('../src/models/prompter.js');
const { setSettings } = await import('../src/agent/settings.js');

function fixture(stock = { stone_axe: 1 }) {
    const messages = [], receipts = [];
    const agent = {
        name: 'Mia', gather_epoch: 1, instruction_epoch: 2, gather_goal: { active: false },
        bot: { inventory: { items: () => Object.entries(stock).filter(([, n]) => n > 0)
            .map(([name, count]) => ({ name, count })) } },
        self_prompter: { isStopped: () => true },
        history: { add: async (...args) => receipts.push(args), save: async () => {} },
        routeResponse: async (...args) => messages.push(args)
    };
    return { stock, agent, messages, receipts };
}
const receipt = () => ({ item: 'stone_axe', target: 1, held: 1, initialHeld: 0,
    goalEpoch: 1, instructionEpoch: 2, requester: 'CaptainNeyo' });
function promptFixture(f, sendRequest) {
    setSettings({ allow_insecure_coding: false, log_all_prompts: false });
    return {
        agent: f.agent, profile: { conversing: 'Custom Mia prompt with no inventory placeholder.' },
        convo_examples: null, checkCooldown: async () => {}, replaceStrings: async s => s,
        _saveLog: async () => {}, chat_model: { sendRequest }
    };
}

function observedFixture(t) {
    const f = fixture(), root = mkdtempSync(join(tmpdir(), 'mia-observed-prompt-'));
    const bot = f.agent.bot = Object.assign(new EventEmitter(), f.agent.bot);
    bot.world = new EventEmitter(); bot.game = { dimension: 'overworld' };
    bot.entity = { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0 };
    bot.registry = { blocksByName: { furnace: { id: 1 } } };
    let furnace = { name: 'furnace', position: new Vec3(3, 64, 0) };
    bot.blockAt = p => p.x === 3 && p.y === 64 && p.z === 0 ? furnace : { name: 'air', position: p };
    bot.findBlocks = () => furnace?.name === 'furnace' ? [furnace.position] : [];
    bot.blockAtCursor = () => furnace;
    f.agent.memory_bank = new MemoryBank();
    const memory = installLocalMemory(f.agent, { root, config: { world_id: 'test-world', embeddings: false } });
    t.after(() => { memory.close(); rmSync(root, { recursive: true, force: true }); });
    return { ...f, bot, remove() {
        const old = furnace; furnace = { name: 'air', position: old.position };
        bot.world.emit('blockUpdate', old, furnace);
    } };
}

test('a block removed during model generation discards its stale response and supplies the missing location', async t => {
    const f = observedFixture(t); let calls = 0;
    const fake = promptFixture(f, async messages => {
        if (++calls === 1) { f.remove(); return 'Use the old furnace'; }
        assert.doesNotMatch(messages.at(-1).content, /^- furnace at /m);
        assert.match(messages.at(-1).content, /seen_station.*missing/);
        return 'The old furnace is gone; replan the station.';
    });
    assert.equal(await Prompter.prototype.promptConvo.call(fake, []), 'The old furnace is gone; replan the station.');
    assert.equal(calls, 2);
});

test('a block change during model-log persistence also suppresses the already generated stale decision', async t => {
    const f = observedFixture(t); let calls = 0, logs = 0;
    const fake = promptFixture(f, async () => ++calls === 1 ? 'Use the old furnace' : 'Reassess the missing furnace');
    fake._saveLog = async () => { if (++logs === 1) f.remove(); };
    assert.equal(await Prompter.prototype.promptConvo.call(fake, []), 'Reassess the missing furnace');
    assert.equal(calls, 2);
});

test('teleport refreshes the real position before accepting a conversational decision', async t => {
    const f = observedFixture(t); let calls = 0;
    const fake = promptFixture(f, async messages => {
        if (++calls === 1) { f.bot.entity.position = new Vec3(9.5, 65, 9.5); f.bot.emit('forcedMove'); return 'Stay at the old coordinates'; }
        assert.match(messages.at(-1).content, /feet position: 9.5, 65, 9.5/); return 'Use the current position';
    });
    assert.equal(await Prompter.prototype.promptConvo.call(fake, []), 'Use the current position'); assert.equal(calls, 2);
});

test('ordinary movement and unrelated terrain changes keep a conversational decision usable', async t => {
    const f = observedFixture(t); let calls = 0;
    const fake = promptFixture(f, async () => {
        calls++; f.bot.entity.position.x += 0.1; f.bot.emit('move');
        f.bot.world.emit('blockUpdate', { name: 'air', position: new Vec3(40, 64, 40) },
            { name: 'short_grass', position: new Vec3(40, 64, 40) });
        return 'Ready';
    });
    assert.equal(await Prompter.prototype.promptConvo.call(fake, []), 'Ready'); assert.equal(calls, 1);
});

test('a pending table pickup is described as unverified recovery rather than a reusable placed station', async () => {
    const f = fixture(); let prompt;
    f.agent.bot.craftingStation = { available: () => true, travelDistance: 32,
        record: { position: { x: 16, y: 89, z: 17 }, pickupMinimum: 1 } };
    const fake = promptFixture(f, async (_messages, system) => { prompt = system; return 'Recheck the station.'; });
    assert.equal(await Prompter.prototype.promptConvo.call(fake, []), 'Recheck the station.');
    assert.match(prompt, /pickup remains pending near 16, 89, 17/);
    assert.doesNotMatch(prompt, /Your reusable crafting table is remembered/);
    assert.match(prompt, /not a verified placed table or a successful inventory receipt/);
});

test('giving an axe away replaces old inventory with an explicit current absence on every model request', async () => {
    const f = fixture();
    const history = [{ role: 'system', content: 'INVENTORY\n- stone_axe: 1' },
        { role: 'system', content: 'CaptainNeyo received stone_axe.' },
        { role: 'user', content: 'Make sure you have one stone axe.' }];
    const original = structuredClone(history);
    delete f.stock.stone_axe;
    let received;
    const fake = promptFixture(f, async messages => { received = messages; return '!makeGoal("stone_axe", 1)'; });
    assert.equal(await Prompter.prototype.promptConvo.call(fake, history), '!makeGoal("stone_axe", 1)');
    assert.deepEqual(history, original, 'Ephemeral live state must not rewrite chat history');
    assert.equal(received.at(-1).role, 'system');
    assert.match(received.at(-1).content, /CURRENT LIVE INVENTORY/);
    assert.match(received.at(-1).content, /unlisted carried item has a current count of 0/);
    assert.doesNotMatch(received.at(-1).content, /- stone_axe: 1/);
    assert.match(received.at(-1).content, /!makeGoal/);
});

test('consecutive prompts refresh counts even when the profile omits the inventory placeholder', async () => {
    const f = fixture({ stick: 4 });
    const snapshots = [];
    const fake = promptFixture(f, async messages => { snapshots.push(messages.at(-1).content); return 'Ready'; });
    await Prompter.prototype.promptConvo.call(fake, []);
    f.stock.stick = 12;
    await Prompter.prototype.promptConvo.call(fake, []);
    assert.match(snapshots[0], /- stick: 4/);
    assert.match(snapshots[1], /- stick: 12/);
});

test('inventory changing during generation discards the stale response and refreshes before deciding', async () => {
    const f = fixture();
    let calls = 0;
    const fake = promptFixture(f, async messages => {
        calls++;
        if (calls === 1) { delete f.stock.stone_axe; return 'I still have an axe'; }
        assert.doesNotMatch(messages.at(-1).content, /- stone_axe: 1/);
        return '!makeGoal("stone_axe", 1)';
    });
    assert.equal(await Prompter.prototype.promptConvo.call(fake, []), '!makeGoal("stone_axe", 1)');
    assert.equal(calls, 2);
});

test('continuously changing inventory ends bounded retries without returning stale claims', async () => {
    const f = fixture({ stick: 1 });
    let calls = 0;
    const fake = promptFixture(f, async () => { calls++; f.stock.stick++; return 'I have the old count'; });
    assert.equal(await Prompter.prototype.promptConvo.call(fake, []), '');
    assert.equal(calls, 3);
});

test('missing or failed inventory reads remain unavailable rather than fabricated empty stock', () => {
    assert.equal(captureInventory({}).available, false);
    assert.equal(captureInventory({ inventory: { items() { throw Error('closed'); } } }).available, false);
    assert.match(inventoryContext(captureInventory({})), /unavailable/);
    assert.doesNotMatch(inventoryContext(captureInventory({})), /count of 0/);
});

test('split stacks are combined consistently without depending on their order', () => {
    const one = captureInventory({ inventory: { items: () => [
        { name: 'stick', count: 2 }, { name: 'stone_axe', count: 1 }, { name: 'stick', count: 2 }
    ] } });
    const two = captureInventory({ inventory: { items: () => [
        { name: 'stone_axe', count: 1 }, { name: 'stick', count: 4 }
    ] } });
    assert.equal(one.counts.stick, 4);
    assert.equal(one.fingerprint, two.fingerprint);
    assert.equal(groundInventory([], one).length, 1);
});

test('verified completion writes a receipt and reports once without a model request or command execution', async () => {
    const f = fixture();
    f.agent.prompter = { promptConvo: () => assert.fail('Completion must not create an action-generating loop') };
    assert.equal(await reportManagedGoal(f.agent, receipt()), true);
    assert.equal(await reportManagedGoal(f.agent, receipt()), false);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0][0], 'CaptainNeyo');
    assert.match(f.messages[0][1], /1 stone_axe/);
    assert.doesNotMatch(f.messages[0][1], /![A-Za-z]/);
    assert.match(f.receipts[0][1], /Verified managed goal complete/);
});

test('an already-satisfied goal report says that no additional crafting was needed', async () => {
    const f = fixture();
    assert.equal(await reportManagedGoal(f.agent, { ...receipt(), initialHeld: 1 }), true);
    assert.match(f.messages[0][1], /no additional crafting was needed/);
});

test('superseded, canceled, active, dead and shutting-down contexts do not issue completion claims', async () => {
    for (const override of [
        { instruction_epoch: 3 }, { gather_epoch: 2 }, { gather_goal: { active: true } },
        { recovering_from_death: true }, { _shuttingDown: true }, { shut_up: true }
    ]) {
        const f = fixture(); Object.assign(f.agent, override);
        assert.equal(await reportManagedGoal(f.agent, receipt()), false);
        assert.equal(f.messages.length + f.receipts.length, 0);
    }
});

test('a transferred or otherwise missing target item cannot receive a success report', async () => {
    const f = fixture({});
    assert.equal(await reportManagedGoal(f.agent, receipt()), false);
    assert.equal(f.messages.length + f.receipts.length, 0);
});

test('a newer instruction during receipt persistence suppresses the delayed report', async () => {
    const f = fixture();
    f.agent.history.save = async () => { f.agent.instruction_epoch++; };
    assert.equal(await reportManagedGoal(f.agent, receipt()), false);
    assert.equal(f.messages.length, 0);
});

test('inventory changes during receipt persistence cannot report a departed item', async () => {
    const f = fixture();
    f.agent.history.save = async () => { delete f.stock.stone_axe; };
    assert.equal(await reportManagedGoal(f.agent, receipt()), false);
    assert.equal(f.messages.length, 0);
});

test('unrelated pickups during persistence do not suppress an accurate target report', async () => {
    const f = fixture();
    f.agent.history.save = async () => { f.stock.apple = 1; };
    assert.equal(await reportManagedGoal(f.agent, receipt()), true);
    assert.equal(f.messages.length, 1);
});

test('position, aim and nearby blocks are refreshed for each decision even when the profile has no stats placeholder', async () => {
    const f = fixture(), seen = [], calls = [];
    let block = { name: 'furnace', position: { x: 5, y: 64, z: 2 } };
    f.agent.bot.game = { dimension: 'overworld' };
    f.agent.bot.entity = { position: { x: 1, y: 64, z: 2 }, yaw: 0, pitch: 0 };
    f.agent.bot.health = 0; f.agent.bot.food = 0;
    f.agent.bot.registry = { blocksByName: { furnace: { id: 1 }, iron_ore: { id: 2 } } };
    f.agent.bot.blockAtCursor = range => { assert.equal(range, 4); return block; };
    f.agent.bot.findBlocks = options => {
        calls.push(options); return options.matching.includes(1) && block ? [block.position] : [];
    };
    f.agent.bot.blockAt = () => block;
    const fake = promptFixture(f, async messages => {
        seen.push(messages.at(-1).content);
        // Ordinary movement while a response is generated must not starve
        // decisions with endless retries. Actions recheck their actual routes.
        f.agent.bot.entity.position.x++;
        return 'Ready';
    });
    const history = [{ role: 'system', content: 'Historical: furnace at 999, 60, 999' }];
    await Prompter.prototype.promptConvo.call(fake, history);
    block = null;
    f.agent.bot.entity.position = { x: 7, y: 65, z: 3 };
    await Prompter.prototype.promptConvo.call(fake, history);
    assert.equal(seen.length, 2);
    assert.match(seen[0], /feet position: 1, 64, 2/);
    assert.match(seen[0], /furnace at 5, 64, 2/);
    assert.match(seen[0], /Health: 0; hunger: 0/);
    assert.match(seen[1], /feet position: 7, 65, 3/);
    assert.doesNotMatch(seen[1], /furnace at 5, 64, 2/);
    assert.match(seen[1], /no block hit/);
    assert.match(seen[1], /reachability unproven/);
    assert(calls.every(c => c.maxDistance === 12 && c.count <= 8));
    assert.equal(history.length, 1, 'Observations must not accumulate in persistent history');
});

test('dimension changes during generation discard the stale decision even with unchanged inventory', async () => {
    const f = fixture(); f.agent.bot.game = { dimension: 'overworld' };
    let calls = 0;
    const fake = promptFixture(f, async messages => {
        if (++calls === 1) { f.agent.bot.game.dimension = 'the_nether'; return 'Use the overworld table'; }
        assert.match(messages.at(-1).content, /Dimension: the_nether/);
        return 'Reassess here';
    });
    assert.equal(await Prompter.prototype.promptConvo.call(fake, []), 'Reassess here');
    assert.equal(calls, 2);
});

test('unknown position and failed block observations stay unknown instead of becoming fabricated empty terrain', () => {
    const missing = worldContext(captureWorld({}));
    assert.match(missing, /feet position: unavailable/);
    assert.match(missing, /Scan unavailable/);
    const bot = { entity: { position: { x: 1, y: 64, z: 2 } },
        blockAtCursor() { throw Error('unloaded'); } };
    assert.match(worldContext(captureWorld(bot)), /aimed at within 4 blocks: unavailable/);
    const before = captureInventory({ inventory: { items: () => [] }, game: { dimension: 'overworld' } });
    assert(inventoryChanged({ inventory: { items: () => [] }, game: { dimension: 'the_nether' } }, before));
});
