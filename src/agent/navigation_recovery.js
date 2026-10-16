import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { safeMiningMovements } from './navigation_policy.js';

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

async function boundedGoto(bot, goal, movements, { deadline, stallMs, pollMs, log }) {
    if (bot.interrupt_code) return false;
    bot.pathfinder.setMovements(movements);
    let last = bot.entity.position.clone(), changed = Date.now(), stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        // setGoal(null) immediately settles goto's GoalChanged listener. stop()
        // can wait forever for the next path node when physically obstructed.
        bot.pathfinder.setGoal(null);
        bot.clearControlStates?.();
    };
    const timer = setInterval(() => {
        if (bot.entity.position.distanceTo(last) >= 0.2) {
            last = bot.entity.position.clone(); changed = Date.now();
        }
        if (bot.interrupt_code || Date.now() >= deadline || Date.now() - changed >= stallMs) stop();
    }, pollMs);
    try {
        await bot.pathfinder.goto(goal);
        return !stopped && !bot.interrupt_code && reached(bot, goal);
    } catch (error) {
        if (!bot.interrupt_code) log?.('Safe route ended: ' + error.message);
        return false;
    } finally {
        clearInterval(timer);
        if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null);
    }
}

// One action owns navigation, its cancellation, and all route retries. No
// Promise.race leaves a path running after the caller has changed actions.
export async function walkSafely(bot, position, { movements, range = 0, prepareTravel,
    timeoutMs = 12000, stallMs = 2500, pollMs = 100, searchMs = 180, goal: suppliedGoal, log } = {}) {
    if (bot.interrupt_code) return false;
    await prepareTravel?.(position);
    if (bot.interrupt_code) return false;
    const goal = suppliedGoal || (range > 0 ? new pf.goals.GoalNear(position.x, position.y, position.z, range) :
        new pf.goals.GoalBlock(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)));
    if (reached(bot, goal)) return true;
    const token = { active: true };
    const previous = bot.navigationRecovery;
    bot.navigationRecovery = token;
    const deadline = Date.now() + timeoutMs;
    try {
        const toward = new Vec3(position.x, position.y, position.z);
        const detours = safeWaypoints(bot, { radii: [3, 5], toward }).slice(0, 8);
        let detourCount = 0;
        for (let attempt = 0; attempt < 3 && !bot.interrupt_code && Date.now() < deadline; attempt++) {
            const policy = safeMiningMovements(movements());
            const path = await planSafePath(bot, policy, goal, Math.min(searchMs, Math.max(1, deadline - Date.now())));
            if (path.status === 'success' && await boundedGoto(bot, goal, policy,
                { deadline, stallMs, pollMs, log })) return true;
            if (bot.interrupt_code || Date.now() >= deadline || detourCount >= 2) break;
            let moved = false;
            while (detours.length && !bot.interrupt_code && Date.now() < deadline) {
                const point = detours.shift();
                if (bot.entity.position.distanceTo(center(point)) < 1) continue;
                const around = new pf.goals.GoalBlock(point.x, point.y, point.z);
                const route = await planSafePath(bot, policy, around, Math.min(searchMs, Math.max(1, deadline - Date.now())));
                if (route.status !== 'success') { await new Promise(resolve => setTimeout(resolve, 0)); continue; }
                detourCount++;
                moved = await boundedGoto(bot, around, policy, { deadline, stallMs, pollMs, log });
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
