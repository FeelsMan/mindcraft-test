import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { captureInventory, inventoryContext, groundInventory } from '../src/agent/live_inventory.js';
import { reportManagedGoal } from '../src/agent/managed_goal_report.js';

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
