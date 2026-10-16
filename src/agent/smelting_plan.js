export const smeltingRecipes = Object.freeze({ iron_ingot: 'raw_iron', charcoal: 'oak_log' });
export const ironPickaxes = new Set(['copper', 'stone', 'iron', 'diamond', 'netherite'].map(tier => tier + '_pickaxe'));
export const fuelTicks = name => name === 'coal' || name === 'charcoal' ? 1600 :
    typeof name === 'string' && name.endsWith('_planks') ? 300 : 0;
export const SMELT_TICKS = 200;

export function furnaceEnergy(snapshot, now = Date.now()) {
    if (!snapshot) return 0;
    const elapsed = Math.max(0, now - (snapshot.observedAt || now)) / 50;
    return Math.max(0, (snapshot.burnTicks || 0) - elapsed) +
        fuelTicks(snapshot.fuel?.name) * (snapshot.fuel?.count || 0);
}

export function furnacePending(snapshot, output) {
    if (!snapshot) return 0;
    const input = smeltingRecipes[output];
    if (snapshot.input && snapshot.input.name !== input || snapshot.output && snapshot.output.name !== output)
        throw new Error('Owned furnace contains another recipe. Clear its input/output before resuming this goal.');
    return (snapshot.input?.count || 0) + (snapshot.output?.count || 0);
}

// Spend existing fuel in the virtual inventory before asking for new planks.
// Output charcoal is reserved when charcoal itself is the target.
export function reserveFuel(stock, ticks, output) {
    let remaining = Math.max(0, ticks);
    const names = ['coal', ...(output === 'charcoal' ? [] : ['charcoal']),
        ...Object.keys(stock).filter(name => name.endsWith('_planks'))];
    for (const name of [...new Set(names)]) {
        const units = Math.min(stock[name] || 0, Math.ceil(remaining / fuelTicks(name)));
        stock[name] = (stock[name] || 0) - units;
        remaining = Math.max(0, remaining - units * fuelTicks(name));
    }
    return Math.ceil(remaining / 300);
}
