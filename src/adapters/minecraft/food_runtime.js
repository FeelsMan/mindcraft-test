import * as skills from '../../agent/library/skills.js';
import { getItemCraftingRecipes } from '../../utils/mcdata.js';
import { hasReusableTable } from '../../agent/crafting_station.js';
import { getNearestBlock } from '../../agent/library/world.js';
import { createFoodAPI } from './food.js';

export function foodRuntime(agent, options = {}) {
    const production = {
        resourceRecovery: true, recipes: getItemCraftingRecipes,
        hasTable: bot => skills.getCraftingStation(bot).available() || Boolean(getNearestBlock(bot, 'crafting_table', 16)),
        hasOwnedTable: bot => { skills.getCraftingStation(bot); return hasReusableTable(bot); },
        recoverTable: bot => bot.craftingStation.pack(),
        hasFurnace: bot => skills.getManagedFurnace(bot).available(),
        furnaceSnapshot: bot => skills.getManagedFurnace(bot).snapshot,
        inspectFurnace: skills.inspectManagedFurnace, smelt: skills.smeltManaged,
        collect: skills.collectBlock, craft: skills.craftRecipe,
        pickup: (bot, item) => skills.pickupNearbyItems(bot, { itemName: item }),
        navigation: bot => skills.getManagedTravel(bot),
        ...options
    };
    return { ...production, food: createFoodAPI(agent, { ...skills, ...production }, options) };
}
