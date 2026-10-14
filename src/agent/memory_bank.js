export class MemoryBank {
	constructor() {
		this.memory = {};
	}

	rememberPlace(name, x, y, z) {
		this.memory[name] = [x, y, z];
	}

	recallPlace(name) {
		return this.memory[name];
	}

	getJson() {
		return this.memory
	}

	loadJson(json) {
		this.memory = {};
        if (!json || typeof json !== 'object' || Array.isArray(json)) return;
        for (const [name, pos] of Object.entries(json)) {
            if (['__proto__', 'constructor', 'prototype'].includes(name)) continue;
            if (Array.isArray(pos) && pos.length === 3 && pos.every(Number.isFinite))
                this.memory[name] = [...pos];
        }
	}

	getKeys() {
		return Object.keys(this.memory).join(', ')
	}
}