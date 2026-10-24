import { readWorldState, sameScope } from './worldState.js';

const managedLabels = new Set(['action:makeGoal', 'action:gatherGoal', 'action:shelterGoal']);
const specialistForStep = type => ({ gather: 'gathering', craft: 'crafting', smelt: 'crafting',
    inspect: 'crafting', recover: 'crafting', return: 'navigation', site: 'building',
    place: 'building', clear: 'building', finish: 'building' })[type] || 'navigation';
const specialistForGoal = kind => ({ make: 'crafting', gather: 'gathering', shelter: 'building' })[kind];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// One foreground goal. Specialists retain their planners; ActionManager is the
// only physical executor. No background timer, LLM loop or game API lives here.
export class MainSupervisor {
    constructor(adapter, { clock = Date.now, pollMs = 50 } = {}) {
        this.adapter = adapter;
        this.clock = clock;
        this.pollMs = pollMs;
        this.current = null;
        this.owner = null;
        this.epoch = 0;
        this.transitions = [];
        this.resumeFlight = null;
    }

    observe() { return readWorldState(this.adapter, this.clock); }

    beginGoal(goal, request = {}) {
        if (!specialistForGoal(goal.kind)) throw Error('Unsupported supervised goal.');
        if (this.current?.goal.active && this.current.goal !== goal)
            throw Error('A managed goal already owns the supervisor.');
        this.epoch++;
        this.current = { goal, scope: this.observe().scope, status: null, reason: '',
            specialist: specialistForGoal(goal.kind), step: null,
            requester: request?.requester || 'system', conditionCheck: null };
        this.setStatus(goal, 'running', 'Requested goal accepted.');
    }

    setStatus(goal, status, reason) {
        const record = this.current;
        if (record?.goal !== goal || record.status === 'cancelled' && status !== 'cancelled') return;
        goal.status = status;
        if (record.status === status && record.reason === reason) return;
        record.status = status; record.reason = String(reason || '').slice(0, 400);
        const event = { at: this.clock(), kind: goal.kind, status, reason: record.reason };
        this.transitions.push(event);
        if (this.transitions.length > 32) this.transitions.shift();
        this.adapter.log?.(`${goal.kind}: ${status}; ${record.reason}`);
        // Reuse the existing checkpoint/schema, including cancellation guards.
        if (goal.memoryId) this.adapter.checkpoint?.(goal, status, record.reason);
    }

    setStep(goal, step) {
        if (this.current?.goal !== goal || !goal.active || goal.cancelled) return;
        this.current.step = { type: step.type, item: step.item };
        this.current.specialist = specialistForStep(step.type);
    }

    actionUnavailable(label, goal, priority) {
        const record = this.current;
        const state = this.observe();
        if (!state.available) return 'The environment is unavailable.';
        if (managedLabels.has(label) && (!goal || record?.goal !== goal || !goal.active || goal.cancelled))
            return 'This managed action no longer owns the goal.';
        if (record?.goal.active && !record.goal.cancelled && priority < 50)
            return 'A managed goal owns the action slot.';
        if (goal && !sameScope(record.scope, state.scope))
            return 'The goal belongs to another world or dimension.';
        return null;
    }

    actionStarted(run) {
        this.owner = { run, label: run.label, priority: run.priority,
            specialist: managedLabels.has(run.label) ? this.current?.specialist :
                run.label === 'mode:self_defense' ? 'combat' :
                run.label === 'mode:unstuck' ? 'navigation' : run.label.startsWith('mode:') ? 'survival' : 'direct action' };
        if (!managedLabels.has(run.label) && this.current?.goal.active)
            this.setStatus(this.current.goal, 'paused', `Control handed to ${run.label}.`);
    }

    actionFinished(run, result) {
        if (this.owner?.run !== run) return; // An old callback cannot release a newer owner.
        this.owner = null;
        const goal = this.current?.goal;
        if (goal?.active && !goal.cancelled && result.interrupted)
            this.setStatus(goal, 'paused', `Interrupted by ${result.interruptedBy || 'safety recovery'}.`);
    }

    async waitForTurn(goal) {
        let calmSince = null;
        while (goal.active && !goal.cancelled && this.current?.goal === goal) {
            const state = this.observe();
            if (!state.available || !sameScope(this.current.scope, state.scope)) {
                goal.cancelled = true;
                goal.cancelReason = state.available ? 'dimension' : 'disconnect';
                this.setStatus(goal, 'paused', 'Environment changed; target retained for scoped recovery.');
                return false;
            }
            const busy = state.action.executing || state.recovering || state.health === 0 || state.interruptions.length;
            if (busy) {
                calmSince = null;
                this.setStatus(goal, 'paused', `Waiting for ${state.action.label || state.interruptions[0] || 'safety recovery'}.`);
            } else {
                if (this.current.status !== 'paused' && goal.status !== 'paused') return true;
                calmSince ??= this.clock();
                if (this.clock() - calmSince >= (goal.resumeDelayMs ?? 400)) {
                    // The next planner iteration reads live inventory/blocks. Keep
                    // the fresh condition check visible without inventing safety.
                    this.current.conditionCheck = state;
                    this.setStatus(goal, 'running', 'Control returned; live condition checked; replanning.');
                    return true;
                }
            }
            await sleep(this.pollMs);
        }
        return false;
    }

    cancelGoal(goal = this.current?.goal) {
        if (goal && this.current?.goal !== goal) return;
        this.epoch++; // Also invalidates a queued memory restore before it starts.
        if (goal && this.current?.goal === goal && this.current.status !== 'complete') {
            goal.cancelled = true; goal.cancelReason = 'cancelled';
            this.setStatus(goal, 'cancelled', 'Explicitly stopped.');
        }
    }

    finishGoal(goal, completed, report) {
        if (this.current?.goal !== goal) return { completed: false, report: 'Superseded goal stopped.' };
        if ((goal.cancelled || this.current.status === 'cancelled') && completed) {
            completed = false; report = 'Goal cancelled; late completion ignored.';
        }
        if (completed) {
            let outcome;
            try { outcome = sameScope(this.current.scope, this.observe().scope) && this.adapter.verifyCompletion(goal); }
            catch (error) { outcome = { verified: false, reason: error.message }; }
            if (!outcome?.verified) {
                completed = false;
                report = 'Goal blocked: final live verification failed. ' + (outcome?.reason || 'Environment changed.');
            }
        }
        const status = completed ? 'complete' : goal.cancelReason === 'death' && goal.memoryDeaths >= 2 ? 'blocked' :
            ['death', 'disconnect', 'dimension'].includes(goal.cancelReason) ? 'paused' :
            goal.cancelled ? 'cancelled' : 'blocked';
        this.setStatus(goal, status, report);
        return { completed, report };
    }

    resume(restore) {
        if (this.resumeFlight) return this.resumeFlight;
        const epoch = this.epoch;
        const valid = () => epoch === this.epoch && this.observe().available;
        const flight = Promise.resolve().then(() => valid() ? restore(valid) : false);
        this.resumeFlight = flight;
        flight.finally(() => { if (this.resumeFlight === flight) this.resumeFlight = null; }).catch(() => {});
        return flight;
    }

    view() {
        const state = this.observe(), record = this.current;
        const saved = !record && this.adapter.savedGoal?.();
        const goal = record?.goal || saved;
        return {
            version: 1, state,
            goal: goal ? { kind: goal.kind, item: goal.item, target: goal.target,
                status: record?.status || goal.status, reason: record?.reason || goal.reason || '',
                specialist: record?.specialist || specialistForGoal(goal.kind),
                requester: record?.requester || null, step: record?.step || null,
                scope: record?.scope || { ...state.scope, dimension: goal.dimension } } : null,
            owner: this.owner ? { label: this.owner.label, specialist: this.owner.specialist, priority: this.owner.priority } : null,
            conditionCheck: record?.conditionCheck || null
        };
    }

    summary() {
        const { goal, owner, state } = this.view();
        return 'MAIN SUPERVISOR v1\n' +
            (goal ? `Goal: ${goal.kind} ${goal.target} ${goal.item} (${goal.status}).\n` +
                `Specialist: ${goal.specialist}. Reason: ${goal.reason}\n` : 'No managed goal.\n') +
            `Action owner: ${owner ? owner.specialist + ' / ' + owner.label : 'none'}.\n` +
            `Live condition: health ${state.health ?? 'unknown'}, hunger ${state.hunger ?? 'unknown'}; ${state.scope.dimension}.`;
    }
}
