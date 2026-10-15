#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function configureMemory(root, bot, worldId) {
    if (typeof bot !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(bot)) throw new Error('Bot name must be a Minecraft username.');
    if (typeof worldId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(worldId)) throw new Error('World ID must be 1–64 letters, digits, underscores or hyphens.');
    const filename = path.join(root, 'bots', bot, 'memory-config.json');
    const previous = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {};
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('Invalid existing memory config; no changes made.');
    const config = { enabled: true, resume_goals: true, embeddings: true, ...previous, world_id: worldId };
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = filename + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(temporary, filename);
    return filename;
}
module.exports = { configureMemory };
if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        const value = flag => args[args.indexOf(flag) + 1];
        if (!args.includes('--world-id')) throw new Error('Usage: node scripts/configure-memory.cjs --world-id mia-survival-1 [--bot Mia]');
        const filename = configureMemory(process.cwd(), args.includes('--bot') ? value('--bot') : 'Mia', value('--world-id'));
        console.log('Local memory configured: ' + filename + '\nUse the same world ID after restarting; change it before joining a different world.');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
