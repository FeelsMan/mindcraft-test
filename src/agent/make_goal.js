import { countItem } from './gather_goal.js';
import { collectAndVerify, waitForInventory, waitForGoalTurn } from './managed_goal.js';

const tools = new Set(['wooden_axe', 'wooden_pickaxe', 'wooden_shovel', 'wooden_hoe', 'wooden_sword']);
export const supportedItems = new Set(['oak_planks', 'stick', 'crafting_table', ...tools]);

// Pure planner: reserve every ingredient in a virtual inventory, including
// ingredients used for the crafting table. Recipe output counts are batch sizes.
export function planMake(item, target, inventory, nearbyTable, recipesFor) {
    if (!supportedItems.has(item)) throw new Error('Supported: oak_planks, stick, crafting_table, and wooden tools.');
    if (!Number.isSafeInteger(target) || target < 1 || target > 64) throw new Error('Target must be 1 to 64 total items.');
    const stock = { ...inventory };
    const steps = [];
    if ((stock[item] || 0) >= target) return steps;
    function ensure(name, amount, chain = []) {
        const missing = amount - (stock[name] || 0);
        if (missing <= 0) return;
        if (chain.includes(name)) throw new Error('Recipe cycle: ' + name);
        if (name === 'oak_log') {
            steps.push({ type: 'gather', item: name, count: missing });
            stock[name] = (stock[name] || 0) + missing;
            return;
        }
        if (!supportedItems.has(name)) throw new Error('Unsupported prerequisite: ' + name);
        // Select an oak-based recipe from the installed Minecraft recipe data.
        const recipe = (recipesFor(name) || []).find(([ingredients, result]) =>
            Object.keys(ingredients).length > 0 && Number.isSafeInteger(result.craftedCount) && result.craftedCount > 0 &&
            Object.entries(ingredients).every(([key, n]) =>
                ['oak_log', 'oak_planks', 'stick'].includes(key) && Number.isSafeInteger(n) && n > 0));
        if (!recipe) throw new Error('No supported oak recipe found for ' + name);
        const [ingredients, result] = recipe;
        const batches = Math.ceil(missing / result.craftedCount);
        for (const [ingredient, quantity] of Object.entries(ingredients)) {
            ensure(ingredient, quantity * batches, [...chain, name]);
            stock[ingredient] -= quantity * batches;
        }
        stock[name] = (stock[name] || 0) + batches * result.craftedCount;
        steps.push({ type: 'craft', item: name, batches, output: result.craftedCount });
    }
    if (tools.has(item) && !nearbyTable) ensure('crafting_table', 1);
    ensure(item, target);
    return steps;
}

export function inventoryCounts(bot) {
    const counts = {};
    for (const item of bot.inventory.items()) counts[item.name] = (counts[item.name] || 0) + item.count;
    return counts;
}

export async function startMakeGoal(agent, item, target, api) {
    if (agent.gather_goal?.active) return 'A managed goal is active. Use !endGoal first.';
    const plan = () => planMake(item, target, inventoryCounts(agent.bot), api.hasTable(agent.bot), api.recipes);
    let initial;
    try { initial = plan(); } catch (error) { return error.message; }
    const goal = { item, target, active: true, cancelled: false, kind: 'make', status: 'running' };
    agent.gather_goal = goal; // shared command guard, !stop and !endGoal
    agent.gather_epoch = (agent.gather_epoch || 0) + 1;
    agent.actions.cancelResume();
    const cancel = () => { goal.cancelled = true; };
    agent.bot.once('death', cancel);
    agent.bot.once('end', cancel);
    const cleanup = () => {
        goal.active = false;
        agent.gather_epoch = (agent.gather_epoch || 0) + 1;
        agent.bot.removeListener('death', cancel);
        agent.bot.removeListener('end', cancel);
    };
    try {
        await agent.self_prompter.stop();
        await agent.history.save();
    } catch (error) { cleanup(); throw error; }
    const describe = steps => steps.map(s => s.type === 'gather' ?
        `gather ${s.count} ${s.item}` : `craft ${s.item} (${s.batches} batch(es), ${s.output} each)`).join(' -> ');
    console.log('Make plan:', describe(initial) || 'Already complete');
    goal.done = (async () => {
        let report = '';
        let noProgress = 0;
        try {
            for (let attempt = 0; attempt < 512 && !goal.cancelled; attempt++) {
                if (!await waitForGoalTurn(agent, goal)) break;
                if (countItem(agent.bot, item) >= target) {
                    report = `Crafting complete: ${countItem(agent.bot, item)}/${target} ${item} in inventory. Kept the item; goal stopped.`;
                    break;
                }
                const steps = plan();
                const step = steps[0];
                if (!step) throw new Error('Planner produced no next step.');
                const before = countItem(agent.bot, step.item);
                // One batch/block per action, then plan again from real inventory.
                console.log('Make next step:', step);
                let verified = false;
                const result = await agent.actions.runAction('action:makeGoal', async () => {
                    if (goal.cancelled) return;
                    if (step.type === 'gather') {
                        verified = await collectAndVerify(agent, goal, step.item, api.collect, api.pickup, api.verifyTimeoutMs);
                    } else {
                        await api.craft(agent.bot, step.item, 1);
                        verified = await waitForInventory(agent, goal, step.item, before + step.output, api.verifyTimeoutMs);
                    }
                }, { timeout: 1 });
                if (goal.cancelled) break;
                if (result.timedout) throw new Error('Action timed out; goal stopped without claiming completion.');
                if (result.interrupted || result.deferred) {
                    goal.status = 'paused';
                    // A safety action may have consumed or collected items.
                    // Retain the target and compute a fresh plan after it ends.
                    continue;
                }
                noProgress = result.success && verified ? 0 : noProgress + 1;
                if (noProgress >= 2)
                    throw new Error(`Could not verify ${step.item} output. Check ingredients, reachable logs, or space for the crafting table.`);
            }
            if (goal.cancelled) report = 'Crafting goal cancelled.';
            else if (!report) report = 'Crafting stopped at the action limit. Goal not marked complete.';
        } catch (error) {
            report = 'Crafting stopped: ' + error.message;
        } finally { cleanup(); }
        console.log(report);
        await agent.history.add('system', report);
        await agent.history.save();
        if (!goal.cancelled) agent.openChat(report);
        return report;
    })();
    goal.done.catch(error => console.error('Could not save crafting report:', error));
    return `Make goal: keep ${target} ${item} total. ${describe(initial) || 'Inventory already meets target.'}`;
}
