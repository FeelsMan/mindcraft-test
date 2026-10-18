import { planMake, inventoryCounts } from './make_goal.js';
import { countItem, cancelGatherGoal } from './gather_goal.js';
import { actionFailureDetail, collectAndVerify, waitForGoalTurn, waitForInventory } from './managed_goal.js';
import { shelterBlueprint, shelterRecord } from './shelter_blueprint.js';
import { inspectShelter, findShelterSite, placeShelterBlock, clearShelterPlant, enterAndVerifyShelter } from './shelter_building.js';
import { walkSafely } from './navigation_recovery.js';

export async function startShelterGoal(agent, api) {
    if (agent.gather_goal?.active) return 'A managed goal is active. Use !endGoal first.';
    const bot = agent.bot, dimension = String(bot.game?.dimension ?? 'unknown');
    if (!['overworld', 'minecraft:overworld'].includes(dimension)) return 'The starter shelter currently supports the Overworld only.';
    const build = { inspect: inspectShelter, findSite: findShelterSite, place: placeShelterBlock,
        clear: clearShelterPlant, finish: enterAndVerifyShelter, ...api.building };
    const restored = agent.local_memory?.restoringGoal;
    const record = shelterRecord(restored?.kind === 'shelter' ? restored.shelter : agent.local_memory?.shelter?.());
    const goal = { item: 'shelter', target: 1, kind: 'shelter', shelter: record,
        active: true, cancelled: false, status: 'running', resourceRecoveryEnabled: true };
    if (record) bot.shelterSite = { dimension, record };
    const request = { requester: api.requestContext?.requester || 'system',
        instructionEpoch: api.requestContext?.instructionEpoch ?? (agent.instruction_epoch || 0) };
    agent.gather_goal = bot.managedGoal = goal;
    agent.gather_epoch = (agent.gather_epoch || 0) + 1;
    agent.actions.cancelResume();
    const onDeath = () => { goal.cancelled = true; goal.cancelReason = 'death'; };
    const onEnd = () => { goal.cancelled = true; goal.cancelReason = 'disconnect'; };
    bot.once('death', onDeath); bot.once('end', onEnd);
    const cleanup = () => {
        goal.active = false;
        if (bot.managedGoal === goal) delete bot.managedGoal;
        agent.gather_epoch = (agent.gather_epoch || 0) + 1;
        bot.removeListener('death', onDeath); bot.removeListener('end', onEnd);
    };
    try {
        await agent.self_prompter.stop();
        agent.local_memory?.beginGoal(goal);
        await agent.history.save();
    } catch (error) { cleanup(); throw error; }

    const travel = () => api.navigation(bot);
    const active = () => !goal.cancelled && !bot.interrupt_code && String(bot.game?.dimension ?? 'unknown') === dimension;
    goal.done = (async () => {
        let completed = false, report = '', completionEpoch;
        try {
            let noProgress = 0;
            for (let attempt = 0; attempt < 512 && !goal.cancelled; attempt++) {
                if (!await waitForGoalTurn(agent, goal)) break;
                if (String(bot.game?.dimension ?? 'unknown') !== dimension) {
                    goal.cancelled = true; goal.cancelReason = 'dimension'; break;
                }
                if (goal.navigationFailure) throw new Error(goal.navigationFailure);
                let step;
                if (!goal.shelter) step = { type: 'site', item: 'shelter' };
                else if (!bot.blockAt(shelterBlueprint(goal.shelter).origin)) step = { type: 'return', item: 'shelter' };
                else {
                    const state = build.inspect(bot, goal.shelter);
                    // Recompute the deficit after every receipt. Completed cells
                    // need no carried planks, including after death or restart.
                    step = state.clear[0];
                    if (!step && state.needsDoor && countItem(bot, 'oak_door') < 1)
                        step = planMake('oak_door', 1, inventoryCounts(bot), api.hasTable(bot), api.recipes)[0];
                    if (!step && countItem(bot, 'oak_planks') < state.planks)
                        step = planMake('oak_planks', state.planks, inventoryCounts(bot), api.hasTable(bot), api.recipes)[0];
                    if (!step && state.missing.length) step = { type: 'place', ...state.missing[0] };
                    if (!step && state.needsDoor) step = { type: 'place', item: 'oak_door', position: state.door };
                    step ??= { type: 'finish', item: 'shelter', position: state.inside };
                }
                agent.local_memory?.beginStep(goal, step);
                console.log('Shelter next step:', step);
                let verified = false;
                const result = await agent.actions.runAction('action:shelterGoal', async () => {
                    if (!active()) return;
                    if (step.type === 'site') {
                        const site = shelterRecord(await build.findSite(bot, travel()));
                        if (!active()) return;
                        if (!site) throw new Error('No reachable clear, level 7x7 work area found nearby. Move near open ground, then use !resumeGoal.');
                        goal.shelter = site;
                        bot.shelterSite = { dimension, record: site };
                        agent.local_memory?.saveShelter(site);
                        agent.local_memory?.checkpoint(goal); // Site committed before collecting or placing anything.
                        console.log('Shelter site:', site.origin, '; blueprint: 58 oak_planks (including 3 outside access steps) and 1 oak_door, existing ground floor.');
                        verified = true;
                    } else if (step.type === 'return') {
                        verified = await walkSafely(bot, shelterBlueprint(goal.shelter).outside, travel());
                    } else if (step.type === 'clear') {
                        verified = await build.clear(bot, goal.shelter, step, travel(), active, { verifyMs: api.verifyTimeoutMs });
                    } else if (step.type === 'gather') {
                        verified = await collectAndVerify(agent, goal, step.item, api.collect, api.pickup, api.verifyTimeoutMs);
                    } else if (step.type === 'craft') {
                        const before = countItem(bot, step.item);
                        await api.craft(bot, step.item, 1);
                        verified = await waitForInventory(agent, goal, step.item, before + step.output, api.verifyTimeoutMs);
                    } else if (step.type === 'place') {
                        // Generic placeBlock may remove occupied blocks or use
                        // cheat mode. This builder only sends survival placements
                        // into observed air, from supported visible work positions.
                        verified = await build.place(bot, goal.shelter, step, travel(), active, { verifyMs: api.verifyTimeoutMs });
                    } else if (step.type === 'finish') {
                        verified = await build.finish(bot, goal.shelter, travel(), active, { verifyMs: api.verifyTimeoutMs });
                    }
                }, { timeout: 1 });
                if (goal.cancelled) break;
                agent.local_memory?.stepResult(goal, step, verified);
                if (result.timedout) throw new Error('Shelter action timed out; site and partial build retained.');
                if (result.interrupted || result.deferred) { goal.status = 'paused'; continue; }
                noProgress = result.success && verified ? 0 : noProgress + 1;
                if (noProgress >= 2) {
                    const detail = step.type === 'gather' && goal.resourceFailure || actionFailureDetail(result);
                    const reason = 'Could not verify shelter ' + step.type + ' for ' + step.item +
                        (step.position ? ' at ' + step.position : '') + '. ' + (detail || 'Two attempts made no verified progress.');
                    agent.local_memory?.failStep(goal, step, reason);
                    throw new Error(reason);
                }
                if (step.type === 'finish' && result.success && verified) {
                    const final = build.inspect(bot, goal.shelter);
                    if (!final.structureComplete || final.doorState.open) throw new Error('Shelter changed during final verification.');
                    completed = true;
                    agent.local_memory?.rememberPlace('home', final.inside);
                    report = 'Shelter complete: 58 oak-plank blocks (55 shell/roof, 3 access steps) and a two-block oak door verified. Entrance tested, door closed, and home saved at ' + final.inside + '.';
                    break;
                }
            }
            if (goal.cancelled) report = ['death', 'disconnect', 'dimension'].includes(goal.cancelReason) && agent.local_memory?.enabled
                ? 'Shelter paused after ' + goal.cancelReason + '; site saved for replanning.' : 'Shelter goal cancelled; placed blocks remain.';
            else if (!report) report = 'Shelter action limit reached; partial build retained without claiming completion.';
        } catch (error) { report = 'Shelter stopped: ' + error.message; }
        finally {
            cleanup(); completionEpoch = agent.gather_epoch;
            agent.local_memory?.finishGoal(goal, completed, report);
        }
        console.log(report);
        await agent.history.add('system', report); await agent.history.save();
        if (!goal.cancelled && completionEpoch === agent.gather_epoch && !agent._shuttingDown &&
            request.instructionEpoch === (agent.instruction_epoch || 0)) {
            if (completed && agent.routeResponse) await agent.routeResponse(request.requester, report);
            else agent.openChat(report);
        }
        return report;
    })();
    goal.done.catch(error => console.error('Could not save shelter report:', error));
    return 'Shelter goal started: a 5x5 oak shelter, 3x3 interior with two-block headroom, roof and working door. Materials and actual block updates will be verified. Use !endGoal to cancel.';
}

export async function resetShelterSite(agent) {
    if (agent.gather_goal?.active && agent.gather_goal.kind !== 'shelter')
        return 'A different managed goal is active. Use !endGoal before resetting the shelter site.';
    if (agent.gather_goal?.active) await cancelGatherGoal(agent);
    const memory = agent.local_memory;
    if (memory?.enabled && !memory.resetShelter())
        return 'Could not reset the saved shelter site; its record was retained.';
    const dimension = String(agent.bot.game?.dimension ?? 'unknown');
    if (agent.bot.shelterSite?.dimension === dimension) delete agent.bot.shelterSite;
    await agent.history.save();
    return 'Shelter site reset in this world/dimension. Placed blocks and history remain; a matching home waypoint was cleared. Move near another level area and use !shelterGoal to choose a new site.';
}
