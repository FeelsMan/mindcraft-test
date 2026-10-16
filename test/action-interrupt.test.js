import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { requestActionInterrupt, withActionWatchdog } from '../src/agent/action_interrupt.js';
import { ActionManager } from '../src/agent/action_manager.js';
const require = createRequire(import.meta.url);
const { CollectBlock } = require('mineflayer-collectblock/lib/CollectBlock.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture() {
    const bot = new EventEmitter();
    let stops = 0, cancellations = 0;
    bot.pathfinder = { stop() { stops++; } };
    bot.stopDigging = () => {};
    bot.pvp = { stop: async () => {} };
    const plugin = Object.create(CollectBlock.prototype);
    plugin.bot = bot; plugin.targets = { empty: false };
    bot.collectBlock = { cancelTask() { cancellations++; return plugin.cancelTask(); } };
    return { bot, plugin, stops: () => stops, cancellations: () => cancellations };
}

test('400 repeated interrupts share one real collectblock cancellation listener pair', async () => {
    const f = fixture();
    for (let i = 0; i < 400; i++) requestActionInterrupt(f.bot);
    assert.equal(f.cancellations(), 1);
    assert.equal(f.bot.listenerCount('collectBlock_finished'), 1);
    assert.equal(f.bot.listenerCount('error'), 1);
    assert(f.stops() >= 400, 'Path stopping continues while asynchronous cancellation is pending');
    f.bot.emit('collectBlock_finished'); await sleep(0);
    assert.equal(f.bot.listenerCount('collectBlock_finished'), 0);
    assert.equal(f.bot.listenerCount('error'), 0);
    requestActionInterrupt(f.bot);
    assert.equal(f.cancellations(), 2, 'A later task can be cancelled independently');
    f.bot.emit('collectBlock_finished'); await sleep(0);
});

test('a real collectblock cancellation error is handled and its listeners are removed', async t => {
    t.mock.method(console, 'warn', () => {});
    const f = fixture();
    requestActionInterrupt(f.bot);
    f.bot.emit('error', Error('disconnected during cancellation'));
    await sleep(0);
    assert.equal(f.bot.listenerCount('collectBlock_finished'), 0);
    assert.equal(f.bot.listenerCount('error'), 0);
    requestActionInterrupt(f.bot); assert.equal(f.cancellations(), 2);
    f.bot.emit('collectBlock_finished'); await sleep(0);
});

test('ActionManager can poll during a slow stop without accumulating cancellation listeners', async () => {
    const f = fixture();
    f.bot.output = '';
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const agent = {
        bot: f.bot, requestInterrupt: () => requestActionInterrupt(f.bot),
        clearBotLogs() { f.bot.output = ''; f.bot.interrupt_code = false; },
        cleanKill(message) { assert.fail(message); }
    };
    const actions = new ActionManager(agent);
    const run = actions.runAction('action:gatherGoal', () => gate);
    while (!actions.executing) await sleep(0);
    const stop = actions.stop('mode:unstuck');
    await sleep(120);
    assert.equal(f.cancellations(), 1);
    assert.equal(f.bot.listenerCount('collectBlock_finished'), 1);
    f.bot.emit('collectBlock_finished'); release();
    assert.equal((await run).interrupted, true); await stop;
    assert.equal(f.bot.listenerCount('collectBlock_finished'), 0);
});

test('synchronous plugin errors do not prevent other interrupt controls from stopping', t => {
    t.mock.method(console, 'warn', () => {});
    const f = fixture();
    f.bot.stopDigging = () => { throw Error('not digging'); };
    assert.doesNotThrow(() => requestActionInterrupt(f.bot));
    assert.equal(f.cancellations(), 1); assert(f.stops() >= 1);
    f.bot.emit('collectBlock_finished');
});

test('unstuck watchdog is cleared after an action throws', async () => {
    let kills = 0;
    const agent = { actions: { currentRun: {} }, cleanKill() { kills++; } };
    await assert.rejects(withActionWatchdog(agent, async () => { throw Error('blocked'); }, 10, 'stuck'), /blocked/);
    await sleep(25); assert.equal(kills, 0);
});

test('a watchdog cannot terminate a subsequent action owner', async () => {
    let kills = 0;
    const agent = { actions: { currentRun: {} }, cleanKill() { kills++; } };
    const result = withActionWatchdog(agent, () => sleep(25), 10, 'stuck');
    agent.actions.currentRun = {};
    await result; assert.equal(kills, 0);
});

test('a genuinely hung current action still triggers its watchdog', async () => {
    let kills = 0;
    const agent = { actions: { currentRun: {} }, cleanKill(message) { assert.equal(message, 'stuck'); kills++; } };
    await withActionWatchdog(agent, () => sleep(25), 5, 'stuck');
    assert.equal(kills, 1);
});
