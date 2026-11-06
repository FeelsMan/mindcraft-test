// Shared food accounting. Raw meat/fish and planting supplies are not a
// prepared reserve; never count hypothetical drops or furnace input as food.
const excluded = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish',
    'suspicious_stew', 'chorus_fruit', 'ominous_bottle', 'beef', 'porkchop', 'mutton',
    'chicken', 'rabbit', 'cod', 'salmon', 'tropical_fish', 'potato']);

export function foodItems(bot, context = {}) {
    if (!bot.inventory?.items || !bot.registry?.foodsByName) return [];
    const pending = context.replantPending;
    let reserved = pending?.seed ? 1 : 0;
    return bot.inventory.items().filter(item => {
        if (!(item?.count > 0) || excluded.has(item.name) ||
            !(bot.registry.foodsByName[item.name]?.foodPoints > 0) || item.name.endsWith('_bucket')) return false;
        if (reserved && item.name === pending.seed) {
            reserved--;
            if (item.count === 1) return false;
        }
        return true;
    });
}

export function countFood(bot, context = {}) {
    // A pending crop seed is reserved once across inventory stacks.
    const pending = context.replantPending;
    const count = foodItems(bot).reduce((n, item) => n + item.count, 0);
    return Math.max(0, count - (pending && foodItems(bot).some(i => i.name === pending.seed) ? 1 : 0));
}

const position = p => p && [p.x, p.y, p.z].every(Number.isFinite) &&
    Math.abs(p.x) <= 30000000 && Math.abs(p.z) <= 30000000 && Math.abs(p.y) <= 4096;

export function restoreFoodProgress(data = {}) {
    const result = {};
    const p = data?.replantPending;
    if (p && ['wheat', 'carrots', 'potatoes', 'beetroots'].includes(p.block) &&
        ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds'].includes(p.seed) && position(p.position) &&
        typeof p.scope?.world === 'string' && typeof p.scope.dimension === 'string')
        result.replantPending = { kind: 'replant', block: p.block, item: p.item, seed: p.seed,
            position: { x: p.position.x, y: p.position.y, z: p.position.z }, scope: { ...p.scope } };
    const s = data?.foodSearch;
    if (s && position(s.origin) && Number.isSafeInteger(s.attempts) && s.attempts >= 0 && s.attempts <= 16 &&
        typeof s.world === 'string' && typeof s.dimension === 'string')
        result.foodSearch = { world: s.world, dimension: s.dimension, origin: { ...s.origin },
            attempts: s.attempts, visited: (Array.isArray(s.visited) ? s.visited : []).filter(position)
                .slice(0, 16).map(p => ({ x: p.x, y: p.y, z: p.z })) };
    result.foodActions = Number.isSafeInteger(data?.foodActions) && data.foodActions >= 0 ? Math.min(256, data.foodActions) : 0;
    result.foodFailures = Number.isSafeInteger(data?.foodFailures) && data.foodFailures >= 0 ? Math.min(3, data.foodFailures) : 0;
    result.foodRejected = (Array.isArray(data?.foodRejected) ? data.foodRejected : []).filter(s => typeof s === 'string' && s.length <= 160).slice(0, 16);
    if (Number.isSafeInteger(data?.foodDeadline) && data.foodDeadline > 0) result.foodDeadline = data.foodDeadline;
    return result;
}
