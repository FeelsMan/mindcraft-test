import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { SurvivalSupervisor, survivalDefaults } from '../../supervisors/survival.js';
import { sameScope } from '../../core/worldState.js';
import { inspectShelter, prepareShelterTravel } from '../../agent/shelter_building.js';
import { shelterRecord } from '../../agent/shelter_blueprint.js';
import { safeFeet, safeSolid, safeWaypoints, walkSafely } from '../../agent/navigation_recovery.js';
import { guardShelterDoor, protectCraftingMaterials } from '../../agent/navigation_policy.js';
import { withActionWatchdog } from '../../agent/action_interrupt.js';

// Entity type "mob" also includes passive animals in some native versions.
const hostiles = new Set(['blaze', 'bogged', 'breeze', 'cave_spider', 'creeper', 'drowned',
    'elder_guardian', 'endermite', 'evoker', 'ghast', 'giant', 'guardian', 'hoglin', 'husk',
    'magma_cube', 'parched', 'phantom', 'piglin_brute', 'pillager', 'ravager', 'shulker',
    'silverfish', 'skeleton', 'slime', 'spider', 'stray', 'vex', 'vindicator', 'warden',
    'witch', 'wither', 'wither_skeleton', 'zoglin', 'zombie', 'zombie_nautilus', 'zombie_villager']);
const unsafeFoods = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish',
    'suspicious_stew', 'chorus_fruit', 'chicken', 'ominous_bottle']);
const finitePosition = p => p && [p.x, p.y, p.z].every(Number.isFinite);
const point = p => ({ x: p.x, y: p.y, z: p.z });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fullBlock = block => safeSolid(block) && block.shapes?.some(shape =>
    shape.length === 6 && shape.every((value, i) => value === (i < 3 ? 0 : 1)));

export class MinecraftSurvivalAdapter {
    constructor(agent, options = {}) {
        const { routeMs = 18000, consumeMs = 4000, verifyMs = 1200, pollMs = 50 } = options;
        this.agent = agent;
        this.routeMs = routeMs;
        this.consumeMs = consumeMs;
        this.verifyMs = verifyMs;
        this.pollMs = pollMs;
        this.assessor = { config: { ...survivalDefaults, ...options }, clock: options.clock || Date.now };
    }

    scope() {
        return { environment: 'minecraft', world: this.agent.local_memory?.world || null,
            dimension: String(this.agent.bot.game?.dimension ?? 'unknown') };
    }

    food() {
        const bot = this.agent.bot;
        if (!bot.inventory?.items || !bot.registry?.foodsByName) return [];
        return bot.inventory.items().filter(item => item.count > 0 && !unsafeFoods.has(item.name) &&
            Number.isFinite(bot.registry.foodsByName[item.name]?.foodPoints) &&
            bot.registry.foodsByName[item.name].foodPoints > 0 && !item.name.endsWith('_bucket'))
            .sort((a, b) => bot.registry.foodsByName[b.name].foodPoints - bot.registry.foodsByName[a.name].foodPoints);
    }

    threats() {
        const bot = this.agent.bot;
        if (!finitePosition(bot.entity?.position) || !bot.entities || typeof bot.entities !== 'object') return null;
        const found = [];
        for (const entity of Object.values(bot.entities)) {
            if (!entity || !hostiles.has(entity.name) || entity === bot.entity) continue;
            if (!finitePosition(entity.position)) return null;
            const distance = bot.entity.position.distanceTo(entity.position);
            if (distance <= 48) found.push({ entity, id: entity.id, name: entity.name, distance });
        }
        return found.sort((a, b) => a.distance - b.distance);
    }

    observe() {
        const agent = this.agent, bot = agent.bot, p = bot.entity?.position, threats = this.threats();
        return {
            available: Boolean(!agent._shuttingDown && !agent._disconnectHandled && !bot._client?.ended &&
                !agent.recovering_from_death && finitePosition(p) && threats !== null &&
                Number.isFinite(bot.health) && Number.isFinite(bot.food) && bot.inventory?.items),
            scope: this.scope(), position: finitePosition(p) ? point(p) : null,
            health: Number.isFinite(bot.health) ? bot.health : null,
            hunger: Number.isFinite(bot.food) ? bot.food : null,
            damageAt: bot.lastDamageTime, damageTaken: bot.lastDamageTaken,
            threats: (threats || []).map(({ id, name, distance }) => ({ id, name, distance })),
            foodAvailable: this.food().length > 0
        };
    }

    run(token, fn, valid = () => true) {
        return this.agent.actions.runAction('mode:survival', fn, { timeout: 0.75,
            valid: () => Boolean(this.agent.survival_supervisor?.isCurrent(token)) && valid() });
    }

    active(valid, scope, deathEpoch) {
        const state = this.observe();
        return valid() && !this.agent.bot.interrupt_code && state.available && state.health > 0 &&
            sameScope(scope, state.scope) && (this.agent.death_epoch || 0) === deathEpoch;
    }

    rememberedShelter(scope) {
        // Memory's lookup is already keyed by the live world and dimension.
        // A bare home waypoint or unscoped cached coordinate is insufficient.
        if (!scope.world || !sameScope(scope, this.scope())) return null;
        return shelterRecord(this.agent.local_memory?.shelter?.());
    }

    movements(record) {
        const bot = this.agent.bot, movements = protectCraftingMaterials(bot, new pf.Movements(bot));
        if (record) guardShelterDoor(movements, record);
        const start = this.threats();
        const avoidDistance = Math.max(0, Math.min(4, ...(start || []).map(t => t.distance)) - 0.25);
        movements.exclusionAreasStep ??= [];
        movements.exclusionAreasStep.push(block => {
            const threats = this.threats();
            // Leaving an already-close enemy must remain cheap. Penalizing
            // every initial step can exhaust A* before it finds any escape.
            return !threats || threats.some(({ entity }) => entity.position.distanceTo(block.position) < avoidDistance) ? 25 : 0;
        });
        return movements;
    }

    threatInside(plan) {
        const threats = this.threats();
        return !threats || threats.some(({ entity }) => {
            const p = entity.position;
            return p.x >= plan.origin.x && p.x < plan.origin.x + 5 &&
                p.z >= plan.origin.z && p.z < plan.origin.z + 5 &&
                p.y >= plan.origin.y - 1 && p.y < plan.origin.y + 3;
        });
    }

    covered(at, threats) {
        const bot = this.agent.bot;
        if (!safeFeet(bot, at) || !threats.length) return false;
        // Both torso and head must have observed solid cover from every threat.
        return threats.every(({ entity }) => [0.7, 1.55].every(height => {
            const from = at.offset(0.5, height, 0.5), to = entity.position.offset(0, 1.3, 0);
            const length = from.distanceTo(to), steps = Math.ceil(length * 4);
            for (let i = 1; i < steps; i++) {
                const sample = from.plus(to.minus(from).scaled(i / steps)), block = bot.blockAt(sample);
                if (!block) return false;
                if (fullBlock(block)) return true;
            }
            return false;
        }));
    }

    refugeValid(refuge) {
        const bot = this.agent.bot, state = this.observe();
        if (!refuge?.scope || !sameScope(refuge.scope, state.scope) || !state.available ||
            !finitePosition(refuge) || bot.entity.position.distanceTo(new Vec3(refuge.x + 0.5, refuge.y, refuge.z + 0.5)) > 1.5)
            return false;
        const at = new Vec3(refuge.x, refuge.y, refuge.z), threats = this.threats();
        if (!safeFeet(bot, at) || !threats) return false;
        if (refuge.kind === 'shelter') {
            try {
                const record = this.rememberedShelter(state.scope);
                if (!record) return false;
                const plan = inspectShelter(bot, record);
                return plan.structureComplete && plan.doorState.sealed && plan.inside.equals(at) && !this.threatInside(plan);
            } catch { return false; }
        }
        if (refuge.kind === 'cover') return this.covered(at, threats);
        return refuge.kind === 'escape' && threats.every(t => t.distance >= 8);
    }

    async retreat(valid) {
        const scope = this.scope(), deathEpoch = this.agent.death_epoch || 0;
        let stopped = false;
        const stop = () => {
            if (stopped) return;
            stopped = true;
            this.agent.requestInterrupt();
        };
        const timer = setTimeout(stop, this.routeMs);
        const monitor = setInterval(() => { if (!this.active(valid, scope, deathEpoch)) stop(); }, this.pollMs);
        try {
            return await withActionWatchdog(this.agent, () => this.retreatToSafety(valid), this.routeMs + 5000,
                'Survival navigation could not settle safely; restarting with saved state.');
        } finally { clearTimeout(timer); clearInterval(monitor); }
    }

    async retreatToSafety(valid) {
        const bot = this.agent.bot, scope = this.scope(), deathEpoch = this.agent.death_epoch || 0;
        const active = () => this.active(valid, scope, deathEpoch), deadline = Date.now() + this.routeMs;
        if (!active()) return { verified: false, reason: 'Recovery interrupted or live conditions unavailable.' };
        const record = this.rememberedShelter(scope);
        let shelterReason = 'No scoped verified shelter is available.';
        const travel = () => {
            const remaining = Math.max(1, deadline - Date.now());
            return { movements: () => this.movements(record), timeoutMs: Math.min(3500, remaining),
                stallMs: 1500, progressMs: 2500, searchMs: 100, log: message => this.log(message),
                prepareTravel: p => prepareShelterTravel(bot, p, {
                    movements: () => this.movements(record), timeoutMs: Math.min(2500, remaining),
                    stallMs: 1500, progressMs: 2500, log: message => this.log(message)
                }, { verifyMs: Math.min(600, remaining) }) };
        };
        if (record) {
            try {
                const plan = inspectShelter(bot, record);
                if (plan.structureComplete && plan.doorState.geometryKnown && safeFeet(bot, plan.inside) && !this.threatInside(plan)) {
                    if (await walkSafely(bot, plan.inside, travel()) && active()) {
                        const final = inspectShelter(bot, record);
                        if (final.structureComplete && final.doorState.sealed && safeFeet(bot, final.inside) && !this.threatInside(final) &&
                            bot.entity.position.floored().equals(final.inside))
                            return { verified: true, reason: 'Reached observed intact shelter and sealed its entrance.',
                                destination: { kind: 'shelter', ...point(final.inside), scope: { ...scope } } };
                    }
                    shelterReason = 'The observed shelter could not be reached and sealed within its route budget.';
                } else shelterReason = 'The remembered shelter is incomplete or its interior/door is unsafe.';
            } catch (error) { shelterReason = 'Remembered shelter rejected: ' + error.message; }
        }
        if (!active() || Date.now() >= deadline) return { verified: false, reason: shelterReason };
        const threats = this.threats();
        if (!threats?.length) return { verified: false, reason: shelterReason + ' No observed threat supplies an escape direction.' };

        const origin = bot.entity.position.clone();
        const standing = origin.floored();
        if (this.covered(standing, threats)) return { verified: true,
            reason: 'Current supported position has observed solid cover from nearby threats.',
            destination: { kind: 'cover', ...point(standing), scope: { ...scope } } };
        const distance = at => Math.min(...threats.map(({ entity }) => at.distanceTo(entity.position)));
        const startDistance = distance(origin);
        const points = safeWaypoints(bot, { radii: [4, 8, 12, 16] });
        const cover = points.filter(at => distance(at) >= 4 && this.covered(at, threats))
            .sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin)).slice(0, 2);
        const candidates = [...cover.map(at => ({ at, kind: 'cover' })),
            ...points.filter(at => distance(at) >= 8 && distance(at) >= startDistance + 3 && !cover.some(p => p.equals(at)))
                .sort((a, b) => distance(b) - distance(a)).slice(0, 2).map(at => ({ at, kind: 'escape' }))];
        for (const { at, kind } of candidates) {
            if (!active() || Date.now() >= deadline) break;
            try {
                if (!await walkSafely(bot, at, travel()) || !active()) continue;
                const current = this.threats();
                if (!current || !safeFeet(bot, at) || !bot.entity.position.floored().equals(at)) continue;
                const nearest = current.length ? Math.min(...current.map(t => t.distance)) : Infinity;
                const verified = kind === 'cover' ? this.covered(at, current) :
                    nearest >= 8 && nearest >= startDistance + 3 && bot.entity.position.distanceTo(origin) >= 3;
                if (verified) return { verified: true,
                    reason: kind === 'cover' ? 'Reached loaded supported cover blocking observed threats.' :
                        'Reached a supported escape position farther from observed threats; recovery remains necessary.',
                    destination: { kind, ...point(at), scope: { ...scope } } };
            } catch (error) { shelterReason += ' Route failed: ' + error.message; }
        }
        return { verified: false, reason: shelterReason + ' No safe cover or escape route verified within the recovery budget.' };
    }

    async eat(valid) {
        const bot = this.agent.bot, scope = this.scope(), deathEpoch = this.agent.death_epoch || 0;
        const active = () => this.active(valid, scope, deathEpoch), selected = this.food()[0];
        const safeToEat = () => {
            if (!active()) return false;
            const supervisor = this.agent.survival_supervisor, state = this.observe();
            // Share the coordinator's exact live risk assessment, including
            // configurable ranges and recent damage, throughout equip/use.
            const assessment = supervisor?.assess ? supervisor.assess(state) :
                SurvivalSupervisor.prototype.assess.call(this.assessor, state);
            const config = supervisor?.config || this.assessor.config, refuge = supervisor?.refuge;
            const clear = !assessment.recent && assessment.nearest > config.clearRadius;
            const unsafe = !clear || assessment.danger && assessment.nearest <= config.threatRadius;
            return assessment.known && (!unsafe ||
                ['shelter', 'cover'].includes(refuge?.kind) && this.refugeValid(refuge));
        };
        if (!active()) return { verified: false, reason: 'Food action interrupted or live conditions unavailable.' };
        if (!safeToEat()) return { verified: false, reason: 'Nearby danger prevents unprotected food consumption.' };
        if (!selected) return { verified: false, reason: 'No suitable edible food is present in live inventory.' };
        if (bot.food >= 20) return { verified: false, reason: 'Hunger is full; no food consumption needed.' };
        const count = () => bot.inventory.items().filter(item => item.name === selected.name)
            .reduce((total, item) => total + item.count, 0);
        const before = count(), hunger = bot.food;
        let expired = false, timer, monitor;
        try {
            // Await every physical promise even after cancellation. The native
            // consume promise has its own timeout; a watchdog handles a broken
            // plugin without allowing a second owner to begin over it.
            const cancelUse = () => {
                this.agent.requestInterrupt();
                bot.deactivateItem?.();
            };
            timer = setTimeout(() => { expired = true; cancelUse(); }, this.consumeMs);
            monitor = setInterval(() => { if (!safeToEat()) cancelUse(); }, this.pollMs);
            await withActionWatchdog(this.agent, async () => {
                await bot.equip(selected, 'hand');
                if (safeToEat() && count() > 0) await bot.consume();
            }, this.consumeMs + 5000, 'Survival consumption could not settle safely; restarting with saved state.');
            clearTimeout(timer); clearInterval(monitor);
            const end = Date.now() + this.verifyMs;
            while (safeToEat() && !expired) {
                if (count() < before && bot.food > hunger)
                    return { verified: true, reason: `Consumed ${selected.name}; inventory decrease and hunger increase observed.`, item: selected.name };
                if (Date.now() >= end) break;
                await sleep(Math.min(this.pollMs, Math.max(1, end - Date.now())));
            }
            return { verified: false, reason: expired ? 'Consumption exceeded its time budget.' :
                'Food consumption was interrupted or inventory and hunger changes were not both verified.' };
        } catch (error) {
            return { verified: false, reason: 'Food consumption failed: ' + error.message };
        } finally { clearTimeout(timer); clearInterval(monitor); }
    }

    log(message) { console.log('[Mia survival] ' + message); }
}

export function installSurvivalSupervisor(agent, options = {}) {
    agent.bot.autoEat?.disable?.();
    return agent.survival_supervisor = new SurvivalSupervisor(new MinecraftSurvivalAdapter(agent, options), options);
}
