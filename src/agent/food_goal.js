import { countFood, restoreFoodProgress } from './food_policy.js';
import { planMake, inventoryCounts } from './make_goal.js';
import { foodCookingRecipes } from './smelting_plan.js';
import { countInventoryItem, collectAndVerify, waitForInventory, waitForGoalTurn, finishManagedGoal, actionFailureDetail } from './managed_goal.js';

export function foodContext(data = {}) {
    return { kind: 'food', item: 'food', target: 8, foodDeadline: Date.now() + 300000, ...restoreFoodProgress(data) };
}
const sourceKey = source => `${source.type || source.kind}:${source.entityId ??
    [source.position?.x, source.position?.y, source.position?.z].join(',')}`;

// Returns one observed step. The existing action owner executes it; no child
// managed goal, second scheduler or optimistic inventory is introduced.
export async function planFoodStep(agent, goal, api, valid = () => true) {
    if (!valid()) return null;
    const bot = agent.bot;
    if (goal.replantPending) return { ...goal.replantPending, type: 'replant', item: goal.replantPending.seed };
    if (countFood(bot, goal) >= goal.target) return null;
    if (!goal.furnaceChecked && api.hasFurnace?.(bot)) return { type: 'inspect', item: 'furnace' };
    const stock = inventoryCounts(bot), snapshot = api.furnaceSnapshot?.(bot);
    const cooking = Object.entries(foodCookingRecipes).find(([output, raw]) => stock[raw] > 0 ||
        snapshot?.input?.name === raw && snapshot.input.count > 0 || snapshot?.output?.name === output && snapshot.output.count > 0);
    if (cooking) {
        const [output, raw] = cooking;
        const available = (stock[raw] || 0) + (snapshot?.input?.name === raw ? snapshot.input.count : 0) +
            (snapshot?.output?.name === output ? snapshot.output.count : 0);
        return planMake(output, (stock[output] || 0) + Math.min(8, available, Math.max(1, goal.target - countFood(bot, goal))), stock, api.hasTable(bot), api.recipes,
            { furnace: api.hasFurnace?.(bot) || false, snapshot })[0];
    }
    if (stock.wheat >= 3)
        return planMake('bread', (stock.bread || 0) + Math.min(Math.floor(stock.wheat / 3), Math.max(1, goal.target - countFood(bot, goal))), stock, api.hasTable(bot), api.recipes)[0];
    const sources = await api.food.discover(valid, { radius: 24 });
    if (!valid()) return null;
    const crop = sources.crops?.find(s => !goal.foodRejected?.includes(sourceKey(s)));
    if (crop) return { ...crop, type: 'harvest', item: crop.item };
    const animal = sources.animals?.find(s => !goal.foodRejected?.includes(sourceKey(s)));
    if (animal) {
        const tool = bot.inventory.items().some(i => i.count > 0 && /_(sword|axe)$/.test(i.name));
        if (!tool) return planMake('wooden_sword', 1, stock, api.hasTable(bot), api.recipes)[0];
        return { ...animal, type: 'hunt', item: animal.item };
    }
    return { type: 'search', item: 'food' };
}

export async function executeFoodStep(agent, goal, step, api, valid) {
    const bot = agent.bot, before = countInventoryItem(bot, step.item);
    if (!valid()) return { verified: false, reason: 'Food work superseded.' };
    if (['harvest', 'hunt', 'replant'].includes(step.type)) {
        const result = await api.food[step.type](step, valid, goal);
        if (valid() && step.type === 'replant' && result?.verified) delete goal.replantPending;
        return result;
    }
    if (step.type === 'search') return api.food.search(valid, goal);
    let verified = false;
    if (step.type === 'gather') verified = await collectAndVerify(agent, goal, step.item, api.collect, api.pickup, api.verifyTimeoutMs);
    else if (step.type === 'inspect') {
        verified = await api.inspectFurnace(bot); goal.furnaceChecked = Boolean(verified);
    } else if (step.type === 'smelt') {
        await api.smelt(bot, step);
        verified = valid() && await waitForInventory(agent, goal, step.item, before + 1, api.verifyTimeoutMs);
        goal.furnaceChecked = Boolean(api.furnaceSnapshot?.(bot));
    } else if (step.type === 'recover') {
        await api.recoverTable(bot);
        verified = valid() && await waitForInventory(agent, goal, step.item, before + 1, api.verifyTimeoutMs);
    } else if (step.type === 'craft') {
        await api.craft(bot, step.item, 1);
        verified = valid() && await waitForInventory(agent, goal, step.item, before + step.output, api.verifyTimeoutMs);
    }
    return { verified: Boolean(valid() && verified), reason: verified ? `Verified ${step.type} ${step.item}.` : `Could not verify ${step.type} ${step.item}.` };
}

export async function runFoodWork(agent, context, api, valid, checkpoint = () => {}) {
    if (Date.now() >= context.foodDeadline) return { verified: false, blocked: true, reason: 'Food work time budget exhausted; progress retained.' };
    if (context.foodActions >= 256) return { verified: false, blocked: true, reason: 'Food action budget exhausted; progress retained.' };
    if (context.foodFailures >= 2) return { verified: false, blocked: true, reason: context.foodReason || 'Food attempts blocked; use !resumeGoal after conditions change.' };
    const step = await planFoodStep(agent, context, api, valid);
    if (!step || !valid()) return { verified: Boolean(valid() && !context.replantPending && countFood(agent.bot, context) >= context.target), complete: true };
    context.foodActions++;
    checkpoint();
    let outcome;
    try { outcome = await executeFoodStep(agent, context, step, api, valid); }
    catch (error) { outcome = { verified: false, reason: error.message }; }
    if (valid()) {
        context.foodFailures = outcome?.verified ? 0 : context.foodFailures + 1;
        context.foodReason = outcome?.reason;
        if (!outcome?.verified && ['harvest', 'hunt'].includes(step.type))
            context.foodRejected = [...new Set([...(context.foodRejected || []), sourceKey(step)])].slice(-16);
        checkpoint();
    }
    return { ...outcome, step };
}

export async function startFoodGoal(agent, target, api, request = {}) {
    if (agent.gather_goal?.active) return 'A managed goal is active. Use !endGoal first.';
    if (!Number.isSafeInteger(target) || target < 1 || target > 64) return 'Food target must be 1 to 64 total prepared food items.';
    const restored = agent.local_memory?.restoringGoal;
    const goal = { ...foodContext(restored?.kind === 'food' ? restored : {}), target,
        active: true, cancelled: false, status: 'running', resourceRecoveryEnabled: true,
        automatic: Boolean(restored?.automatic || request.automatic) };
    const instructionEpoch = request.instructionEpoch ?? (agent.instruction_epoch || 0);
    const bot = agent.bot;
    goal.checkpoint = () => agent.local_memory?.checkpoint(goal);
    agent.gather_goal = bot.managedGoal = bot.craftingGoal = goal;
    agent.gather_epoch = (agent.gather_epoch || 0) + 1;
    agent.actions.cancelResume();
    const death = () => { goal.cancelled = true; goal.cancelReason = 'death'; };
    const end = () => { goal.cancelled = true; goal.cancelReason = 'disconnect'; };
    bot.once('death', death); bot.once('end', end);
    try {
        agent.main_supervisor?.beginGoal(goal, request);
        agent.local_memory?.beginGoal(goal);
        await agent.self_prompter.stop(); await agent.history.save();
    } catch (error) {
        goal.active = false;
        if (bot.managedGoal === goal) delete bot.managedGoal;
        if (bot.craftingGoal === goal) delete bot.craftingGoal;
        bot.removeListener('death', death); bot.removeListener('end', end);
        agent.gather_epoch = (agent.gather_epoch || 0) + 1;
        agent.main_supervisor?.finishGoal(goal, false, 'Food startup failed: ' + error.message);
        if (goal.memoryId) agent.local_memory?.finishGoal(goal, false, 'Food startup failed: ' + error.message);
        throw error;
    }
    goal.done = (async () => {
        let completed = false, report = '', epoch;
        try {
            while (goal.active && !goal.cancelled) {
                if (!await waitForGoalTurn(agent, goal)) break;
                if (Date.now() >= goal.foodDeadline) throw Error('Food work time budget exhausted; progress retained.');
                if (goal.foodActions >= 256) throw Error('Food action budget exhausted.');
                const step = await planFoodStep(agent, goal, api, () => goal.active && !goal.cancelled);
                if (!step) {
                    completed = !goal.replantPending && countFood(bot, goal) >= target;
                    if (!completed) throw Error('Food target could not be verified.');
                    report = `Food goal complete: ${countFood(bot, goal)}/${target} prepared food items verified and kept. Harvested plots replanted.`;
                    break;
                }
                agent.main_supervisor?.setStep(goal, step);
                agent.local_memory?.beginStep(goal, step);
                let outcome;
                const valid = () => goal.active && !goal.cancelled && agent.gather_goal === goal && !bot.interrupt_code;
                const result = await agent.actions.runAction('action:foodGoal', async () => {
                    if (!valid()) return;
                    goal.foodActions++;
                    agent.local_memory?.checkpoint(goal);
                    outcome = await executeFoodStep(agent, goal, step, api, valid);
                }, { timeout: 1, goal, valid: () => goal.active && !goal.cancelled && agent.gather_goal === goal && Date.now() < goal.foodDeadline });
                if (goal.cancelled) break;
                if (result.interrupted || result.deferred) continue;
                agent.local_memory?.stepResult(goal, step, Boolean(outcome?.verified));
                if (result.timedout) throw Error('Food action timed out; target and planting obligations retained.');
                goal.foodFailures = result.success && outcome?.verified ? 0 : goal.foodFailures + 1;
                if (!outcome?.verified && ['harvest', 'hunt'].includes(step.type))
                    goal.foodRejected = [...new Set([...goal.foodRejected, sourceKey(step)])].slice(-16);
                if (goal.foodFailures >= 2 || outcome?.blocked) {
                    const reason = outcome?.reason || actionFailureDetail(result) || 'No verified food progress.';
                    agent.local_memory?.failStep(goal, step, reason); throw Error(reason);
                }
                agent.local_memory?.checkpoint(goal);
            }
            if (goal.cancelled) report = ['death', 'dimension', 'disconnect'].includes(goal.cancelReason) ?
                'Food work paused after ' + goal.cancelReason + '; target and planting progress retained.' : 'Food goal cancelled.';
        } catch (error) { report = 'Food goal blocked: ' + error.message; }
        finally {
            goal.active = false;
            if (bot.managedGoal === goal) delete bot.managedGoal;
            if (bot.craftingGoal === goal) delete bot.craftingGoal;
            bot.removeListener('death', death); bot.removeListener('end', end);
            agent.gather_epoch = (agent.gather_epoch || 0) + 1; epoch = agent.gather_epoch;
            ({ completed, report } = finishManagedGoal(agent, goal, completed, report));
        }
        await agent.history.add('system', report); await agent.history.save();
        if (!goal.cancelled && epoch === agent.gather_epoch && instructionEpoch === (agent.instruction_epoch || 0) && !agent._shuttingDown)
            await (agent.routeResponse ? agent.routeResponse(request.requester || 'system', report) : agent.openChat(report));
        return report;
    })();
    goal.done.catch(error => console.error('Food goal persistence failed:', error.message));
    return `Food goal started: keep ${target} total prepared food items; harvest/replant, hunt or cook from verified world state.`;
}
