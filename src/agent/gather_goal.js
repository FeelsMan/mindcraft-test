// Deterministic log collection. Target is TOTAL inventory, not additional logs.
import { collectAndVerify, waitForGoalTurn } from './managed_goal.js';
export function countItem(bot, item) {
    return bot.inventory.items().filter(x => x.name === item).reduce((n, x) => n + x.count, 0);
}
export function gatherCommandAllowed(agent, name) {
    return !agent.gather_goal?.active || ['!stats', '!inventory', '!memory', '!endGoal', '!stop'].includes(name);
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
    const stopOnDeath = () => { goal.cancelled = true; goal.cancelReason = 'death'; };
    const stopOnEnd = () => { goal.cancelled = true; goal.cancelReason = 'disconnect'; };
    agent.bot.once('death', stopOnDeath);
    agent.bot.once('end', stopOnEnd);
    try {
        await agent.self_prompter.stop();
        agent.local_memory?.beginGoal(goal);
        await agent.history.save();
    } catch (error) {
        goal.active = false;
        agent.bot.removeListener('death', stopOnDeath);
        agent.bot.removeListener('end', stopOnEnd);
        agent.gather_epoch = (agent.gather_epoch || 0) + 1;
        throw error;
    }
    goal.done = (async () => {
        let noProgress = 0;
        let report = '';
        let completed = false;
        try {
            while (!goal.cancelled) {
                if (!await waitForGoalTurn(agent, goal)) break;
                if (goal.memoryDimension && goal.memoryDimension !== String(agent.bot.game?.dimension ?? 'unknown')) {
                    goal.cancelled = true; goal.cancelReason = 'dimension'; break;
                }
                const before = countItem(agent.bot, item);
                if (before >= target) {
                    completed = true;
                    report = `Collection complete: ${before}/${target} ${item} in inventory. Goal stopped.`;
                    break;
                }
                let verified = false;
                const step = { type: 'gather', item };
                agent.local_memory?.beginStep(goal, step);
                const result = await agent.actions.runAction('action:gatherGoal', async () => {
                    if (!goal.cancelled) verified = await collectAndVerify(agent, goal, item, collect, pickup);
                }, { timeout: 1 });
                if (goal.cancelled) break;
                agent.local_memory?.stepResult(goal, step, verified);
                const after = countItem(agent.bot, item);
                if (result.timedout) {
                    agent.local_memory?.failStep(goal, step, 'Collection action timed out; output was not verified.');
                    report = `Collection stopped at ${after}/${target} ${item}: action timed out.`;
                    break;
                }
                if (result.interrupted || result.deferred) { goal.status = 'paused'; continue; }
                noProgress = result.success && verified ? 0 : noProgress + 1;
                if (noProgress >= 2) {
                    report = `Collection paused at ${after}/${target} ${item}: two attempts made no inventory progress. Move me nearer reachable logs and retry.`;
                    agent.local_memory?.failStep(goal, step, report);
                    break;
                }
            }
            if (goal.cancelled && goal.cancelReason === 'death' && goal.memoryDeaths >= 2)
                report = 'Collection blocked after two deaths; target saved. Reassess surroundings before using !resumeGoal.';
            else if (goal.cancelled) report = ['death', 'disconnect', 'dimension'].includes(goal.cancelReason) && agent.local_memory?.enabled ?
                `Collection paused after ${goal.cancelReason}; target saved for replanning.` : 'Collection goal cancelled.';
        } catch (error) {
            report = `Collection stopped after an error: ${error.message}`;
        } finally {
            goal.active = false;
            agent.local_memory?.finishGoal(goal, completed, report);
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
    agent.local_memory?.cancelGoal();
    const goal = agent.gather_goal;
    if (!goal?.active) return;
    goal.cancelled = true;
    goal.cancelReason = 'cancelled';
    agent.gather_epoch = (agent.gather_epoch || 0) + 1;
    await agent.actions.stop();
    if (goal.done) await goal.done;
}
