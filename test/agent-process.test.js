import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { releaseAgentSocket, restartRegisteredAgent } from '../src/mindcraft/agent_restart.js';

const logouts = [];
mock.module(new URL('../src/mindcraft/mindserver.js', import.meta.url).href, {
    namedExports: { logoutAgent: name => logouts.push(name) }
});
const { AgentProcess } = await import('../src/process/agent_process.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t, options = {}) {
    let now = 0;
    const children = [];
    const manager = new AgentProcess('Mia', 8080, {
        now: () => now, restartTimeoutMs: 20,
        spawnProcess(_exe, args) {
            const child = Object.assign(new EventEmitter(), {
                pid: children.length + 1000, args, signals: [],
                kill(signal) { this.signals.push(signal); return true; }
            });
            children.push(child); return child;
        }, ...options
    });
    t.after(() => manager.stop());
    return { manager, children, time: value => { now = value; } };
}

test('repeated start/Connect requests cannot spawn or kill an already starting child', t => {
    const f = fixture(t);
    const first = f.manager.start(false, null, 7);
    assert.equal(f.manager.start(true, 'connected', 7), first);
    assert.equal(f.children.length, 1); assert.deepEqual(first.signals, []);
});

test('normal startup loads memory by default and still forwards an explicit opt-out', t => {
    for (const value of [undefined, true, false]) {
        const f = fixture(t), child = value === undefined ? f.manager.start() : f.manager.start(value);
        const index = child.args.indexOf('-l');
        assert(index >= 0, 'The child must not guess whether startup memory is wanted');
        assert.equal(child.args[index + 1], value === false ? 'false' : 'true');
    }
});

test('a dashboard restart is registered before graceful exit and creates one replacement', async t => {
    const f = fixture(t);
    const child = f.manager.start(false, null, 4); f.time(20000);
    let named;
    const connections = { Mia: { socket: { connected: true, emit(event, name) {
        assert.equal(event, 'restart-agent'); named = name;
        assert.equal(f.manager.restartRequested, true);
        child.emit('exit', 1, null);
    } } } };
    const replacement = await restartRegisteredAgent('Mia', connections, (_name, graceful) => f.manager.forceRestart(graceful));
    assert.equal(named, 'Mia'); assert.equal(f.children.length, 2);
    assert.equal(replacement, f.children[1]); assert.deepEqual(child.signals, []);
    assert(f.children[1].args.includes('Agent process restarted.'));
    assert.equal(f.children[1].args[f.children[1].args.indexOf('-c') + 1], 4);
});

test('overlapping restart requests share one exit waiter and one replacement', async t => {
    const f = fixture(t), child = f.manager.start();
    const first = f.manager.forceRestart(() => true);
    const second = f.manager.forceRestart(() => assert.fail('Second shutdown sent'));
    assert.equal(first, second);
    child.emit('exit', 1, null);
    assert.equal(await first, f.children[1]); assert.equal(f.children.length, 2);
});

test('automatic crash recovery followed by Connect does not kill the new child', t => {
    const f = fixture(t), child = f.manager.start(); f.time(20000);
    child.emit('exit', 1, null);
    assert.equal(f.children.length, 2);
    const replacement = f.manager.start(true);
    assert.equal(replacement, f.children[1]); assert.deepEqual(replacement.signals, []);
    child.emit('exit', 1, null);
    assert.equal(f.manager.process, replacement); assert.equal(f.children.length, 2);
});

test('stop cancels a pending restart and prevents automatic replacement', async t => {
    const f = fixture(t), child = f.manager.start(); f.time(20000);
    const restart = f.manager.forceRestart(() => true);
    f.manager.stop();
    assert.equal(await restart, false);
    child.emit('exit', 1, null);
    assert.equal(f.children.length, 1); assert.equal(f.manager.running, false);
});

test('a child that ignores graceful exit is killed before replacement starts', async t => {
    const f = fixture(t), child = f.manager.start();
    child.kill = signal => {
        child.signals.push(signal);
        if (signal === 'SIGKILL') child.emit('exit', null, signal);
        return true;
    };
    const next = await f.manager.forceRestart(() => true);
    assert.deepEqual(child.signals, ['SIGKILL']);
    assert.equal(next, f.children[1]); assert.equal(f.children.length, 2);
});

test('an unconfirmed exit never creates a concurrent replacement child', async t => {
    const f = fixture(t), child = f.manager.start();
    assert.equal(await f.manager.forceRestart(), false);
    assert.deepEqual(child.signals, ['SIGINT', 'SIGKILL']);
    assert.equal(f.children.length, 1); assert.equal(f.manager.process, child);
});

test('unknown/disconnected restart requests are safe and use parent signal fallback', async t => {
    const f = fixture(t), child = f.manager.start();
    assert.equal(restartRegisteredAgent(undefined, {}, () => assert.fail('Invalid restart')), false);
    assert.equal(restartRegisteredAgent('__proto__', {}, () => assert.fail('Invalid restart')), false);
    const operation = restartRegisteredAgent('Mia', { Mia: { socket: null } }, (_name, graceful) => f.manager.forceRestart(graceful));
    assert.deepEqual(child.signals, ['SIGINT']); child.emit('exit', null, 'SIGINT');
    assert.equal(await operation, f.children[1]);
});

test('fast unexpected startup failures remain bounded, while explicit restarts still work', async t => {
    const f = fixture(t), child = f.manager.start(); f.time(100);
    child.emit('exit', 1, null);
    assert.equal(f.children.length, 1); assert.equal(f.manager.running, false);
    assert.equal(await f.manager.forceRestart(), f.children[1]);
});

test('a late old-socket disconnect cannot clear the replacement agent connection', () => {
    const previous = {}, current = {};
    const connections = { Mia: { socket: current, in_game: true } };
    assert.equal(releaseAgentSocket('Mia', connections, previous), false);
    assert.equal(connections.Mia.socket, current); assert.equal(connections.Mia.in_game, true);
    assert.equal(releaseAgentSocket('Mia', connections, current), true);
    assert.equal(connections.Mia.socket, null); assert.equal(connections.Mia.in_game, false);
});

test('real child processes exit once and restart once through the graceful dashboard path', async t => {
    const children = [];
    const script = `process.on('message', m => { if (m === 'restart') process.exit(1); }); setInterval(() => {}, 1000);`;
    const manager = new AgentProcess('Mia', 8080, {
        spawnProcess() {
            const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
            children.push(child); return child;
        }, restartTimeoutMs: 3000
    });
    t.after(() => { manager.stop(); for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const first = manager.start(); await once(first, 'spawn');
    const operation = manager.forceRestart(() => { first.send('restart'); return true; });
    assert.equal(manager.forceRestart(), operation);
    const replacement = await operation;
    assert.equal(children.length, 2); assert.equal(replacement, children[1]);
    assert.equal(first.exitCode, 1);
    assert.equal(manager.start(), replacement);
    const stopped = once(replacement, 'exit'); manager.stop(); await stopped;
    await sleep(30); assert.equal(children.length, 2);
});
