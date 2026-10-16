// ActionManager may poll while an action unwinds. Reuse each asynchronous
// cancellation so collectblock does not attach a new events.once pair per poll.
const pending = new WeakMap();

export function requestActionInterrupt(bot) {
    bot.interrupt_code = true;
    let tasks = pending.get(bot);
    if (!tasks) { tasks = new Map(); pending.set(bot, tasks); }
    const invoke = (key, receiver, method) => {
        if (!receiver || typeof receiver[method] !== 'function' || tasks.has(key)) return;
        const token = {};
        tasks.set(key, token);
        const clear = () => { if (tasks.get(key) === token) tasks.delete(key); };
        const failed = error => {
            clear();
            console.warn(`[Mia actions] ${method} cancellation failed: ${error?.message || error}`);
        };
        try {
            const result = receiver[method]();
            if (result && typeof result.then === 'function') Promise.resolve(result).then(clear, failed);
            else clear();
        } catch (error) { failed(error); }
    };
    invoke('dig', bot, 'stopDigging');
    invoke('collection', bot.collectBlock, 'cancelTask');
    // Continue stopping paths: a plugin can start its path after an await.
    invoke('path', bot.pathfinder, 'stop');
    invoke('combat', bot.pvp, 'stop');
}

export async function withActionWatchdog(agent, action, timeoutMs, message) {
    const owner = agent.actions.currentRun;
    const timer = setTimeout(() => {
        if (owner && agent.actions.currentRun === owner) agent.cleanKill(message);
    }, timeoutMs);
    try { return await action(); }
    finally { clearTimeout(timer); }
}
