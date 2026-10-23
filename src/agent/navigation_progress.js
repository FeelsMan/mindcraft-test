const finite = p => p && [p.x, p.y, p.z].every(Number.isFinite);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const copy = p => ({ x: p.x, y: p.y, z: p.z });
const cell = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

// Motion and useful progress are different. In particular, a new path event
// is not progress, and repeatedly reaching the same waypoint earns no credit.
// New waypoints let legitimate detours get farther from the destination.
export class NavigationProgress {
    constructor(position, remaining, { now = Date.now(), stallMs = 2500, progressMs = 5000 } = {}) {
        this.motionPosition = copy(position);
        this.lastMotion = this.lastProgress = now;
        this.bestRemaining = Number.isFinite(remaining) ? remaining : Infinity;
        this.stallMs = stallMs; this.progressMs = progressMs;
        this.route = []; this.cursor = 0; this.visited = new Set([cell(position)]);
        this.workSeen = new Set(); this.work = null;
    }

    setPath(path) {
        // Pathfinder mutates/shifts its path after emitting it. Keep a bounded
        // snapshot, using cell centers for both raw and postprocessed nodes.
        this.route = (Array.isArray(path) ? path : []).slice(0, 512).filter(finite)
            .map(p => ({ x: Math.floor(p.x) + 0.5, y: p.y, z: Math.floor(p.z) + 0.5 }));
        this.cursor = 0;
    }

    observe(position, remaining, now = Date.now(), work = null) {
        if (!finite(position)) return 'invalid_position';
        if (this.work && (this.work.key !== work?.key || now >= this.work.until)) {
            const elapsed = Math.max(0, Math.min(now, this.work.until) - this.work.started);
            this.lastMotion = Math.min(now, this.lastMotion + elapsed);
            this.lastProgress = Math.min(now, this.lastProgress + elapsed);
            this.work = null;
        }
        // An actual dig may take longer than a walking stall. Grant one finite
        // allowance per block/state; restarting that dig cannot renew it.
        if (work && !this.workSeen.has(work.key) && this.workSeen.size < 256) {
            this.workSeen.add(work.key);
            this.work = { key: work.key, started: now, until: now + Math.max(0, Math.min(45000, work.duration)) };
        }
        if (distance(position, this.motionPosition) >= 0.2) {
            this.motionPosition = copy(position); this.lastMotion = now;
        }
        let useful = false;
        if (Number.isFinite(remaining) && this.bestRemaining - remaining >= 0.5) {
            this.bestRemaining = remaining; useful = true;
        }
        // Look ahead a few nodes to allow skipped physics samples and the
        // pathfinder's own shortcuts. Only physical arrival earns credit.
        for (let i = this.cursor; i < Math.min(this.route.length, this.cursor + 8); i++) {
            const p = this.route[i];
            if (distance(position, p) > 0.75) continue;
            const key = cell(p);
            if (!this.visited.has(key) && this.visited.size < 2048) { this.visited.add(key); useful = true; }
            this.cursor = i + 1;
            break;
        }
        if (useful) this.lastProgress = now;
        if (this.work) return null;
        if (now - this.lastMotion >= this.stallMs) return 'physical_stall';
        if (now - this.lastProgress >= this.progressMs) return 'no_progress';
        return null;
    }
}
