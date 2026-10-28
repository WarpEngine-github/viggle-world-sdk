import { Mat4, Vec3 } from 'playcanvas';

import type { Skeleton } from './skeleton';

/**
 * Per-axis scale for a single bone, in a frame aligned to the bone:
 *  - `along`     - scale down the bone's own axis (lengthen / shorten),
 *  - `width` / `thickness` - scale across the bone (the two cross-section axes;
 *    their world orientation is bone-dependent, so treat them as "the two
 *    perpendicular directions" rather than a fixed front/side).
 *
 * Each defaults to `1`. A bare `number` is shorthand for a uniform scale on all
 * three axes.
 *
 * @group Characters & Animation
 */
export interface BoneScale {
  along: number;
  width: number;
  thickness: number;
}

/** A bone scale, or a number meaning uniform scale on all three axes. */
export type BoneScaleInput = Partial<BoneScale> | number;

/**
 * Per-bone data that realizes a set of bone scales. Produced by
 * {@link computeBoneStretch}, consumed by {@link Skeleton} (lengthening) and
 * {@link SplatSkinning} (flesh/covariance stretch).
 *
 * @group Characters & Animation
 */
export interface BoneStretch {
  /**
   * Per-bone multiplier on the local rest translation. A bone's local
   * translation is its offset from its parent (the parent segment's vector),
   * so scaling it lengthens that segment by the parent's `along` factor.
   * Translation-only → never inflates covariance, never compounds down a
   * chain. Indexed by bone; `1` = unchanged.
   */
  lengthScale: Float32Array;
  /**
   * Per-bone local stretch matrix (`F·diag(along,width,thickness)·Fᵀ` in the
   * bone-aligned frame `F`), folded into the skinning palette so the bone's
   * Gaussians scale on all three axes and their covariances follow. Identity
   * for unscaled bones. Indexed by bone.
   */
  covStretch: Mat4[];
  /** True when at least one bone is actually scaled. */
  any: boolean;
}

const IDENT: BoneScale = { along: 1, width: 1, thickness: 1 };

function normalize(v: BoneScaleInput): BoneScale {
  if (typeof v === 'number') return { along: v, width: v, thickness: v };
  return {
    along: v.along ?? 1,
    width: v.width ?? 1,
    thickness: v.thickness ?? 1,
  };
}

function isIdentity(s: BoneScale): boolean {
  return s.along === 1 && s.width === 1 && s.thickness === 1;
}

/**
 * Translate a map of per-bone scales into the {@link BoneStretch} arrays.
 * `factors[boneName]` scales that bone's flesh + segment (e.g.
 * `{ thigh_l: { along: 1.3 }, calf_l: { along: 1.3 } }` → a 1.3× longer left
 * leg; `{ upperarm_l: { width: 1.4, thickness: 1.4 } }` → a beefier arm).
 * Bones not listed stay at `1`.
 *
 * Correct for arbitrary bone sets (limbs, spine, …) with no boundary
 * compensation: lengthening lives in per-segment translations (no cumulative
 * scale), and the flesh scale is per-bone in the palette (non-propagating).
 * Each bone scales in ITS OWN frame, so bones at any orientation scale
 * correctly.
 *
 * @param skeleton  Rig to read the rest pose / hierarchy from.
 * @param boneNames Bone names in index order (from the armature).
 * @param factors   Per-bone scales keyed by bone name.
 */
export function computeBoneStretch(
  skeleton: Skeleton,
  boneNames: readonly string[],
  factors: Record<string, BoneScaleInput>,
): BoneStretch {
  const n = skeleton.numBones;
  const parents = skeleton.parents;
  const restT = skeleton.restPose.positions; // local rest translations (per bone)

  const scaleOf: BoneScale[] = Array.from({ length: n }, () => IDENT);
  let any = false;
  for (const name in factors) {
    const s = normalize(factors[name]);
    if (isIdentity(s)) continue;
    const idx = boneNames.indexOf(name);
    if (idx >= 0) {
      scaleOf[idx] = s;
      any = true;
    }
  }

  const children = buildChildren(parents, n);

  // Lengthening: a parent's `along` scale lengthens the offsets of its children.
  const lengthScale = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const p = parents[i];
    if (p >= 0 && p < n) lengthScale[i] = scaleOf[p].along;
  }

  // Flesh stretch: per-bone 3-axis scale in a frame aligned to the bone.
  const covStretch: Mat4[] = Array.from({ length: n }, () => new Mat4());
  const e0 = new Vec3();
  const e1 = new Vec3();
  const e2 = new Vec3();
  for (let b = 0; b < n; b++) {
    const s = scaleOf[b];
    if (isIdentity(s)) continue;
    if (!boneAxis(b, children, scaleOf, restT, e0)) continue; // no axis → skip
    perpendicularFrame(e0, e1, e2);
    setFrameScale(covStretch[b], e0, e1, e2, s);
  }

  return { lengthScale, covStretch, any };
}

function buildChildren(parents: Int32Array, n: number): number[][] {
  const children: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const p = parents[i];
    if (p >= 0 && p < n) children[p].push(i);
  }
  return children;
}

/**
 * Write the bone's local axis (the "along" direction) into `out`. A bone spans
 * from its joint to its child's, so the axis is the (primary) child's offset;
 * for a leaf bone, fall back to the bone's own offset from its parent. Returns
 * false if neither yields a usable direction.
 */
function boneAxis(
  b: number,
  children: number[][],
  scaleOf: BoneScale[],
  restT: { x: number; y: number; z: number }[],
  out: Vec3,
): boolean {
  const child = primaryChild(b, children, scaleOf, restT);
  const off = child >= 0 ? restT[child] : restT[b];
  out.set(off.x, off.y, off.z);
  if (out.length() < 1e-6) return false;
  out.normalize();
  return true;
}

/**
 * Pick the child that defines a bone's axis. Single-child bones are
 * unambiguous; for a branch (e.g. the top spine bone, parent of both clavicles
 * and the neck) prefer a scaled child (the region's continuation), else the
 * child with the longest offset.
 */
function primaryChild(
  b: number,
  children: number[][],
  scaleOf: BoneScale[],
  restT: { x: number; y: number; z: number }[],
): number {
  const kids = children[b];
  if (kids.length === 0) return -1;
  if (kids.length === 1) return kids[0];
  let best = -1;
  let bestLen = -1;
  for (const c of kids) {
    if (!isIdentity(scaleOf[c])) return c;
    const o = restT[c];
    const len = o.x * o.x + o.y * o.y + o.z * o.z;
    if (len > bestLen) {
      bestLen = len;
      best = c;
    }
  }
  return best;
}

/** Complete `e0` to an orthonormal basis (e1, e2) with a stable seed choice. */
function perpendicularFrame(e0: Vec3, e1: Vec3, e2: Vec3): void {
  // Seed with whichever cardinal axis is least parallel to e0, then Gram-Schmidt.
  if (Math.abs(e0.x) <= Math.abs(e0.y) && Math.abs(e0.x) <= Math.abs(e0.z)) {
    e1.set(1, 0, 0);
  } else if (Math.abs(e0.y) <= Math.abs(e0.z)) {
    e1.set(0, 1, 0);
  } else {
    e1.set(0, 0, 1);
  }
  const d = e1.dot(e0);
  e1.set(e1.x - d * e0.x, e1.y - d * e0.y, e1.z - d * e0.z).normalize();
  e2.cross(e0, e1); // already unit (e0, e1 orthonormal)
}

/** In-place: m's 3×3 = F·diag(along,width,thickness)·Fᵀ, F = [e0 e1 e2]. */
function setFrameScale(
  m: Mat4,
  e0: Vec3,
  e1: Vec3,
  e2: Vec3,
  s: BoneScale,
): void {
  const { along: a, width: w, thickness: t } = s;
  const d = m.data; // identity to start (column-major; the matrix is symmetric)
  for (let i = 0; i < 3; i++) {
    const c0 = i === 0 ? e0.x : i === 1 ? e0.y : e0.z;
    const c1 = i === 0 ? e1.x : i === 1 ? e1.y : e1.z;
    const c2 = i === 0 ? e2.x : i === 1 ? e2.y : e2.z;
    for (let j = 0; j < 3; j++) {
      const r0 = j === 0 ? e0.x : j === 1 ? e0.y : e0.z;
      const r1 = j === 0 ? e1.x : j === 1 ? e1.y : e1.z;
      const r2 = j === 0 ? e2.x : j === 1 ? e2.y : e2.z;
      d[i * 4 + j] = a * c0 * r0 + w * c1 * r1 + t * c2 * r2;
    }
  }
}
