import { knownShelter, shelterBlueprint } from './shelter_blueprint.js';

const urgentModes = new Set(['self_preservation', 'cowardice', 'self_defense']);
const ingredients = ['cobblestone', 'oak_log', 'oak_planks', 'oak_door', 'stick', 'crafting_table', 'furnace', 'raw_iron', 'iron_ingot', 'coal', 'charcoal'];

// Pathfinder calls these "scafoldingBlocks" (one f). Protect recipe supplies
// during routine movement, including unstuck. Actual combat/escape may spend
// them; the managed goal will then replan from the surviving inventory.
export function protectCraftingMaterials(bot, movements) {
    const urgent = (bot.modes?.getActiveModes?.() || []).some(name => urgentModes.has(name));
    const home = !urgent && knownShelter(bot);
    if (home) {
        const plan = shelterBlueprint(home), reserved = new Set(plan.blocks.map(s => s.position.toString()));
        reserved.add(plan.door.toString()); reserved.add(plan.door.offset(0, 1, 0).toString());
        for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) reserved.add(plan.origin.offset(x, -1, z).toString());
        movements.exclusionAreasBreak ??= [];
        movements.exclusionAreasBreak.push(block => reserved.has(block.position?.toString()) ? 100 : 0);
    }
    const goal = bot.craftingGoal || bot.managedGoal;
    if (!goal?.active || urgent) return movements;
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
    // Pathfinder measures a drop to the landing SUPPORT block, not the feet.
    // A normal one-block step down therefore needs 2; 1 strands the bot on
    // ledges/roofs. This still rejects a two-block downward step.
    movements.maxDropDown = 2;
    return movements;
}
