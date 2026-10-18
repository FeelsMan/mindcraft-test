import Vec3 from 'vec3';

// A versioned, fixed blueprint. Persist coordinates, never executable build code.
export function shelterRecord(value) {
    const p = value?.origin;
    if (value?.version !== 1 || !p || ![p.x, p.y, p.z].every(Number.isSafeInteger) ||
        Math.abs(p.x) > 29999980 || Math.abs(p.z) > 29999980 || p.y < -63 || p.y > 316) return null;
    return { version: 1, origin: { x: p.x, y: p.y, z: p.z } };
}

export function knownShelter(bot) {
    const cached = bot.shelterSite;
    return shelterRecord(cached?.dimension === String(bot.game?.dimension ?? 'unknown') ? cached.record : bot.localMemory?.shelter?.());
}

export function shelterBlueprint(record) {
    const valid = shelterRecord(record);
    if (!valid) throw new Error('Invalid saved shelter blueprint; no construction started.');
    const { x, y, z } = valid.origin, origin = new Vec3(x, y, z), blocks = [];
    // Permanent outside access steps provide one-block rises to the roof and
    // back down. They fit in the work ring and remain useful after building.
    for (const [dx, dy, dz] of [[-1, 0, -1], [-1, 0, 0], [-1, 1, 0]])
        blocks.push({ item: 'oak_planks', position: origin.offset(dx, dy, dz) });
    for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 5; dz++) for (let dx = 0; dx < 5; dx++) {
        if (dx !== 0 && dx !== 4 && dz !== 0 && dz !== 4) continue;
        if (dx === 2 && dz === 0) continue; // Two-block doorway stays open until the roof is finished.
        blocks.push({ item: 'oak_planks', position: origin.offset(dx, dy, dz) });
    }
    const roof = [];
    for (let dz = 0; dz < 5; dz++) for (let dx = 0; dx < 5; dx++)
        roof.push({ item: 'oak_planks', position: origin.offset(dx, 2, dz), edge: Math.min(dx, dz, 4 - dx, 4 - dz) });
    roof.sort((a, b) => a.edge - b.edge); // Supported rim, then inward; never a floating first roof block.
    blocks.push(...roof.map(({ item, position }) => ({ item, position })));
    return { record: valid, origin, blocks, door: origin.offset(2, 0, 0),
        inside: origin.offset(2, 0, 2), outside: origin.offset(2, 0, -1) };
}
