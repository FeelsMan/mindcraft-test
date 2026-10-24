import { MainSupervisor } from '../../core/mainSupervisor.js';
import { emergencyModes } from '../../agent/managed_goal.js';
import { inspectShelter } from '../../agent/shelter_building.js';

export class MinecraftSupervisorAdapter {
    constructor(agent) { this.agent = agent; }

    observe() {
        const agent = this.agent, bot = agent.bot, p = bot.entity?.position;
        const inventory = bot.inventory?.items ? {} : null;
        if (inventory) for (const item of bot.inventory.items())
            inventory[item.name] = (inventory[item.name] || 0) + item.count;
        return {
            scope: { environment: 'minecraft', world: agent.local_memory?.world || null,
                dimension: String(bot.game?.dimension ?? 'unknown') },
            available: !agent._shuttingDown && !agent._disconnectHandled && !bot._client?.ended,
            recovering: agent.recovering_from_death,
            health: bot.health, hunger: bot.food,
            position: p && [p.x, p.y, p.z].every(Number.isFinite) ? { x: p.x, y: p.y, z: p.z } : null,
            inventory,
            interruptions: (bot.modes?.getActiveModes?.() || []).filter(name => emergencyModes.has(name)),
            action: { executing: Boolean(agent.actions.executing), label: agent.actions.currentActionLabel }
        };
    }

    verifyCompletion(goal) {
        if (goal.kind === 'shelter') {
            try {
                const state = inspectShelter(this.agent.bot, goal.shelter);
                return { verified: Boolean(state.structureComplete && state.doorState.sealed),
                    reason: 'Shelter blocks and sealed door must still be present.' };
            } catch (error) { return { verified: false, reason: error.message }; }
        }
        const inventory = this.observe().inventory;
        return { verified: inventory !== null && (inventory[goal.item] || 0) >= goal.target,
            reason: `Inventory must contain at least ${goal.target} ${goal.item}.` };
    }

    checkpoint(goal, status, reason) { this.agent.local_memory?.checkpoint(goal, status, reason); }
    savedGoal() { return this.agent.local_memory?.pendingGoal(); }
    log(message) { console.log('[Mia supervisor] ' + message); }
}

export function installMainSupervisor(agent, options) {
    return agent.main_supervisor = new MainSupervisor(new MinecraftSupervisorAdapter(agent), options);
}
