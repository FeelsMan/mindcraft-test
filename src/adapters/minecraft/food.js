import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { safeFeet, safeWaypoints, walkSafely } from '../../agent/navigation_recovery.js';
import { protectCraftingMaterials } from '../../agent/navigation_policy.js';
import { prepareShelterTravel } from '../../agent/shelter_building.js';
import { blockFaceReachable } from '../../agent/block_interaction.js';
import { withActionWatchdog } from '../../agent/action_interrupt.js';

const crops = Object.freeze({
    carrots: { item: 'carrot', seed: 'carrot' }, potatoes: { item: 'potato', seed: 'potato' },
    wheat: { item: 'wheat', seed: 'wheat_seeds' }, beetroots: { item: 'beetroot', seed: 'beetroot_seeds' }
});
const animals = Object.freeze({ cow: 'beef', pig: 'porkchop', sheep: 'mutton', chicken: 'chicken', rabbit: 'rabbit' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finite = p => p && [p.x, p.y, p.z].every(Number.isFinite);
const position = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const vector = p => new Vec3(p.x, p.y, p.z);
const key = p => `${p.x},${p.y},${p.z}`;
const sameScope = (a, b) => a && b && a.world === b.world && a.dimension === b.dimension;
const air = b => ['air', 'cave_air', 'void_air'].includes(b?.name);

// A world-food specialist invoked by the existing managed action owner. No
// independent hunting/farming timer or secondary goal scheduler is installed.
export class MinecraftFoodAdapter {
    constructor(agent, skillsApi = {}, { routeMs = 5000, actionMs = 14000, huntMs = 5000,
        verifyMs = 1200, pollMs = 50, searchLimit = 6, searchRadius = 64 } = {}) {
        this.agent = agent; this.skills = skillsApi;
        Object.assign(this, { routeMs, actionMs, huntMs, verifyMs, pollMs, searchLimit, searchRadius });
    }

    scope() { return { world: this.agent.local_memory?.world || null,
        dimension: String(this.agent.bot.game?.dimension ?? 'unknown') }; }
    count(item) { return this.agent.bot.inventory.items().filter(i => i.name === item).reduce((n, i) => n + i.count, 0); }
    available(valid, scope = this.scope(), death = this.agent.death_epoch || 0) {
        const agent = this.agent, bot = agent.bot;
        return Boolean(valid() && !bot.interrupt_code && !agent._shuttingDown && !agent._disconnectHandled &&
            !agent.recovering_from_death && !bot._client?.ended && bot.health !== 0 &&
            finite(bot.entity?.position) && bot.inventory?.items && sameScope(scope, this.scope()) &&
            death === (agent.death_epoch || 0));
    }
    async checkpoint(goal) {
        if (goal.checkpoint) await goal.checkpoint();
        else if (this.skills.checkpoint) await this.skills.checkpoint(goal);
        else if (goal.memoryId) await this.agent.local_memory?.checkpoint(goal);
    }
    canCarry(item) {
        const inventory = this.agent.bot.inventory;
        return !inventory.emptySlotCount || inventory.emptySlotCount() > 0 || inventory.items().some(i =>
            i.name === item && i.count < (this.agent.bot.registry.itemsByName[item]?.stackSize || 64));
    }
    maxAge(name) {
        const state = this.agent.bot.registry?.blocksByName?.[name]?.states?.find(s => s.name === 'age');
        if (!state) return null;
        const ages = state.values?.map(Number).filter(Number.isFinite);
        return ages?.length ? Math.max(...ages) : Number.isInteger(state.num_values) ? state.num_values - 1 : null;
    }
    mature(block) {
        const maximum = this.maxAge(block?.name), age = block?.getProperties?.().age;
        return Boolean(crops[block?.name] && maximum !== null && Number(age) === maximum && age !== undefined);
    }
    cropSource(source, planting = false) {
        const spec = crops[source?.block];
        return Boolean(spec && finite(source.position) && source.scope?.world && source.scope.dimension !== 'unknown' &&
            sameScope(source.scope, this.scope()) &&
            (source.item === spec.item || planting && source.item === spec.seed) && source.seed === spec.seed);
    }
    standing(at) {
        const bot = this.agent.bot, support = at.offset(0, -1, 0), choices = [];
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1],
            [2, 0], [-2, 0], [0, 2], [0, -2]])
            for (const dy of [0, 1, -1]) {
                const feet = at.offset(dx, dy, dz);
                if (safeFeet(bot, feet) && blockFaceReachable(bot, support, feet, 4.25)) choices.push(feet);
            }
        return choices.sort((a, b) => Number(bot.blockAt(a.offset(0, -1, 0))?.name === 'farmland') -
            Number(bot.blockAt(b.offset(0, -1, 0))?.name === 'farmland') ||
            a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
    }
    workingAt(at) {
        return this.standing(at).some(p => this.agent.bot.entity.position.distanceTo(p.offset(0.5, 0, 0.5)) < 0.9);
    }
    travel(timeoutMs) {
        const bot = this.agent.bot;
        const supplied = this.skills.navigation?.(bot) || this.skills.getManagedTravel?.(bot);
        const baseMovements = supplied?.movements || (() => protectCraftingMaterials(bot, new pf.Movements(bot)));
        const movements = () => {
            const policy = baseMovements();
            // This milestone pursues land food only; even a route to an adult
            // on land must not choose swimming as its shortcut.
            for (const name of ['water', 'lava', 'fire', 'soul_fire', 'powder_snow']) {
                const id = bot.registry.blocksByName[name]?.id;
                if (Number.isInteger(id)) policy.blocksToAvoid.add(id);
            }
            return policy;
        };
        return { ...supplied, movements, timeoutMs: Math.min(this.routeMs, Math.max(1, timeoutMs)),
            stallMs: Math.min(1500, this.routeMs), progressMs: Math.min(2500, this.routeMs),
            pollMs: Math.max(1, this.pollMs), searchMs: 120,
            prepareTravel: supplied?.prepareTravel || (p => prepareShelterTravel(bot, p, { movements,
                timeoutMs: Math.min(this.routeMs, Math.max(1, timeoutMs)) })),
            log: message => this.log(message) };
    }
    async approach(points, active, deadline) {
        const bot = this.agent.bot;
        if (!active() || !points.length) return false;
        const goal = new pf.goals.GoalCompositeAny(points.slice(0, 8).map(p => new pf.goals.GoalBlock(p.x, p.y, p.z)));
        return await walkSafely(bot, points[0], { ...this.travel(deadline - Date.now()), goal }) && active() &&
            points.some(p => bot.entity.position.distanceTo(p.offset(0.5, 0, 0.5)) < 0.9);
    }
    async bounded(valid, fn) {
        const scope = this.scope(), death = this.agent.death_epoch || 0, end = Date.now() + this.actionMs;
        const active = () => Date.now() < end && this.available(valid, scope, death);
        let interrupted = false;
        const stop = () => {
            if (interrupted) return;
            interrupted = true; this.agent.requestInterrupt();
        };
        const monitor = setInterval(() => { if (!active()) stop(); }, this.pollMs);
        try {
            return await withActionWatchdog(this.agent, () => fn(active, end), this.actionMs + 5000,
                'Food action could not settle safely; restarting with saved state.');
        } finally { clearInterval(monitor); }
    }
    async wait(check, active, timeoutMs = this.verifyMs) {
        const end = Date.now() + timeoutMs;
        while (active()) {
            if (check()) return true;
            if (Date.now() >= end) break;
            await sleep(Math.min(this.pollMs, Math.max(1, end - Date.now())));
        }
        return false;
    }
    async pickup(names, active, deadline) {
        const bot = this.agent.bot;
        for (const item of [...new Set(names)]) {
            if (!active() || Date.now() >= deadline) break;
            if (this.skills.pickup) await this.skills.pickup(bot, item);
            else if (this.skills.pickupNearbyItems) await this.skills.pickupNearbyItems(bot, { itemName: item });
            else {
                const drops = Object.values(bot.entities || {}).filter(e => e.name === 'item' && finite(e.position) &&
                    e.getDroppedItem?.()?.name === item && e.position.distanceTo(bot.entity.position) <= 6).slice(0, 2);
                for (const drop of drops) {
                    if (!active() || Date.now() >= deadline) break;
                    const at = drop.position.floored();
                    if (safeFeet(bot, at)) await walkSafely(bot, at, this.travel(deadline - Date.now()));
                }
            }
        }
    }
    rememberPatch(source) {
        const memory = this.agent.local_memory, scope = this.scope();
        if (!scope.world || !memory?.safe || !sameScope(source.scope, scope)) return;
        memory.safe(() => memory.store.putLocation(scope.world, scope.dimension,
            'food:patch:' + key(source.position), 'food_patch', source.position,
            { block: source.block, item: crops[source.block].item, seed: source.seed, replanted: true }));
    }

    async discover(valid, { radius = 24 } = {}) {
        const bot = this.agent.bot, result = { crops: [], animals: [] };
        if (!this.available(valid) || !Number.isFinite(radius)) return result;
        radius = Math.min(32, Math.max(1, radius));
        const scope = this.scope(), ids = Object.keys(crops).map(n => bot.registry.blocksByName[n]?.id).filter(Number.isInteger);
        const seen = bot.findBlocks?.({ matching: ids, maxDistance: radius, count: 24 }) || [];
        const memory = this.agent.local_memory;
        const known = memory?.safe?.(() => memory.store.locations(scope.world, scope.dimension, 'food_patch'), []) || [];
        const positions = [...seen, ...known.map(row => row.position)].filter(finite), unique = new Set();
        for (const p of positions.slice(0, 48)) {
            if (!this.available(valid, scope)) break;
            const at = vector(position(p)), k = key(at);
            if (unique.has(k) || at.distanceTo(bot.entity.position) > radius) continue;
            unique.add(k);
            const block = bot.blockAt(at), farmland = bot.blockAt(at.offset(0, -1, 0));
            if (!this.mature(block) || farmland?.name !== 'farmland' || !this.standing(at).length) continue;
            result.crops.push({ kind: 'harvest', block: block.name, ...crops[block.name], position: position(at),
                mature: true, scope: { ...scope } });
            if (result.crops.length >= 12) break;
        }
        result.crops.sort((a, b) => vector(a.position).distanceTo(bot.entity.position) - vector(b.position).distanceTo(bot.entity.position));
        for (const entity of Object.values(bot.entities || {})) {
            if (!this.available(valid, scope) || result.animals.length >= 8) break;
            if (!this.huntable(entity) || entity.position.distanceTo(bot.entity.position) > radius) continue;
            result.animals.push({ kind: 'hunt', name: entity.name, item: animals[entity.name], entityId: entity.id,
                position: position(entity.position), scope: { ...scope } });
        }
        result.animals.sort((a, b) => vector(a.position).distanceTo(bot.entity.position) - vector(b.position).distanceTo(bot.entity.position));
        return result;
    }

    async harvest(source, valid, goal) {
        return this.bounded(valid, async (active, deadline) => {
            const bot = this.agent.bot;
            if (!active() || !this.cropSource(source)) return { verified: false, reason: 'Crop source is unavailable or belongs to another scope.' };
            if (goal.replantPending) return { verified: false, reason: 'Finish the saved replant obligation before harvesting another crop.' };
            const at = vector(source.position);
            const ready = () => this.mature(bot.blockAt(at)) && bot.blockAt(at)?.name === source.block &&
                bot.blockAt(at.offset(0, -1, 0))?.name === 'farmland';
            if (!ready() || !this.canCarry(source.item)) return { verified: false, reason: 'Crop is unripe, unloaded or there is no inventory space.' };
            if (!await this.approach(this.standing(at), active, deadline) || !ready())
                return { verified: false, reason: 'No verified supported approach to the mature crop.' };
            if (!active() || !this.cropSource(source) || !ready() || !this.workingAt(at)) return { verified: false, reason: 'Crop changed before harvesting.' };
            const before = this.count(source.item);
            goal.replantPending = { kind: 'replant', block: source.block, item: source.item, seed: source.seed,
                position: position(at), scope: { ...source.scope } };
            await this.checkpoint(goal); // Durable intent precedes destruction.
            if (!active() || !ready() || !this.workingAt(at)) return { verified: false, reason: 'Harvest interrupted; saved replant intent retained.', replantPending: goal.replantPending };
            await bot.dig(bot.blockAt(at), true);
            if (active()) await this.pickup([source.item, source.seed], active, deadline);
            const verified = await this.wait(() => this.count(source.item) > before && air(bot.blockAt(at)) &&
                bot.blockAt(at.offset(0, -1, 0))?.name === 'farmland', active);
            return { verified, reason: verified ? 'Mature crop removal and food pickup verified; planting material is reserved for replanting.' :
                'Crop harvest/pickup was not verified; saved replant obligation retained.', replantPending: goal.replantPending };
        });
    }

    async replant(source, valid) {
        return this.bounded(valid, async (active, deadline) => {
            const bot = this.agent.bot;
            if (!active() || !this.cropSource(source, true)) return { verified: false, reason: 'Replant source is unavailable or belongs to another scope.' };
            const at = vector(source.position), current = bot.blockAt(at);
            // A saved pre-dig intent may outlive a cancellation before digging.
            // Observed existing crop is preserved; no extra seed is consumed.
            if (current?.name === source.block && bot.blockAt(at.offset(0, -1, 0))?.name === 'farmland')
                return { verified: true, reason: 'The saved farm position still contains its crop; no replant action is needed.' };
            const ready = () => air(bot.blockAt(at)) && bot.blockAt(at.offset(0, -1, 0))?.name === 'farmland';
            if (!ready()) return { verified: false, reason: 'Replant position or farmland is obstructed/unloaded; retained for recovery.' };
            if (this.count(source.seed) < 1) return { verified: false, reason: `Replant blocked: retain one ${source.seed} before continuing.` };
            if (!await this.approach(this.standing(at), active, deadline) || !active() || !ready())
                return { verified: false, reason: 'No verified supported approach for replanting.' };
            const item = bot.inventory.items().find(i => i.name === source.seed), before = this.count(source.seed);
            if (!item || before < 1 || !active()) return { verified: false, reason: 'Reserved planting material is no longer in live inventory.' };
            await bot.equip(item, 'hand');
            if (!active() || !ready() || !this.workingAt(at) || this.count(source.seed) < 1 || !this.cropSource(source, true))
                return { verified: false, reason: 'Planting conditions changed during equip.' };
            const farmland = bot.blockAt(at.offset(0, -1, 0));
            await bot.lookAt?.(farmland.position.offset(0.5, 0.9, 0.5), true);
            if (!active() || !ready() || !this.workingAt(at)) return { verified: false, reason: 'Replant interrupted before placement.' };
            await bot.placeBlock(farmland, new Vec3(0, 1, 0));
            const verified = await this.wait(() => bot.blockAt(at)?.name === source.block &&
                Number(bot.blockAt(at)?.getProperties?.().age) === 0 && this.count(source.seed) === before - 1, active);
            if (verified) this.rememberPatch(source);
            return { verified, reason: verified ? 'Young crop and exact planting-material decrease verified.' :
                'Replant placement/seed receipt was not verified; obligation retained.' };
        });
    }

    huntable(entity) {
        const bot = this.agent.bot;
        if (!animals[entity?.name] || !Number.isInteger(entity.id) || !finite(entity.position) || entity.isValid === false ||
            entity.isTamed || entity.owner || entity.customName) return false;
        const keys = bot.registry.entitiesByName[entity.name]?.metadataKeys;
        const baby = keys?.indexOf('baby'), custom = keys?.indexOf('custom_name');
        const age = baby >= 0 ? entity.metadata?.[baby] : undefined;
        if (![false, 0].includes(age) || custom >= 0 && entity.metadata?.[custom]) return false;
        return safeFeet(bot, entity.position.floored());
    }

    async hunt(source, valid) {
        return this.bounded(valid, async (active, deadline) => {
            const bot = this.agent.bot;
            const target = () => Object.values(bot.entities || {}).find(e => e.id === source?.entityId && e.name === source.name);
            if (!active() || !source?.scope?.world || source.scope.dimension === 'unknown' || !sameScope(source.scope, this.scope()) ||
                animals[source.name] !== source.item || !this.huntable(target()))
                return { verified: false, reason: 'Food animal is absent, protected, immature or unsafe to pursue.' };
            if (!this.canCarry(source.item)) return { verified: false, reason: 'No inventory space for verified animal food.' };
            const origin = target().position.clone(), at = origin.floored();
            const approaches = [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]
                .map(([x, z]) => at.offset(x, 0, z)).filter(p => safeFeet(bot, p));
            if (!await this.approach(approaches, active, deadline) || !this.huntable(target()) ||
                target().position.distanceTo(origin) > 4 || target().position.distanceTo(bot.entity.position) > 4)
                return { verified: false, reason: 'No bounded supported approach to the food animal.' };
            const weapons = bot.inventory.items().filter(i => /_(sword|axe|pickaxe|shovel)$/.test(i.name));
            weapons.sort((a, b) => Number(b.name.endsWith('_sword')) - Number(a.name.endsWith('_sword')));
            if (!weapons.length) return { verified: false, reason: 'Carry a usable weapon/tool before the bounded food hunt.' };
            await bot.equip(weapons[0], 'hand');
            if (!active() || !this.huntable(target()) || !sameScope(source.scope, this.scope()) ||
                target().position.distanceTo(origin) > 4 || target().position.distanceTo(bot.entity.position) > 4)
                return { verified: false, reason: 'Animal or safety conditions changed before attack.' };
            if (!bot.pvp?.attack || !bot.pvp?.stop) return { verified: false, reason: 'Bounded combat executor is unavailable.' };
            const before = this.count(source.item), huntEnd = Math.min(deadline, Date.now() + this.huntMs);
            let dead = false;
            const onDeath = entity => { if (entity?.id === source.entityId) dead = true; };
            bot.on('entityDead', onDeath);
            const previousMovements = bot.pvp.movements;
            let huntMovements;
            try {
                const travel = this.travel(huntEnd - Date.now());
                const movements = travel.movements();
                movements.canDig = false; movements.scafoldingBlocks = []; movements.allow1by1towers = false;
                movements.allowParkour = false; movements.maxDropDown = 2;
                // PVP.attack installs its own policy, so protect that exact
                // plugin field as well as the current pathfinder policy.
                bot.pvp.movements = huntMovements = movements;
                bot.pathfinder.setMovements(movements);
                await bot.pvp.attack(target());
                while (active() && !dead && Date.now() < huntEnd) {
                    const entity = target();
                    if (!this.huntable(entity) || entity.position.distanceTo(origin) > 8 ||
                        entity.position.distanceTo(bot.entity.position) > 8) break;
                    await sleep(Math.min(this.pollMs, Math.max(1, huntEnd - Date.now())));
                }
            } finally {
                try { await bot.pvp.stop(); } // Settle before any pickup/resumption.
                finally {
                    if (bot.pvp.movements === huntMovements) bot.pvp.movements = previousMovements;
                    bot.removeListener('entityDead', onDeath);
                }
            }
            if (!active() || !dead) return { verified: false, reason: 'Hunt stopped without a confirmed animal death; disappearance is not success.' };
            await this.pickup([source.item], active, deadline);
            const verified = await this.wait(() => this.count(source.item) > before, active);
            return { verified, reason: verified ? 'Animal death and expected raw-food pickup verified.' :
                'Animal death was observed, but expected food pickup was not verified.' };
        });
    }

    async search(valid, goal) {
        return this.bounded(valid, async (active, deadline) => {
            const bot = this.agent.bot, scope = this.scope();
            if (!active()) return { verified: false, progressed: false, reason: 'Food search interrupted.' };
            if (goal.foodSearch && !sameScope(goal.foodSearch, scope))
                return { verified: false, progressed: false, reason: 'Saved food search belongs to another world/dimension.' };
            const state = goal.foodSearch ??= { ...scope, origin: position(bot.entity.position), attempts: 0, visited: [] };
            if (!finite(state.origin) || !Number.isSafeInteger(state.attempts) || state.attempts < 0 || !Array.isArray(state.visited) ||
                state.attempts >= this.searchLimit) return { verified: false, progressed: false, reason: 'Food search attempt budget exhausted or invalid.' };
            const choices = safeWaypoints(bot, { radii: [12, 20, 28] }).filter(p =>
                p.distanceTo(vector(state.origin)) <= this.searchRadius && !state.visited.some(v => finite(v) && vector(v).distanceTo(p) < 8));
            for (const at of choices.slice(0, 2)) {
                if (!active() || state.attempts >= this.searchLimit) break;
                state.attempts++; state.visited.push(position(at)); state.visited = state.visited.slice(-12);
                await this.checkpoint(goal); // A restart cannot refund exploration.
                if (!active()) break;
                const before = bot.entity.position.clone();
                const verified = await walkSafely(bot, at, this.travel(deadline - Date.now()));
                const progressed = active() && bot.entity.position.distanceTo(before) >= 4;
                if (verified || progressed) return { verified: Boolean(verified && active()), progressed,
                    reason: 'Food search changed the observed area; rescan live sources before claiming food.' };
            }
            return { verified: false, progressed: false, reason: 'No safe supported food-search route completed within the saved budget.' };
        });
    }

    log(message) { this.skills.log?.(this.agent.bot, message); }
}

export function createFoodAPI(agent, skillsApi = {}, options = {}) {
    const adapter = new MinecraftFoodAdapter(agent, skillsApi, options);
    return Object.fromEntries(['discover', 'harvest', 'replant', 'hunt', 'search'].map(name => [name, adapter[name].bind(adapter)]));
}
