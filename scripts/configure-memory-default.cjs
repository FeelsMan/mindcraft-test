#!/usr/bin/env node
'use strict';

// Explicit, field-only settings update for installer users. Never import or
// replace the user's full configuration, profile, JSON memory or SQLite data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function safePath(root, relative) {
    let next = root;
    for (const part of relative.split('/')) {
        next = path.join(next, part);
        if (fs.existsSync(next) && fs.lstatSync(next).isSymbolicLink()) throw Error('Refusing a symbolic-link settings or backup path.');
    }
    return next;
}
function atomicWrite(filename, bytes) {
    const temporary = filename + '.mia-' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, bytes, { flag: 'wx' }); fs.renameSync(temporary, filename); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function enable(root) {
    const filename = safePath(root, 'settings.js'), original = fs.readFileSync(filename), text = original.toString('utf8');
    if (!Buffer.from(text).equals(original)) throw Error('Settings must be UTF-8; nothing changed.');
    const pattern = /^([\t ]*(?:"load_memory"|'load_memory'|load_memory)[\t ]*:[\t ]*)(true|false)(?=[\t ]*(?:,|(?:\/\/[^\r\n]*)?\r?$))/gm;
    const matches = [...text.matchAll(pattern)];
    if (matches.length !== 1) throw Error('Expected one standalone load_memory boolean in settings.js; nothing changed.');
    if (matches[0][2] === 'true') { console.log('Startup memory loading is already enabled.'); return; }
    const enabled = Buffer.from(text.replace(pattern, (_match, prefix) => prefix + 'true'));
    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: enabled, encoding: 'utf8' });
    if (syntax.error || syntax.status !== 0) throw Error('Settings syntax check failed; nothing changed.');
    const base = safePath(root, 'mia-goal-backups/memory-default');
    const session = crypto.randomUUID(), directory = path.join(base, session);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'original.js'), original, { flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ before: digest(original), after: digest(enabled) }), { flag: 'wx' });
    if (digest(fs.readFileSync(filename)) !== digest(original)) throw Error('Settings changed during backup; newer settings retained.');
    atomicWrite(filename, enabled);
    try { atomicWrite(path.join(base, 'latest.json'), Buffer.from(JSON.stringify({ session }))); }
    catch (error) {
        if (digest(fs.readFileSync(filename)) === digest(enabled)) atomicWrite(filename, original);
        throw error;
    }
    console.log('Startup memory loading enabled. Only load_memory changed; original settings backed up.');
}
function restore(root) {
    const filename = safePath(root, 'settings.js'), base = safePath(root, 'mia-goal-backups/memory-default');
    const { session } = JSON.parse(fs.readFileSync(path.join(base, 'latest.json'), 'utf8'));
    if (typeof session !== 'string' || !/^[a-f0-9-]{36}$/.test(session)) throw Error('Invalid memory-settings backup.');
    safePath(root, 'mia-goal-backups/memory-default/' + session);
    const manifest = JSON.parse(fs.readFileSync(safePath(root, 'mia-goal-backups/memory-default/' + session + '/manifest.json'), 'utf8'));
    const original = fs.readFileSync(safePath(root, 'mia-goal-backups/memory-default/' + session + '/original.js'));
    if (digest(original) !== manifest.before) throw Error('Memory-settings backup failed verification.');
    const current = fs.readFileSync(filename);
    if (digest(current) === manifest.before) { console.log('Original memory settings already restored.'); return; }
    if (digest(current) !== manifest.after) throw Error('Settings changed since enabling memory; newer settings retained.');
    atomicWrite(filename, original);
    console.log('Restored the exact original settings bytes.');
}
if (require.main === module) {
    try {
        const args = process.argv.slice(2), root = fs.realpathSync(process.cwd());
        if (args.length !== 1 || !['--enable', '--restore'].includes(args[0])) throw Error('Usage: node scripts/configure-memory-default.cjs --enable|--restore');
        if (!fs.existsSync(path.join(root, 'main.js')) || !fs.existsSync(path.join(root, 'package.json'))) throw Error('Run from the Mindcraft folder with Mia stopped.');
        if (args[0] === '--enable') enable(root); else restore(root);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { enable, restore };
