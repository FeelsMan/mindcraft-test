import { captureInventory } from './live_inventory.js';

// Final reports use a controller receipt, never a second action-generating
// model loop. A new instruction, goal, death or shutdown supersedes the receipt.
export async function reportManagedGoal(agent, event) {
    const current = () => !agent._shuttingDown && !agent.recovering_from_death &&
        !agent.shut_up && event.goalEpoch === (agent.gather_epoch || 0) &&
        (!Number.isSafeInteger(event.instructionEpoch) ||
            event.instructionEpoch === (agent.instruction_epoch || 0)) &&
        !agent.gather_goal?.active;
    if (!current() || agent._reportedMakeGoalEpoch === event.goalEpoch) return false;
    const inventory = captureInventory(agent.bot);
    const held = inventory.available ? inventory.counts[event.item] || 0 : -1;
    if (!Number.isSafeInteger(event.target) || event.target < 1 || held < event.target) return false;
    agent._reportedMakeGoalEpoch = event.goalEpoch;

    const receipt = 'Verified managed goal complete: target ' + event.target + ' ' + event.item +
        '; observed current inventory ' + held + ' ' + event.item +
        '. The controller verified the target and kept the output. This is an action receipt, not a permanent inventory fact.';
    try {
        await agent.history.add('system', receipt);
        await agent.history.save();
    } catch (error) {
        console.warn('[Mia goal report] Could not save completion receipt:', error.message);
    }
    if (!current()) return false;
    const latest = captureInventory(agent.bot);
    if (!latest.available || (latest.counts[event.item] || 0) !== held) return false;
    const message = event.initialHeld >= event.target
        ? 'I already had enough ' + event.item + '. I verified ' + held + ' in my inventory and kept it; no additional crafting was needed.'
        : 'Goal complete. My inventory now contains ' + held + ' ' + event.item + '. I am keeping the result.';
    await agent.routeResponse(event.requester || 'system', message);
    return true;
}
