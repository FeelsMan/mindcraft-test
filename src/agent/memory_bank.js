export class MemoryBank {
	constructor() {
		this.memory = {};
		this.sessionPlaces = new Map();
	}

	rememberPlace(name, x, y, z) {
		if (this.worldScoped && !this.agent?.local_memory?.enabled) {
			const dimension = String(this.agent?.bot?.game?.dimension ?? 'unknown');
			this.sessionPlaces.set(dimension + ':' + name, [x, y, z]);
			return;
		}
		if (this.agent?.local_memory?.enabled) {
			this.agent.local_memory.rememberPlace(name, { x, y, z });
			return;
		}
		this.memory[name] = [x, y, z];
	}

	recallPlace(name) {
		if (this.worldScoped && !this.agent?.local_memory?.enabled)
			return this.sessionPlaces.get(String(this.agent?.bot?.game?.dimension ?? 'unknown') + ':' + name);
		if (this.agent?.local_memory?.enabled) {
			const p = this.agent.local_memory.recallPlace(name);
			return p ? [p.x, p.y, p.z] : undefined;
		}
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
		if (this.worldScoped && !this.agent?.local_memory?.enabled) {
			const prefix = String(this.agent?.bot?.game?.dimension ?? 'unknown') + ':';
			return [...this.sessionPlaces.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)).join(', ');
		}
		if (this.agent?.local_memory?.enabled) return this.agent.local_memory.placeNames().join(', ');
		return Object.keys(this.memory).join(', ')
	}
}
