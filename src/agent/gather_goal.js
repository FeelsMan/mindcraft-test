// Deterministic log collection. Target is TOTAL inventory, not additional logs.
import { collectAndVerify, waitForGoalTurn } from './managed_goal.js';
export function countItem(bot, item) {
    return bot.inventory.items().filter(x => x.name === item).reduce((n, x) => n + x.count, 0);
}
export function gatherCommandAllowed(agent, name) {
    return !agent.gather_goal?.active || ['!stats', '!inventory', '!endGoal', '!stop'].includes(name);
}
export async function startGatherGoal(agent, item, target, collect, pickup) {
    if (!Number.isSafeInteger(target) || target < 1 || target > 64)
        return 'Choose a total inventory target from 1 to 64.';
    if (!item.endsWith('_log') || !agent.bot.registry.blocksByName[item] || !agent.bot.registry.itemsByName[item])
        return 'This first gatherGoal version supports log blocks such as oak_log and spruce_log.';
    if (agent.gather_goal?.active) return 'A collection goal is already active. Use !endGoal first.';
    const goal = { item, target, active: true, cancelled: false, kind: 'gather', status: 'running' };
    agent.gather_goal = goal;
    agent.gather_epoch = (agent.gather_epoch || 0) + 1;
    agent.actions.cancelResume();
    try {
        await agent.self_prompter.stop();
        await agent.history.save();
    } catch (error) {
        goal.active = false;
        agent.gather_epoch = (agent.gather_epoch || 0) + 1;
        throw error;
    }
    const stopOnDeath = () => { goal.cancelled = true; };
    const stopOnEnd = () => { goal.cancelled = true; };
    agent.bot.once('death', stopOnDeath);
    agent.bot.once('end', stopOnEnd);
    goal.done = (async () => {
        let noProgress = 0;
        let report = '';
        try {
            while (!goal.cancelled) {
                if (!await waitForGoalTurn(agent, goal)) break;
                const before = countItem(agent.bot, item);
                if (before >= target) {
                    report = `Collection complete: ${before}/${target} ${item} in inventory. Goal stopped.`;
                    break;
                }
                let verified = false;
                const result = await agent.actions.runAction('action:gatherGoal', async () => {
                    if (!goal.cancelled) verified = await collectAndVerify(agent, goal, item, collect, pickup);
                }, { timeout: 1 });
                if (goal.cancelled) break;
                const after = countItem(agent.bot, item);
                if (result.timedout) {
                    report = `Collection stopped at ${after}/${target} ${item}: action timed out.`;
                    break;
                }
                if (result.interrupted || result.deferred) { goal.status = 'paused'; continue; }
                noProgress = result.success && verified ? 0 : noProgress + 1;
                if (noProgress >= 2) {
                    report = `Collection paused at ${after}/${target} ${item}: two attempts made no inventory progress. Move me nearer reachable logs and retry.`;
                    break;
                }
            }
            if (goal.cancelled) report = 'Collection goal cancelled.';
        } catch (error) {
            report = `Collection stopped after an error: ${error.message}`;
        } finally {
            goal.active = false;
            agent.gather_epoch = (agent.gather_epoch || 0) + 1;
            agent.bot.removeListener('death', stopOnDeath);
            agent.bot.removeListener('end', stopOnEnd);
        }
        console.log(report);
        await agent.history.add('system', report);
        await agent.history.save();
        if (!goal.cancelled) agent.openChat(report);
        return report;
    })();
    goal.done.catch(error => console.error('Collection report could not be saved:', error));
    return `Collection target set: keep at least ${target} ${item}. Inventory checks will stop the goal automatically.`;
}
export async function cancelGatherGoal(agent) {
    const goal = agent.gather_goal;
    if (!goal?.active) return;
    goal.cancelled = true;
    agent.gather_epoch = (agent.gather_epoch || 0) + 1;
    await agent.actions.stop();
    if (goal.done) await goal.done;
}
