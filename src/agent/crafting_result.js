import { captureInventory } from './live_inventory.js';

export function craftItemCount(bot, item) {
    const inventory = captureInventory(bot);
    return inventory.available ? inventory.counts[item] || 0 : null;
}

export async function waitForCraftOutput(bot, item, minimum, timeoutMs = 1200) {
    const deadline = Date.now() + timeoutMs;
    while (!bot.interrupt_code) {
        const count = craftItemCount(bot, item);
        if (count === null) return { verified: false, count: null };
        if (count >= minimum) return { verified: true, count };
        if (Date.now() >= deadline) return { verified: false, count };
        await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
    return { verified: false, count: craftItemCount(bot, item) };
}

export function craftingReceipt({ item, requested, submitted, outputPerBatch, before, after, verified, reason = '' }) {
    const gain = before === null || after === null ? null : after - before;
    const verifiedBatches = gain === null ? 0 :
        Math.min(submitted, Math.floor(Math.max(0, gain) / outputPerBatch));
    const status = verified ? 'Crafting output verified' : 'Crafting output NOT fully verified';
    return status + ' for ' + item + '.\n' +
        'Recipe batches requested: ' + requested + '; submitted to crafting: ' + submitted +
        '; complete batch outputs observed: ' + verifiedBatches + '.\n' +
        'Output per recipe batch: ' + outputPerBatch + ' ' + item + ' item(s). ' +
        'Observed inventory gain: ' + (gain === null ? 'unavailable' : gain) + ' ' + item + ' item(s). ' +
        'Current carried inventory total: ' + (after === null ? 'unavailable' : after) + ' ' + item + '.' +
        (reason ? '\n' + reason : '');
}
