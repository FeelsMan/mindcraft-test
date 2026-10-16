import { cellOf, positionOf, validPosition } from './local_memory.js';

export const RESOURCE_SEARCH_LIMIT = 8;
export const RESOURCE_SEARCH_RADIUS = 96;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const count = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);

// This bounded JSON state is included in the existing goal checkpoint. A crash
// or combat interruption cannot reset an exhausted search into an endless walk.
export function restoredResourceSearch(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    for (const [item, data] of Object.entries(value).slice(0, 12)) {
        if (!/^[a-z0-9_]{1,80}$/.test(item) || !validPosition(data?.origin) ||
            !Number.isSafeInteger(data.attempts) || data.attempts < 0 || data.attempts > RESOURCE_SEARCH_LIMIT) continue;
        result[item] = { origin: positionOf(data.origin), attempts: data.attempts,
            visited: Array.isArray(data.visited) ? data.visited.filter(p => validPosition(p)).slice(-20).map(positionOf) : [] };
    }
    return result;
}

export async function collectWithRecovery(bot, goal, item, api, { budgetMs = 30000 } = {}) {
    goal.resourceSearch ??= {};
    const state = goal.resourceSearch[item] ??= { origin: positionOf(bot.entity.position), attempts: 0, visited: [] };
    const dimension = String(bot.game?.dimension ?? 'unknown');
    const interrupted = () => goal.cancelled || bot.interrupt_code || String(bot.game?.dimension ?? 'unknown') !== dimension;
    const checkpoint = () => bot.localMemory?.checkpoint(goal);
    const deadline = Date.now() + budgetMs;
    const before = count(bot, item);
    goal.resourceFailure = '';
    let skipLocal = Boolean(goal.skipResourceArea);
    goal.skipResourceArea = false;
    while (!interrupted() && Date.now() < deadline) {
        if (count(bot, item) > before) return true;
        if (!skipLocal && await api.collect()) return true;
        skipLocal = false;
        if (interrupted()) return false;
        if (count(bot, item) > before) return true;
        const here = positionOf(bot.entity.position);
        if (!state.visited.some(p => cellOf(p) === cellOf(here))) state.visited.push(here);
        state.visited = state.visited.slice(-20);
        checkpoint();
        if (state.attempts >= RESOURCE_SEARCH_LIMIT) break;
        const untried = p => validPosition(p) && distance(p, bot.entity.position) >= 8 &&
            distance(p, state.origin) <= RESOURCE_SEARCH_RADIUS &&
            !state.visited.some(v => distance(v, p) < 8);
        // Historical collection areas are hints. We inspect live blocks again
        // after reaching them and never count travel as inventory progress.
        const memories = (api.memories?.() || []).filter(untried).slice(0, 2);
        const choices = [...memories.map(position => ({ position, remembered: true })),
            ...api.waypoints(memories[0]).filter(untried).map(position => ({ position, remembered: false }))];
        let relocated = false;
        for (const { position, remembered } of choices) {
            if (interrupted() || Date.now() >= deadline || state.attempts >= RESOURCE_SEARCH_LIMIT) break;
            state.attempts++;
            state.visited.push(positionOf(position)); state.visited = state.visited.slice(-20);
            checkpoint(); // Charge the attempt before travel, including crashes.
            api.log?.(`Resource recovery ${state.attempts}/${RESOURCE_SEARCH_LIMIT}: ${remembered ? 'rechecking a remembered area' : 'checking another supported area'} for ${item}.`);
            const from = positionOf(bot.entity.position);
            const arrived = await api.move(position);
            // A bounded route can stop after making useful progress into new
            // chunks. Rescan there before considering another old waypoint.
            if (arrived || distance(from, bot.entity.position) >= 4) { relocated = true; break; }
        }
        if (!relocated) break;
        // A move across chunks can arrive before the last chunk packet. Yield
        // briefly, then rescan rather than treating cached coordinates as facts.
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!interrupted()) {
        goal.resourceFailure = `Resource search paused: no verified ${item} gain after ${state.attempts}/${RESOURCE_SEARCH_LIMIT} relocations within ${RESOURCE_SEARCH_RADIUS} blocks of the starting area. Goal saved; no vertical mining or scaffolding was used.`;
        api.log?.(goal.resourceFailure);
    }
    return count(bot, item) > before;
}
