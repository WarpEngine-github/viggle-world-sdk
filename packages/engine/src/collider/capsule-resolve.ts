/**
 * Capsule push-out against a dense occupancy grid: collide and slide.
 *
 * Ported from PlayCanvas's supersplat-viewer
 * (https://github.com/playcanvas/supersplat-viewer): `resolveIterative` from
 * `src/collision/collision.ts` and `resolveDeepestPenetrationCapsule` from
 * `src/collision/voxel-collision.ts`. Changes from upstream:
 *
 * - reads our dense `Uint8Array` grid instead of their sparse octree;
 * - pushes in X/Z only. The walker's height belongs to the floor probe, so each
 *   voxel is tested against the capsule's horizontal slice at the nearest point
 *   of its axis - their sphere test with the vertical component taken out;
 * - all lengths are in the grid's local units, so the epsilon is per voxel.
 *
 * Copyright (c) 2011-2026 PlayCanvas Ltd.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * @module
 */

/** A dense occupancy grid in local units, `(z * ny + y) * nx + x`. */
export interface PushGrid {
  occ: Uint8Array;
  nx: number;
  ny: number;
  nz: number;
  /** Low corner of cell (0,0,0). */
  gx: number;
  gy: number;
  gz: number;
  /** Cell edge. */
  v: number;
}

/** A horizontal push. */
export interface Push2 {
  x: number;
  z: number;
}

/**
 * A vertical capsule: the axis from `axisLo` to `axisHi` at (x, z), swept by
 * `radius`. Local units.
 */
export interface PushCapsule {
  axisLo: number;
  axisHi: number;
  radius: number;
}

/** Maximum iterations for iterative capsule resolution. Upstream's value. */
export const MAX_RESOLVE_ITERATIONS = 4;

/** Minimum penetration worth resolving, as a fraction of a voxel. */
const PENETRATION_EPSILON_VOXELS = 1e-3;

/**
 * Find the single deepest penetrating voxel for the capsule at (cx, cz), and
 * write the horizontal push that clears it into `out`.
 *
 * @returns true if a penetrating voxel was found.
 */
export function deepestPenetration(
  g: PushGrid,
  cx: number,
  cz: number,
  capsule: PushCapsule,
  out: Push2,
): boolean {
  const { occ, nx, ny, nz, gx, gy, gz, v } = g;
  const { axisLo, axisHi, radius } = capsule;
  const radiusSq = radius * radius;

  // Bounding box of the capsule in voxel indices, clamped to the grid.
  const ixMin = Math.max(0, Math.floor((cx - radius - gx) / v));
  const iyMin = Math.max(0, Math.floor((axisLo - radius - gy) / v));
  const izMin = Math.max(0, Math.floor((cz - radius - gz) / v));
  const ixMax = Math.min(nx - 1, Math.floor((cx + radius - gx) / v));
  const iyMax = Math.min(ny - 1, Math.floor((axisHi + radius - gy) / v));
  const izMax = Math.min(nz - 1, Math.floor((cz + radius - gz) / v));

  let bestPushX = 0;
  let bestPushZ = 0;
  let bestPenetration = v * PENETRATION_EPSILON_VOXELS;
  let found = false;

  for (let iz = izMin; iz <= izMax; iz++) {
    for (let iy = iyMin; iy <= iyMax; iy++) {
      for (let ix = ixMin; ix <= ixMax; ix++) {
        if (!occ[(iz * ny + iy) * nx + ix]) continue;

        const vMinX = gx + ix * v;
        const vMinY = gy + iy * v;
        const vMinZ = gz + iz * v;
        const vMaxX = vMinX + v;
        const vMaxY = vMinY + v;
        const vMaxZ = vMinZ + v;

        // Closest Y on the axis to this voxel.
        let segY: number;
        if (axisHi < vMinY) {
          segY = axisHi;
        } else if (axisLo > vMaxY) {
          segY = axisLo;
        } else {
          segY = Math.max(axisLo, Math.min(axisHi, (vMinY + vMaxY) * 0.5));
        }

        // The capsule's horizontal radius at the voxel's nearest height.
        const dy = segY - Math.max(vMinY, Math.min(segY, vMaxY));
        const sliceSq = radiusSq - dy * dy;
        if (sliceSq <= 0) continue;
        const slice = Math.sqrt(sliceSq);

        const nearX = Math.max(vMinX, Math.min(cx, vMaxX));
        const nearZ = Math.max(vMinZ, Math.min(cz, vMaxZ));
        const dx = cx - nearX;
        const dz = cz - nearZ;
        const distSq = dx * dx + dz * dz;
        if (distSq >= sliceSq) continue;

        let px: number;
        let pz: number;
        let penetration: number;
        if (distSq > 1e-12) {
          // Axis is outside the voxel: push radially outward.
          const dist = Math.sqrt(distSq);
          penetration = slice - dist;
          px = (dx / dist) * penetration;
          pz = (dz / dist) * penetration;
        } else {
          // Axis is inside the voxel: push to the nearest face plus the slice.
          const escapeX = cx - vMinX < vMaxX - cx ? -(cx - vMinX + slice) : vMaxX - cx + slice;
          const escapeZ = cz - vMinZ < vMaxZ - cz ? -(cz - vMinZ + slice) : vMaxZ - cz + slice;
          if (Math.abs(escapeX) <= Math.abs(escapeZ)) {
            px = escapeX; pz = 0; penetration = Math.abs(escapeX);
          } else {
            px = 0; pz = escapeZ; penetration = Math.abs(escapeZ);
          }
        }

        if (penetration > bestPenetration) {
          bestPenetration = penetration;
          bestPushX = px;
          bestPushZ = pz;
          found = true;
        }
      }
    }
  }

  if (found) {
    out.x = bestPushX;
    out.z = bestPushZ;
  }
  return found;
}

/**
 * Iteratively resolve penetrations: push out of the deepest overlap, project
 * each later push against the walls already met so a corner cannot shove the
 * body back into one of them, and accumulate.
 *
 * @returns the resolved position; the input when nothing penetrated.
 */
export function resolveCapsule(g: PushGrid, cx: number, cz: number, capsule: PushCapsule): Push2 {
  const epsilon = g.v * PENETRATION_EPSILON_VOXELS;
  const normals: Push2[] = [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }];
  const scratch: Push2 = { x: 0, z: 0 };
  let resolvedX = cx;
  let resolvedZ = cz;
  let numNormals = 0;

  for (let iter = 0; iter < MAX_RESOLVE_ITERATIONS; iter++) {
    if (!deepestPenetration(g, resolvedX, resolvedZ, capsule, scratch)) break;

    let px = scratch.x;
    let pz = scratch.z;
    for (let i = 0; i < numNormals; i++) {
      const n = normals[i];
      const dot = px * n.x + pz * n.z;
      if (dot < 0) {
        px -= dot * n.x;
        pz -= dot * n.z;
      }
    }

    const len = Math.sqrt(scratch.x * scratch.x + scratch.z * scratch.z);
    if (len > epsilon && numNormals < 3) {
      const n = normals[numNormals];
      n.x = scratch.x / len;
      n.z = scratch.z / len;
      numNormals++;
    }

    resolvedX += px;
    resolvedZ += pz;
  }

  return { x: resolvedX, z: resolvedZ };
}
