#!/usr/bin/env node
'use strict';

// Rebuild the cumulative distribution only after the source/tests/docs settle.
// Existing accepted source hashes and the established exact-byte rollback
// engine are retained. No live bot data or private runtime settings are read.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BASELINE = 'e81fcab25d0f31fa0e1527b9a55ee4a7af2f8cec';
const RELEASE_ID = 'mia-survival-recovery-2026-10-24';
const NEW_FILES = [
    'src/supervisors/survival.js',
    'src/adapters/minecraft/survival.js',
    'src/agent/modes.js',
    'src/adapters/minecraft/supervisor.js',
    'src/core/mainSupervisor.js',
    'src/core/worldState.js',
    'src/agent/managed_goal.js',
    'src/agent/action_manager.js',
    'src/agent/agent.js',
    'test/survival-supervisor.test.js',
    'test/survival-adapter.test.js',
    'docs/mia-survival.md'
];
const NEW_TESTS = ['test/survival-supervisor.test.js', 'test/survival-adapter.test.js'];

function argumentsOf(argv) {
    const options = { root: path.resolve(__dirname, '..'), baseline: BASELINE, extra: [] };
    for (let i = 0; i < argv.length; i++) {
        const value = argv[i];
        if (['--root', '--history-root', '--template', '--baseline'].includes(value)) {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('Missing value for ' + value);
            options[({ '--root': 'root', '--history-root': 'historyRoot', '--template': 'template', '--baseline': 'baseline' })[value]] = argv[++i];
        } else if (value.startsWith('--')) throw Error('Unknown option: ' + value);
        else options.extra.push(value);
    }
    options.root = path.resolve(options.root);
    options.historyRoot = path.resolve(options.historyRoot ||
        (fs.existsSync(path.join(options.root, '.mia-development/survival-v1/.git')) ?
            path.join(options.root, '.mia-development/survival-v1') : options.root));
    // Extend the current distribution so its installed source remains an
    // accepted upgrade baseline, including files introduced by Survival v1.
    const templates = ['scripts/mia-survival-supervisor-update.cjs', 'mia-survival-supervisor-update.cjs',
        'scripts/mia-shelter-repair-update.cjs', 'mia-shelter-repair-update.cjs'];
    options.template = path.resolve(options.template ||
        templates.map(relative => path.join(options.root, relative)).find(filename => fs.existsSync(filename)) ||
        path.join(options.root, templates[2]));
    if (!Array.isArray(options.extra)) throw Error('Extra source paths must be an array.');
    return options;
}

function sourcePath(root, relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') ||
        relative.split('/').some(part => !part || part === '.' || part === '..'))
        throw Error('Unsafe source path: ' + relative);
    if (relative === 'MIA_PROJECT.md' || relative === 'AGENTS.md' ||
        (!/^(src|test|docs|scripts|profiles\/defaults)\//.test(relative) && relative !== 'package.json'))
        throw Error('File is outside the distributable source/test/documentation scope: ' + relative);
    const filename = path.resolve(root, relative);
    if (!filename.startsWith(root + path.sep)) throw Error('Source path leaves the project: ' + relative);
    let next = root;
    for (const part of relative.split('/')) {
        next = path.join(next, part);
        if (fs.existsSync(next) && fs.lstatSync(next).isSymbolicLink())
            throw Error('Refusing a symbolic-link source: ' + relative);
    }
    return filename;
}

function originalFile(options, relative) {
    try {
        return execFileSync('git', ['show', options.baseline + ':' + relative],
            { cwd: options.historyRoot, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
    } catch {
        // A missing path is expected for new Survival files. First establish
        // that the requested baseline itself exists so unavailable history
        // cannot be mistaken for a genuinely new file.
        execFileSync('git', ['cat-file', '-e', options.baseline + '^{commit}'],
            { cwd: options.historyRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        return null;
    }
}

function build(options) {
    // A caller may build twice in one process after source changes. Reload
    // the on-disk payload instead of losing the preceding build's hashes.
    delete require.cache[require.resolve(options.template)];
    const template = require(options.template);
    const engine = fs.readFileSync(options.template, 'utf8');
    const entries = new Map(template.PAYLOAD.map(entry => [entry.path, { ...entry, before: [...entry.before] }]));
    for (const relative of new Set([...entries.keys(), ...NEW_FILES, ...options.extra])) {
        const filename = sourcePath(options.root, relative);
        if (!fs.existsSync(filename) || !fs.statSync(filename).isFile())
            throw Error('Required source file is missing: ' + relative);
        let entry = entries.get(relative);
        if (!entry) {
            const original = originalFile(options, relative);
            entry = { path: relative, content: '', before: [], allowMissing: original === null };
            if (original !== null) entry.before.push(template.gitHash(original));
            entries.set(relative, entry);
        } else {
            entry.before.push(template.gitHash(Buffer.from(entry.content)));
        }
        entry.content = template.normalize(fs.readFileSync(filename));
        entry.before = [...new Set(entry.before)];
    }
    const payload = [...entries.values()];
    const tests = [...new Set([...template.TEST_FILES, ...NEW_TESTS])];
    for (const relative of tests) {
        if (!fs.existsSync(sourcePath(options.root, relative))) throw Error('Required test file is missing: ' + relative);
    }
    for (const pattern of [/^const RELEASE_ID = .*;$/m, /^const PAYLOAD = .*;$/m, /^const TEST_FILES = .*;$/m]) {
        if (!pattern.test(engine)) throw Error('Unexpected installer template structure: ' + pattern);
    }
    // Change user-facing labels before inserting payload, so historical release
    // documentation and accepted embedded source remain byte-for-byte intact.
    const output = engine.replace(/Shelter-repair/g, 'Survival Supervisor')
        .replace(/^const RELEASE_ID = .*;$/m, () => 'const RELEASE_ID = ' + JSON.stringify(RELEASE_ID) + ';')
        .replace(/^const PAYLOAD = .*;$/m, () => 'const PAYLOAD = ' + JSON.stringify(payload) + ';')
        .replace(/^const TEST_FILES = .*;$/m, () => 'const TEST_FILES = ' + JSON.stringify(tests) + ';');
    const destinations = ['scripts/mia-survival-supervisor-update.cjs', 'mia-survival-supervisor-update.cjs'];
    for (const relative of destinations) {
        const filename = path.join(options.root, relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, output);
    }
    console.log('Built ' + RELEASE_ID + ': ' + payload.length + ' payload files; ' + tests.length + ' regression files.');
    console.log(destinations.map(relative => path.join(options.root, relative)).join('\n'));
    return { payload, tests, destinations };
}

module.exports = { BASELINE, RELEASE_ID, NEW_FILES, NEW_TESTS, argumentsOf, build };
if (require.main === module) {
    try { build(argumentsOf(process.argv.slice(2))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
