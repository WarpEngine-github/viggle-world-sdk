/**
 * The pure half of reading an environment for its proxy: which slices of an
 * LOD bundle make up one level, and the world-space crop. No PlayCanvas and no
 * I/O, so it runs under `node --test`. `environment-source.ts` is the half
 * that touches assets.
 *
 * Internal.
 */

import type { ProxyMeshInput } from './voxelizer';

/** One node's run of gaussians inside one chunk file, at one LOD level. */
export interface LodSlice {
  fileIndex: number;
  offset: number;
  count: number;
}

/** The subset of PlayCanvas's `GSplatOctree` the proxy reads. */
export interface OctreeLike {
  lodLevels: number;
  files: { url: string }[];
  nodes: { lods: { fileIndex: number; offset: number; count: number }[] }[];
}

/**
 * Every node's slice at `level`. A node with no data at that level (the
 * manifest writes `fileIndex -1`) contributes nothing. Pure.
 */
export function lodSlices(octree: OctreeLike, level: number): LodSlice[] {
  const out: LodSlice[] = [];
  for (const node of octree.nodes) {
    const lod = node.lods[level];
    if (!lod || lod.fileIndex < 0 || lod.count <= 0) continue;
    out.push({ fileIndex: lod.fileIndex, offset: lod.offset, count: lod.count });
  }
  return out;
}

/**
 * Resolve a requested level against a bundle: `'coarsest'` is the last level
 * (and so is the first level `'auto'` tries), a number is clamped into range.
 * Pure.
 */
export function resolveLodLevel(requested: number | 'coarsest' | 'auto', lodLevels: number): number {
  const last = Math.max(0, lodLevels - 1);
  // `auto` starts where `coarsest` does and walks finer from there.
  if (requested === 'coarsest' || requested === 'auto') return last;
  return Math.min(last, Math.max(0, Math.round(requested)));
}

/**
 * Keep only the splats whose WORLD position is inside `[min, max]`, given the
 * local-to-world matrix of the node the positions are local to. Returns the
 * input itself when nothing is dropped. Pure.
 *
 * Why a crop exists at all: the voxelizer sizes one dense grid to the bounds of
 * everything it is given, and a capture's bounds are set by its floaters, not
 * its floor. A room whose walls span 6 m can carry wisps 20 m out, and the
 * grid ceiling then coarsens the whole room to fit them.
 */
export function cropInputToWorldBox(
  input: ProxyMeshInput,
  localToWorld: ArrayLike<number>,
  min: { x: number; y: number; z: number },
  max: { x: number; y: number; z: number },
): ProxyMeshInput {
  const p = input.positions;
  const n = Math.floor(p.length / 3);
  const m = localToWorld;
  const keep = new Uint8Array(n);
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    // Column-major, the layout of PlayCanvas's `Mat4.data`.
    const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (wx < min.x || wy < min.y || wz < min.z || wx > max.x || wy > max.y || wz > max.z) continue;
    keep[i] = 1;
    kept++;
  }
  if (kept === n) return input;

  const positions = new Float32Array(kept * 3);
  const opacities = input.opacities ? new Float32Array(kept) : undefined;
  let w = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    positions[w * 3] = p[i * 3];
    positions[w * 3 + 1] = p[i * 3 + 1];
    positions[w * 3 + 2] = p[i * 3 + 2];
    if (opacities) opacities[w] = input.opacities![i];
    w++;
  }
  return { positions, opacities };
}

/**
 * Distinct voxels of edge `voxelSize` that at least one splat at or above
 * `opacityThreshold` lands in - before any dilation. Pure.
 *
 * Divided into the splat count it is the density {@link AUTO_LOD_SPLATS_PER_VOXEL}
 * judges an LOD level by.
 */
export function occupiedVoxelCount(input: ProxyMeshInput, voxelSize: number, opacityThreshold: number): number {
  const p = input.positions;
  const a = input.opacities;
  const n = Math.floor(p.length / 3);
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  for (let i = 0; i < n; i++) {
    if (a && a[i] < opacityThreshold) continue;
    if (p[i * 3] < mnx) mnx = p[i * 3];
    if (p[i * 3 + 1] < mny) mny = p[i * 3 + 1];
    if (p[i * 3 + 2] < mnz) mnz = p[i * 3 + 2];
  }
  // 2^17 cells an axis keeps the packed key an exact integer in a double;
  // anything past it wraps, which only ever undercounts a pathological grid.
  const K = 1 << 17;
  const inv = 1 / voxelSize;
  const cells = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (a && a[i] < opacityThreshold) continue;
    const x = Math.floor((p[i * 3] - mnx) * inv) % K;
    const y = Math.floor((p[i * 3 + 1] - mny) * inv) % K;
    const z = Math.floor((p[i * 3 + 2] - mnz) * inv) % K;
    cells.add((z * K + y) * K + x);
  }
  return cells.size;
}

/**
 * The density below which an LOD level is too sparse to voxelize at a given
 * voxel size: fewer opaque splats than this per occupied voxel, and the shell
 * has pinholes a shadow falls through.
 *
 * Measured on PlayCanvas's `playbot` bundle (7 levels, 465k opaque splats at
 * level 0), as the share of the finest level's splats a level's dilated
 * voxels still hold: 3.08 splats a voxel covered 99.9%, 1.41 covered 98.6%,
 * 1.09 and 1.05 fell to 87% and 70%. Three sits past the knee with margin for
 * captures sparser than a scanned prop; at 0.1 m it picks that bundle's
 * coarsest level, at 0.03 m its level 3.
 */
export const AUTO_LOD_SPLATS_PER_VOXEL = 3;

/** Whether `input` is dense enough to voxelize at `voxelSize`. See {@link AUTO_LOD_SPLATS_PER_VOXEL}. */
export function denseEnough(input: ProxyMeshInput, voxelSize: number, opacityThreshold: number): boolean {
  const a = input.opacities;
  const n = Math.floor(input.positions.length / 3);
  let opaque = 0;
  for (let i = 0; i < n; i++) if (!a || a[i] >= opacityThreshold) opaque++;
  const occupied = occupiedVoxelCount(input, voxelSize, opacityThreshold);
  return occupied === 0 || opaque >= AUTO_LOD_SPLATS_PER_VOXEL * occupied;
}
