import { sameScope } from '../core/worldState.js';

export const survivalDefaults = Object.freeze({
    lowHealth: 12, threatenedHealth: 16, recoverHealth: 14, eatAt: 14,
    closeThreat: 5, threatRadius: 24, clearRadius: 16,
    damageWindowMs: 6000, calmMs: 5000, budgetMs: 90000,
    maxRetreats: 3, maxMeals: 6
});

// Assessed by the existing agent tick. Physical work always goes through the
// coordinator's ActionManager; recovery can hold the goal without moving.
export class SurvivalSupervisor {
    constructor(adapter, { clock = Date.now, ...config } = {}) {
        this.adapter = adapter;
        this.clock = clock;
        this.config = { ...survivalDefaults, ...config };
        this.epoch = 0;
        this.active = false;
        this.flight = null;
        this.status = 'idle';
        this.reason = 'No survival intervention needed.';
        this.suppressed = null;
    }

    assess(state) {
        const c = this.config;
        const known = state.available && Number.isFinite(state.health) && Number.isFinite(state.hunger) &&
            state.position && Array.isArray(state.threats);
        const nearest = known ? Math.min(Infinity, ...state.threats.map(t => t.distance)) : Infinity;
        const recent = Number.isFinite(state.damageAt) && state.damageAt > 0 &&
            this.clock() - state.damageAt >= 0 && this.clock() - state.damageAt < c.damageWindowMs;
        const danger = known && (state.health <= c.lowHealth || nearest <= c.closeThreat ||
            nearest <= c.threatRadius && (state.health <= c.threatenedHealth || state.hunger <= 6 || recent) ||
            recent && (state.health <= c.threatenedHealth || state.damageTaken >= state.health));
        return { known, nearest, recent, danger, hungry: known && state.hunger <= c.eatAt };
    }

    setStatus(status, reason) {
        if (this.status === status && this.reason === reason) return;
        this.status = status; this.reason = reason;
        this.adapter.log?.(`${status}; ${reason}`);
    }

    signature(s) {
        return JSON.stringify([s.scope, s.health, s.hunger, s.damageAt,
            s.foodAvailable, s.threats?.map(t => [t.id, Math.floor(t.distance / 4)])]);
    }

    isCurrent(token) {
        const s = this.adapter.observe();
        return this.active && token === this.epoch && this.assess(s).known && s.health > 0 &&
            sameScope(this.scope, s.scope);
    }

    cancel(reason = 'Explicitly stopped.') {
        this.epoch++;
        this.active = false;
        this.suppressed = this.signature(this.adapter.observe());
        this.setStatus('cancelled', reason);
    }

    hold(status, reason) {
        this.setStatus(status, reason);
        // Blocking new requests is not enough: stop any action that was
        // already moving when recovery began, even if no food is available.
        if (!this.held && !this.flight) this.dispatch(null);
    }

    dispatch(action) {
        const token = this.epoch;
        const valid = () => this.isCurrent(token) &&
            (action !== 'retreat' || this.clock() - this.startedAt < this.config.budgetMs);
        const flight = Promise.resolve().then(() => this.adapter.run(token, async () => {
            if (!valid()) return;
            this.held = true;
            if (!action) return; // ActionManager has settled the previous owner.
            if (action === 'eat') this.meals++; else this.retreats++;
            const outcome = await this.adapter[action](valid);
            if (!valid()) return;
            if (action === 'retreat' && outcome?.verified) {
                this.refuge = outcome.destination || null;
                this.refugeDamageAt = this.adapter.observe().damageAt;
            }
            this.setStatus(outcome?.verified ? 'recovering' : 'blocked', outcome?.reason ||
                (outcome?.verified ? 'Survival action verified; checking fresh conditions.' : 'Survival action was not verified.'));
        }, valid)).catch(error => {
            if (valid()) this.setStatus('blocked', `Survival action failed: ${error.message}`);
        }).finally(() => { if (this.flight === flight) this.flight = null; });
        this.flight = flight;
    }

    update() {
        const s = this.adapter.observe(), a = this.assess(s), now = this.clock();
        if (s.health === 0 || this.active && !sameScope(this.scope, s.scope)) {
            if (this.active) {
                this.epoch++; this.active = false;
                this.setStatus('paused', 'Environment changed; waiting for fresh survival observations.');
            }
            return;
        }
        if (!a.known) {
            if (this.active) {
                this.calmSince = null;
                this.epoch++;
                this.setStatus('blocked', 'Survival observations unavailable; interrupted task remains held.');
            }
            return;
        }
        if (!this.active) {
            if (this.flight || !a.danger && !a.hungry || this.suppressed === this.signature(s)) return;
            this.suppressed = null;
            this.active = true; this.epoch++;
            this.scope = { ...s.scope };
            this.startedAt = now; this.calmSince = null;
            this.retreats = 0; this.meals = 0; this.refuge = null;
            this.held = false;
            this.setStatus('recovering', a.danger ? 'Danger detected; preserving the interrupted task.' : 'Hunger requires verified food.');
        }
        const needsFood = s.hunger < 20 && (a.hungry || s.health < 18);
        const clear = !a.recent && a.nearest > this.config.clearRadius;
        if (clear && !a.danger && s.health >= this.config.recoverHealth && !needsFood && !this.flight) {
            this.calmSince ??= now;
            if (now - this.calmSince >= this.config.calmMs) {
                this.active = false; this.epoch++;
                this.setStatus('idle', 'Conditions improved; returning control for fresh task planning.');
                return;
            }
        } else this.calmSince = null;
        // A verified refuge is rechecked by the adapter on each tick; a broken
        // wall or an approaching threat must not silently become safe cover.
        if (this.refuge) {
            const newDamage = Number.isFinite(s.damageAt) && s.damageAt > (this.refugeDamageAt || 0);
            if (newDamage || !this.adapter.refugeValid?.(this.refuge)) {
                this.refuge = null;
                this.adapter.log?.(newDamage ? 'Refuge invalidated by damage after arrival; reassessing safety.' :
                    'Refuge no longer verified by live position, blocks or threats; reassessing safety.');
            }
        }
        if (this.flight) return;
        const protectedRefuge = this.refuge && ['shelter', 'cover'].includes(this.refuge.kind);
        const unsafeEnvironment = !clear || a.danger && a.nearest <= this.config.threatRadius;
        let action;
        if (unsafeEnvironment && !protectedRefuge && this.retreats < this.config.maxRetreats) {
            if (now - this.startedAt >= this.config.budgetMs) {
                this.hold('blocked', 'Recovery budget exhausted; task held until observed conditions improve.');
                return;
            }
            action = 'retreat';
        }
        else if (needsFood && (!unsafeEnvironment || protectedRefuge) && this.meals < this.config.maxMeals) {
            if (!s.foodAvailable) {
                this.hold('blocked', 'No suitable food in live inventory; supply edible food. Recovery will recheck it, including after the retreat deadline.');
                return;
            }
            // Waiting for supplies or a threat to clear must not permanently
            // disable eating. Each meal is bounded by the adapter and the
            // intervention's meal count; movement budgets are not renewed.
            action = 'eat';
        }
        if (!action) {
            this.hold(unsafeEnvironment && !protectedRefuge ? 'blocked' : 'recovering',
                unsafeEnvironment && !protectedRefuge ? 'No verified reachable refuge; retreat attempts exhausted.' :
                needsFood && this.meals >= this.config.maxMeals ? 'Food attempt budget exhausted; awaiting improved conditions.' :
                'Holding recovery until threats, recent damage, health and hunger are acceptable.');
            return;
        }
        this.setStatus(action === 'eat' ? 'eating' : 'retreating', action === 'eat' ?
            'Eating carried food and checking live consumption.' : 'Seeking verified shelter, cover or a safer supported position.');
        this.dispatch(action);
    }

    view() {
        return { version: 1, active: this.active, status: this.status, reason: this.reason,
            retreatAttempts: this.retreats || 0, foodAttempts: this.meals || 0 };
    }
}
