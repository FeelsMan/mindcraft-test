const urgentModes = new Set(['self_preservation', 'cowardice', 'self_defense']);
const ingredients = ['cobblestone', 'oak_log', 'oak_planks', 'stick', 'crafting_table', 'furnace', 'raw_iron', 'iron_ingot', 'coal', 'charcoal'];

// Pathfinder calls these "scafoldingBlocks" (one f). Protect recipe supplies
// during routine movement, including unstuck. Actual combat/escape may spend
// them; the managed goal will then replan from the surviving inventory.
export function protectCraftingMaterials(bot, movements) {
    const goal = bot.craftingGoal || bot.managedGoal;
    if (!goal?.active ||
        (bot.modes?.getActiveModes?.() || []).some(name => urgentModes.has(name))) return movements;
    const reserved = new Set([...ingredients, goal.item].map(name => bot.registry?.itemsByName?.[name]?.id));
    movements.scafoldingBlocks = movements.scafoldingBlocks.filter(id => !reserved.has(id));
    movements.allow1by1towers = false;
    return movements;
}

export function safeMiningMovements(movements) {
    movements.canDig = false;
    movements.scafoldingBlocks = [];
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.maxDropDown = 1;
    return movements;
}
