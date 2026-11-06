import { countFood, restoreFoodProgress } from './food_policy.js';
import { startFoodGoal, foodContext, runFoodWork } from './food_goal.js';

// Policy assessment is called by the existing mode tick. MainSupervisor and
// Survival retain scheduling and ownership; this object creates no timer.
export class FoodReserve {
    constructor(agent, api, { clock = Date.now } = {}) {
        this.agent = agent; this.api = api; this.clock = clock;
        this.policy = agent.local_memory?.foodReserve?.() || { target: 0 };
        this.epoch = 0; this.flight = null; this.recovery = this.loadRecovery();
        this.scope = this.scopeKey();
    }
    loadRecovery() {
        const saved = this.agent.local_memory?.foodRecovery?.();
        return saved && (saved.replantPending || saved.foodDeadline || saved.foodActions || saved.foodFailures) ?
            { ...foodContext(saved), target: 1 } : null;
    }
    scopeKey() { return JSON.stringify([this.agent.local_memory?.world, this.agent.bot.game?.dimension]); }
    refreshScope() {
        const scope = this.scopeKey();
        if (scope !== this.scope) {
            this.epoch++; this.scope = scope; this.recovery = this.loadRecovery();
            this.policy = this.agent.local_memory?.foodReserve?.() || { target: 0 };
        }
    }
    save() { this.agent.local_memory?.saveFoodReserve?.(this.policy); }
    savedWorkOwnsSlot() {
        const saved = this.agent.local_memory?.pendingGoal?.();
        return Boolean(saved && ['running', 'paused', 'blocked'].includes(saved.status) &&
            !(saved.status === 'blocked' && saved.kind === 'food' && saved.automatic === true));
    }
    cancel() {
        this.refreshScope();
        this.epoch++; this.recovery = null;
        this.agent.local_memory?.saveFoodRecovery?.(null);
        this.policy = { target: 0 }; this.save();
    }
    configure(target) {
        this.refreshScope();
        if (!Number.isSafeInteger(target) || target < 0 || target > 64) return 'Choose a food reserve from 0 to 64 prepared food items.';
        this.epoch++; this.policy = { target }; this.save();
        return target ? `Food reserve enabled: replenish to ${target} prepared food items when safe. !stop disables the reserve.` : 'Food reserve disabled.';
    }
    retry() {
        this.refreshScope(); this.epoch++;
        const saved = this.recovery || this.agent.local_memory?.foodRecovery?.();
        this.recovery = { ...foodContext(saved), target: 1, foodActions: 0, foodFailures: 0,
            foodSearch: undefined, foodRejected: [], foodDeadline: this.clock() + 300000 };
        this.agent.local_memory?.saveFoodRecovery?.(restoreFoodProgress(this.recovery));
        if (this.agent.survival_supervisor) this.agent.survival_supervisor.provisions = 0;
        this.policy = { target: this.policy.target || 0 }; this.save();
    }
    fingerprint() {
        const bot = this.agent.bot, p = bot.entity?.position;
        const crops = p && bot.findBlocks?.({ matching: ['wheat', 'carrots', 'potatoes', 'beetroots']
            .map(n => bot.registry.blocksByName[n]?.id).filter(Number.isInteger), maxDistance: 24, count: 16 }) || [];
        return JSON.stringify([bot.game?.dimension, p && [Math.floor(p.x / 8), Math.floor(p.y / 8), Math.floor(p.z / 8)],
            bot.inventory?.items?.().map(i => [i.name, i.count]).sort(),
            crops.map(p => [p.x, p.y, p.z, bot.blockAt(p)?.stateId ?? 'unknown']),
            Object.values(bot.entities || {}).filter(e => ['cow', 'pig', 'sheep', 'chicken', 'rabbit'].includes(e.name))
                .slice(0, 8).map(e => [e.id, e.name])]);
    }
    update() {
        this.refreshScope();
        const a = this.agent, target = this.policy.target;
        if (!target || this.flight || a._shuttingDown || a.recovering_from_death || a.gather_goal?.active ||
            a.survival_supervisor?.active || a.actions.executing || a.self_prompter?.isActive?.()) return;
        if (this.savedWorkOwnsSlot()) return;
        const state = a.survival_supervisor?.adapter.observe(), risk = state && a.survival_supervisor.assess(state);
        if (!risk?.known || risk.danger || risk.recent || risk.nearest <= 24 || countFood(a.bot) >= target) return;
        const fingerprint = this.fingerprint();
        if (this.policy.blocked === fingerprint || this.clock() < (this.policy.retryAfter || 0)) return;
        const token = this.epoch;
        const instructionEpoch = a.instruction_epoch || 0;
        this.flight = Promise.resolve().then(async () => {
            const current = a.survival_supervisor?.adapter.observe(), risk = current && a.survival_supervisor.assess(current);
            if (token !== this.epoch || this.scope !== this.scopeKey() || a.gather_goal?.active || this.savedWorkOwnsSlot() || !this.policy.target ||
                instructionEpoch !== (a.instruction_epoch || 0) || a.self_prompter?.isActive?.() ||
                a.actions.executing || a.survival_supervisor?.active || !risk?.known || risk.danger || risk.recent ||
                risk.nearest <= 24 || countFood(a.bot) >= target) return;
            await startFoodGoal(a, target, this.api, { requester: 'system', automatic: true, instructionEpoch });
            const goal = a.gather_goal;
            if (goal?.kind !== 'food') return;
            await goal.done;
            if (token !== this.epoch) return;
            if (goal.status === 'blocked') {
                this.policy.blocked = this.fingerprint(); this.policy.retryAfter = this.clock() + 120000; this.save();
            }
        }).catch(error => console.warn('[Mia food reserve] ' + error.message)).finally(() => { this.flight = null; });
    }
    async provision(valid) {
        this.refreshScope();
        const a = this.agent, state = a.survival_supervisor?.adapter.observe(), assessment = state && a.survival_supervisor.assess(state);
        if (!valid() || !assessment?.known || assessment.recent || assessment.nearest <= 24 || state.health < 10)
            return { verified: false, blocked: true, reason: 'Food collection is unsafe; need clear surroundings and health at least 10.' };
        const foreground = a.gather_goal?.active ? a.gather_goal : null;
        // A food goal may itself be paused between harvest and planting. Reuse
        // that obligation, including its seed reservation, before creating a
        // survival subtask or accepting an already-held carrot as new food.
        const context = foreground?.kind === 'food' && foreground.replantPending ? foreground :
            foreground?.foodRecovery?.replantPending ? foreground.foodRecovery :
            this.recovery?.replantPending ? this.recovery :
            foreground ? (foreground.foodRecovery ??= { ...foodContext(), target: 1 }) :
                (this.recovery ??= { ...foodContext(a.local_memory?.foodRecovery?.()), target: 1 });
        context.foodDeadline ??= this.clock() + 300000;
        if (context.foodFailures >= 2) return { verified: false, blocked: true, reason: context.foodReason || 'Food search blocked; use !resumeGoal or supply food.' };
        const token = this.epoch, scope = state.scope;
        const current = () => valid() && Date.now() < context.foodDeadline && this.canProvision() && token === this.epoch && !a.bot.interrupt_code &&
            (!foreground || a.gather_goal === foreground && foreground.active && !foreground.cancelled) &&
            a.survival_supervisor.adapter.observe().scope.world === scope.world &&
            a.survival_supervisor.adapter.observe().scope.dimension === scope.dimension;
        const attached = foreground && (context === foreground || context === foreground.foodRecovery);
        const checkpoint = () => attached ? a.local_memory?.checkpoint(foreground, 'paused', 'Survival obtaining food; original target retained.') :
            a.local_memory?.saveFoodRecovery?.(restoreFoodProgress(context));
        context.checkpoint = checkpoint;
        const monitor = setInterval(() => { if (!current()) a.requestInterrupt(); }, 50);
        let outcome;
        try { outcome = await runFoodWork(a, context, this.api, current, checkpoint); }
        finally { clearInterval(monitor); }
        if (current() && context !== foreground && !context.replantPending &&
            (countFood(a.bot, context) > 0 || state.hunger >= 20 && outcome?.verified)) {
            if (attached) delete foreground.foodRecovery;
            else { this.recovery = null; a.local_memory?.saveFoodRecovery?.(null); }
            if (attached) checkpoint();
        }
        return outcome;
    }
    canProvision() {
        const a = this.agent, state = a.survival_supervisor?.adapter.observe(), risk = state && a.survival_supervisor.assess(state);
        return Boolean(risk?.known && !risk.recent && risk.nearest > 24 && state.health >= 10);
    }
    context() {
        this.refreshScope();
        const goal = this.agent.gather_goal?.active ? this.agent.gather_goal : null;
        return goal?.replantPending ? goal : goal?.foodRecovery?.replantPending ? goal.foodRecovery :
            this.recovery?.replantPending ? this.recovery : goal?.foodRecovery || goal || this.recovery || {};
    }
    pendingRecovery() { return Boolean(this.context().replantPending); }
    view() { return { target: this.policy.target || 0, held: countFood(this.agent.bot, this.context()), active: Boolean(this.flight) }; }
}
