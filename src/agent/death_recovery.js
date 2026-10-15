// A Mineflayer craft promise cannot safely be cancelled by abandoning it.
// Wait for the action to settle; ActionManager restarts if it cannot stop.
export function installDeathRecovery(agent) {
    const bot = agent.bot;
    bot.on('death', () => {
        if (agent.recovering_from_death) return;
        agent.recovering_from_death = true;
        agent.death_epoch = (agent.death_epoch || 0) + 1;
        const p = bot.entity?.position;
        const position = p && [p.x, p.y, p.z].every(Number.isFinite) ? [p.x, p.y, p.z] : null;
        const dimension = bot.game?.dimension || 'unknown';
        if (position) agent.memory_bank.rememberPlace('last_death_position', ...position);
        agent.actions.cancelResume();
        // Install the listener before any await: respawn can arrive quickly.
        let cleanup;
        const spawned = new Promise(resolve => {
            const onSpawn = () => { cleanup(); resolve(true); };
            const onEnd = () => { cleanup(); resolve(false); };
            const timer = setTimeout(onEnd, 30000);
            cleanup = () => {
                clearTimeout(timer);
                bot.removeListener('spawn', onSpawn);
                bot.removeListener('end', onEnd);
            };
            bot.once('spawn', onSpawn);
            bot.once('end', onEnd);
        });
        agent.death_recovery = (async () => {
            try {
                await agent.history.add('system', `Death recorded in ${dimension} at ${position ? position.join(', ') : 'unknown position'}.`);
                await agent.history.save();
                await agent.actions.stop();
                if (!await spawned) {
                    agent.cleanKill('Respawn did not complete; restarting.');
                    return;
                }
                agent.recovering_from_death = false;
                const report = `You died and have now respawned in ${dimension}. Previous action has stopped. ` +
                    (position ? `Actual death position: ${position.join(', ')}; saved as last_death_position. ` : 'Death position was unavailable. ') +
                    'Check current inventory and surroundings before continuing. Recover items only if safe.';
                if (agent.gather_goal?.done) await agent.gather_goal.done;
                const resumed = await agent.resumeMemoryGoal?.();
                // Active autonomous loop will read the report on its next step.
                if (resumed || agent.self_prompter.isActive()) await agent.history.add('system', report);
                else await agent.handleMessage('system', report, 1);
                await agent.history.save();
            } catch (error) {
                console.error('Death recovery failed:', error);
                agent.cleanKill('Death recovery failed; restarting with saved state.');
            } finally {
                cleanup();
            }
        })();
    });
}
