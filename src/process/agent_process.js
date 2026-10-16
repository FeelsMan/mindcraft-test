import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { logoutAgent } from '../mindcraft/mindserver.js';

const init_agent_path = fileURLToPath(new URL('./init_agent.js', import.meta.url));

export class AgentProcess {
    constructor(name, port, { spawnProcess = spawn, now = Date.now, restartTimeoutMs = 5000 } = {}) {
        this.name = name;
        this.port = port;
        this.spawnProcess = spawnProcess;
        this.now = now;
        this.restartTimeoutMs = restartTimeoutMs;
        this.process = null;
        this.running = false;
        this.stopRequested = false;
        this.restartRequested = false;
        this.restartPromise = null;
        this.restartTimer = null;
    }

    start(load_memory = false, init_message = null, count_id = 0) {
        // A live or exiting child remains the sole owner until its exit event.
        if (this.process || this.restartRequested) return this.process;
        this.count_id = count_id;
        this.stopRequested = false;
        const args = [init_agent_path, this.name, '-n', this.name, '-c', count_id];
        if (load_memory) args.push('-l', load_memory);
        if (init_message) args.push('-m', init_message);
        args.push('-p', this.port);
        const child = this.spawnProcess(process.execPath, args, { stdio: 'inherit' });
        this.process = child;
        this.running = true;
        this.startedAt = this.now();
        child.once('exit', (code, signal) => this._onExit(child, code, signal));
        child.on('error', error => {
            console.error(`Agent process error for ${this.name}:`, error);
            // Spawn failures have no PID and do not necessarily emit exit.
            if (this.process === child && !child.pid) this._onExit(child, 1, null);
        });
        return child;
    }

    _onExit(child, code, signal) {
        if (this.process !== child) return; // Ignore late events from an old child.
        console.log(`Agent ${this.name} process exited with code ${code} and signal ${signal}`);
        this.process = null;
        this.running = false;
        logoutAgent(this.name);
        if (this.restartRequested) { this._finishRestart(); return; }
        if (this.stopRequested) return;
        if (code > 1) { console.log('Ending task'); process.exit(code); return; }
        if (code !== 0 && signal !== 'SIGINT') {
            if (this.now() - this.startedAt < 10000) {
                console.error(`Agent ${this.name} exited too quickly and will not be restarted.`);
                return;
            }
            console.log(`Restarting agent ${this.name} after an unexpected exit.`);
            this.start(true, 'Agent process restarted.', this.count_id);
        }
    }

    _signal(child, signal) {
        try { return child.kill(signal); }
        catch (error) { console.warn(`Could not send ${signal} to ${this.name}: ${error.message}`); return false; }
    }

    _clearRestart() {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
        this.restartRequested = false;
        this.restartPromise = null;
        const resolve = this.resolveRestart;
        this.resolveRestart = null;
        return resolve;
    }

    _finishRestart() {
        const resolve = this._clearRestart();
        try { resolve?.(this.start(true, 'Agent process restarted.', this.count_id)); }
        catch (error) { console.error(`Could not restart ${this.name}:`, error); resolve?.(false); }
    }

    stop() {
        this.stopRequested = true;
        const resolve = this._clearRestart();
        resolve?.(false);
        if (this.process) this._signal(this.process, 'SIGINT');
    }

    forceRestart(gracefulStop) {
        if (this.restartPromise) return this.restartPromise;
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        this.restartPromise = promise;
        this.resolveRestart = resolve;
        this.restartRequested = true;
        this.stopRequested = false;
        const child = this.process;
        console.log(`Restarting agent ${this.name}.`);
        if (!child) { this._finishRestart(); return promise; }
        this.restartTimer = setTimeout(() => {
            if (this.process !== child || !this.restartRequested) return;
            console.warn(`Agent ${this.name} did not exit; terminating it before replacement.`);
            this._signal(child, 'SIGKILL');
            if (this.process !== child || !this.restartRequested) return;
            this.restartTimer = setTimeout(() => {
                if (this.process !== child || !this.restartRequested) return;
                console.error(`Agent ${this.name} still has not exited. No second child was started.`);
                this._clearRestart()?.(false);
            }, this.restartTimeoutMs);
        }, this.restartTimeoutMs);
        let requested = false;
        try { requested = gracefulStop?.() === true; }
        catch (error) { console.warn(`Graceful restart request failed for ${this.name}: ${error.message}`); }
        if (!requested && this.process === child) this._signal(child, 'SIGINT');
        return promise;
    }
}
