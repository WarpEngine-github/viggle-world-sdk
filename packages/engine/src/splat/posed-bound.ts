/**
 * A posed character's bounds without skinning every splat.
 *
 * A CPU-skinned center is a weighted average of `bone * rest` over its
 * influences, so it lies inside the union of each influencing bone's
 * transformed box of rest centers. Baking those per-bone boxes once makes a
 * conservative posed bound O(bones) instead of O(splats).
 */

/** Same cut-offs as `Splat.updatePositions`. */
const MIN_WEIGHT = 0.001;
const STRIDE = 11;

/**
 * Per-bone min/max of the rest centers each bone moves, from the packed
 * `[x, y, z, w0, b0, ... w3, b3]` influences. 6 floats per slot; the last slot
 * holds the centers the skin leaves at rest (no usable weight).
 */
export function bakeBoneBoxes(packed: Float32Array, numSplats: number): Float32Array {
  let maxBone = -1;
  for (let i = 0, base = 0; i < numSplats; i++, base += STRIDE) {
    for (let k = 0; k < 4; k++) {
      if (packed[base + 3 + k * 2] >= MIN_WEIGHT) maxBone = Math.max(maxBone, packed[base + 4 + k * 2] | 0);
    }
  }
  const slots = maxBone + 2;
  const boxes = new Float32Array(slots * 6);
  for (let s = 0; s < slots; s++) boxes.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], s * 6);
  const add = (s: number, x: number, y: number, z: number) => {
    const o = s * 6;
    if (x < boxes[o]) boxes[o] = x;
    if (y < boxes[o + 1]) boxes[o + 1] = y;
    if (z < boxes[o + 2]) boxes[o + 2] = z;
    if (x > boxes[o + 3]) boxes[o + 3] = x;
    if (y > boxes[o + 4]) boxes[o + 4] = y;
    if (z > boxes[o + 5]) boxes[o + 5] = z;
  };
  for (let i = 0, base = 0; i < numSplats; i++, base += STRIDE) {
    const x = packed[base], y = packed[base + 1], z = packed[base + 2];
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const w = packed[base + 3 + k * 2];
      if (w < MIN_WEIGHT) continue;
      add(packed[base + 4 + k * 2] | 0, x, y, z);
      total += w;
    }
    if (total <= MIN_WEIGHT) add(slots - 1, x, y, z);
  }
  return boxes;
}

/**
 * Bound of every skinned center for `bones` (column-major 4x4s, as
 * `Mat4.data`) into `out` = [minX, minY, minZ, maxX, maxY, maxZ]. A bone
 * missing from `bones` is skipped by the skin, so its splats may stay at rest:
 * its box is taken untransformed.
 */
export function posedBound(boxes: Float32Array, bones: ArrayLike<{ data: ArrayLike<number> }>, out: Float32Array): void {
  out[0] = out[1] = out[2] = Infinity;
  out[3] = out[4] = out[5] = -Infinity;
  const slots = boxes.length / 6;
  for (let s = 0; s < slots; s++) {
    const o = s * 6;
    if (!(boxes[o] <= boxes[o + 3])) continue;
    const cx = (boxes[o] + boxes[o + 3]) / 2, cy = (boxes[o + 1] + boxes[o + 4]) / 2, cz = (boxes[o + 2] + boxes[o + 5]) / 2;
    const ex = (boxes[o + 3] - boxes[o]) / 2, ey = (boxes[o + 4] - boxes[o + 1]) / 2, ez = (boxes[o + 5] - boxes[o + 2]) / 2;
    let px = cx, py = cy, pz = cz, hx = ex, hy = ey, hz = ez;
    if (s < slots - 1 && s < bones.length) {
      const m = bones[s].data;
      px = cx * m[0] + cy * m[4] + cz * m[8] + m[12];
      py = cx * m[1] + cy * m[5] + cz * m[9] + m[13];
      pz = cx * m[2] + cy * m[6] + cz * m[10] + m[14];
      hx = Math.abs(m[0]) * ex + Math.abs(m[4]) * ey + Math.abs(m[8]) * ez;
      hy = Math.abs(m[1]) * ex + Math.abs(m[5]) * ey + Math.abs(m[9]) * ez;
      hz = Math.abs(m[2]) * ex + Math.abs(m[6]) * ey + Math.abs(m[10]) * ez;
    }
    if (px - hx < out[0]) out[0] = px - hx;
    if (py - hy < out[1]) out[1] = py - hy;
    if (pz - hz < out[2]) out[2] = pz - hz;
    if (px + hx > out[3]) out[3] = px + hx;
    if (py + hy > out[4]) out[4] = py + hy;
    if (pz + hz > out[5]) out[5] = pz + hz;
  }
}
