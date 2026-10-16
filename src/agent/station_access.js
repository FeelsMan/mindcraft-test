import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { safeEmpty, safeSolid, safeFeet, walkSafely, planSafePath } from './navigation_recovery.js';
import { safeMiningMovements } from './navigation_policy.js';
import { sleep } from './managed_goal.js';

const point = p => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
const stations = new Set(['crafting_table', 'furnace']);

export function supportedStationSpace(bot, position) {
    const p = point(position), pos = bot.entity.position;
    // Full blocks cannot occupy either the player's feet or head, including
    // a player straddling a cell boundary. Do not push her away after placing.
    const overlaps = pos.x + 0.3 > p.x && pos.x - 0.3 < p.x + 1 &&
        pos.z + 0.3 > p.z && pos.z - 0.3 < p.z + 1 &&
        pos.y < p.y + 1 && pos.y + (bot.entity.height || 1.8) > p.y;
    return !overlaps && safeEmpty(bot.blockAt(p)) && safeSolid(bot.blockAt(p.offset(0, -1, 0)));
}

// A station needs an actual supported work position and a visible block face.
// Distance alone can finish behind a wall or on the wrong side of a ledge.
export function stationWorkGoal(bot, position, { placing = false } = {}) {
    const p = point(position);
    if (!bot.world?.getBlock || !bot.world?.raycast) return null;
    if (placing ? !supportedStationSpace(bot, p) : !stations.has(bot.blockAt(p)?.name)) return null;
    const face = placing ? new pf.goals.GoalPlaceBlock(p, bot.world,
        { range: 4, faces: [new Vec3(0, -1, 0)], LOS: true }) :
        new pf.goals.GoalLookAtBlock(p, bot.world, { reach: 4, entityHeight: 1.6 });
    const feet = [];
    for (const dy of [0, -1, 1]) for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
        if (dx === 0 && dz === 0) continue;
        const at = p.offset(dx, dy, dz);
        if (safeFeet(bot, at) && face.isEnd(at)) feet.push(at);
    }
    if (!feet.length) return null;
    const goal = new pf.goals.GoalCompositeAny(feet.map(at => new pf.goals.GoalBlock(at.x, at.y, at.z)));
    const isEnd = goal.isEnd.bind(goal);
    goal.isEnd = node => isEnd(node) && safeFeet(bot, node) &&
        (placing ? supportedStationSpace(bot, p) : stations.has(bot.blockAt(p)?.name)) && face.isEnd(node);
    return goal;
}

export function canUseStation(bot, position) {
    return Boolean(stationWorkGoal(bot, position)?.isEnd(bot.entity.position.floored()));
}

export async function approachStation(bot, position, api, { placing = false, timeoutMs = 12000 } = {}) {
    if (bot.interrupt_code) return false;
    const p = point(position), deadline = Date.now() + timeoutMs;
    await api.prepareTravel?.(p);
    if (bot.interrupt_code) return false;
    if (!bot.blockAt(p)) {
        // Historical unloaded blocks remain unknown. Move near enough to load
        // them, then select a work position from the newly observed geometry.
        await walkSafely(bot, p, { ...api, prepareTravel: undefined, range: 3,
            timeoutMs: Math.max(1, deadline - Date.now()) });
    }
    if (bot.interrupt_code || Date.now() >= deadline) return false;
    const goal = stationWorkGoal(bot, p, { placing });
    if (!goal) { api.log?.('No supported work position with a visible station face.'); return false; }
    return walkSafely(bot, p, { ...api, prepareTravel: undefined, goal, searchMs: 500,
        timeoutMs: Math.max(1, deadline - Date.now()) });
}

export async function placeSupportedStation(bot, name, api, onIntent = () => {},
    { timeoutMs = 15000, verifyMs = 1500 } = {}) {
    if (!stations.has(name)) throw new Error('Unsupported station: ' + name);
    const deadline = Date.now() + timeoutMs, dim = bot.game?.dimension;
    const candidates = bot.findBlocks({ matching: block => ['air', 'cave_air', 'void_air'].includes(block.name), maxDistance: 6, count: 48,
        useExtraInfo: block => supportedStationSpace(bot, block.position) }).slice(0, 12);
    for (const candidate of candidates) {
        if (bot.interrupt_code || bot.game?.dimension !== dim || Date.now() >= deadline) return null;
        const p = point(candidate);
        const goal = stationWorkGoal(bot, p, { placing: true });
        if (!goal) continue;
        const path = await planSafePath(bot, safeMiningMovements(api.movements()), goal, 250);
        if (path.status !== 'success') continue;
        if (!await approachStation(bot, p, api, { placing: true, timeoutMs: Math.max(1, deadline - Date.now()) })) continue;
        if (bot.interrupt_code || bot.game?.dimension !== dim || !supportedStationSpace(bot, p)) continue;
        const item = bot.inventory.items().find(item => item.name === name);
        if (!item) throw new Error('No ' + name + ' in live inventory for station placement.');
        await bot.equip(item, 'hand');
        if (bot.interrupt_code || bot.game?.dimension !== dim || !supportedStationSpace(bot, p)) continue;
        onIntent(p); // Persist ownership intent before the placement packet.
        const sneaking = Boolean(bot.getControlState?.('sneak'));
        try {
            bot.setControlState('sneak', true);
            const support = bot.blockAt(p.offset(0, -1, 0));
            await bot.lookAt(p.offset(0.5, 0, 0.5));
            if (!bot.interrupt_code && bot.game?.dimension === dim) await bot.placeBlock(support, new Vec3(0, 1, 0));
        } catch (error) { api.log?.('Station placement response: ' + error.message); }
        finally { bot.setControlState('sneak', sneaking); }
        const verifyEnd = Math.min(deadline, Date.now() + verifyMs);
        do {
            if (bot.game?.dimension !== dim) return null;
            const block = bot.blockAt(p);
            if (block?.name === name) { api.log?.('Verified supported ' + name + ' placement at ' + p + '.'); return block; }
            if (bot.interrupt_code) return null;
            await sleep(50);
        } while (Date.now() < verifyEnd);
        // A late placement could still arrive. Let the saved intent be
        // revalidated before starting a new placement in another action.
        throw new Error('Could not verify ' + name + ' placement; its location was retained for rechecking.');
    }
    if (!bot.interrupt_code) api.log?.('No reachable supported space for the ' + name + ' within the station placement budget.');
    return null;
}
