import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { shelterBlueprint, shelterRecord, knownShelter } from './shelter_blueprint.js';
import { safeSolid, safeEmpty, safeFeet, walkSafely, planSafePath } from './navigation_recovery.js';
import { safeMiningMovements } from './navigation_policy.js';
import { blockFaceReachable } from './block_interaction.js';
import { sleep } from './managed_goal.js';

const air = block => ['air', 'cave_air', 'void_air'].includes(block?.name);
const plants = new Set(['short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow']);
const clearable = block => air(block) || plants.has(block?.name);
const fullFloor = block => safeSolid(block) && !block.name.endsWith('_leaves') &&
    block.shapes?.some(s => s.every((n, i) => n === (i < 3 ? 0 : 1)));
const key = p => `${p.x},${p.y},${p.z}`;
const properties = block => block?.getProperties?.() || {};

export function shelterDoor(bot, record) {
    const { door } = shelterBlueprint(record);
    const lower = bot.blockAt(door), upper = bot.blockAt(door.offset(0, 1, 0));
    const a = properties(lower), b = properties(upper);
    const present = lower?.name === 'oak_door' && upper?.name === 'oak_door' &&
        a.half === 'lower' && b.half === 'upper' && ['north', 'south'].includes(a.facing) &&
        a.facing === b.facing && a.hinge === b.hinge && a.open === b.open;
    return { present, open: present && a.open === true };
}

// Full foundation, interior headroom, doorway and roof are re-observed, not
// inferred from inventory loss or a previously successful placement call.
export function inspectShelter(bot, record, { newSite = false } = {}) {
    const plan = shelterBlueprint(record), expected = new Map(plan.blocks.map(s => [key(s.position), s.item]));
    const missing = [], clear = [], doorState = shelterDoor(bot, record);
    for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) {
        const base = plan.origin.offset(x, 0, z);
        if (!fullFloor(bot.blockAt(base.offset(0, -1, 0))))
            throw new Error('Shelter needs a loaded, level, solid floor at ' + base.offset(0, -1, 0) + '. No filling or digging was attempted.');
        for (let y = 0; y < 3; y++) {
            const p = base.offset(0, y, 0), block = bot.blockAt(p), want = expected.get(key(p));
            const isDoor = x === 2 && z === 0 && y < 2;
            if (!newSite && (want && block?.name === want || isDoor && doorState.present)) continue;
            if (!clearable(block)) throw new Error('Shelter space is obstructed or unloaded at ' + p +
                ' (' + (block?.name || 'unknown') + '); existing blocks will not be replaced.');
            if (plants.has(block.name)) clear.push({ type: 'clear', item: block.name, position: p });
        }
    }
    // The one-block approach outside the door must remain supported and clear.
    if (!fullFloor(bot.blockAt(plan.outside.offset(0, -1, 0)))) throw new Error('Shelter entrance has no safe outside support.');
    for (let y = 0; y < 2; y++) {
        const p = plan.outside.offset(0, y, 0), block = bot.blockAt(p);
        if (!clearable(block)) throw new Error('Shelter entrance approach is obstructed or unloaded at ' + p + '.');
        if (plants.has(block.name)) clear.push({ type: 'clear', item: block.name, position: p });
    }
    for (const step of plan.blocks) {
        const block = bot.blockAt(step.position);
        if (step.position.x < plan.origin.x) {
            if (!fullFloor(bot.blockAt(new Vec3(step.position.x, plan.origin.y - 1, step.position.z))))
                throw new Error('Shelter access steps have no loaded solid foundation.');
            if (newSite || block?.name !== step.item) {
                if (!clearable(block)) throw new Error('Shelter access steps are obstructed or unloaded at ' + step.position + '.');
                if (plants.has(block.name)) clear.push({ type: 'clear', item: block.name, position: step.position });
            }
        }
        if (block?.name !== step.item) missing.push(step);
    }
    return { ...plan, missing, clear, planks: missing.length, needsDoor: !doorState.present, doorState,
        structureComplete: missing.length === 0 && doorState.present && clear.length === 0 };
}

export async function findShelterSite(bot, api) {
    const here = bot.entity.position.floored(), candidates = [];
    for (let dx = -10; dx <= 10; dx += 2) for (let dz = -10; dz <= 10; dz += 2)
        for (const dy of [0, 1, -1, 2, -2]) candidates.push(here.offset(dx - 2, dy, dz - 2));
    candidates.sort((a, b) => a.offset(2, 0, 2).distanceTo(here) - b.offset(2, 0, 2).distanceTo(here));
    const deadline = Date.now() + 4000;
    let routes = 0;
    for (let i = 0; i < candidates.length && Date.now() < deadline; i++) {
        if (i % 20 === 0) await sleep(0);
        if (bot.interrupt_code) return null;
        const record = shelterRecord({ version: 1, origin: candidates[i] });
        if (!record) continue;
        let plan;
        try {
            plan = inspectShelter(bot, record, { newSite: true });
            // A clear working ring avoids choosing a site pressed against a wall.
            for (let x = -1; x <= 5; x++) for (let z = -1; z <= 5; z++) {
                if (x !== -1 && x !== 5 && z !== -1 && z !== 5) continue;
                const at = plan.origin.offset(x, 0, z);
                if (!fullFloor(bot.blockAt(at.offset(0, -1, 0))) ||
                    !clearable(bot.blockAt(at)) || !clearable(bot.blockAt(at.offset(0, 1, 0)))) throw new Error('No working ring');
            }
        } catch { continue; }
        if (++routes > 8) break;
        const goal = new pf.goals.GoalBlock(plan.inside.x, plan.inside.y, plan.inside.z);
        const route = await planSafePath(bot, safeMiningMovements(api.movements()), goal, 250);
        if (route.status === 'success') return record;
    }
    return null;
}

function overlaps(entity, p, height = 1, horizontalMargin = 0) {
    const at = entity.position, halfWidth = (entity.width || 0.6) / 2 + horizontalMargin;
    return at && at.x + halfWidth > p.x && at.x - halfWidth < p.x + 1 &&
        at.z + halfWidth > p.z && at.z - halfWidth < p.z + 1 &&
        at.y < p.y + height && at.y + (entity.height || 1.8) > p.y;
}

function otherOccupant(bot, p, height) {
    return Object.values(bot.entities || {}).find(e => e !== bot.entity && e.height > 0 &&
        !['item', 'experience_orb'].includes(e.name) && e.type !== 'orb' && overlaps(e, p, height));
}

function placementGoal(bot, p, item, baseY, excluded = new Set()) {
    if (!air(bot.blockAt(p)) || item === 'oak_door' && !air(bot.blockAt(p.offset(0, 1, 0)))) return null;
    const face = new pf.goals.GoalPlaceBlock(p, bot.world, { range: 4, LOS: true,
        ...(item === 'oak_door' ? { faces: [new Vec3(0, -1, 0)] } : {}) });
    const points = [];
    for (let dy = 0; dy <= 3; dy++) for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) {
        const at = new Vec3(p.x + x, baseY + dy, p.z + z);
        // GoalBlock accepts a cell, not a centered player hitbox. Keep half a
        // cell of horizontal arrival tolerance where the body shares target
        // height; overhead placement from inside still remains available.
        if (!excluded.has(key(at)) && !overlaps({ width: bot.entity.width, height: bot.entity.height, position: at.offset(0.5, 0, 0.5) },
            p, item === 'oak_door' ? 2 : 1, 0.5) && safeFeet(bot, at) && face.isEnd(at) &&
            (item !== 'oak_door' || at.z > p.z && at.x === p.x)) points.push(at);
    }
    if (!points.length) return null;
    points.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
    const goal = new pf.goals.GoalCompositeAny(points.map(p => new pf.goals.GoalBlock(p.x, p.y, p.z)));
    const matches = goal.isEnd.bind(goal);
    goal.isEnd = at => matches(at) && safeFeet(bot, new Vec3(at.x, at.y, at.z)) && face.isEnd(at);
    return { goal, face };
}

async function observed(bot, predicate, active, timeoutMs) {
    const end = Date.now() + timeoutMs;
    do {
        if (!active()) return false;
        if (predicate()) return true;
        if (Date.now() >= end) break;
        await sleep(Math.min(50, Math.max(1, end - Date.now())));
    } while (true);
    return false;
}

export async function placeShelterBlock(bot, record, step, api, active, { verifyMs = 1500, approachMs = 15000 } = {}) {
    const p = step.position, itemName = step.item, height = itemName === 'oak_door' ? 2 : 1;
    const matches = () => itemName === 'oak_door' ? shelterDoor(bot, record).present : bot.blockAt(p)?.name === itemName;
    const excluded = new Set(), deadline = Date.now() + approachMs;
    let lastReason = 'No usable work position remained.';
    const inspect = () => {
        const block = bot.blockAt(p);
        if (!air(block)) throw new Error('Shelter target ' + p + ' changed to ' + (block?.name || 'unloaded') + '; existing blocks were retained.');
        if (itemName === 'oak_door' && !air(bot.blockAt(p.offset(0, 1, 0))))
            throw new Error('Shelter doorway upper cell is obstructed or unloaded at ' + p.offset(0, 1, 0) + '.');
        const occupant = otherOccupant(bot, p, height);
        if (occupant) throw new Error('Shelter target ' + p + ' is occupied by ' +
            (occupant.username || occupant.name || occupant.type || 'another entity') + ' at ' + occupant.position + '; move clear before resuming.');
    };
    const retry = reason => {
        excluded.add(key(bot.entity.position.floored()));
        lastReason = reason + ' Actual feet: ' + bot.entity.position + '.';
        api.log?.('Shelter approach retry: ' + lastReason);
    };
    for (let approach = 0; approach < 3 && Date.now() < deadline; approach++) {
        if (!active()) return false;
        if (matches()) return true;
        inspect();
        const work = placementGoal(bot, p, itemName, record.origin.y, excluded);
        if (!work) throw new Error('No supported position with a visible placement face at ' + p + '. ' + lastReason);
        if (!await walkSafely(bot, p, { ...api, goal: work.goal, timeoutMs: Math.max(1, deadline - Date.now()) })) {
            if (!active()) return false;
            throw new Error('Safe route did not reach a shelter work position for ' + p + '; actual feet: ' + bot.entity.position + '.');
        }
        if (!active()) return false;
        if (matches()) return true;
        inspect();
        if (!work.goal.isEnd(bot.entity.position.floored()) || overlaps(bot.entity, p, height)) {
            retry('Mia overlaps the target or left the planned work cell.'); continue;
        }
        const item = bot.inventory.items().find(i => i.name === itemName);
        if (!item) throw new Error('Missing ' + itemName + ' in live inventory.');
        await bot.equip(item, 'hand');
        if (!active()) return false;
        if (matches()) return true;
        inspect();
        if (overlaps(bot.entity, p, height)) { retry('Mia drifted into the placement target while equipping.'); continue; }
        const fresh = placementGoal(bot, p, itemName, record.origin.y, excluded);
        const hit = fresh?.face.getFaceAndRef(bot.entity.position.offset(0, 1.6, 0));
        if (!hit) { retry('The placement face is not visible from Mia\'s actual eye position.'); continue; }
        const support = bot.blockAt(hit.ref), sneaking = Boolean(bot.getControlState?.('sneak'));
        let changed = false, response = '';
        try {
            bot.setControlState('sneak', true);
            await bot.lookAt(hit.to, true);
            if (!active()) return false;
            if (matches()) return true;
            inspect();
            const again = placementGoal(bot, p, itemName, record.origin.y, excluded)?.face.getFaceAndRef(bot.entity.position.offset(0, 1.6, 0));
            if (overlaps(bot.entity, p, height) || !again || !again.ref.equals(hit.ref) || !again.face.equals(hit.face)) changed = true;
            else try { await bot.placeBlock(support, hit.face.scaled(-1)); }
            catch (error) { response = String(error.message || error).slice(0, 240); api.log?.('Shelter placement response: ' + response); }
        } finally { bot.setControlState('sneak', sneaking); }
        if (changed) { retry('Support, visibility or body clearance changed before the placement packet.'); continue; }
        // Once a packet is sent, never try another cell/packet on an ambiguous
        // response. Wait for real world evidence, then let the next goal step
        // reconcile a late update against this exact coordinate.
        if (await observed(bot, matches, active, verifyMs)) return true;
        if (!active()) return false;
        throw new Error('No verified ' + itemName + ' at ' + p + '; actual feet: ' + bot.entity.position +
            (response ? '; server response: ' + response : '') + '; site retained for rechecking.');
    }
    if (!active()) return false;
    throw new Error('Shelter approach budget exhausted for ' + p + '. ' + lastReason);
}

function plantReachable(bot, p, at) {
    const eye = at.offset(0.5, 1.6, 0.5), delta = p.offset(0.5, 0.5, 0.5).minus(eye), length = delta.norm();
    if (!bot.world?.raycast || length <= 0 || length > 4) return false;
    const hit = bot.world.raycast(eye, delta.scaled(1 / length), length);
    // Non-colliding grass has no raycast shape. It is still diggable if no
    // solid intervening block hides its cell.
    return !hit || hit.position?.equals(p);
}

export async function clearShelterPlant(bot, record, step, api, active, { verifyMs = 1500 } = {}) {
    if (!active()) return false;
    const p = step.position, block = bot.blockAt(p);
    if (air(block)) return true;
    if (!plants.has(block?.name)) throw new Error('Refusing to clear a non-plant block at ' + p + '.');
    const feet = [];
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
        const at = new Vec3(p.x + x, record.origin.y, p.z + z);
        if (safeFeet(bot, at) && plantReachable(bot, p, at)) feet.push(at);
    }
    if (!feet.length) throw new Error('No safe position to clear a plant at ' + p + '.');
    const goal = new pf.goals.GoalCompositeAny(feet.map(p => new pf.goals.GoalBlock(p.x, p.y, p.z)));
    if (!await walkSafely(bot, p, { ...api, goal }) || !active()) return false;
    const current = bot.blockAt(p);
    if (!plants.has(current?.name) || !plantReachable(bot, p, bot.entity.position.floored())) return air(current);
    await bot.dig(current, true);
    return observed(bot, () => air(bot.blockAt(p)), active, verifyMs);
}

async function setShelterDoor(bot, record, open, active, verifyMs) {
    const plan = shelterBlueprint(record);
    if (!active()) return false;
    const current = shelterDoor(bot, record);
    if (!current.present) return false;
    if (current.open === open) return true;
    if (!blockFaceReachable(bot, plan.door, bot.entity.position.floored())) return false;
    const sneak = Boolean(bot.getControlState?.('sneak'));
    try {
        bot.setControlState('sneak', false);
        await bot.lookAt(plan.door.offset(0.5, 0.5, 0.5), true);
        if (!active()) return false;
        await bot.activateBlock(bot.blockAt(plan.door));
    } finally { bot.setControlState('sneak', sneak); }
    return observed(bot, () => { const door = shelterDoor(bot, record); return door.present && door.open === open; }, active, verifyMs);
}

function openDoorTravel(bot, record, api) {
    const plan = shelterBlueprint(record);
    // This pathfinder version treats even open wooden doors as solid. Only
    // our observed open north/south doorway has a clear center passage; no
    // other door, wall, liquid or unknown block gets a movement exception.
    return { ...api, prepareTravel: undefined, movements: () => {
        const movements = api.movements(), getBlock = movements.getBlock.bind(movements);
        movements.getBlock = (...args) => {
            const block = getBlock(...args);
            if (block.position?.x === plan.door.x && block.position?.z === plan.door.z &&
                [plan.door.y, plan.door.y + 1].includes(block.position?.y) &&
                block.name === 'oak_door' && shelterDoor(bot, record).open) {
                block.safe = true; block.physical = false;
                block.height = block.position.y;
            }
            return block;
        };
        return movements;
    } };
}

// Used before ordinary/managed travel as well as by the builder. Only an
// explicitly remembered shelter door is opened; arbitrary player doors are
// not claimed. Crossing happens before the caller plans its remaining route.
export async function prepareShelterTravel(bot, destination, api, { verifyMs = 1500 } = {}) {
    const record = knownShelter(bot);
    if (!record || bot.shelterCrossing || bot.interrupt_code || !destination) return;
    const plan = shelterBlueprint(record), dimension = String(bot.game?.dimension ?? 'unknown');
    const inside = p => p.x >= plan.origin.x + 1 && p.x < plan.origin.x + 4 &&
        p.z >= plan.origin.z + 1 && p.z < plan.origin.z + 4 && p.y >= plan.origin.y && p.y < plan.origin.y + 2;
    const fromInside = inside(bot.entity.position);
    if (fromInside === inside(destination)) return;
    // A partial build without a door has an open doorway already.
    const lower = bot.blockAt(plan.door), upper = bot.blockAt(plan.door.offset(0, 1, 0));
    if (air(lower) && air(upper)) return;
    const active = () => !bot.interrupt_code && String(bot.game?.dimension ?? 'unknown') === dimension;
    bot.shelterCrossing = true;
    try {
        const entry = fromInside ? plan.origin.offset(2, 0, 1) : plan.outside;
        if (!await walkSafely(bot, entry, { ...api, prepareTravel: undefined }) || !active() ||
            !shelterDoor(bot, record).present || !await setShelterDoor(bot, record, true, active, verifyMs)) {
            if (active()) throw new Error('Could not open the remembered shelter door safely; travel stopped.');
            return;
        }
        if (!await walkSafely(bot, fromInside ? plan.outside : plan.inside, openDoorTravel(bot, record, api)) ||
            !await setShelterDoor(bot, record, false, active, verifyMs)) {
            if (active()) throw new Error('Could not verify passage through the remembered shelter door; travel stopped.');
            return;
        }
        api.log?.('Used the remembered shelter entrance and closed its door.');
    } finally { bot.shelterCrossing = false; }
}

export async function leaveShelterForResource(bot, api) {
    const record = knownShelter(bot);
    if (record) await prepareShelterTravel(bot, shelterBlueprint(record).outside, api);
}

// Exercise the actual entrance: open it, cross outside and back inside, close
// it, then verify the whole shell and headroom before claiming a home.
export async function enterAndVerifyShelter(bot, record, api, active, { verifyMs = 1500 } = {}) {
    const plan = inspectShelter(bot, record);
    if (!plan.structureComplete || !active()) return false;
    const work = new pf.goals.GoalCompositeAny([plan.origin.offset(2, 0, 1), plan.outside]
        .map(p => new pf.goals.GoalBlock(p.x, p.y, p.z)));
    // The builder controls the door itself during final verification. Bypass
    // the general travel hook so it cannot close the door mid entrance test.
    api = { ...api, prepareTravel: undefined };
    if (!await walkSafely(bot, plan.door, { ...api, goal: work }) ||
        !await setShelterDoor(bot, record, true, active, verifyMs)) return false;
    const doorwayTravel = openDoorTravel(bot, record, api);
    if (!active() || !await walkSafely(bot, plan.outside, doorwayTravel)) return false;
    if (!active() || !await walkSafely(bot, plan.inside, doorwayTravel)) return false;
    if (!await setShelterDoor(bot, record, false, active, verifyMs) || !active()) return false;
    const final = inspectShelter(bot, record);
    return final.structureComplete && !final.doorState.open && bot.entity.position.floored().equals(plan.inside);
}
