import { countItem } from './gather_goal.js';
import { actionFailureDetail, collectAndVerify, waitForInventory, waitForGoalTurn } from './managed_goal.js';
import { smeltingRecipes, furnacePending, furnaceEnergy, reserveFuel, SMELT_TICKS, ironPickaxes } from './smelting_plan.js';

const toolKinds = ['axe', 'pickaxe', 'shovel', 'hoe', 'sword'];
const tools = new Set(['wooden', 'stone'].flatMap(tier => toolKinds.map(kind => `${tier}_${kind}`)));
export const supportedItems = new Set(['oak_planks', 'stick', 'crafting_table', 'cobblestone', 'furnace', 'raw_iron', ...Object.keys(smeltingRecipes), ...tools]);

// Pure planner: reserve every ingredient in a virtual inventory, including
// ingredients used for the crafting table. Recipe output counts are batch sizes.
export function planMake(item, target, inventory, nearbyTable, recipesFor, { furnace = false, snapshot = null } = {}) {
    if (!supportedItems.has(item)) throw new Error('Supported: oak planks, sticks, crafting tables, cobblestone, furnaces, wooden/stone tools, raw_iron, iron_ingot and charcoal.');
    if (!Number.isSafeInteger(target) || target < 1 || target > 64) throw new Error('Target must be 1 to 64 total items.');
    const stock = { ...inventory };
    const steps = [];
    if ((stock[item] || 0) >= target) return steps;
    const ensureTable = chain => {
        if (!nearbyTable && !(stock.crafting_table > 0)) ensure('crafting_table', 1, chain);
    };
    function ensure(name, amount, chain = []) {
        const missing = amount - (stock[name] || 0);
        if (missing <= 0) return;
        if (chain.includes(name)) throw new Error('Recipe cycle: ' + name);
        if (name === 'raw_iron') {
            if (!Object.entries(stock).some(([name, count]) => count > 0 && ironPickaxes.has(name)))
                ensure('stone_pickaxe', 1, [...chain, name]);
            steps.push({ type: 'gather', item: name, count: missing });
            stock[name] = (stock[name] || 0) + missing;
            return;
        }
        if (smeltingRecipes[name]) {
            if (!furnace && !(stock.furnace > 0)) ensure('furnace', 1, [...chain, name]);
            const pending = furnacePending(snapshot, name);
            // Retrieve already produced output before seeking more ingredients.
            if (snapshot?.output?.count > 0) {
                steps.push({ type: 'smelt', item: name, input: smeltingRecipes[name], count: missing, output: 1 });
                stock[name] = amount;
                return;
            }
            const needed = Math.max(0, missing - pending);
            if (needed) {
                ensure(smeltingRecipes[name], needed, [...chain, name]);
                stock[smeltingRecipes[name]] -= needed;
            }
            // While input is cooking, elapsed burn is matched by elapsed cook
            // progress (or by output now waiting in the furnace). Reopen before
            // trusting that queue instead of inventing a new fuel shortage.
            const stored = furnaceEnergy(snapshot, snapshot?.input ? snapshot.observedAt : Date.now());
            const shortfall = Math.max(0, missing * SMELT_TICKS - (snapshot?.progressTicks || 0) - stored);
            const energy = stored > 0 && shortfall <= 2 ? 0 : shortfall;
            const planks = reserveFuel(stock, energy, name);
            if (planks) { ensure('oak_planks', planks, [...chain, name]); stock.oak_planks -= planks; }
            steps.push({ type: 'smelt', item: name, input: smeltingRecipes[name], count: missing, output: 1 });
            stock[name] = amount;
            return;
        }
        if (name === 'oak_log' || name === 'cobblestone') {
            if (name === 'cobblestone' && !Object.entries(stock).some(([key, count]) => key.endsWith('_pickaxe') && count > 0)) {
                // Stone drops cobblestone only with a pickaxe. Bootstrap a
                // wooden one before mining; existing better pickaxes are reused.
                ensure('wooden_pickaxe', 1, [...chain, name]);
            }
            steps.push({ type: 'gather', item: name, count: missing });
            stock[name] = (stock[name] || 0) + missing;
            return;
        }
        if (!supportedItems.has(name)) throw new Error('Unsupported prerequisite: ' + name);
        if (tools.has(name) || name === 'furnace') ensureTable([...chain, name]);
        // Select recipes whose prerequisites this planner can obtain. Stone
        // recipes use cobblestone; alternative stone variants are not assumed.
        const recipe = (recipesFor(name) || []).find(([ingredients, result]) =>
            Object.keys(ingredients).length > 0 && Number.isSafeInteger(result.craftedCount) && result.craftedCount > 0 &&
            Object.entries(ingredients).every(([key, n]) =>
                ['oak_log', 'oak_planks', 'stick', 'cobblestone'].includes(key) && Number.isSafeInteger(n) && n > 0));
        if (!recipe) throw new Error('No supported oak/cobblestone recipe found for ' + name);
        const [ingredients, result] = recipe;
        const batches = Math.ceil(missing / result.craftedCount);
        // Make wooden prerequisites before entering a mining area, rather than
        // collecting stone and then leaving again to find sticks/logs.
        const ordered = Object.entries(ingredients).sort(([a], [b]) => Number(a === 'cobblestone') - Number(b === 'cobblestone'));
        for (const [ingredient, quantity] of ordered) {
            ensure(ingredient, quantity * batches, [...chain, name]);
            stock[ingredient] -= quantity * batches;
        }
        stock[name] = (stock[name] || 0) + batches * result.craftedCount;
        steps.push({ type: 'craft', item: name, batches, output: result.craftedCount });
    }
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
    if (!Number.isSafeInteger(target) || target < 1 || target > 64) return 'Target must be 1 to 64 total items.';
    const requestContext = {
        requester: api.requestContext?.requester || 'system',
        instructionEpoch: Number.isSafeInteger(api.requestContext?.instructionEpoch)
            ? api.requestContext.instructionEpoch : (agent.instruction_epoch || 0)
    };
    const initialHeld = countItem(agent.bot, item);
    let goal;
    const plan = () => {
        if (smeltingRecipes[item] && api.hasFurnace?.(agent.bot) && !goal?.furnaceChecked)
            return [{ type: 'inspect', item: 'furnace' }];
        if (item === 'crafting_table' && countItem(agent.bot, item) < target && api.hasOwnedTable?.(agent.bot))
            return [{ type: 'recover', item: 'crafting_table', output: 1 }];
        return planMake(item, target, inventoryCounts(agent.bot), api.hasTable(agent.bot), api.recipes,
            { furnace: api.hasFurnace?.(agent.bot) || false, snapshot: api.furnaceSnapshot?.(agent.bot) || null });
    };
    let initial;
    try { initial = plan(); } catch (error) { return error.message; }
    goal = { item, target, active: true, cancelled: false, kind: 'make', status: 'running',
        resourceRecoveryEnabled: Boolean(api.resourceRecovery) };
    agent.bot.craftingGoal = goal;
    agent.bot.managedGoal = goal;
    agent.gather_goal = goal; // shared command guard, !stop and !endGoal
    agent.gather_epoch = (agent.gather_epoch || 0) + 1;
    agent.actions.cancelResume();
    const onDeath = () => { goal.cancelled = true; goal.cancelReason = 'death'; };
    const onEnd = () => { goal.cancelled = true; goal.cancelReason = 'disconnect'; };
    agent.bot.once('death', onDeath);
    agent.bot.once('end', onEnd);
    const cleanup = () => {
        goal.active = false;
        if (agent.bot.craftingGoal === goal) delete agent.bot.craftingGoal;
        if (agent.bot.managedGoal === goal) delete agent.bot.managedGoal;
        agent.gather_epoch = (agent.gather_epoch || 0) + 1;
        agent.bot.removeListener('death', onDeath);
        agent.bot.removeListener('end', onEnd);
    };
    try {
        await agent.self_prompter.stop();
        agent.local_memory?.beginGoal(goal);
        await agent.history.save();
    } catch (error) { cleanup(); throw error; }
    const describe = steps => steps.map(s => s.type === 'gather' ?
        `gather ${s.count} ${s.item}` : s.type === 'recover' ? 'recover my crafting table' :
        s.type === 'inspect' ? 'inspect my furnace' : s.type === 'smelt' ? `smelt ${s.count} ${s.item} (verify each output)` :
        `craft ${s.item} (${s.batches} batch(es), ${s.output} each)`).join(' -> ');
    console.log('Make plan:', describe(initial) || 'Already complete');
    goal.done = (async () => {
        let report = '';
        let noProgress = 0;
        let completed = false;
        let completionEpoch = null;
        try {
            for (let attempt = 0; attempt < 512 && !goal.cancelled; attempt++) {
                if (!await waitForGoalTurn(agent, goal)) break;
                if (goal.navigationFailure) throw new Error(goal.navigationFailure);
                if (goal.memoryDimension && goal.memoryDimension !== String(agent.bot.game?.dimension ?? 'unknown')) {
                    goal.cancelled = true; goal.cancelReason = 'dimension'; break;
                }
                if (countItem(agent.bot, item) >= target) {
                    completed = true;
                    report = `Crafting complete: ${countItem(agent.bot, item)}/${target} ${item} in inventory. Kept the item; goal stopped.`;
                    break;
                }
                const steps = plan();
                const step = steps[0];
                if (!step) throw new Error('Planner produced no next step.');
                const before = countItem(agent.bot, step.item);
                agent.local_memory?.beginStep(goal, step);
                // One batch/block per action, then plan again from real inventory.
                console.log('Make next step:', step);
                let verified = false;
                const result = await agent.actions.runAction('action:makeGoal', async () => {
                    if (goal.cancelled) return;
                    if (step.type === 'gather') {
                        verified = await collectAndVerify(agent, goal, step.item, api.collect, api.pickup, api.verifyTimeoutMs);
                    } else if (step.type === 'inspect') {
                        verified = await api.inspectFurnace(agent.bot);
                        goal.furnaceChecked = verified;
                    } else if (step.type === 'smelt') {
                        await api.smelt(agent.bot, step);
                        verified = await waitForInventory(agent, goal, step.item, before + 1, api.verifyTimeoutMs);
                        goal.furnaceChecked = Boolean(api.furnaceSnapshot?.(agent.bot));
                    } else if (step.type === 'recover') {
                        await api.recoverTable(agent.bot);
                        verified = await waitForInventory(agent, goal, step.item, before + 1, api.verifyTimeoutMs);
                    } else {
                        await api.craft(agent.bot, step.item, 1);
                        verified = await waitForInventory(agent, goal, step.item, before + step.output, api.verifyTimeoutMs);
                    }
                }, { timeout: 1 });
                if (goal.cancelled) break;
                agent.local_memory?.stepResult(goal, step, verified);
                if (result.timedout) {
                    agent.local_memory?.failStep(goal, step, 'Action timed out; output was not verified.');
                    throw new Error('Action timed out; goal stopped without claiming completion.');
                }
                if (result.interrupted || result.deferred) {
                    goal.status = 'paused';
                    // A safety action may have consumed or collected items.
                    // Retain the target and compute a fresh plan after it ends.
                    continue;
                }
                noProgress = result.success && verified ? 0 : noProgress + 1;
                if (noProgress >= 2) {
                    const detail = step.type === 'gather' && goal.resourceFailure || actionFailureDetail(result);
                    const reason = `Could not verify ${step.item} output.${detail ? ' ' + detail : ' Check ingredients, reachable logs/stone, the pickaxe, and space for the crafting table.'}`;
                    agent.local_memory?.failStep(goal, step, reason);
                    throw new Error(reason);
                }
            }
            if (goal.cancelled && goal.cancelReason === 'death' && goal.memoryDeaths >= 2)
                report = 'Crafting blocked after two deaths; target saved. Reassess surroundings before using !resumeGoal.';
            else if (goal.cancelled) report = ['death', 'disconnect', 'dimension'].includes(goal.cancelReason) && agent.local_memory?.enabled ?
                `Crafting paused after ${goal.cancelReason}; target saved for replanning.` : 'Crafting goal cancelled.';
            else if (!report) report = 'Crafting stopped at the action limit. Goal not marked complete.';
        } catch (error) {
            report = 'Crafting stopped: ' + error.message;
        } finally {
            cleanup();
            // cleanup advances the epoch. Capture it before asynchronous history
            // persistence so newer goals/instructions can invalidate this report.
            completionEpoch = agent.gather_epoch;
            agent.local_memory?.finishGoal(goal, completed, report);
        }
        console.log(report);
        await agent.history.add('system', report);
        await agent.history.save();
        const reportIsCurrent = !goal.cancelled && completionEpoch === agent.gather_epoch;
        if (reportIsCurrent && completed && typeof agent.onManagedGoalCompleted === 'function') {
            try {
                await agent.onManagedGoalCompleted({
                    item, target, held: countItem(agent.bot, item), initialHeld,
                    goalEpoch: completionEpoch, ...requestContext
                });
            } catch (error) {
                console.warn('[Mia goal report] Completion feedback failed:', error.message);
            }
        } else if (reportIsCurrent) agent.openChat(report);
        return report;
    })();
    goal.done.catch(error => console.error('Could not save crafting report:', error));
    return `Make goal: keep ${target} ${item} total. ${describe(initial) || 'Inventory already meets target.'}`;
}
