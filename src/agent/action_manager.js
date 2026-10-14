import assert from 'node:assert/strict';

export function actionPriority(label) {
    if (label === 'mode:self_preservation') return 100;
    if (label === 'mode:cowardice') return 90;
    if (label === 'mode:self_defense') return 80;
    if (label === 'mode:unstuck') return 70;
    if (label === 'action:makeGoal' || label === 'action:gatherGoal') return 50;
    if (label.startsWith('mode:') || label.startsWith('npc:')) return 10;
    return 40;
}

const deferred = message => ({ success: false, message, interrupted: true, timedout: false, deferred: true });

export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.handoff = Promise.resolve();
        this.currentRun = null;
    }

    async resumeAction() { return this._executeResume(); }

    async runAction(label, fn, { timeout = 10, resume = false } = {}) {
        if (resume) return this._executeResume(label, fn, timeout);
        return this._executeAction(label, fn, timeout);
    }

    async stop(reason = 'stop') {
        if (!this.executing) return;
        if (this.currentRun) this.currentRun.interruptedBy ||= reason;
        if (!this.stopping) {
            this.stopping = this._waitForStop();
            this.stopping.finally(() => { this.stopping = null; }).catch(() => {});
        }
        return this.stopping;
    }

    async _waitForStop() {
        const deadline = Date.now() + 10000;
        console.log('Stopping current action...');
        while (this.executing) {
            this.agent.requestInterrupt();
            if (Date.now() >= deadline) {
                this.agent.cleanKill('Action could not stop safely; restarting with saved state.');
                throw new Error('Action cancellation timed out');
            }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }

    cancelResume() { this.resume_func = null; this.resume_name = null; }

    async _executeResume(label = null, fn = null, timeout = 10) {
        const fresh = fn != null;
        if (fresh) {
            assert(label != null, 'actionLabel is required for new resume');
            this.resume_func = fn;
            this.resume_name = label;
        }
        if (this.agent.gather_goal?.active) return deferred('A managed goal owns the action slot.');
        if (this.resume_func && (this.agent.isIdle() || fresh) && (!this.agent.self_prompter.isActive() || fresh))
            return this._executeAction(this.resume_name, this.resume_func, timeout);
        return { success: false, message: null, interrupted: false, timedout: false };
    }

    async _executeAction(label, fn, timeout = 10) {
        // Serialize handoffs, not whole actions: an emergency can request a
        // stop immediately, but two waiters cannot both claim the bot afterward.
        const previous = this.handoff;
        let release;
        this.handoff = new Promise(resolve => { release = resolve; });
        await previous;
        let run;
        try {
            const priority = actionPriority(label);
            if (this.agent.gather_goal?.active && priority < 50)
                return deferred('A managed goal owns the action slot.');
            if (this.currentRun && priority < this.currentRun.priority)
                return deferred(`Waiting for ${this.currentActionLabel}.`);
            await this.stop(label);
            if (this.agent.recovering_from_death) return deferred('Waiting for respawn recovery.');
            run = { label, priority, interruptedBy: null, timedout: false };
            this.currentRun = run;
            this.executing = true;
            this.currentActionLabel = label;
            this.currentActionFn = fn;
            this.timedout = false;
            this.last_action_time = Date.now();
            this.agent.clearBotLogs();
        } finally { release(); }

        let error = null;
        let timer;
        if (timeout > 0) timer = setTimeout(() => {
            if (this.currentRun !== run) return;
            run.timedout = this.timedout = true;
            this.stop('timeout').catch(err => console.error('Action timeout:', err));
        }, timeout * 60000);
        try { await fn(); }
        catch (err) { error = err; }
        finally { clearTimeout(timer); }

        const interrupted = Boolean(run.interruptedBy || this.agent.bot.interrupt_code);
        let message = this.getBotOutputSummary();
        if (error && !interrupted) {
            console.error('Action failed:', error);
            message += `\nAction failed: ${error.message || error}`;
            this.cancelResume();
        }
        const result = { success: !error, message, interrupted, timedout: run.timedout, interruptedBy: run.interruptedBy };
        this.agent.clearBotLogs();
        this.currentRun = null;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        if (!interrupted && !this.agent.gather_goal?.active) this.agent.bot.emit('idle');
        return result;
    }

    getBotOutputSummary() {
        const output = String(this.agent.bot.output || '');
        this.agent.bot.output = '';
        if (output.length > 500) return `Action output (shortened):\n${output.slice(0, 250)}\n...\n${output.slice(-250)}`;
        return 'Action output:\n' + output;
    }
}
