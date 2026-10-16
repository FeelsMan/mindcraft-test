import { countInventoryItem, sleep } from './managed_goal.js';
import { positionOf } from './local_memory.js';
import { fuelTicks, furnaceEnergy, furnacePending, smeltingRecipes, SMELT_TICKS } from './smelting_plan.js';

const dimension = bot => String(bot.game?.dimension ?? 'unknown');
const itemData = item => item ? { name: item.name, count: item.count } : null;
const playerItems = (bot, window) => window?.slots && Number.isInteger(window.inventoryStart) ?
    window.slots.slice(window.inventoryStart, window.inventoryEnd).filter(Boolean) : bot.inventory.items();
const playerCount = (bot, window, name) => playerItems(bot, window).filter(i => i.name === name).reduce((n, i) => n + i.count, 0);

export async function openManagedFurnace(bot, block) {
    // Mineflayer installs its bar listener only after openBlock resolves. Native
    // 26.3 can send initial bars in the same bundle as windowOpen, so retain
    // those packets before activating the block. Read remaining fuel directly
    // from ticks rather than depending on a previously observed totalFuel bar.
    const pending = new Map();
    const capture = packet => {
        if (!Number.isInteger(packet.property) || packet.property < 0 || packet.property > 3 || !Number.isFinite(packet.value)) return;
        if (!pending.has(packet.windowId) && pending.size >= 4) return;
        const bars = pending.get(packet.windowId) || {};
        bars[packet.property] = packet.value; pending.set(packet.windowId, bars);
    };
    bot._client.on('craft_progress_bar', capture);
    let window;
    try { window = await bot.openFurnace(block); }
    finally { bot._client.removeListener('craft_progress_bar', capture); }
    const bars = pending.get(window.id) || {};
    const apply = () => {
        if (Number.isFinite(bars[1])) { window.totalFuel = bars[1]; window.totalFuelSeconds = bars[1] / 20; }
        if (Number.isFinite(bars[0])) window.fuelSeconds = Math.max(0, bars[0]) / 20;
        if (Number.isFinite(bars[3]) && bars[3] > 0) window.totalProgress = bars[3];
        if (Number.isFinite(bars[2])) window.progress = Math.max(0, Math.min(1, bars[2] / (window.totalProgress || SMELT_TICKS)));
    };
    const follow = packet => {
        if (packet.windowId !== window.id || !Number.isInteger(packet.property) || packet.property < 0 || packet.property > 3) return;
        bars[packet.property] = packet.value; apply();
    };
    // Registered after the plugin so a missing initial total cannot overwrite
    // our raw remaining-fuel reading with zero on subsequent updates.
    bot._client.on('craft_progress_bar', follow);
    window.once('close', () => bot._client.removeListener('craft_progress_bar', follow));
    apply();
    return window;
}

export class ManagedFurnace {
    constructor(bot, api, { settleMs = 250, pollMs = 100, waitMs = 25000, verifyMs = 1500 } = {}) {
        this.bot = bot; this.api = api;
        Object.assign(this, { settleMs, pollMs, waitMs, verifyMs });
        this.record = null; this.snapshot = null;
        for (const event of ['death', 'end']) bot.on(event, () => { this.record = null; this.snapshot = null; });
    }
    save() { this.bot.localMemory?.saveFurnace(this.record); }
    forget() {
        if (this.record) this.bot.localMemory?.forgetFurnace(this.record);
        this.record = null; this.snapshot = null;
    }
    available() {
        if (this.record?.dimension !== dimension(this.bot)) { this.record = null; this.snapshot = null; }
        this.record ??= this.bot.localMemory?.furnace() ?? null;
        if (!this.record) return false;
        const block = this.api.blockAt(this.record.position);
        if (block && block.name !== 'furnace') { this.forget(); return false; }
        if (block && this.record.pendingPlacement) { this.record.pendingPlacement = false; this.save(); }
        return true;
    }
    async obtain(place = true) {
        const bot = this.bot;
        if (bot.interrupt_code) return null;
        if (!this.available()) {
            if (!place) return null;
            if (countInventoryItem(bot, 'furnace') < 1) throw new Error('A furnace is required in inventory or at a remembered owned station.');
            let pending;
            await this.api.place(p => {
                pending = this.record = { position: positionOf(p), dimension: dimension(bot), pendingPlacement: true };
                this.save(); // Recover placement across interruption/crash, then recheck the actual block.
            });
            if (bot.interrupt_code) return null;
            if (!pending) throw new Error('No reachable supported space for the furnace.');
            if (this.record !== pending || pending.dimension !== dimension(bot)) return null;
            const deadline = Date.now() + this.verifyMs;
            while (!bot.interrupt_code && Date.now() < deadline) {
                if (this.api.blockAt(this.record.position)?.name === 'furnace') break;
                await sleep(this.pollMs);
            }
            if (bot.interrupt_code) return null;
            if (this.api.blockAt(this.record.position)?.name !== 'furnace') {
                this.forget(); throw new Error('Could not verify furnace placement.');
            }
            this.record.pendingPlacement = false; this.save();
            this.api.log?.('Placed and remembered my furnace; leaving it for reuse and interruption recovery.');
        }
        const record = this.record;
        if (!await this.api.move(record.position) || bot.interrupt_code || this.record !== record) {
            if (bot.interrupt_code) return null;
            throw new Error('Could not reach my owned furnace; its location and goal are retained.');
        }
        const block = this.api.blockAt(record.position);
        if (!block || block.name !== 'furnace') throw new Error('Owned furnace is missing or its chunk is not loaded.');
        return block;
    }
    read(window) {
        this.snapshot = {
            input: itemData(window.inputItem()), fuel: itemData(window.fuelItem()), output: itemData(window.outputItem()),
            burnTicks: Math.max(0, Math.round((Number(window.fuelSeconds) || 0) * 20)),
            progressTicks: Math.round(Math.max(0, Math.min(1, Number(window.progress) || 0)) * SMELT_TICKS),
            observedAt: Date.now()
        };
        return this.snapshot;
    }
    async withWindow(place, action) {
        const block = await this.obtain(place);
        if (!block || this.bot.interrupt_code) return false;
        let window;
        const previous = this.bot.smeltingActivity;
        const token = { active: true };
        this.bot.smeltingActivity = token;
        try {
            window = await this.api.open(block);
            await sleep(this.settleMs);
            if (this.bot.interrupt_code) return false;
            this.read(window);
            return await action(window);
        } finally {
            try {
                if (window) {
                    this.read(window);
                    // close() also emits the event that removes Mineflayer's
                    // craft_progress_bar listener. closeWindow() alone does not.
                    if (this.bot.currentWindow === window) await window.close();
                    else window.emit?.('close');
                }
            } finally {
                token.active = false;
                if (this.bot.smeltingActivity === token) this.bot.smeltingActivity = previous;
            }
        }
    }
    async inspect() { return this.withWindow(false, async () => true); }

    async smelt(step) {
        const bot = this.bot, output = step.item, input = smeltingRecipes[output];
        if (!input) throw new Error('Unsupported managed smelting output: ' + output);
        const baseline = countInventoryItem(bot, output);
        const target = baseline + step.count;
        const gained = await this.withWindow(true, async window => {
            furnacePending(this.read(window), output); // Preserve unrelated contents.
            if (window.outputItem()) {
                await window.takeOutput();
                if (bot.interrupt_code || playerCount(bot, window, output) > baseline) return true;
            }
            const remaining = Math.max(0, target - playerCount(bot, window, output));
            if (!remaining) return true;
            // A new smaller target must not keep a larger old input queue.
            if ((window.inputItem()?.count || 0) > remaining) {
                await window.takeInput();
                if (bot.interrupt_code) return false;
            }
            const queued = window.inputItem()?.count || 0;
            const batch = Math.min(8, remaining);
            const add = Math.max(0, batch - queued);
            if (add) {
                const amount = Math.min(add, playerCount(bot, window, input));
                if (!amount) throw new Error('Missing ' + input + '; furnace inspected, replan from live supplies.');
                await window.putInput(bot.registry.itemsByName[input].id, null, amount);
                if (bot.interrupt_code) return false;
            }
            const deadline = Date.now() + this.waitMs;
            while (!bot.interrupt_code && Date.now() < deadline) {
                const state = this.read(window);
                furnacePending(state, output);
                if (window.outputItem()) {
                    await window.takeOutput();
                    return playerCount(bot, window, output) > baseline;
                }
                const energy = furnaceEnergy(state, state.observedAt);
                const shortfall = Math.max(0, Math.min(batch, state.input?.count || 0) * SMELT_TICKS - state.progressTicks - energy);
                // Fuel and cooking bars arrive in separate packets and may be
                // one tick apart. Do not spend another fuel unit on that gap.
                const demand = energy > 0 && shortfall <= 2 ? 0 : shortfall;
                if (demand > 0) {
                    const slot = state.fuel;
                    const fuel = playerItems(bot, window).filter(i => fuelTicks(i.name) > 0 && i.name !== output &&
                        (!slot || slot.name === i.name)).sort((a, b) => fuelTicks(b.name) - fuelTicks(a.name))[0];
                    if (fuel) {
                        const units = Math.min(fuel.count, Math.ceil(demand / fuelTicks(fuel.name)), 64 - (slot?.count || 0));
                        if (units > 0) {
                            await window.putFuel(fuel.type, null, units);
                            this.api.log?.(`Added ${units} ${fuel.name}; furnace input/output will be verified.`);
                        }
                    } else if (furnaceEnergy(state, state.observedAt) < SMELT_TICKS - state.progressTicks) {
                        throw new Error('Insufficient compatible furnace fuel; retain contents and replan or supply fuel before !resumeGoal.');
                    }
                }
                await sleep(this.pollMs);
            }
            if (!bot.interrupt_code) throw new Error('Furnace produced no verified output within the smelting deadline; contents and goal retained.');
            return false;
        });
        // Closing the window synchronizes player inventory in native 26.3.
        return gained && countInventoryItem(bot, output) > baseline;
    }
}
