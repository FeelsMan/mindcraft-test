const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const builder = require('../scripts/build-food-installer.cjs');
const repository = path.resolve(__dirname, '..');
const currentPath = path.join(repository, 'scripts/mia-survival-supervisor-update.cjs');
const current = require(currentPath);

function gitFile(relative) {
    try {
        return execFileSync('git', ['show', builder.BASELINE + ':' + relative],
            { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return null; }
}
const hasBaseline = Boolean(gitFile('package.json'));

test('Food rebuilds upgrade recovery and preceding Food source with exact rollback and retained private state', {
    skip: !hasBaseline
}, () => {
    const temporary = path.resolve(os.tmpdir());
    const root = fs.mkdtempSync(path.join(temporary, 'mia-food-build-source-'));
    const priorTarget = fs.mkdtempSync(path.join(temporary, 'mia-food-build-prior-'));
    const recoveryTarget = fs.mkdtempSync(path.join(temporary, 'mia-food-build-recovery-'));
    const loggedTarget = fs.mkdtempSync(path.join(temporary, 'mia-food-build-terminal-'));
    const targets = [priorTarget, recoveryTarget, loggedTarget];
    const write = (base, relative, bytes) => {
        const filename = path.join(base, relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes);
    };
    const privateFiles = new Map([
        ['mia-qwen.json', Buffer.from('{"model":"mia:qwen9b","name":"Mia"}\n')],
        ['settings.js', Buffer.from('export default { port: 55555 };\n')],
        ['keys.json', Buffer.from('private-test-credentials\n')],
        ['bots/Mia/memory.json', Buffer.from('{"keep":"verified-history"}\n')],
        ['bots/Mia/memory.sqlite', Buffer.from([0, 13, 10, 255, 17])],
        ['bots/Mia/memory.sqlite-wal', Buffer.from('private-test-wal\n')],
        ['bots/Mia/memory.sqlite-shm', Buffer.from('private-test-shm\n')],
        ['bots/Mia/memory-config.json', Buffer.from('{"world_id":"mia-survival-1"}\n')]
    ]);
    const privateUnchanged = target => {
        for (const [relative, bytes] of privateFiles)
            assert.deepEqual(fs.readFileSync(path.join(target, relative)), bytes, relative);
    };
    const run = (target, command) => {
        const result = spawnSync(process.execPath,
            [path.join(root, 'scripts/mia-food-foundation-update.cjs'), command], { cwd: target, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr + result.stdout);
        privateUnchanged(target);
    };
    const snapshot = (target, payload) => new Map(payload.map(entry => {
        const filename = path.join(target, entry.path);
        return [entry.path, fs.existsSync(filename) ? fs.readFileSync(filename) : null];
    }));
    const unchanged = (target, before) => {
        for (const [relative, bytes] of before) {
            if (bytes === null) assert.equal(fs.existsSync(path.join(target, relative)), false, relative);
            else assert.deepEqual(fs.readFileSync(path.join(target, relative)), bytes, relative);
        }
        privateUnchanged(target);
    };
    try {
        for (const entry of current.PAYLOAD) write(root, entry.path, entry.content);
        // The build input is the current Food source; the template contributes
        // accepted Recovery hashes and rollback behavior, not old source bytes.
        for (const relative of new Set([...current.PAYLOAD.map(entry => entry.path),
            ...builder.NEW_FILES, ...current.TEST_FILES]))
            write(root, relative, fs.readFileSync(path.join(repository, relative)));
        write(root, 'scripts/mia-survival-supervisor-update.cjs', fs.readFileSync(currentPath));
        write(root, 'main.js', ''); write(root, 'package.json', '{"type":"module"}');
        const paths = new Set([...current.PAYLOAD.map(entry => entry.path), ...builder.NEW_FILES]);
        for (const target of targets) {
            for (const relative of paths) {
                const bytes = gitFile(relative);
                if (bytes !== null) write(target, relative, bytes);
            }
            write(target, 'main.js', ''); write(target, 'package.json', '{"type":"module"}');
            for (const [relative, bytes] of privateFiles) write(target, relative, bytes);
        }
        const terminalLog = "                console.log('Agent executed:', user_command_name, 'and got:', execute_res);";
        const commandLine = '                let execute_res = await executeCommand(this, message, requestContext);';
        const loggedSource = current.normalize(gitFile('src/agent/agent.js'))
            .replace(commandLine + '\n', commandLine + '\n' + terminalLog + '\n');
        assert.equal(current.gitHash(Buffer.from(loggedSource)), builder.BASELINE_VARIANTS['src/agent/agent.js'][0]);
        // The reviewed runtime variant uses a CRLF fixture to verify exact
        // byte restoration as well as retaining its log in the upgraded code.
        write(loggedTarget, 'src/agent/agent.js', loggedSource.replace(/\n/g, '\r\n'));
        const loggedRegression = fs.readFileSync(path.join(repository, 'test/agent-command-loop.test.js'));
        assert.equal(current.gitHash(loggedRegression), builder.BASELINE_VARIANTS['test/agent-command-loop.test.js'][0]);
        write(loggedTarget, 'test/agent-command-loop.test.js', loggedRegression);
        const source = 'src/agent/food_goal.js';
        fs.appendFileSync(path.join(root, source), '\n// First packaged Food revision.\n');
        const firstOptions = builder.argumentsOf(['--root', root, '--history-root', repository]);
        assert.equal(firstOptions.template, path.join(root, 'scripts/mia-survival-supervisor-update.cjs'));
        const first = builder.build(firstOptions);
        run(priorTarget, '--check'); run(priorTarget, '--apply'); run(priorTarget, '--verify');
        const prior = snapshot(priorTarget, first.payload);

        fs.appendFileSync(path.join(root, source), '\n// Second packaged Food revision.\n');
        const nextOptions = builder.argumentsOf(['--root', root, '--history-root', repository]);
        assert.equal(nextOptions.template, path.join(root, 'scripts/mia-food-foundation-update.cjs'));
        const next = builder.build(nextOptions);
        const recovery = snapshot(recoveryTarget, next.payload);
        const logged = snapshot(loggedTarget, next.payload);
        assert(next.payload.find(entry => entry.path === 'src/agent/agent.js').content.includes(terminalLog));
        for (const entry of first.payload) {
            const latest = next.payload.find(candidate => candidate.path === entry.path);
            for (const hash of entry.before) assert(latest.before.includes(hash), entry.path);
            assert(latest.before.includes(current.gitHash(Buffer.from(entry.content))), entry.path);
        }
        assert(next.tests.includes('test/food-world.test.js'));
        assert(next.tests.includes('test/food-cooking.test.js'));
        assert(next.tests.includes('test/food-goal.test.js'));
        assert(next.tests.includes('test/food-reserve.test.js'));
        assert(!next.payload.some(entry => /^(bots|node_modules|\.mia-development)\//.test(entry.path)));
        assert.deepEqual(fs.readFileSync(path.join(root, 'scripts/mia-food-foundation-update.cjs')),
            fs.readFileSync(path.join(root, 'mia-food-foundation-update.cjs')));
        for (const [target, before] of [[priorTarget, prior], [recoveryTarget, recovery], [loggedTarget, logged]]) {
            run(target, '--check'); run(target, '--apply'); run(target, '--verify');
            assert.equal(fs.readFileSync(path.join(target, source), 'utf8'), fs.readFileSync(path.join(root, source), 'utf8'));
            run(target, '--restore'); unchanged(target, before);
        }
    } finally {
        for (const directory of [root, ...targets]) {
            assert.equal(path.dirname(path.resolve(directory)), temporary);
            assert(path.basename(directory).startsWith('mia-food-build-'));
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
});
