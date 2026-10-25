const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/configure-memory-default.cjs');
const original = Buffer.from('const settings = {\r\n    "port": 55916,\r\n    "load_memory": false, // remember Mia\r\n    "profiles": ["./mia-qwen.json"]\r\n};\r\nexport default settings;\r\n');
function fixture(t, settings = original) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-startup-memory-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'settings.js'), settings);
    fs.writeFileSync(path.join(root, 'main.js'), '');
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.mkdirSync(path.join(root, 'bots/Mia'), { recursive: true });
    const memory = Buffer.from([0, 255, 13, 10, 42]);
    fs.writeFileSync(path.join(root, 'bots/Mia/memory.sqlite'), memory);
    const run = command => spawnSync(process.execPath, [script, command], { cwd: root, encoding: 'utf8' });
    return { root, run, memory, settings: () => fs.readFileSync(path.join(root, 'settings.js')) };
}
function ok(result) { assert.equal(result.status, 0, result.stdout + result.stderr); }

test('enable changes only startup memory, preserves CRLF/private state, is idempotent and restores exact settings', t => {
    const f = fixture(t);
    ok(f.run('--enable'));
    assert.deepEqual(f.settings(), Buffer.from(original.toString().replace('false', 'true')));
    const latest = fs.readFileSync(path.join(f.root, 'mia-goal-backups/memory-default/latest.json'));
    ok(f.run('--enable'));
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'mia-goal-backups/memory-default/latest.json')), latest);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'bots/Mia/memory.sqlite')), f.memory);
    ok(f.run('--restore')); assert.deepEqual(f.settings(), original);
    ok(f.run('--restore'));
});

test('restore refuses to overwrite settings edited after memory was enabled', t => {
    const f = fixture(t); ok(f.run('--enable'));
    const newer = Buffer.from(f.settings().toString().replace('55916', '55917'));
    fs.writeFileSync(path.join(f.root, 'settings.js'), newer);
    const result = f.run('--restore'); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /newer settings retained/);
    assert.deepEqual(f.settings(), newer);
});

test('ambiguous or invalid settings are rejected without changing settings or memory', t => {
    for (const source of ['export default {};', 'const s = {\n load_memory: false,\n load_memory: false\n};', 'const s = {\n load_memory: false,\n broken syntax\n};']) {
        const f = fixture(t, Buffer.from(source));
        assert.notEqual(f.run('--enable').status, 0);
        assert.equal(f.settings().toString(), source);
        assert.deepEqual(fs.readFileSync(path.join(f.root, 'bots/Mia/memory.sqlite')), f.memory);
    }
});
