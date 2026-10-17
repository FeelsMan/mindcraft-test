// Fresh carried inventory for model decisions. Never persist this as memory.
export function captureInventory(bot) {
    if (typeof bot?.inventory?.items !== 'function')
        return { available: false, counts: {}, fingerprint: 'unavailable' };
    try {
        const counts = Object.create(null);
        for (const item of bot.inventory.items()) {
            if (!item || typeof item.name !== 'string' ||
                !Number.isSafeInteger(item.count) || item.count <= 0) continue;
            counts[item.name] = (counts[item.name] || 0) + item.count;
        }
        const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
        return { available: true, counts: Object.fromEntries(entries),
            fingerprint: JSON.stringify(entries) };
    } catch {
        return { available: false, counts: {}, fingerprint: 'unavailable' };
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

export function groundInventory(messages, snapshot) {
    // Append only to this model request. Old action receipts stay historical;
    // neither history nor persistent memory is rewritten with temporary state.
    return [...messages, { role: 'system', content: inventoryContext(snapshot) }];
}

export function inventoryChanged(bot, snapshot) {
    const latest = captureInventory(bot);
    return latest.available !== snapshot.available || latest.fingerprint !== snapshot.fingerprint;
}
