/**
 * Deterministic initial positions.
 *
 * A force layout seeded from a random number generator produces a different
 * galaxy every launch, which destroys spatial memory — and spatial memory is
 * the whole point of "the map is for situating yourself". Seeding from a hash
 * of each node's stable id means the graph is the same place every time,
 * before any positions have been cached.
 *
 * The Python app hashed with blake2b; here it is FNV-1a, which is synchronous
 * (`crypto.subtle` is not) and plenty for a seed. The seeds therefore differ
 * from the Python app's once — positions are persisted, so a migrated layout
 * keeps its places and only never-placed notes land somewhere new.
 */

/** initial disc radius, in graph units */
export const SPREAD = 900.0;

/** 64-bit FNV-1a split into two 32-bit lanes, one for angle, one for radius. */
export function fnv1a(text: string): [number, number] {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a ^= c;
    a = Math.imul(a, 0x01000193) >>> 0;
    b ^= c + i;
    b = Math.imul(b, 0x01000193) >>> 0;
  }
  return [a >>> 0, b >>> 0];
}

/** A stable point on a disc, derived from the node id alone. */
export function seedPosition(nodeId: string): [number, number] {
  const [a, b] = fnv1a(nodeId);
  const theta = ((a & 0xffff) / 0xffff) * 2 * Math.PI;
  // sqrt keeps the distribution uniform over area rather than clumping at the centre.
  const radius = Math.sqrt((b & 0xffff) / 0xffff) * SPREAD;
  return [radius * Math.cos(theta), radius * Math.sin(theta)];
}
