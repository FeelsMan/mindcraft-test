import Vec3 from 'vec3';
import { randomUUID } from 'node:crypto';
import { positionOf } from './local_memory.js';
import { shelterBlueprint, shelterRecord } from './shelter_blueprint.js';
import { captureInventory } from './live_inventory.js';

const dimensionOf = bot => String(bot.game?.dimension ?? 'unknown');
const keyOf = p => `${p.x},${p.y},${p.z}`;
const samePosition = (a, b) => a && b && keyOf(a) === keyOf(b);
const point = p => new Vec3(p.x, p.y, p.z);
const stations = new Set(['crafting_table', 'furnace', 'blast_furnace', 'smoker']);
const resources = { stone: 'cobblestone', cobblestone: 'cobblestone', iron_ore: 'raw_iron',
    deepslate_iron_ore: 'raw_iron', coal_ore: 'coal', deepslate_coal_ore: 'coal',
    copper_ore: 'raw_copper', deepslate_copper_ore: 'raw_copper' };
const resourceItem = name => resources[name] || (name?.endsWith('_log') ? name : null);
const signature = block => !block ? 'unknown' : JSON.stringify([block.name, block.stateId ?? null, block.getProperties?.() || {}]);
const air = name => ['air', 'cave_air', 'void_air'].includes(name);

// Current observations are a small cache, separate from experience/history.
// Only received/loaded blocks can establish absence. Event handlers never call
// a model or embedding service; SQLite writes are coalesced and flushed on close.
export class WorldMemorySync {
    constructor(memory, { flushMs = 250 } = {}) {
        this.memory = memory; this.agent = memory.agent; this.bot = memory.bot;
        this.flushMs = flushMs; this.session = randomUUID(); this.revision = 0;
        this.dimension = dimensionOf(this.bot); this.entries = new Map(); this.pending = new Map();
        this.listeners = []; this.route = new Set(); this.routeReset = false;
        this.watched = new Map(); this.position = positionOf(this.bot.entity?.position);
        this.closed = false; this.target = null;
        this.listen(this.bot, 'game', () => this.refresh());
        this.listen(this.bot, 'spawn', () => this.refresh());
        this.listen(this.bot, 'move', () => { this.position = positionOf(this.bot.entity?.position); });
        this.listen(this.bot, 'forcedMove', () => this.relocate());
        this.listen(this.bot, 'death', () => this.relocate(false));
        this.listen(this.bot, 'chunkColumnLoad', p => this.chunk(p, true));
        this.listen(this.bot, 'chunkColumnUnload', p => this.chunk(p, false));
        this.listen(this.bot, 'path_update', result => this.watchRoute(result?.path));
        this.listen(this.bot, 'path_stop', () => this.route.clear());
        this.listen(this.bot, 'path_reset', () => this.route.clear());
        this.listen(this.bot, 'goal_updated', () => this.route.clear());
        this.bindWorld(); this.loadLocations();
    }

    listen(emitter, event, fn) {
        if (!emitter?.on) return;
        const handler = (...args) => {
            if (this.closed) return;
            try { fn(...args); }
            catch (error) {
                if (!this.warned) console.warn('[Mia world memory] Observation update failed: ' + error.message);
                this.warned = true;
            }
        };
        emitter.on(event, handler); this.listeners.push([emitter, event, handler]);
    }
    bindWorld() {
        const world = this.bot.world?.on ? this.bot.world : this.bot;
        if (world !== this.worldEmitter) {
            if (this.blockListener) this.worldEmitter?.removeListener('blockUpdate', this.blockListener);
            this.worldEmitter = world;
            this.blockListener = (oldBlock, newBlock) => {
                if (this.closed) return;
                try { this.blockChanged(oldBlock, newBlock); }
                catch (error) { if (!this.warned) console.warn('[Mia world memory] Block update failed: ' + error.message); this.warned = true; }
            };
            world.on('blockUpdate', this.blockListener);
        }
        if (this.bot.inventory !== this.inventoryEmitter) {
            if (this.inventoryListener) this.inventoryEmitter?.removeListener?.('updateSlot', this.inventoryListener);
            this.inventoryEmitter = this.bot.inventory;
            this.inventoryState = captureInventory(this.bot).fingerprint;
            this.inventoryListener = () => {
                const state = captureInventory(this.bot).fingerprint;
                if (!this.closed && state !== this.inventoryState) { this.inventoryState = state; this.revision++; }
            };
            this.inventoryEmitter?.on?.('updateSlot', this.inventoryListener);
        }
    }
    read(p) { try { return this.bot.blockAt?.(point(p)) || null; } catch { return null; } }
    loadLocations() {
        const rows = this.memory.safe(() => {
            const store = this.memory.store, world = this.memory.world, dim = this.dimension;
            const owned = ['owned:crafting_table', 'owned:furnace', 'owned:shelter'].map(name => store.getLocation(world, dim, name));
            return [...owned, ...store.locations(world, dim).filter(r => ['resource_block', 'seen_station'].includes(r.kind))];
        }, []);
        for (const row of rows) if (row) { row.persisted = true; this.trackLocation(row); }
    }
    trackLocation(row) {
        if (this.closed || row.dimension !== this.dimension) return;
        this.forgetLocation(row.name);
        const cells = new Map();
        if (row.kind === 'shelter') {
            const record = shelterRecord(row.metadata);
            if (!record) return;
            const plan = shelterBlueprint(record);
            for (const step of plan.blocks) cells.set(keyOf(step.position), { position: step.position, expected: step.item });
            for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) {
                const floor = plan.origin.offset(x, -1, z);
                cells.set(keyOf(floor), { position: floor, expected: 'solid' });
                if (x > 0 && x < 4 && z > 0 && z < 4) for (let y = 0; y < 2; y++) {
                    const p = plan.origin.offset(x, y, z); cells.set(keyOf(p), { position: p, expected: 'air' });
                }
            }
            for (let y = 0; y < 2; y++) {
                const p = plan.door.offset(0, y, 0); cells.set(keyOf(p), { position: p, expected: 'oak_door' });
                const outside = plan.outside.offset(0, y, 0); cells.set(keyOf(outside), { position: outside, expected: 'air' });
            }
            const support = plan.outside.offset(0, -1, 0); cells.set(keyOf(support), { position: support, expected: 'solid' });
        } else {
            const expected = row.name === 'owned:crafting_table' ? 'crafting_table' :
                row.name === 'owned:furnace' ? 'furnace' : row.metadata.block;
            if (!expected) return;
            cells.set(keyOf(row.position), { position: row.position, expected });
        }
        // Cache limits do not discard owned stations or the shelter blueprint.
        if (this.entries.size >= 128 && !row.name.startsWith('owned:')) {
            const oldest = [...this.entries.keys()].find(name => !name.startsWith('owned:'));
            if (oldest) this.forgetLocation(oldest);
        }
        this.entries.set(row.name, { row, cells, observation: null });
        this.reconcile(this.entries.get(row.name));
    }
    forgetLocation(name) { this.entries.delete(name); this.pending.delete(name); }

    reconcile(entry, unloaded = false) {
        const states = []; let unknown = false, mismatch = false;
        for (const cell of entry.cells.values()) {
            const block = unloaded ? null : this.read(cell.position);
            if (!block) unknown = true;
            else if (cell.expected === 'solid' ? block.boundingBox !== 'block' || air(block.name) :
                cell.expected === 'air' ? !air(block.name) : block.name !== cell.expected) mismatch = true;
            states.push([keyOf(cell.position), signature(block)]);
        }
        const status = mismatch ? entry.row.kind === 'shelter' ? 'changed' : 'missing' : unknown ? 'unknown' : 'present';
        const state = JSON.stringify(states);
        if (entry.observation?.state === state && entry.observation.status === status) return;
        const previous = entry.observation || entry.row.metadata.observation;
        const observation = { status, state, at: this.memory.clock(), session: this.session };
        entry.observation = observation; this.revision++;
        const metadata = entry.row.metadata;
        const revoke = status === 'missing' && metadata.owned && !metadata.pendingPlacement && metadata.pickupMinimum == null;
        if (revoke) {
            metadata.owned = false;
            entry.ownershipRevoked = true;
            const manager = entry.row.name === 'owned:crafting_table' ? this.bot.craftingStation : this.bot.managedFurnace;
            if (samePosition(manager?.record?.position, entry.row.position)) manager.record = null;
        }
        if (entry.row.name === 'owned:furnace' && (status !== 'present' || previous?.state !== state)) {
            if (this.bot.managedFurnace) this.bot.managedFurnace.snapshot = null;
            if (this.agent.gather_goal?.active) this.agent.gather_goal.furnaceChecked = false;
        }
        const changed = previous && ['present', 'verified'].includes(previous.status) && ['missing', 'changed'].includes(status);
        this.pending.set(entry.row.name, { entry, observation, revoke: Boolean(entry.ownershipRevoked),
            changed: Boolean(changed), create: !entry.row.persisted });
        this.schedule();
    }
    schedule() {
        if (this.timer || this.closed) return;
        this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
        this.timer.unref?.();
    }
    flush() {
        clearTimeout(this.timer); this.timer = null;
        const writes = [...this.pending.values()]; this.pending.clear();
        if (!writes.length) return;
        this.memory.safe(() => {
            const store = this.memory.store; store.db.exec('BEGIN IMMEDIATE');
            try {
                for (const write of writes) {
                    const { entry, observation } = write, row = entry.row;
                    const current = store.getLocation(this.memory.world, row.dimension, row.name);
                    if (current && !samePosition(current.position, row.position) || !current && !write.create) continue;
                    const metadata = { ...(current?.metadata || row.metadata),
                        ...(['resource_block', 'seen_station'].includes(row.kind) ? row.metadata : {}), observation };
                    if (write.revoke && !metadata.pendingPlacement && metadata.pickupMinimum == null) metadata.owned = false;
                    store.putLocation(this.memory.world, row.dimension, row.name, row.kind, row.position, metadata);
                    row.persisted = true;
                    if (write.changed) store.record(this.memory.world, row.dimension, { kind: 'world_change',
                        item: row.metadata.item || row.metadata.block || row.kind, position: row.position, verified: true,
                        text: `Loaded world changed at ${keyOf(row.position)}: ${row.name} is ${observation.status}. Historical change; recheck live blocks.` });
                }
                store.prune(); store.db.exec('COMMIT');
            } catch (error) { store.db.exec('ROLLBACK'); throw error; }
        });
    }

    observe(block, item = null) {
        const p = positionOf(block?.position), here = this.bot.entity?.position;
        if (this.closed || !p || !here || Math.hypot(p.x - here.x, p.y - here.y, p.z - here.z) > 64) return;
        item ||= resourceItem(block.name);
        const kind = stations.has(block.name) ? 'seen_station' : item ? 'resource_block' : null;
        if (!kind) return;
        const name = `seen:${kind}:${keyOf(p)}`;
        const old = this.entries.get(name);
        if (old && old.row.metadata.block === block.name) { this.reconcile(old); return; }
        this.trackLocation({ name, kind, position: p, dimension: this.dimension,
            metadata: { owned: false, block: block.name, ...(item ? { item } : {}) } });
    }
    blockChanged(oldBlock, newBlock) {
        if (dimensionOf(this.bot) !== this.dimension) { this.refresh(); return; }
        const p = positionOf(newBlock?.position || oldBlock?.position);
        if (!p) return; // Unload notifications can contain two null blocks.
        const key = keyOf(p), changed = signature(oldBlock) !== signature(newBlock);
        for (const entry of this.entries.values()) if (entry.cells.has(key)) this.reconcile(entry);
        const here = this.bot.entity?.position;
        if (newBlock && here && Math.hypot(p.x - here.x, p.y - here.y, p.z - here.z) <= 12) this.observe(newBlock);
        if (this.watched.has(key) && this.watched.get(key) !== signature(newBlock)) {
            this.watched.set(key, signature(newBlock)); this.revision++;
        }
        if (changed && this.target?.key === key && !this.target.matches(newBlock) && !this.bot.pathfinder?.isMining?.()) {
            this.target.expired = true;
            if (this.agent.actions?.currentRun === this.target.run) this.stopRoute();
        } else if (changed && this.route.has(key)) this.resetRoute();
    }
    chunk(p, loaded) {
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return;
        for (const entry of this.entries.values()) if ([...entry.cells.values()].some(cell =>
            Math.floor(cell.position.x / 16) === Math.floor(p.x / 16) && Math.floor(cell.position.z / 16) === Math.floor(p.z / 16)))
            this.reconcile(entry, !loaded);
        if ([...this.watched.keys()].some(k => { const [x, , z] = k.split(',').map(Number); return Math.floor(x / 16) === Math.floor(p.x / 16) && Math.floor(z / 16) === Math.floor(p.z / 16); })) this.revision++;
        if (!loaded && [...this.route].some(k => { const [x, , z] = k.split(',').map(Number); return Math.floor(x / 16) === Math.floor(p.x / 16) && Math.floor(z / 16) === Math.floor(p.z / 16); })) this.resetRoute();
    }
    refresh() {
        if (this.closed) return;
        const dimension = dimensionOf(this.bot);
        if (dimension !== this.dimension) {
            this.flush(); this.entries.clear(); this.watched.clear(); this.route.clear(); this.target = null;
            this.dimension = dimension; this.revision++;
            if (this.bot.craftingStation) this.bot.craftingStation.record = null;
            if (this.bot.managedFurnace) { this.bot.managedFurnace.record = null; this.bot.managedFurnace.snapshot = null; }
            this.stopAction(); this.loadLocations();
        }
        this.bindWorld();
        for (const entry of this.entries.values()) this.reconcile(entry);
        this.position = positionOf(this.bot.entity?.position);
    }
    relocate(stop = true) {
        if (this.closed) return;
        this.revision++; this.watched.clear(); this.route.clear(); this.target = null;
        this.position = positionOf(this.bot.entity?.position);
        if (this.bot.managedFurnace) this.bot.managedFurnace.snapshot = null;
        if (this.agent.gather_goal?.active) this.agent.gather_goal.furnaceChecked = false;
        for (const entry of this.entries.values()) this.reconcile(entry, true);
        if (stop) this.stopAction();
    }
    stopAction() {
        const label = this.agent.actions?.currentActionLabel || '';
        if (!this.agent.actions?.executing || label.startsWith('mode:')) return;
        Promise.resolve(this.agent.actions.stop('world_changed')).catch(error => console.warn('[Mia world memory] Could not stop stale action: ' + error.message));
    }
    stopRoute() {
        if (this.agent.actions?.currentActionLabel?.startsWith('mode:')) return;
        if (this.bot.pathfinder?.goal && !this.bot.pathfinder.isMining?.() && !this.bot.pathfinder.isBuilding?.()) {
            this.bot.pathfinder.setGoal(null); this.bot.clearControlStates?.();
        }
    }
    watchTarget(block, matches) {
        const token = { key: keyOf(block.position), matches, expired: false, run: this.agent.actions?.currentRun }; this.target = token;
        return () => { if (this.target === token) this.target = null; };
    }
    watchRoute(path) {
        this.route.clear();
        for (const node of (path || []).slice(0, 64)) {
            const p = positionOf(node); if (!p) continue;
            for (const y of [-1, 0, 1]) this.route.add(keyOf({ x: p.x, y: p.y + y, z: p.z }));
        }
    }
    resetRoute() {
        const pf = this.bot.pathfinder;
        this.routeRequest = { pf, goal: pf?.goal, movements: pf?.movements, run: this.agent.actions?.currentRun };
        if (this.routeReset) return;
        this.routeReset = true;
        queueMicrotask(() => {
            this.routeReset = false;
            const { pf, goal, movements, run } = this.routeRequest;
            if (!this.closed && this.route.size && pf === this.bot.pathfinder && goal && pf.goal === goal &&
                movements && pf.movements === movements && run === this.agent.actions?.currentRun &&
                pf.isMoving?.() && !pf.isMining?.() && !pf.isBuilding?.())
                pf.setMovements(pf.movements); // Replan with the same policy and goal; never enable digging.
        });
    }
    watchDecision(blocks) {
        this.watched.clear();
        for (const block of blocks.filter(Boolean).slice(0, 24)) if (positionOf(block.position))
            this.watched.set(keyOf(block.position), signature(block));
    }
    decisionChanged(token) {
        this.refresh();
        for (const [key, before] of this.watched) {
            const [x, y, z] = key.split(',').map(Number), now = signature(this.read({ x, y, z }));
            if (before !== now) { this.watched.set(key, now); this.revision++; }
        }
        return !token || token.session !== this.session || token.revision !== this.revision || token.dimension !== this.dimension;
    }
    token() { return { session: this.session, revision: this.revision, dimension: this.dimension }; }
    evidenceFor(step) {
        if (dimensionOf(this.bot) !== this.dimension) return [];
        return [...this.entries.values()].filter(entry => entry.row.metadata.item === step?.item ||
            ['craft', 'recover'].includes(step?.type) && (entry.row.name === 'owned:crafting_table' || entry.row.metadata.block === 'crafting_table') ||
            ['inspect', 'smelt'].includes(step?.type) && (entry.row.name === 'owned:furnace' || entry.row.metadata.block === 'furnace') ||
            ['site', 'place', 'clear', 'return', 'finish'].includes(step?.type) && entry.row.kind === 'shelter')
            .slice(0, 12).map(entry => [entry.row.name, entry.observation?.status, entry.observation?.state]).sort();
    }
    status(name) { return this.observedStatus(name) || 'unknown'; }
    observedStatus(name) { return dimensionOf(this.bot) === this.dimension ? this.entries.get(name)?.observation?.status : undefined; }
    owns(name) { return dimensionOf(this.bot) === this.dimension ? this.entries.get(name)?.row.metadata.owned : undefined; }
    locationSaved(name) {
        if (dimensionOf(this.bot) !== this.dimension) this.refresh();
        const row = this.memory.safe(() => this.memory.store.getLocation(this.memory.world, dimensionOf(this.bot), name));
        if (row) { row.persisted = true; this.trackLocation(row); }
    }
    lines() {
        if (dimensionOf(this.bot) !== this.dimension) return [];
        return [...this.entries.values()].filter(entry => entry.row.name.startsWith('owned:') ||
            ['missing', 'changed'].includes(entry.observation?.status))
            .sort((a, b) => Number(b.row.name.startsWith('owned:')) - Number(a.row.name.startsWith('owned:')))
            .slice(0, 8).map(entry =>
            `${entry.row.name} at ${keyOf(entry.row.position)}: ${entry.observation?.status || 'unknown'} ` +
            (entry.row.kind === 'shelter' ? '(block observations only; entrance and safety require verification).' : '(loaded block observation; access unverified).'));
    }
    close() {
        if (this.closed) return;
        this.flush(); this.closed = true;
        for (const [emitter, event, fn] of this.listeners) emitter.removeListener(event, fn);
        this.worldEmitter?.removeListener('blockUpdate', this.blockListener);
        this.inventoryEmitter?.removeListener?.('updateSlot', this.inventoryListener);
        this.entries.clear(); this.watched.clear(); this.route.clear(); this.target = null;
    }
}
