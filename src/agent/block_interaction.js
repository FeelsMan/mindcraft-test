import Vec3 from 'vec3';

// Measure from the player's eyes to real block faces. Comparing the player's
// feet to a point above the target incorrectly rejects overhead blocks.
export function blockFaceReachable(bot, position, feet, reach = 4) {
    if (!bot.world?.raycast) return false;
    const p = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    const block = bot.blockAt(p);
    if (!block?.shapes?.length) return false;
    const eye = new Vec3(feet.x + 0.5, feet.y + 1.6, feet.z + 0.5);
    for (const [x0, y0, z0, x1, y1, z1] of block.shapes) {
        const x = (x0 + x1) / 2, y = (y0 + y1) / 2, z = (z0 + z1) / 2;
        for (const [dx, dy, dz] of [[x0, y, z], [x1, y, z], [x, y0, z],
            [x, y1, z], [x, y, z0], [x, y, z1]]) {
            const delta = p.offset(dx, dy, dz).minus(eye), length = delta.norm();
            if (length <= 0 || length > reach) continue;
            const hit = bot.world.raycast(eye, delta.scaled(1 / length), Math.min(reach, length + 0.0001));
            if (hit?.position?.equals(p)) return true;
        }
    }
    return false;
}
