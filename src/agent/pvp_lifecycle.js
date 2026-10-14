// mineflayer-pvp.stop() clears its target before its asynchronous path cleanup
// finishes. Later callers must await that same cleanup, rather than returning
// early and allowing it to clear a new owner's path several seconds later.
export function serializePvpStop(pvp) {
    if (!pvp || pvp.miaStopSerialized) return;
    const stop = pvp.stop.bind(pvp);
    let pending = null;
    pvp.stop = () => {
        if (pending) return pending;
        const current = Promise.resolve(stop()).finally(() => {
            if (pending === current) pending = null;
        });
        pending = current;
        return current;
    };
    pvp.miaStopSerialized = true;
}
