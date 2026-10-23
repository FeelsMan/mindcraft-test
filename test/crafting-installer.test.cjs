const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const repository = path.resolve(__dirname, '..');
const namedInstaller = path.join(repository, 'scripts/mia-navigation-progress-fix.cjs');
const scriptsInstaller = path.join(repository, 'scripts/mia-crafting-reliability-fix.cjs');
// --test must validate the file actually launched by the user, even when an
// older installer remains elsewhere in their Mindcraft folder.
const installer = process.env.MIA_TEST_INSTALLER || (fs.existsSync(namedInstaller) ? namedInstaller :
    fs.existsSync(scriptsInstaller) ? scriptsInstaller : path.join(repository, 'mia-navigation-progress-fix.cjs'));
const { PAYLOAD, normalize } = require(installer);
const baseline = 'f231c082f0ebeb838c8edb844479db08c477f37b';
const prior = '5f53ba3a859b9b2353af2491bc8ed320fecb377a';
const published = '760145bcba62295d57b82afdec7ad43e73e1a6dd';
const nearbyPublished = '4859a384b97e9a2ee27c6989fe7205eed1c3f4d4';
function gitFile(ref, filename) {
    try { return execFileSync('git', ['show', ref + ':' + filename], {
        cwd: repository, stdio: ['ignore', 'pipe', 'pipe']
    }); } catch { return null; }
}
const hasBaseline = Boolean(gitFile(baseline, 'package.json'));
function fixture(ref = baseline) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-crafting-patch-'));
    const before = new Map();
    for (const entry of PAYLOAD) {
        const bytes = gitFile(ref, entry.path);
        before.set(entry.path, bytes);
        if (bytes !== null) {
            const filename = path.join(root, entry.path);
            fs.mkdirSync(path.dirname(filename), { recursive: true });
            fs.writeFileSync(filename, bytes);
        }
    }
    fs.writeFileSync(path.join(root, 'main.js'), '');
    fs.writeFileSync(path.join(root, 'package.json'), gitFile(ref, 'package.json'));
    const privateFiles = {
        'andy.json': Buffer.from('{"name":"Mia","model":"unchanged-model"}\n'),
        'mia-qwen.json': Buffer.from('{"name":"Mia","model":"mia:qwen9b"}\n'),
        'settings.js': Buffer.from('export default { port: 55916 };\n'),
        'keys.json': Buffer.from('local-keys-sentinel\n'),
        'bots/Mia/memory.json': Buffer.from('{"world":"mia-survival-1","keep":"verified history"}\n'),
        'bots/Mia/memory.sqlite': Buffer.from([0, 1, 255, 13, 10, 42])
    };
    for (const [relative, bytes] of Object.entries(privateFiles)) {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), bytes);
    }
    return { root, before, privateFiles };
}
function run(f, command) {
    return spawnSync(process.execPath, [installer, command], { cwd: f.root, encoding: 'utf8' });
}
function ok(result) {
    assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
}
function assertPrivateUnchanged(f) {
    for (const [relative, bytes] of Object.entries(f.privateFiles))
        assert.deepEqual(fs.readFileSync(path.join(f.root, relative)), bytes, relative);
}
function latest(f) {
    return fs.readFileSync(path.join(f.root, 'mia-goal-backups/crafting-reliability/latest.json'), 'utf8');
}

test('the standalone installer embeds the current source, tests and documentation', () => {
    for (const entry of PAYLOAD)
        assert.equal(normalize(fs.readFileSync(path.join(repository, entry.path))), entry.content, entry.path);
});

test('the published pickup-recovery build upgrades navigation and restores exact bytes while retaining saved memory', {
    skip: !gitFile('38162a579c2d0e8b01235242e99f3eb9d413c6b3', 'package.json')
}, () => {
    const f = fixture('38162a579c2d0e8b01235242e99f3eb9d413c6b3');
    try {
        ok(run(f, '--check')); ok(run(f, '--apply')); ok(run(f, '--verify'));
        assertPrivateUnchanged(f);
        assert.match(fs.readFileSync(path.join(f.root, 'src/agent/navigation_progress.js'), 'utf8'), /class NavigationProgress/);
        assert.match(fs.readFileSync(path.join(f.root, 'src/agent/navigation_recovery.js'), 'utf8'), /gotoWithProgress/);
        ok(run(f, '--restore'));
        for (const [name, bytes] of f.before) {
            if (bytes === null) assert.equal(fs.existsSync(path.join(f.root, name)), false, name);
            else assert.deepEqual(fs.readFileSync(path.join(f.root, name)), bytes, name);
        }
        assertPrivateUnchanged(f);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('the published live-memory build receives pending-pickup recovery and restores exact bytes without touching saved state', {
    skip: !gitFile('bcf96ed452fcbba362de3783674254f2afe86029', 'package.json')
}, () => {
    const f = fixture('bcf96ed452fcbba362de3783674254f2afe86029');
    try {
        ok(run(f, '--check')); ok(run(f, '--apply')); ok(run(f, '--verify'));
        assertPrivateUnchanged(f);
        assert.match(fs.readFileSync(path.join(f.root, 'src/agent/crafting_station.js'), 'utf8'), /retireStationPickup/);
        assert.match(fs.readFileSync(path.join(f.root, 'src/agent/memory_runtime.js'), 'utf8'), /pickup_failed/);
        ok(run(f, '--restore'));
        for (const [name, bytes] of f.before) {
            if (bytes === null) assert.equal(fs.existsSync(path.join(f.root, name)), false, name);
            else assert.deepEqual(fs.readFileSync(path.join(f.root, name)), bytes, name);
        }
        assertPrivateUnchanged(f);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('the published door fix upgrades to live world memory and restores exact source while retaining personal state', {
    skip: !gitFile('882847e501d29499e4a48f2c4a42dd7d2c2a569f', 'package.json')
}, () => {
    const f = fixture('882847e501d29499e4a48f2c4a42dd7d2c2a569f');
    try {
        ok(run(f, '--check')); ok(run(f, '--apply')); ok(run(f, '--verify'));
        assertPrivateUnchanged(f);
        assert(fs.existsSync(path.join(f.root, 'src/agent/world_memory_sync.js')));
        assert.match(fs.readFileSync(path.join(f.root, 'src/models/prompter.js'), 'utf8'), /worldChanged/);
        ok(run(f, '--restore'));
        for (const [name, bytes] of f.before) {
            if (bytes === null) assert.equal(fs.existsSync(path.join(f.root, name)), false, name);
            else assert.deepEqual(fs.readFileSync(path.join(f.root, name)), bytes, name);
        }
        assertPrivateUnchanged(f);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('the nearby-interaction build upgrades to shelter support and restores exact source without touching memory', {
    skip: !gitFile(nearbyPublished, 'package.json')
}, () => {
    const f = fixture(nearbyPublished);
    try {
        ok(run(f, '--check')); ok(run(f, '--apply')); ok(run(f, '--verify'));
        assertPrivateUnchanged(f);
        assert(fs.existsSync(path.join(f.root, 'src/agent/shelter_goal.js')));
        assert.match(fs.readFileSync(path.join(f.root, 'src/agent/commands/actions.js'), 'utf8'), /!shelterGoal/);
        ok(run(f, '--restore'));
        for (const [name, bytes] of f.before) {
            if (bytes === null) assert.equal(fs.existsSync(path.join(f.root, name)), false, name);
            else assert.deepEqual(fs.readFileSync(path.join(f.root, name)), bytes, name);
        }
        assertPrivateUnchanged(f);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('the installed crafting reliability build upgrades without changing profiles or saved memory', {
    skip: !gitFile(published, 'package.json')
}, () => {
    const f = fixture(published);
    try {
        ok(run(f, '--apply')); ok(run(f, '--verify'));
        assertPrivateUnchanged(f);
        ok(run(f, '--restore'));
        for (const [name, bytes] of f.before) {
            if (bytes === null) assert.equal(fs.existsSync(path.join(f.root, name)), false, name);
            else assert.deepEqual(fs.readFileSync(path.join(f.root, name)), bytes, name);
        }
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('installer applies and verifies known source, is idempotent, and preserves profiles/settings/memory', { skip: !hasBaseline }, () => {
    const f = fixture();
    try {
        ok(run(f, '--check')); ok(run(f, '--apply')); ok(run(f, '--verify'));
        assertPrivateUnchanged(f);
        for (const entry of PAYLOAD)
            assert.equal(fs.readFileSync(path.join(f.root, entry.path), 'utf8'), entry.content);
        const first = latest(f);
        ok(run(f, '--apply'));
        assert.equal(latest(f), first, 'Idempotent apply must keep the useful original backup');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('installer restores exact CRLF source bytes and removes files newly added by the patch', { skip: !hasBaseline }, () => {
    const f = fixture();
    try {
        const relative = 'src/models/prompter.js';
        const crlf = Buffer.from(f.before.get(relative).toString('utf8').replace(/\n/g, '\r\n'));
        fs.writeFileSync(path.join(f.root, relative), crlf);
        f.before.set(relative, crlf);
        ok(run(f, '--apply')); ok(run(f, '--restore'));
        for (const [name, bytes] of f.before) {
            if (bytes === null) assert.equal(fs.existsSync(path.join(f.root, name)), false, name);
            else assert.deepEqual(fs.readFileSync(path.join(f.root, name)), bytes, name);
        }
        assertPrivateUnchanged(f);
        ok(run(f, '--restore'));
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('unknown local source is rejected before changing or backing up any file', { skip: !hasBaseline }, () => {
    const f = fixture();
    try {
        const relative = 'src/agent/agent.js';
        const modified = Buffer.concat([f.before.get(relative), Buffer.from('\n// local customization\n')]);
        fs.writeFileSync(path.join(f.root, relative), modified);
        const result = run(f, '--apply');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Unrecognized local source/);
        assert.deepEqual(fs.readFileSync(path.join(f.root, relative)), modified);
        assert.equal(fs.existsSync(path.join(f.root, 'mia-goal-backups/crafting-reliability')), false);
        assertPrivateUnchanged(f);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('the preceding smelting-command build can receive the station prerequisites and the new patch together', {
    skip: !hasBaseline || !gitFile(prior, 'package.json')
}, () => {
    const f = fixture(prior);
    try {
        ok(run(f, '--apply')); ok(run(f, '--verify'));
        assert.equal(fs.existsSync(path.join(f.root, 'src/agent/station_access.js')), true);
        ok(run(f, '--restore'));
        for (const [name, bytes] of f.before) {
            if (bytes === null) assert.equal(fs.existsSync(path.join(f.root, name)), false, name);
            else assert.deepEqual(fs.readFileSync(path.join(f.root, name)), bytes, name);
        }
        assertPrivateUnchanged(f);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('restore refuses to overwrite source edited after the patch was installed', { skip: !hasBaseline }, () => {
    const f = fixture();
    try {
        ok(run(f, '--apply'));
        const filename = path.join(f.root, 'src/models/prompter.js');
        const modified = Buffer.concat([fs.readFileSync(filename), Buffer.from('\n// later edit\n')]);
        fs.writeFileSync(filename, modified);
        const result = run(f, '--restore');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Source changed after installation/);
        assert.deepEqual(fs.readFileSync(filename), modified);
        assertPrivateUnchanged(f);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('corrupted backup bytes fail verification before any restore write', { skip: !hasBaseline }, () => {
    const f = fixture();
    try {
        ok(run(f, '--apply'));
        const session = JSON.parse(latest(f)).session;
        const directory = path.join(f.root, 'mia-goal-backups/crafting-reliability', session);
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
        const original = manifest.files.find(file => file.existed);
        fs.writeFileSync(path.join(directory, original.backupFile), 'corrupted bytes');
        const installed = fs.readFileSync(path.join(f.root, 'src/agent/agent.js'));
        const result = run(f, '--restore');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Backup bytes failed verification/);
        assert.deepEqual(fs.readFileSync(path.join(f.root, 'src/agent/agent.js')), installed);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});


test('a damaged manifest cannot turn an existing source backup into a delete operation', { skip: !hasBaseline }, () => {
    const f = fixture();
    try {
        ok(run(f, '--apply'));
        const session = JSON.parse(latest(f)).session;
        const directory = path.join(f.root, 'mia-goal-backups/crafting-reliability', session);
        const filename = path.join(directory, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
        const original = manifest.files.find(file => file.path === 'src/agent/agent.js');
        original.existed = false;
        fs.writeFileSync(filename, JSON.stringify(manifest));
        const installed = fs.readFileSync(path.join(f.root, 'src/agent/agent.js'));
        const result = run(f, '--restore');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Unexpected backup entry/);
        assert.deepEqual(fs.readFileSync(path.join(f.root, 'src/agent/agent.js')), installed);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('the published shelter build receives the world-awareness update and restores exact bytes without touching memory', {
    skip: !gitFile('455912280ebcd97fe4a231b32ab25fd5db4b858c', 'package.json')
}, () => {
    const f = fixture('455912280ebcd97fe4a231b32ab25fd5db4b858c');
    try {
        ok(run(f, '--check')); ok(run(f, '--apply')); ok(run(f, '--verify'));
        assertPrivateUnchanged(f);
        assert.match(fs.readFileSync(path.join(f.root, 'src/agent/live_inventory.js'), 'utf8'), /CURRENT WORLD OBSERVATION/);
        assert.match(fs.readFileSync(path.join(f.root, 'src/agent/commands/actions.js'), 'utf8'), /!resetShelter/);
        ok(run(f, '--restore'));
        for (const [name, bytes] of f.before) {
            if (bytes === null) assert.equal(fs.existsSync(path.join(f.root, name)), false, name);
            else assert.deepEqual(fs.readFileSync(path.join(f.root, name)), bytes, name);
        }
        assertPrivateUnchanged(f);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('the published world-awareness build upgrades door recognition and restores exact bytes while preserving saved progress', {
    skip: !gitFile('71b0308747a891404986a4623e65606f9a9d2639', 'package.json')
}, () => {
    const f = fixture('71b0308747a891404986a4623e65606f9a9d2639');
    try {
        ok(run(f, '--check')); ok(run(f, '--apply')); ok(run(f, '--verify'));
        assertPrivateUnchanged(f);
        assert.match(fs.readFileSync(path.join(f.root, 'src/agent/shelter_building.js'), 'utf8'), /geometryKnown/);
        ok(run(f, '--restore'));
        for (const [name, bytes] of f.before) {
            if (bytes === null) assert.equal(fs.existsSync(path.join(f.root, name)), false, name);
            else assert.deepEqual(fs.readFileSync(path.join(f.root, name)), bytes, name);
        }
        assertPrivateUnchanged(f);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
