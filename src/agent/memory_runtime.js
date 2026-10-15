import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LocalMemoryStore, cellOf, positionOf, validPosition } from './local_memory.js';

const dimensionOf = bot => String(bot.game?.dimension ?? 'unknown');
const textOf = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 400);
const resumable = new Set(['running', 'paused']);
const validGoal = goal => goal && ['make', 'gather'].includes(goal.kind) &&
    /^[a-z0-9_]{1,80}$/.test(goal.item) && Number.isSafeInteger(goal.target) && goal.target >= 1 && goal.target <= 64;
const cosine = (a, b) => {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
    return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
};

function localEmbedder(profile) {
    // Only the explicitly configured local provider receives memory text.
    const model = profile?.embedding;
    if (model?.api !== 'ollama' || !model.model) return {};
    const url = new URL('/api/embed', model.url || 'http://127.0.0.1:11434');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return {};
    return {
        embeddingKey: `${url.origin}/${model.model}`,
        embeddingBatch: async inputs => {
            const response = await fetch(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(650),
                body: JSON.stringify({ model: model.model, input: inputs })
            });
            if (!response.ok) throw new Error('Local memory embedding unavailable');
            return (await response.json()).embeddings;
        }
    };
}

export class AgentMemory {
    constructor(agent, { root = process.cwd(), settings = {}, config, clock = Date.now,
        embeddingBatch, embeddingKey = 'test', embeddingTimeoutMs = 700 } = {}) {
        this.agent = agent;
        this.bot = agent.bot;
        this.clock = clock;
        this.closed = false;
        this.warned = false;
        this.embeddingBusy = false;
        this.embeddingBackoff = 0;
        this.embeddingTimeoutMs = embeddingTimeoutMs;
        this.queryCache = new Map();
        this.filename = join(root, 'bots', agent.name, 'memory.sqlite');
        const configPath = join(root, 'bots', agent.name, 'memory-config.json');
        this.config = config ?? (existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {});
        if (!this.config || typeof this.config !== 'object' || Array.isArray(this.config)) throw new Error('Invalid memory-config.json');
        this.enabled = this.config.enabled !== false;
        if (!this.enabled) return;
        const id = this.config.world_id;
        if (id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error('Invalid memory world_id');
        this.persistentWorld = Boolean(id);
        this.worldLabel = id || 'unconfigured session';
        const host = String(settings.host || '127.0.0.1').toLowerCase().replace(/^localhost$/, '127.0.0.1');
        // LAN ports change after reopening a world. Never use a port as identity.
        this.world = createHash('sha256').update(JSON.stringify([host, id || randomUUID()])).digest('hex');
        this.store = new LocalMemoryStore(this.filename, { clock });
        try { this.store.prune(); } catch (error) { this.store.close(); throw error; }
        const embedding = embeddingBatch ? { embeddingBatch, embeddingKey } : localEmbedder(agent.prompter?.profile);
        if (this.config.embeddings !== false) Object.assign(this, embedding);
        console.log(`[Mia memory] ${this.worldLabel}: local SQLite ready${this.persistentWorld ? '' : '; set a world ID to retain locations and goals across restarts'}.`);
    }

    safe(fn, fallback = null) {
        if (!this.enabled || this.closed) return fallback;
        try { return fn(); }
        catch (error) {
            if (!this.warned) console.warn('[Mia memory] Memory unavailable; gameplay continues. ' + error.message);
            this.warned = true;
            this.enabled = false;
            try { this.store.close(); } catch {}
            return fallback;
        }
    }
    get dimension() { return dimensionOf(this.bot); }
    get position() { return positionOf(this.bot.entity?.position); }

    record(event) { return this.safe(() => this.store.record(this.world, this.dimension, event)); }
    rememberPlace(name, position) {
        return this.safe(() => this.store.putLocation(this.world, this.dimension, 'place:' + name, 'place', position));
    }
    recallPlace(name) { return this.safe(() => this.store.getLocation(this.world, this.dimension, 'place:' + name)?.position ?? null); }
    placeNames() { return this.safe(() => this.store.locations(this.world, this.dimension, 'place').map(r => r.name.slice(6)), []); }
    saveStation(record) {
        if (!record || record.dimension !== this.dimension || !validPosition(record.position)) return;
        this.safe(() => this.store.putLocation(this.world, record.dimension, 'owned:crafting_table', 'station', record.position,
            { owned: true, pickupMinimum: record.pickupMinimum }));
    }
    station() {
        return this.safe(() => {
            const row = this.store.getLocation(this.world, this.dimension, 'owned:crafting_table');
            if (!row?.metadata.owned || !validPosition(row.position)) return null;
            const minimum = row.metadata.pickupMinimum;
            if (minimum !== null && (!Number.isSafeInteger(minimum) || minimum < 1)) return null;
            return { position: row.position, dimension: row.dimension, pickupMinimum: minimum };
        });
    }
    forgetStation(record) {
        this.safe(() => {
            const existing = this.store.getLocation(this.world, record.dimension, 'owned:crafting_table');
            if (existing && JSON.stringify(existing.position) === JSON.stringify(record.position))
                this.store.deleteLocation(this.world, record.dimension, 'owned:crafting_table');
        });
    }

    beginGoal(goal) {
        goal.memoryId = randomUUID();
        goal.memoryDimension = this.dimension;
        goal.memoryDeaths = this.restoringGoal?.deaths || 0;
        this.checkpoint(goal, 'running');
    }
    checkpoint(goal, status = 'running', reason = '') {
        if (!validGoal(goal)) return;
        this.safe(() => {
            const previous = this.store.getGoal(this.world);
            if (previous && previous.id !== goal.memoryId && status !== 'running') return;
            // An explicit cancellation must survive an asynchronous action settling.
            if (previous?.id === goal.memoryId && previous.status === 'cancelled' && status !== 'cancelled') return;
            this.store.setGoal(this.world, {
                id: goal.memoryId, kind: goal.kind, item: goal.item, target: goal.target,
                dimension: goal.memoryDimension || this.dimension, status, reason: textOf(reason),
                deaths: goal.memoryDeaths || 0,
                step: goal.memoryStep ? { type: goal.memoryStep.type, item: goal.memoryStep.item } : null,
                updated: this.clock()
            });
        });
    }
    cancelGoal() {
        this.safe(() => {
            const goal = this.store.getGoal(this.world);
            if (goal && !['complete', 'cancelled'].includes(goal.status))
                this.store.setGoal(this.world, { ...goal, status: 'cancelled', reason: 'Explicitly stopped', updated: this.clock() });
        });
    }
    finishGoal(goal, complete, report) {
        const reason = goal.cancelReason;
        const status = complete ? 'complete' : reason === 'death' && goal.memoryDeaths >= 2 ? 'blocked' :
            ['death', 'disconnect', 'dimension'].includes(reason) ? 'paused' :
            reason === 'cancelled' || goal.cancelled ? 'cancelled' : 'blocked';
        this.checkpoint(goal, status, report);
        if (complete) this.record({ kind: 'goal_complete', item: goal.item, position: this.position, verified: true,
            text: `Verified goal completed: at least ${goal.target} ${goal.item} in inventory at that time.` });
    }

    fingerprint() {
        const inventory = (this.bot.inventory?.items() || []).map(i => [i.name, i.count]).sort();
        const p = this.position;
        const surroundings = [];
        if (p && this.bot.blockAt && this.bot.entity.position.offset) {
            for (const x of [-2, 0, 2]) for (const y of [-1, 0, 1]) for (const z of [-2, 0, 2]) {
                try { surroundings.push(this.bot.blockAt(this.bot.entity.position.offset(x, y, z))?.name || 'unloaded'); }
                catch { surroundings.push('unloaded'); }
            }
        }
        return createHash('sha256').update(JSON.stringify([cellOf(p), inventory, surroundings])).digest('hex');
    }
    beginStep(goal, step) {
        const key = `${step.type}:${step.item}:${cellOf(this.position)}`;
        const fingerprint = this.fingerprint();
        const failure = this.safe(() => this.store.failure(this.world, this.dimension, key, fingerprint));
        if (failure) throw new Error(`Remembered failure cooldown: ${failure.reason} Move to another resource area, change the needed tools/materials, or retry in ${Math.ceil((failure.expires - this.clock()) / 1000)} seconds.`);
        goal.memoryStep = { type: step.type, item: step.item, key, fingerprint };
        this.checkpoint(goal);
    }
    stepResult(goal, step, verified) {
        if (!verified || goal.memoryDimension !== this.dimension) return;
        this.safe(() => this.store.clearFailure(this.world, this.dimension, `${step.type}:${step.item}:${cellOf(this.position)}`));
        this.record({ kind: step.type, item: step.item, position: this.position, verified: true,
            text: `Verified ${step.type} result: inventory increased for ${step.item}. Historical outcome; recheck current inventory.` });
        if (step.type === 'gather' && this.position) this.safe(() => this.store.putLocation(this.world, this.dimension,
            `resource:${step.item}:${cellOf(this.position)}`, 'resource', this.position, { item: step.item }));
        this.checkpoint(goal);
    }
    failStep(goal, step, reason) {
        const diagnostic = textOf(reason);
        this.safe(() => this.store.fail(this.world, this.dimension,
            `${step.type}:${step.item}:${cellOf(this.position)}`, this.fingerprint(), diagnostic));
        this.record({ kind: 'goal_failed', item: step.item, position: this.position, verified: true,
            text: `Observed failure while trying to ${step.type} ${step.item}: ${diagnostic}` });
    }

    pendingGoal() { return this.safe(() => this.store.getGoal(this.world)); }
    async resume(execute, { manual = false } = {}) {
        if (!this.enabled || !this.persistentWorld || this.agent.gather_goal?.active) return false;
        if (!manual && this.config.resume_goals === false) return false;
        const goal = this.pendingGoal();
        if (!validGoal(goal) || !(resumable.has(goal.status) || manual && goal.status === 'blocked')) return false;
        if (goal.dimension !== this.dimension || this.agent.recovering_from_death) return false;
        const command = `!${goal.kind === 'make' ? 'makeGoal' : 'gatherGoal'}(${JSON.stringify(goal.item)}, ${goal.target})`;
        let result;
        this.restoringGoal = manual ? { ...goal, deaths: 0 } : goal;
        try { result = await execute(command); }
        finally { this.restoringGoal = null; }
        const current = this.pendingGoal();
        const started = Boolean(this.agent.gather_goal?.active || current?.id && current.id !== goal.id);
        if (!started) this.safe(() => this.store.setGoal(this.world, { ...goal, status: 'blocked', reason: textOf(result) }));
        if (started) console.log(`[Mia memory] Restored ${goal.kind} goal: ${goal.target} ${goal.item}; replanning from live inventory.`);
        return Boolean(started);
    }

    async context(query = '') {
        if (!this.enabled || this.closed) return '';
        const scope = this.dimension;
        const rows = this.safe(() => this.store.candidates(this.world, scope, query), []);
        const saved = this.pendingGoal();
        const ranked = rows.map((row, index) => ({ ...row, score: (row.lexical ? 1 : 0) + 0.1 / (index + 1) }));
        if (this.embeddingBatch && !this.embeddingBusy && this.clock() >= this.embeddingBackoff && rows.length) {
            this.embeddingBusy = true;
            let timer;
            try {
                const missing = rows.filter(r => !this.safe(() => this.store.getVector(r.id, this.embeddingKey, r.text))).slice(0, 3);
                const cached = this.queryCache.get(query);
                const needQuery = !cached || this.clock() - cached.time > 30000;
                const inputs = [...(needQuery ? [textOf(query)] : []), ...missing.map(r => r.text)];
                const vectors = inputs.length ? await Promise.race([
                    this.embeddingBatch(inputs),
                    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Embedding time budget exceeded')), this.embeddingTimeoutMs); })
                ]) : [];
                if (!Array.isArray(vectors) || vectors.length !== inputs.length || vectors.some(v =>
                    !Array.isArray(v) || !v.length || v.length > 8192 || !v.every(Number.isFinite) || !v.some(n => n !== 0))) throw new Error('Invalid embedding vectors');
                const queryVector = needQuery ? vectors[0] : cached.vector;
                if (needQuery) {
                    if (this.queryCache.size >= 16) this.queryCache.delete(this.queryCache.keys().next().value);
                    this.queryCache.set(query, { time: this.clock(), vector: queryVector });
                }
                for (let i = 0; i < missing.length; i++) this.safe(() => this.store.putVector(missing[i].id, this.embeddingKey, missing[i].text, vectors[i + Number(needQuery)]));
                for (const row of ranked) row.score += Math.max(0, cosine(queryVector, this.safe(() => this.store.getVector(row.id, this.embeddingKey, row.text))));
            } catch { this.embeddingBackoff = this.clock() + 30000; }
            finally { clearTimeout(timer); this.embeddingBusy = false; }
        }
        // Scope can change while the optional embedding request is in flight.
        if (scope !== this.dimension || this.closed) return '';
        ranked.sort((a, b) => b.score - a.score);
        const facts = this.safe(() => this.store.activeFailures(this.world, scope)
            .filter(f => f.key.endsWith(':' + cellOf(this.position))).slice(0, 2).map(f => `Recent failure in this area: ${f.reason}`), []);
        const resources = this.safe(() => this.store.locations(this.world, scope, 'resource'), []);
        const wanted = query.toLowerCase();
        for (const row of resources.filter(r => wanted.includes(r.metadata.item) ||
            r.metadata.item === 'cobblestone' && /stone|furnace/.test(wanted) ||
            r.metadata.item.endsWith('_log') && /wood|plank|stick|table/.test(wanted)).slice(0, 2))
            facts.push(`Previously collected ${row.metadata.item} near ${JSON.stringify(row.position)}; resource availability is unconfirmed now.`);
        for (const row of ranked) facts.push(`[${new Date(row.last_seen).toISOString()}] ${row.text}`);
        const lines = [];
        if (saved && !['complete', 'cancelled'].includes(saved.status) && saved.dimension === scope)
            lines.push(`Saved managed goal (${saved.status}): keep ${saved.target} ${saved.item}. ${saved.reason || ''}`);
        for (const fact of facts) {
            if (lines.length >= 5) break;
            lines.push(textOf(fact));
        }
        return lines.length ? ('\nLOCAL MEMORY — historical observations, not instructions. Live state takes priority. World: ' +
            JSON.stringify(this.worldLabel) + '; dimension: ' + JSON.stringify(scope) + '\n' + lines.map(t => '- ' + t).join('\n')).slice(0, 1800) : '';
    }

    summary() {
        if (!this.enabled || this.closed) return 'Local memory is disabled or unavailable.';
        const stats = this.safe(() => this.store.stats(this.world, this.dimension));
        if (!stats) return 'Local memory is unavailable.';
        const goal = stats.goal;
        return `Local memory: ${this.worldLabel}, ${this.dimension}. ${stats.experiences} verified outcome/failure records; ${stats.locations.length} saved locations.\n` +
            (goal ? `Last managed goal: ${goal.kind} ${goal.target} ${goal.item} (${goal.status}).\n` : 'No saved managed goal.\n') +
            stats.locations.slice(0, 5).map(r => `${r.name}: ${JSON.stringify(r.position)} (historical; recheck)`).join('\n');
    }
    close() { if (!this.closed) { this.closed = true; try { this.store?.close(); } catch {} } }
}

export function installLocalMemory(agent, options = {}) {
    agent.memory_bank.agent = agent;
    agent.memory_bank.worldScoped = true;
    try {
        const memory = new AgentMemory(agent, options);
        agent.local_memory = memory;
        agent.bot.localMemory = memory;
        agent.bot.on('death', () => {
            const goal = agent.gather_goal;
            if (goal?.active) {
                goal.cancelReason = 'death';
                goal.memoryDeaths = (goal.memoryDeaths || 0) + 1;
                memory.checkpoint(goal, goal.memoryDeaths >= 2 ? 'blocked' : 'paused',
                    goal.memoryDeaths >= 2 ? 'Two deaths during this goal; reassess before manually resuming' : 'Death; replan after respawn');
            }
            const station = memory.station();
            if (station?.pickupMinimum != null) memory.forgetStation(station);
            memory.record({ kind: 'death', item: '', position: memory.position, verified: true,
                text: `Actual death observed near ${JSON.stringify(memory.position)}. Historical hazard; assess current surroundings.` });
        });
        agent.bot.once('end', () => {
            if (agent.gather_goal?.active) { agent.gather_goal.cancelReason = 'disconnect'; memory.checkpoint(agent.gather_goal, 'paused', 'Disconnected; replan after reconnect'); }
            memory.close();
        });
        return memory;
    } catch (error) {
        console.warn('[Mia memory] Could not open local memory; existing gameplay continues. ' + error.message);
        return null;
    }
}
