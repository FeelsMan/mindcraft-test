// Fresh, portable observations. This is a view, never a second memory store.
export function readWorldState(adapter, clock = Date.now) {
    const observed = adapter.observe();
    return {
        observedAt: clock(), source: 'live',
        scope: { ...observed.scope },
        available: observed.available !== false,
        recovering: Boolean(observed.recovering),
        health: Number.isFinite(observed.health) ? observed.health : null,
        hunger: Number.isFinite(observed.hunger) ? observed.hunger : null,
        position: observed.position ? { ...observed.position } : null,
        inventory: observed.inventory == null ? null : { ...observed.inventory },
        interruptions: [...(observed.interruptions || [])],
        action: { ...observed.action }
    };
}

export function sameScope(a, b) {
    return a.environment === b.environment && a.world === b.world && a.dimension === b.dimension;
}
