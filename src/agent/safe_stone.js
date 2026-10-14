import pf from 'mineflayer-pathfinder';
import { safeMiningMovements } from './navigation_policy.js';

const hazards = new Set(['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'campfire', 'soul_campfire', 'powder_snow']);
const solid = block => block?.boundingBox === 'block' && !hazards.has(block.name);
const empty = block => block?.boundingBox === 'empty' && !hazards.has(block.name);
const stone = block => block && ['stone', 'cobblestone'].includes(block.name);
const sameColumn = (a, b) => Math.floor(a.x) === b.x && Math.floor(a.z) === b.z;

export function stoneStandingPositions(bot, block) {
    if (!stone(block) || !block.position) return [];
    const target = block.position;
    // Never select our support block, even if it is the closest stone.
    if (sameColumn(bot.entity.position, target) && target.y < Math.floor(bot.entity.position.y)) return [];
    if (!solid(bot.blockAt(target.offset(0, -1, 0)))) return [];
    const positions = [];
    for (const dy of [0, -1]) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const feet = target.offset(dx, dy, dz);
            if (empty(bot.blockAt(feet)) && empty(bot.blockAt(feet.offset(0, 1, 0))) &&
                solid(bot.blockAt(feet.offset(0, -1, 0)))) positions.push(feet);
        }
    }
    return positions.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
}

export function findSafeStoneTargets(bot, canBreak) {
    // Extra-info filtering runs on actual blocks at their real positions,
    // rather than the position-less palette entries used for section matching.
    return bot.findBlocks({
        matching: stone,
        useExtraInfo: block => canBreak(block) && stoneStandingPositions(bot, block).length > 0,
        maxDistance: 64,
        count: 12
    }).map(position => bot.blockAt(position)).filter(Boolean);
}

export async function collectStoneFromSide(bot, candidates, api) {
    for (const candidate of candidates) {
        for (const feet of stoneStandingPositions(bot, candidate)) {
            if (bot.interrupt_code) return false;
            const movements = safeMiningMovements(api.movements());
            const destination = new pf.goals.GoalBlock(feet.x, feet.y, feet.z);
            const path = bot.pathfinder.getPathTo(movements, destination, 75);
            if (path.status !== 'success') { await new Promise(resolve => setTimeout(resolve, 0)); continue; }
            await api.prepareTravel?.(feet);
            if (bot.interrupt_code) return false;
            bot.pathfinder.setMovements(movements);
            try { await bot.pathfinder.goto(destination); }
            catch (error) {
                if (bot.interrupt_code) return false;
                api.log?.('Safe stone approach blocked: ' + error.message);
                continue;
            }
            if (bot.interrupt_code) return false;
            const block = bot.blockAt(candidate.position);
            const current = bot.entity.position;
            if (!stone(block) || sameColumn(current, block.position) ||
                !stoneStandingPositions(bot, block).some(p => current.distanceTo(p.offset(0.5, 0, 0.5)) < 0.8)) continue;
            if (!api.canBreak(block)) continue;
            await bot.tool.equipForBlock(block);
            if (bot.interrupt_code) return false;
            if (!block.canHarvest(bot.heldItem?.type ?? null)) {
                api.log?.('A usable pickaxe is required to mine stone.');
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
                try { await bot.pathfinder.goto(new pf.goals.GoalBlock(cleared.x, cleared.y, cleared.z)); }
                catch (error) {
                    if (bot.interrupt_code) return false;
                    api.log?.('Stone drop approach blocked: ' + error.message);
                }
            }
            api.log?.('Mined stone from a reachable side position; crafting cobblestone remains reserved.');
            return true;
        }
    }
    api.log?.('No safely reachable exposed stone. Move near a stone wall or an accessible cave; I will not dig a vertical hole to get cobblestone.');
    return false;
}
