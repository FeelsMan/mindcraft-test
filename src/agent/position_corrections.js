const position = p => p && [p.x, p.y, p.z].every(Number.isFinite) ? { x: p.x, y: p.y, z: p.z } : null;
const dimension = bot => String(bot.game?.dimension ?? 'unknown');
const equal = (a, b) => a && b && a.x === b.x && a.y === b.y && a.z === b.z;

// Mineflayer emits forcedMove for ordinary server corrections as well as
// teleports. Its native reply emits move(oldPosition) immediately beforehand.
// Keep that pre-reply position: reading only the current position loses the
// displacement and can either restart forever or miss a real teleport.
export function observePositionCorrections(bot, callback) {
    let current = position(bot.entity?.position), previous = current, scope = dimension(bot), movedAt = 0;
    const moved = old => {
        previous = position(old) || current;
        current = position(bot.entity?.position);
        movedAt = Date.now();
    };
    const forced = () => {
        const next = position(bot.entity?.position), nextScope = dimension(bot);
        const from = equal(next, current) && Date.now() - movedAt <= 100 ? previous : current;
        const distance = from && next ? Math.hypot(next.x - from.x, next.y - from.y, next.z - from.z) : Infinity;
        const relocated = nextScope !== scope || distance > 1;
        scope = nextScope; previous = current = next; movedAt = 0;
        callback({ relocated, distance, position: next });
    };
    bot.on?.('move', moved); bot.on?.('forcedMove', forced);
    return () => { bot.removeListener?.('move', moved); bot.removeListener?.('forcedMove', forced); };
}
