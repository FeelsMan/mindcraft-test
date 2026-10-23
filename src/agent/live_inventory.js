// Fresh carried inventory for model decisions. Never persist this as memory.
export function captureInventory(bot) {
    const dimension = String(bot?.game?.dimension ?? 'unknown');
    if (typeof bot?.inventory?.items !== 'function')
        return { available: false, counts: {}, fingerprint: 'unavailable', dimension };
    try {
        const counts = Object.create(null);
        for (const item of bot.inventory.items()) {
            if (!item || typeof item.name !== 'string' ||
                !Number.isSafeInteger(item.count) || item.count <= 0) continue;
            counts[item.name] = (counts[item.name] || 0) + item.count;
        }
        const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
        return { available: true, counts: Object.fromEntries(entries),
            fingerprint: JSON.stringify(entries), dimension };
    } catch {
        return { available: false, counts: {}, fingerprint: 'unavailable', dimension };
    }
}

export function inventoryContext(snapshot) {
    if (!snapshot.available)
        return 'CURRENT LIVE INVENTORY: unavailable. Do not infer current item counts from chat history or claim that you checked them.';
    const lines = [
        'CURRENT LIVE INVENTORY — captured from the game for this decision:',
        ...Object.entries(snapshot.counts).map(([name, count]) => '- ' + name + ': ' + count)
    ];
    if (!Object.keys(snapshot.counts).length) lines.push('- No carried items.');
    lines.push('Every unlisted carried item has a current count of 0.',
        'This snapshot supersedes ALL inventory counts, crafting totals and transfer claims in earlier messages, memory and examples.',
        'A successful givePlayer transfers the item out of your inventory; "Discarded" in its older output means the item was dropped for delivery.',
        'For a supported crafting request, use !makeGoal with the TOTAL amount to keep. The planner obtains missing ingredients and verifies the result.',
        'A recipe batch is different from an item: one stick batch produces 4 sticks; one oak_planks batch produces 4 planks.',
        'Report only what the latest live state and verified tool output establish. Do not claim an item is present because you made it earlier.');
    return lines.join('\n');
}

// Native game observations, not remembered descriptions or screenshot vision.
// Searches cover only nearby loaded blocks. Finding a block does not prove a
// safe route or an unobstructed interaction face.
export function captureWorld(bot) {
    bot?.worldMemory?.refresh();
    const finite = n => typeof n === 'number' && Number.isFinite(n);
    const p = bot?.entity?.position;
    const position = p && [p.x, p.y, p.z].every(finite) ? { x: p.x, y: p.y, z: p.z } : null;
    const blockView = block => block?.name && block.position ? {
        name: block.name, position: { x: block.position.x, y: block.position.y, z: block.position.z },
        properties: block.getProperties?.() || {}
    } : null;
    const state = { observedAt: new Date().toISOString(), dimension: String(bot?.game?.dimension ?? 'unknown'),
        position, health: finite(bot?.health) ? bot.health : null, hunger: finite(bot?.food) ? bot.food : null,
        yaw: finite(bot?.entity?.yaw) ? bot.entity.yaw : null, pitch: finite(bot?.entity?.pitch) ? bot.entity.pitch : null,
        aim: null, aimAvailable: false, nearby: [], nearbyAvailable: false };
    const watched = [];
    if (position && typeof bot.blockAtCursor === 'function') {
        try { const block = bot.blockAtCursor(4); watched.push(block); state.aim = blockView(block); state.aimAvailable = true; } catch {}
    }
    if (position && typeof bot.findBlocks === 'function' && typeof bot.blockAt === 'function') {
        for (const [names, count] of [
            [['crafting_table', 'furnace', 'blast_furnace', 'smoker'], 4],
            [['iron_ore', 'deepslate_iron_ore', 'coal_ore', 'deepslate_coal_ore', 'copper_ore', 'deepslate_copper_ore'], 8],
            [['oak_door'], 2]
        ]) {
            const matching = names.map(name => bot.registry?.blocksByName?.[name]?.id).filter(Number.isInteger);
            if (!matching.length) continue;
            try {
                const found = bot.findBlocks({ matching, maxDistance: 12, count });
                for (const at of found) {
                    const native = bot.blockAt(at), block = blockView(native);
                    watched.push(native);
                    if (block && names.includes(block.name)) state.nearby.push(block);
                }
                state.nearbyAvailable = true;
            } catch {}
        }
    }
    for (const block of watched.filter(Boolean)) bot?.worldMemory?.observe(block);
    bot?.worldMemory?.watchDecision(watched);
    state.memoryToken = bot?.worldMemory?.token();
    state.memoryStatus = bot?.worldMemory?.lines() || [];
    return state;
}

export function worldChanged(bot, state) {
    return Boolean(bot?.worldMemory?.decisionChanged(state?.memoryToken));
}

export function worldContext(state) {
    if (!state) return '';
    const point = p => p ? [p.x, p.y, p.z].map(n => Math.round(n * 100) / 100).join(', ') : 'unavailable';
    const angle = n => n === null ? 'unavailable' : String(Math.round(n * 180 / Math.PI));
    const describe = block => block.name + ' at ' + point(block.position) +
        (Object.keys(block.properties || {}).length ? ' ' + JSON.stringify(block.properties) : '');
    const lines = ['CURRENT WORLD OBSERVATION — ' + state.observedAt + ':',
        'Dimension: ' + state.dimension + '; feet position: ' + point(state.position) + '.',
        'Health: ' + (state.health ?? 'unavailable') + '; hunger: ' + (state.hunger ?? 'unavailable') + '.',
        'Minecraft yaw: ' + angle(state.yaw) + ' degrees; pitch: ' + angle(state.pitch) + ' degrees.',
        'Block currently aimed at within 4 blocks: ' + (!state.aimAvailable ? 'unavailable' : state.aim ?
            describe(state.aim) : 'no block hit') + '.',
        'Nearby loaded workstations, ores and oak doors (within 12 blocks; limited sample; reachability unproven):'];
    for (const block of state.nearby) lines.push('- ' + describe(block));
    if (!state.nearby.length) lines.push(state.nearbyAvailable ? '- No matches in the bounded scan.' : '- Scan unavailable.');
    lines.push('These observations supersede older positions, directions and block descriptions in memory and examples.',
        'World blocks can change. Recheck the actual block, support and route before using a remembered location. A failed route does not mean a block is absent.');
    if (state.memoryStatus?.length) lines.push('CURRENT WORLD-TO-MEMORY STATUS (supersedes historical location claims):',
        ...state.memoryStatus.map(line => '- ' + line));
    return lines.join('\n');
}

export function groundInventory(messages, snapshot, world) {
    // Append only to this model request. Old action receipts stay historical;
    // neither history nor persistent memory is rewritten with temporary state.
    return [...messages, { role: 'system', content: [inventoryContext(snapshot), worldContext(world)].filter(Boolean).join('\n\n') }];
}

export function inventoryChanged(bot, snapshot) {
    const latest = captureInventory(bot);
    return latest.available !== snapshot.available || latest.fingerprint !== snapshot.fingerprint || latest.dimension !== snapshot.dimension;
}
