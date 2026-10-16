import { countInventoryItem, emergencyModes, sleep } from './managed_goal.js';

export const STATION_TRAVEL_DISTANCE = 32;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const dimension = bot => String(bot.game?.dimension ?? 'overworld');

// Only tables placed by this bot are owned. Nearby player tables may be used,
// but are never registered here or collected when the bot moves away.
export class CraftingStation {
    constructor(bot, api, { travelDistance = STATION_TRAVEL_DISTANCE, verifyTimeoutMs = 1500 } = {}) {
        this.bot = bot;
        this.api = api;
        this.travelDistance = travelDistance;
        this.verifyTimeoutMs = verifyTimeoutMs;
        this.record = null;
        this.busy = false;
        // Drop session references while retaining the historical world location.
        // It is revalidated against loaded blocks before any use or pickup.
        bot.on('death', () => { this.record = null; });
        bot.on('end', () => { this.record = null; });
    }

    forget() {
        if (this.record) this.bot.localMemory?.forgetStation(this.record);
        this.record = null;
    }

    remember(block) {
        if (block?.name !== 'crafting_table') throw new Error('Cannot remember an unverified crafting table.');
        const { x, y, z } = block.position;
        this.record = { position: { x, y, z }, dimension: dimension(this.bot), pickupMinimum: null, pendingPlacement: false };
        this.bot.localMemory?.saveStation(this.record);
        this.api.log?.(`Leaving my crafting table at ${x}, ${y}, ${z}; reusing it nearby and packing it before travel beyond ${this.travelDistance} blocks.`);
    }

    unsafe() {
        return this.bot.interrupt_code || this.bot.pvp?.target ||
            (this.bot.modes?.getActiveModes?.() || []).some(name => emergencyModes.has(name));
    }

    available() {
        if (this.record && this.record.dimension !== dimension(this.bot)) this.record = null;
        this.record ??= this.bot.localMemory?.station() ?? null;
        const record = this.record;
        if (!record) return false;
        if (record.dimension !== dimension(this.bot)) { this.forget(); return false; }
        const block = this.api.blockAt(record.position);
        // An unloaded chunk is unknown, not proof that the table disappeared.
        if (block && block.name !== 'crafting_table' && record.pickupMinimum === null) {
            this.api.log?.('My remembered crafting table is gone.');
            this.forget();
            return false;
        }
        if (block?.name === 'crafting_table' && record.pendingPlacement) {
            record.pendingPlacement = false;
            this.bot.localMemory?.saveStation(record);
        }
        return true;
    }

    async place() {
        if (this.busy || this.unsafe()) return null;
        if (this.available()) return this.forCraft();
        this.busy = true;
        let pending;
        try {
            const block = await this.api.place(position => {
                pending = this.record = { position: { x: position.x, y: position.y, z: position.z },
                    dimension: dimension(this.bot), pickupMinimum: null, pendingPlacement: true };
                this.bot.localMemory?.saveStation(pending);
            });
            if (block?.name !== 'crafting_table' || this.record !== pending || pending.dimension !== dimension(this.bot)) return null;
            this.remember(block);
            return block;
        } finally { this.busy = false; }
    }

    async approach(record) {
        const pickup = record.pickupMinimum !== null;
        const usable = () => pickup || !this.api.canUse ? distance(this.bot.entity.position, record.position) <= 3 :
            this.api.canUse(record.position);
        if (!usable()) {
            this.api.log?.('Returning to my crafting table.');
            if (!await this.api.move(record.position, { pickup }) && !this.bot.interrupt_code)
                throw new Error('Could not reach my crafting table; travel stopped so it is not abandoned.');
        }
        if (this.bot.interrupt_code || this.record !== record) return null;
        if (!usable()) throw new Error('Crafting table approach did not reach a verified work position; station and goal retained.');
        const block = this.api.blockAt(record.position);
        if (!block) throw new Error('Crafting table chunk did not load; try again from a reachable location.');
        return block;
    }

    async forCraft() {
        if (this.busy || !this.available() || this.unsafe()) return null;
        if (this.record.pickupMinimum !== null) {
            await this.pack();
            return null;
        }
        const record = this.record;
        this.busy = true;
        try {
            const block = await this.approach(record);
            if (!block) return null;
            if (block.name !== 'crafting_table') { this.forget(); return null; }
            return block;
        } finally { this.busy = false; }
    }

    needsPacking(target = this.bot.entity.position) {
        return !this.busy && this.available() &&
            distance(target, this.record.position) > this.travelDistance;
    }

    async beforeTravel(target) {
        if (this.unsafe() || !this.needsPacking(target)) return;
        await this.pack();
    }

    async pack() {
        if (this.busy || this.unsafe() || !this.available()) return false;
        const record = this.record;
        this.busy = true;
        try {
            const knownBlock = this.api.blockAt(record.position);
            if (record.pickupMinimum !== null && knownBlock && knownBlock.name !== 'crafting_table' &&
                countInventoryItem(this.bot, 'crafting_table') >= record.pickupMinimum) {
                this.forget();
                this.api.log?.('Crafting table pickup was completed before the interruption; no return trip is needed.');
                return true;
            }
            const block = await this.approach(record);
            if (!block) return false;
            if (block.name === 'crafting_table') {
                if (this.api.canCarry && !this.api.canCarry())
                    throw new Error('Make inventory space before collecting the crafting table.');
                record.pickupMinimum = countInventoryItem(this.bot, 'crafting_table') + 1;
                this.bot.localMemory?.saveStation(record);
                await this.api.break(record.position);
            } else if (record.pickupMinimum === null) {
                this.forget();
                return true;
            }
            if (this.bot.interrupt_code || this.record !== record) return false;
            await this.api.pickup(record.position);
            const deadline = Date.now() + this.verifyTimeoutMs;
            while (!this.bot.interrupt_code && this.record === record) {
                const after = this.api.blockAt(record.position);
                if (after && after.name !== 'crafting_table' &&
                    countInventoryItem(this.bot, 'crafting_table') >= record.pickupMinimum) {
                    this.forget();
                    this.api.log?.('Packed my crafting table; pickup verified. Continuing the trip.');
                    return true;
                }
                if (Date.now() >= deadline) break;
                await sleep(50);
            }
            if (this.bot.interrupt_code || this.record !== record) return false;
            throw new Error('Could not verify crafting table pickup; travel stopped. Check the dropped table and inventory space.');
        } finally { this.busy = false; }
    }
}

export function hasReusableTable(bot) {
    return Boolean(bot.craftingStation?.available());
}
