export const emergencyModes = new Set(['self_preservation', 'cowardice', 'self_defense', 'unstuck']);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function actionFailureDetail(result) {
    // ActionManager has already consumed/cleared bot.output at this point.
    const message = String(result?.message || '');
    const error = message.match(/(?:^|\n)Action failed: [^\n]+/g)?.at(-1);
    return (error ? error.replace(/^\s*Action failed:\s*/, '') :
        message.replace(/^Action output(?: \(shortened\))?:\s*/, '')).trim().slice(-320);
}

export function countInventoryItem(bot, name) {
    return bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
}

export function modeAllowedDuringGoal(agent, name) {
    if (agent.survival_supervisor?.active) return name === 'self_preservation';
    return !agent.gather_goal?.active || emergencyModes.has(name);
}

export async function waitForGoalTurn(agent, goal) {
    if (agent.main_supervisor) return agent.main_supervisor.waitForTurn(goal);
    let calmSince = null;
    while (!goal.cancelled) {
        const busy = agent.actions.executing || agent.recovering_from_death || agent.survival_supervisor?.active ||
            (agent.bot.modes.getActiveModes?.() || []).some(name => emergencyModes.has(name));
        if (busy) {
            calmSince = null;
            if (goal.status !== 'paused') {
                goal.status = 'paused';
                console.log(`Managed goal paused for ${agent.actions.currentActionLabel || 'safety recovery'}; target retained.`);
            }
        } else {
            if (goal.status !== 'paused') return true;
            calmSince ??= Date.now();
            if (Date.now() - calmSince >= (goal.resumeDelayMs ?? 400)) {
                goal.status = 'running';
                console.log(`Resuming managed goal: ${goal.target} ${goal.item}; replanning from current inventory.`);
                return true;
            }
        }
        await sleep(50);
    }
    return false;
}

export async function waitForInventory(agent, goal, name, minimum, timeoutMs = 1200) {
    const end = Date.now() + timeoutMs;
    while (!goal.cancelled && !agent.bot.interrupt_code) {
        if (countInventoryItem(agent.bot, name) >= minimum) return true;
        if (Date.now() >= end) return false;
        await sleep(Math.min(50, Math.max(1, end - Date.now())));
    }
    return false;
}

export function finishManagedGoal(agent, goal, completed, report) {
    const outcome = agent.main_supervisor?.finishGoal(goal, completed, report) || { completed, report };
    agent.local_memory?.finishGoal(goal, outcome.completed, outcome.report);
    return outcome;
}

// Mining completion and dropped-item pickup are separate server events. The
// same action owns both, including the final inventory check and any pickup.
export async function collectAndVerify(agent, goal, name, collect, pickup, timeoutMs = 1200) {
    const before = countInventoryItem(agent.bot, name);
    await collect(agent.bot, name, 1);
    if (await waitForInventory(agent, goal, name, before + 1, timeoutMs)) return true;
    if (goal.cancelled || agent.bot.interrupt_code) return false;
    if (pickup) await pickup(agent.bot, name);
    return waitForInventory(agent, goal, name, before + 1, timeoutMs);
}
