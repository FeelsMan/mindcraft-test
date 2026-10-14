// Count rejected capability requests across intervening valid commands, so
// alternating moveAway/newAction cannot evade the retry limit.
export function resetUnavailableAttempts(agent) {
    agent.unavailable_commands = { counts: new Map(), total: 0 };
}

export function recordUnavailableAttempt(agent, name) {
    if (!agent.unavailable_commands) resetUnavailableAttempts(agent);
    const state = agent.unavailable_commands;
    const count = (state.counts.get(name) || 0) + 1;
    state.counts.set(name, count);
    state.total++;
    const stop = count >= 2 || state.total >= 3;
    if (stop) agent.command_failure_epoch = (agent.command_failure_epoch || 0) + 1;
    return { count, stop };
}

export function availabilityReason(name, { exists = true, blocked = false, allowCoding = false } = {}) {
    if (!exists) return `Command ${name} does not exist. Use only commands listed in the current command docs.`;
    if (blocked) return `Command ${name} is disabled for this agent. Choose an available command.`;
    if (name === '!newAction' && !allowCoding)
        return '!newAction is unavailable: code generation is disabled. Choose an available command or explain that this task cannot be completed with the available tools.';
    return null;
}
