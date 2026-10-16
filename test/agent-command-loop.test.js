import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// Exercise the real Agent.handleMessage, command catalog and retry guard.
// Rendering, translation and model transport are replaced at their boundaries.
for (const [file, exports] of [
    ['../src/models/prompter.js', { Prompter: class {} }],
    ['../src/agent/coder.js', { Coder: class {} }],
    ['../src/agent/vision/vision_interpreter.js', { VisionInterpreter: class {} }],
    ['../src/agent/vision/browser_viewer.js', { addBrowserViewer() {} }],
    ['../src/agent/tasks/tasks.js', { Task: class {} }],
    ['../src/agent/speak.js', { speak() {} }],
    ['../src/utils/translator.js', { handleEnglishTranslation: async s => s, handleTranslation: async s => s }]
]) mock.module(new URL(file, import.meta.url).href, { namedExports: exports });

const { Agent } = await import('../src/agent/agent.js');
const { SelfPrompter } = await import('../src/agent/self_prompter.js');
const { setSettings } = await import('../src/agent/settings.js');
const { getCommandDocs, executeCommand } = await import('../src/agent/commands/index.js');

function fixture(responses) {
    setSettings({ allow_insecure_coding: false, max_commands: -1, show_command_syntax: 'full' });
    let requests = 0;
    const messages = [], turns = [];
    const agent = Object.assign(new Agent(), {
        name: 'Mia', blocked_actions: [], task: { data: null },
        bot: { modes: { flushBehaviorLog: () => '' } },
        prompter: { promptConvo: async () => responses[requests++] ?? '!newAction("build again")' },
        history: { add: async (name, content) => turns.push({ name, content }), getHistory: () => turns, save: async () => {} },
        routeResponse: (_source, message) => messages.push(message),
        openChat: message => messages.push(message)
    });
    agent.self_prompter = new SelfPrompter(agent);
    // Active autonomous state, without starting a competing background loop.
    agent.self_prompter.state = 1;
    return { agent, messages, requests: () => requests };
}

test('real response loop stops repeated unavailable commands after two model replies', async () => {
    const f = fixture(['!newAction("house")', '!newAction("different house")']);
    await f.agent.handleMessage('system', 'Continue the goal.');
    assert.equal(f.requests(), 2);
    assert.equal(f.agent.self_prompter.isStopped(), true);
    assert.equal(f.messages.filter(m => m.includes('Automatic commands paused')).length, 1);
});

test('actual docs and runtime agree about the disabled code-generation command', async () => {
    const f = fixture([]);
    assert.equal(getCommandDocs(f.agent).includes('!newAction'), false);
    assert.match(await executeCommand(f.agent, '!newAction("house")'), /unavailable/);
    setSettings({ allow_insecure_coding: true });
    assert.equal(getCommandDocs(f.agent).includes('!newAction'), true);
    f.agent.blocked_actions = ['!newAction'];
    assert.equal(getCommandDocs(f.agent).includes('!newAction'), false);
    assert.match(await executeCommand(f.agent, '!newAction("house")'), /disabled/);
});

test('real loop cannot evade the limit by querying help between unavailable requests', async () => {
    const f = fixture(['!newAction("house")', '!help', '!newAction("cube")']);
    await f.agent.handleMessage('system', 'Continue the goal.');
    assert.equal(f.requests(), 3);
    assert.equal(f.agent.self_prompter.isStopped(), true);
});

test('a human request for an unavailable command receives feedback without invoking the model', async () => {
    const f = fixture([]);
    assert.equal(await f.agent.handleMessage('ADMIN', '!newAction("house")'), false);
    assert.equal(f.requests(), 0);
    assert.match(f.messages[0], /unavailable/);
});

test('actual startup handler restores a managed goal before invoking greeting or old self-prompt', async () => {
    const f = fixture([]);
    f.agent.bot.on = () => {};
    f.agent.bot.autoEat = {};
    f.agent.local_memory = { resume: async () => true };
    await f.agent._setupEventHandlers({ self_prompt: 'old task', last_sender: 'OtherBot' }, 'Hello world');
    assert.equal(f.requests(), 0);
});

test('actual resume command uses the memory recovery path, and memory query is available', async () => {
    const f = fixture([]);
    let called = false;
    f.agent.local_memory = {
        summary: () => 'Verified memory summary',
        resume: async (_execute, { manual }) => { called = manual; return true; }
    };
    assert.match(await executeCommand(f.agent, '!resumeGoal'), /resumed/);
    assert.equal(called, true);
    f.agent.gather_goal = { active: true };
    assert.equal(await executeCommand(f.agent, '!memory'), 'Verified memory summary');
});

test('restart before bot initialization exits without accessing chat or overwriting unloaded history', async t => {
    const exits = [];
    t.mock.method(process, 'exit', code => exits.push(code));
    t.mock.method(console, 'warn', () => {});
    const agent = new Agent();
    agent.history = { add: () => assert.fail('History has not loaded'), save: () => assert.fail('Must preserve the existing file') };
    await agent.cleanKill('Dashboard restart during initialization.');
    assert.deepEqual(exits, [1]);
    assert.equal(agent._shuttingDown, true);
    assert.equal(agent._disconnectHandled, true);
    assert.equal(await agent.handleMessage('system', 'Continue'), false);
    await agent.start(); // Shutdown must prevent initialization from restarting.
});

test('shutdown waits for history, skips pre-login chat and coalesces repeated requests', async t => {
    const events = [];
    t.mock.method(process, 'exit', code => events.push(`exit:${code}`));
    t.mock.method(console, 'warn', () => {});
    let release;
    const saved = new Promise(resolve => { release = resolve; });
    const agent = Object.assign(new Agent(), {
        task: {}, bot: { entity: {}, _client: { state: 'login' }, chat: () => assert.fail('Not logged in yet') },
        history: { add: async () => { events.push('add'); }, save: async () => { events.push('save'); await saved; events.push('saved'); } },
        local_memory: { close: () => events.push('close') }
    });
    const pending = agent.cleanKill('Restart');
    await new Promise(resolve => setImmediate(resolve));
    await agent.cleanKill('Duplicate restart');
    assert.deepEqual(events, ['add', 'save']);
    release(); await pending;
    assert.deepEqual(events, ['add', 'save', 'saved', 'close', 'exit:1']);
});

test('failed history, chat and memory cleanup cannot prevent the requested process exit', async t => {
    const events = [];
    t.mock.method(process, 'exit', code => events.push(`exit:${code}`));
    t.mock.method(console, 'warn', () => {});
    const agent = Object.assign(new Agent(), {
        task: {}, bot: { entity: {}, _client: { state: 'play' }, chat: () => { events.push('chat'); throw Error('Closed connection'); } },
        history: { add: async () => { events.push('add'); throw Error('Report failed'); }, save: async () => { events.push('save'); throw Error('Disk unavailable'); } },
        local_memory: { close: () => { events.push('close'); throw Error('Already closed'); } }
    });
    await agent.cleanKill('Restart', 2);
    assert.deepEqual(events, ['add', 'save', 'chat', 'close', 'exit:2']);
});
