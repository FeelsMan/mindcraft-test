import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { safeMiningMovements } from './navigation_policy.js';
import { NavigationProgress } from './navigation_progress.js';
import { observePositionCorrections } from './position_corrections.js';

const hazards = new Set(['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'campfire', 'soul_campfire', 'powder_snow']);
export const safeSolid = block => block?.boundingBox === 'block' && !hazards.has(block.name);
export const safeEmpty = block => block?.boundingBox === 'empty' && !hazards.has(block.name);
export const safeFeet = (bot, p) => safeEmpty(bot.blockAt(p)) && safeEmpty(bot.blockAt(p.offset(0, 1, 0))) &&
    safeSolid(bot.blockAt(p.offset(0, -1, 0)));
const directions = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
const center = p => new Vec3(Math.floor(p.x) + 0.5, Math.floor(p.y), Math.floor(p.z) + 0.5);

// Only loaded, supported cells are candidates. Pathfinder must still prove the
// route; a remembered location or an empty-looking cell is not proof of access.
export function safeWaypoints(bot, { radii = [16, 24, 32], toward = null } = {}) {
    const origin = bot.entity.position.floored();
    const points = [];
    for (const radius of radii) for (const [dx, dz] of directions) {
        const length = Math.hypot(dx, dz);
        const p = origin.offset(Math.round(dx * radius / length), 0, Math.round(dz * radius / length));
        for (const dy of [0, 1, -1, 2, -2, 3, -3, 4, -4, 6, -6]) {
            const feet = p.offset(0, dy, 0);
            if (safeFeet(bot, feet)) { points.push(feet); break; }
        }
    }
    if (toward) points.sort((a, b) => a.distanceTo(toward) - b.distanceTo(toward));
    return points;
}

function reached(bot, goal) {
    return goal.isEnd(bot.entity.position.floored());
}

export async function planSafePath(bot, movements, goal, budgetMs = 180) {
    if (!bot.pathfinder.getPathFromTo) return bot.pathfinder.getPathTo(movements, goal, budgetMs);
    // getPathTo returns only the first generator slice. A partial first slice
    // is not evidence that the route is impossible; continue within our budget.
    const search = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal,
        { timeout: budgetMs, tickTimeout: 25 });
    const deadline = Date.now() + budgetMs;
    try {
        while (!bot.interrupt_code) {
            const next = search.next();
            const result = next.value?.result;
            if (!result) return { status: 'noPath' };
            if (result.status !== 'partial' || next.done || Date.now() >= deadline) return result;
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        return { status: 'interrupted' };
    } finally { search.return?.(); }
}

const cell = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const finite = p => p && [p.x, p.y, p.z].every(Number.isFinite);
const dim = bot => String(bot.game?.dimension ?? 'unknown');
const remaining = (bot, goal) => {
    const value = goal.heuristic?.(bot.entity.position.floored());
    return Number.isFinite(value) ? value : Infinity;
};

// The same owner controls the goto, watchdog and cancellation. No Promise.race
// leaves a path running, and an old watchdog never stops a replacement goal.
export async function gotoWithProgress(bot, goal, movements, { deadline = Date.now() + 60000,
    stallMs = 2500, progressMs = 5000, pollMs = 100, path, log } = {}) {
    if (bot.interrupt_code) return { success: false, reason: 'interrupted' };
    if (reached(bot, goal)) return { success: true, reason: 'reached' };
    const previous = bot.navigationRecovery, token = { active: true }, dimension = dim(bot);
    bot.navigationRecovery = token;
    const progress = new NavigationProgress(bot.entity.position, remaining(bot, goal), { stallMs, progressMs });
    let reason = '', endpoint = null, timer;
    const owns = () => token.active && bot.navigationRecovery === token;
    const stop = why => {
        if (reason) return;
        reason = why;
        if (owns() && bot.pathfinder.goal === goal) {
            // stop() can wait forever for the next obstructed path node.
            // setGoal(null) settles upstream goto and removes its listeners.
            bot.pathfinder.setGoal(null); bot.clearControlStates?.();
        }
    };
    const update = result => {
        if (!owns()) return;
        progress.setPath(result?.path);
        const last = result?.path?.at(-1);
        if (result?.status === 'success' && finite(last) && goal.isEnd(new Vec3(last.x, last.y, last.z).floored()))
            endpoint = { x: Math.floor(last.x), y: Math.floor(last.y), z: Math.floor(last.z) };
    };
    const ended = () => stop('disconnected');
    const died = () => stop('death');
    const unwatchCorrections = observePositionCorrections(bot, correction => {
        if (correction.relocated) stop('world_changed');
    });
    bot.on?.('path_update', update); bot.once?.('end', ended); bot.once?.('death', died);
    update({ status: 'success', path });
    try {
        bot.pathfinder.setMovements(movements);
        timer = setInterval(() => {
            try {
                if (!owns()) return stop('superseded');
                if (bot.interrupt_code) return stop('interrupted');
                if (dim(bot) !== dimension) return stop('dimension_changed');
                if (Date.now() >= deadline) return stop('deadline');
                if (reached(bot, goal)) return;
                if (bot.pathfinder.goal !== goal) return stop('goal_changed');
                let work = null;
                if (movements.canDig && bot.targetDigBlock?.position && bot.digTime) {
                    const block = bot.targetDigBlock, duration = bot.digTime(block);
                    if (Number.isFinite(duration)) work = { key: cell(block.position) + ':' + block.stateId, duration: duration + 1000 };
                }
                const stalled = progress.observe(bot.entity.position, remaining(bot, goal), Date.now(), work);
                if (stalled) stop(stalled);
            } catch (error) {
                log?.('Route progress observation failed: ' + error.message);
                stop('watchdog_error');
            }
        }, pollMs);
        await bot.pathfinder.goto(goal);
        const success = !reason && owns() && !bot.interrupt_code && dim(bot) === dimension && reached(bot, goal);
        return { success, reason: success ? 'reached' : reason || 'arrival_unverified', endpoint };
    } catch (error) {
        if (!reason && !bot.interrupt_code) log?.('Route ended: ' + error.message);
        reason ||= bot.interrupt_code ? 'interrupted' : error.name === 'GoalChanged' ? 'goal_changed' :
            error.name === 'PathStopped' ? 'path_stopped' : 'path_failed';
        return { success: false, reason, endpoint };
    } finally {
        clearInterval(timer);
        bot.removeListener?.('path_update', update); bot.removeListener?.('end', ended);
        bot.removeListener?.('death', died); unwatchCorrections();
        if (owns() && bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null);
        token.active = false;
        if (bot.navigationRecovery === token) bot.navigationRecovery = previous;
        if (['physical_stall', 'no_progress'].includes(reason))
            log?.(`Navigation ${reason === 'no_progress' ? 'made no useful progress' : 'physically stalled'}; checking another supported approach.`);
    }
}

function alternateGoal(goal, excluded) {
    if (!Array.isArray(goal.goals) || !excluded.size) return goal;
    const choices = goal.goals.filter(g => !finite(g) || !excluded.has(cell(g)));
    if (!choices.length) return null;
    const alternate = new pf.goals.GoalCompositeAny(choices);
    const valid = alternate.isEnd.bind(alternate);
    alternate.isEnd = node => valid(node) && goal.isEnd(node);
    return alternate;
}

// One action owns navigation, its cancellation, and all route retries. No
// Promise.race leaves a path running after the caller has changed actions.
export async function walkSafely(bot, position, { movements, range = 0, prepareTravel,
    timeoutMs = 12000, stallMs = 2500, progressMs = 5000, pollMs = 100, searchMs = 180, goal: suppliedGoal, log } = {}) {
    if (bot.interrupt_code) return false;
    await prepareTravel?.(position);
    if (bot.interrupt_code) return false;
    const goal = suppliedGoal || (range > 0 ? new pf.goals.GoalNear(position.x, position.y, position.z, range) :
        new pf.goals.GoalBlock(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)));
    if (reached(bot, goal)) return true;
    const token = { active: true };
    const previous = bot.navigationRecovery;
    bot.navigationRecovery = token;
    const deadline = Date.now() + timeoutMs, dimension = dim(bot), excluded = new Set();
    const current = () => !bot.interrupt_code && token.active && bot.navigationRecovery === token && dim(bot) === dimension;
    try {
        const toward = new Vec3(position.x, position.y, position.z);
        const detours = safeWaypoints(bot, { radii: [3, 5], toward }).slice(0, 8);
        let detourCount = 0;
        for (let attempt = 0; attempt < 3 && current() && Date.now() < deadline; attempt++) {
            const selected = alternateGoal(goal, excluded);
            if (!selected) break;
            const policy = safeMiningMovements(movements());
            const path = await planSafePath(bot, policy, selected, Math.min(searchMs, Math.max(1, deadline - Date.now())));
            if (!current()) break;
            if (path.status === 'success') {
                const result = await gotoWithProgress(bot, selected, policy,
                    { deadline, stallMs, progressMs, pollMs, path: path.path, log });
                if (result.success) return true;
                if (['interrupted', 'superseded', 'death', 'disconnected', 'world_changed', 'dimension_changed', 'goal_changed', 'path_stopped'].includes(result.reason)) break;
                if (Array.isArray(goal.goals) && result.endpoint) {
                    excluded.add(cell(result.endpoint));
                    log?.('That work position did not succeed; selecting a different supported work position.');
                    continue;
                }
            }
            if (!current() || Date.now() >= deadline || detourCount >= 2) break;
            let moved = false;
            while (detours.length && current() && Date.now() < deadline) {
                const point = detours.shift();
                if (bot.entity.position.distanceTo(center(point)) < 1) continue;
                const around = new pf.goals.GoalBlock(point.x, point.y, point.z);
                const route = await planSafePath(bot, policy, around, Math.min(searchMs, Math.max(1, deadline - Date.now())));
                if (route.status !== 'success') { await new Promise(resolve => setTimeout(resolve, 0)); continue; }
                detourCount++;
                moved = (await gotoWithProgress(bot, around, policy,
                    { deadline, stallMs, progressMs, pollMs, path: route.path, log })).success;
                if (moved) log?.('Tried a supported detour; checking the destination again.');
                break;
            }
            if (!moved) break;
        }
        if (!bot.interrupt_code) log?.('No safe route completed within the navigation budget; target retained.');
        return false;
    } finally {
        token.active = false;
        if (bot.navigationRecovery === token) bot.navigationRecovery = previous;
    }
}
