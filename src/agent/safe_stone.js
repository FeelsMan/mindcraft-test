import pf from 'mineflayer-pathfinder';
import { safeMiningMovements } from './navigation_policy.js';
import { safeFeet, planSafePath } from './navigation_recovery.js';
import { blockFaceReachable } from './block_interaction.js';

const hazards = new Set(['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'campfire', 'soul_campfire', 'powder_snow']);
const solid = block => block?.boundingBox === 'block' && !hazards.has(block.name);
const empty = block => block?.boundingBox === 'empty' && !hazards.has(block.name);
const stone = block => block && ['stone', 'cobblestone'].includes(block.name);
const ironOre = block => block && ['iron_ore', 'deepslate_iron_ore'].includes(block.name);
const sameColumn = (a, b) => Math.floor(a.x) === b.x && Math.floor(a.z) === b.z;

export function stoneStandingPositions(bot, block) {
    if ((!stone(block) && !ironOre(block)) || !block.position) return [];
    const target = block.position;
    // Never select our support block, even if it is the closest stone.
    if (sameColumn(bot.entity.position, target) && target.y < Math.floor(bot.entity.position.y)) return [];
    if (!solid(bot.blockAt(target.offset(0, -1, 0)))) return [];
    const face = bot.world?.getBlock && bot.world?.raycast ?
        { isEnd: feet => blockFaceReachable(bot, target, feet) } : null;
    const positions = [];
    // Floor ore is below our feet; an exposed high wall block can be above
    // our head. Both can be mined from an existing supported side position.
    for (const dy of [1, 0, -1, -2, -3]) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const feet = target.offset(dx, dy, dz);
            if (empty(bot.blockAt(feet)) && empty(bot.blockAt(feet.offset(0, 1, 0))) &&
                solid(bot.blockAt(feet.offset(0, -1, 0))) && (!face || face.isEnd(feet))) positions.push(feet);
        }
    }
    return positions.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
}

export function logStandingPositions(bot, block) {
    if (!block?.name.endsWith('_log') || !block.position) return [];
    if (sameColumn(bot.entity.position, block.position) && block.position.y < Math.floor(bot.entity.position.y)) return [];
    const positions = [];
    for (const dy of [0, -1, -2]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const feet = block.position.offset(dx, dy, dz);
        if (safeFeet(bot, feet)) positions.push(feet);
    }
    return positions.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
}

export function findSafeLogTargets(bot, item, canBreak) {
    return bot.findBlocks({ matching: b => b.name === item,
        useExtraInfo: b => canBreak(b) && logStandingPositions(bot, b).length > 0,
        maxDistance: 64, count: 48 }).map(p => bot.blockAt(p)).filter(Boolean);
}

export function findSafeStoneTargets(bot, canBreak) {
    // Extra-info filtering runs on actual blocks at their real positions,
    // rather than the position-less palette entries used for section matching.
    return bot.findBlocks({
        matching: stone,
        useExtraInfo: block => canBreak(block) && stoneStandingPositions(bot, block).length > 0,
        maxDistance: 64,
        count: 48
    }).map(position => bot.blockAt(position)).filter(Boolean);
}

export function findSafeIronTargets(bot, canBreak) {
    return bot.findBlocks({ matching: ironOre,
        useExtraInfo: block => canBreak(block) && stoneStandingPositions(bot, block).length > 0,
        maxDistance: 64, count: 48 }).map(p => bot.blockAt(p)).filter(Boolean);
}

export async function collectIronFromSide(bot, candidates, api) {
    return collectFromSide(bot, candidates, api, stoneStandingPositions, ironOre);
}

export async function collectStoneFromSide(bot, candidates, api) {
    return collectFromSide(bot, candidates, api, stoneStandingPositions, stone);
}

export async function collectLogFromSide(bot, candidates, api) {
    return collectFromSide(bot, candidates, api, logStandingPositions, b => b?.name.endsWith('_log'));
}

async function collectFromSide(bot, candidates, api, standingPositions, matches) {
    const deadline = Date.now() + 5000;
    for (const candidate of candidates) {
        for (const feet of standingPositions(bot, candidate)) {
            if (Date.now() >= deadline) break;
            if (bot.interrupt_code) return false;
            const movements = safeMiningMovements(api.movements());
            const destination = new pf.goals.GoalBlock(feet.x, feet.y, feet.z);
            if (bot.entity.position.distanceTo(feet.offset(0.5, 0, 0.5)) >= 0.8) {
                const path = await planSafePath(bot, movements, destination, 150);
                if (path.status !== 'success') { await new Promise(resolve => setTimeout(resolve, 0)); continue; }
                await api.prepareTravel?.(feet);
                if (bot.interrupt_code) return false;
                bot.pathfinder.setMovements(movements);
                try {
                    if (api.travel) { if (!await api.travel(feet)) continue; }
                    else await bot.pathfinder.goto(destination);
                }
                catch (error) {
                    if (bot.interrupt_code) return false;
                    api.log?.('Safe stone approach blocked: ' + error.message);
                    continue;
                }
            } else bot.pathfinder.setMovements(movements);
            if (bot.interrupt_code) return false;
            const block = bot.blockAt(candidate.position);
            const current = bot.entity.position;
            if (!matches(block) || sameColumn(current, block.position) ||
                !standingPositions(bot, block).some(p => current.distanceTo(p.offset(0.5, 0, 0.5)) < 0.8)) continue;
            if (!api.canBreak(block)) continue;
            await bot.tool.equipForBlock(block);
            if (bot.interrupt_code) return false;
            if (!block.canHarvest(bot.heldItem?.type ?? null)) {
                api.log?.('A usable harvesting tool is required for this block.');
                return false;
            }
            await bot.dig(block, true);
            if (bot.interrupt_code) return false;
            // A side position can be just outside automatic pickup range.
            // Enter the cleared block only when it has headroom and a solid
            // floor; never dig another block or place a scaffold for pickup.
            const cleared = block.position;
            if (empty(bot.blockAt(cleared)) && empty(bot.blockAt(cleared.offset(0, 1, 0))) &&
                solid(bot.blockAt(cleared.offset(0, -1, 0)))) {
                try {
                    if (api.travel) await api.travel(cleared);
                    else await bot.pathfinder.goto(new pf.goals.GoalBlock(cleared.x, cleared.y, cleared.z));
                }
                catch (error) {
                    if (bot.interrupt_code) return false;
                    api.log?.('Stone drop approach blocked: ' + error.message);
                }
            }
            api.log?.('Mined ' + block.name + ' from a supported side position; recipe materials remain reserved.');
            return true;
        }
    }
    api.log?.('No safely reachable exposed resource in this area; checking recovery options.');
    return false;
}
