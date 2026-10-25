const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const builder = require('../scripts/build-survival-installer.cjs');
const currentPath = path.resolve(__dirname, '../scripts/mia-survival-supervisor-update.cjs');
const current = require(currentPath);

test('successive default rebuilds retain installed Survival source and exact rollback', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-build-source-'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-build-target-'));
    const write = (base, relative, bytes) => {
        const filename = path.join(base, relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes);
    };
    try {
        for (const entry of current.PAYLOAD) for (const base of [root, target]) write(base, entry.path, entry.content);
        for (const relative of current.TEST_FILES) write(root, relative, fs.readFileSync(path.resolve(__dirname, '..', relative)));
        for (const base of [root, target]) { write(base, 'main.js', ''); write(base, 'package.json', '{"type":"module"}'); }
        write(root, 'scripts/mia-survival-supervisor-update.cjs', fs.readFileSync(currentPath));
        const source = 'src/supervisors/survival.js';
        for (let build = 1; build <= 2; build++) {
            fs.appendFileSync(path.join(root, source), `\n// next recovery revision ${build}\n`);
            const options = builder.argumentsOf(['--root', root]);
            assert.equal(options.template, path.join(root, 'scripts/mia-survival-supervisor-update.cjs'));
            builder.build(options);
        }
        const installer = path.join(root, 'scripts/mia-survival-supervisor-update.cjs');
        const run = command => {
            const result = spawnSync(process.execPath, [installer, command], { cwd: target, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr + result.stdout);
        };
        run('--check'); run('--apply'); run('--verify');
        assert.equal(fs.readFileSync(path.join(target, source), 'utf8'), fs.readFileSync(path.join(root, source), 'utf8'));
        run('--restore');
        for (const entry of current.PAYLOAD) assert.equal(fs.readFileSync(path.join(target, entry.path), 'utf8'), entry.content);
    } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(target, { recursive: true, force: true }); }
});
