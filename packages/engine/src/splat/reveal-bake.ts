/**
 * The reveal's per-splat bake: a continuous feet-to-head coordinate along the
 * skeleton, so the front of {@link Splat.setReveal} walks up the body rather
 * than sweeping a flat plane. Pure, so it runs without a GPU.
 */

/** Skeleton distances shared by every splat of one character. */
export interface RevealSkeleton {
  /** Bind-pose bone positions, `numBones * 3`. */
  pos: Float32Array;
  /** Distance from the nearest foot; `-1` = off the body graph. */
  chain: Float32Array;
  /** Parents, with deformation helpers flattened out. */
  parents: Int32Array;
}

/**
 * Distances along the body graph, measured from the nearest foot. Pelvis is
 * `pelvisHint` when given, else from the rig's bone names; failing both, the
 * bone nearest `centre`.
 */
export function buildRevealSkeleton(
  pos: Float32Array,
  parents: ArrayLike<number>,
  names: readonly string[],
  centre: { x: number; y: number; z: number },
  pelvisHint = -1,
): RevealSkeleton | null {
  const n = parents.length;
  if (n === 0) return null;

  let pelvis = pelvisHint >= 0 && pelvisHint < n ? pelvisHint : -1;
  const isRevealHelper = (index: number): boolean => {
    const name = names[index]?.toLowerCase() ?? '';
    return name.includes('twist') || name === 'facial_c_facialroot';
  };
  for (let i = 0; pelvis < 0 && i < n && i < names.length; i++) {
    if (names[i]?.toLowerCase().includes('pelvis')) pelvis = i;
  }
  if (pelvis < 0) {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = pos[i * 3] - centre.x;
      const dy = pos[i * 3 + 1] - centre.y;
      const dz = pos[i * 3 + 2] - centre.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; pelvis = i; }
    }
  }

  // Flatten deformation helpers out of the reveal-only hierarchy.
  const revealParents = Int32Array.from(parents);
  for (let i = 0; i < n; i++) {
    let p = revealParents[i];
    while (p >= 0 && p < n && isRevealHelper(p)) p = revealParents[p];
    revealParents[i] = p;
  }
  const children: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    if (isRevealHelper(i)) continue;
    const p = revealParents[i];
    if (p >= 0 && p < n) children[p].push(i);
  }
  const body = new Uint8Array(n);
  body[pelvis] = 1;
  const queue = [pelvis];
  for (let q = 0; q < queue.length; q++) {
    const a = queue[q];
    for (const b of children[a]) {
      if (body[b]) continue;
      body[b] = 1;
      queue.push(b);
    }
  }
  // Measure the body graph from the nearest foot.
  const chain = new Float32Array(n).fill(-1);
  const sources: number[] = [];
  for (let i = 0; i < n && i < names.length; i++) {
    const nm = names[i]?.toLowerCase() ?? '';
    if (body[i] && nm.includes('foot') && !nm.includes('ik')) sources.push(i);
  }
  if (sources.length === 0) {
    // No named feet: the lowest body bone stands in.
    let low = -1;
    let lowY = Infinity;
    for (let i = 0; i < n; i++) {
      if (body[i] && pos[i * 3 + 1] < lowY) { lowY = pos[i * 3 + 1]; low = i; }
    }
    if (low >= 0) sources.push(low);
  }
  if (sources.length > 0) {
    // The rig has only a few hundred bones, so a linear Dijkstra is enough.
    const dist = new Float64Array(n).fill(Infinity);
    const settled = new Uint8Array(n);
    for (const src of sources) dist[src] = 0;
    const relax = (a: number, b: number) => {
      if (!body[b] || settled[b]) return;
      const dx = pos[a * 3] - pos[b * 3];
      const dy = pos[a * 3 + 1] - pos[b * 3 + 1];
      const dz = pos[a * 3 + 2] - pos[b * 3 + 2];
      const nd = dist[a] + Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (nd < dist[b]) dist[b] = nd;
    };
    for (;;) {
      let a = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!settled[i] && dist[i] < best) { best = dist[i]; a = i; }
      }
      if (a < 0) break;
      settled[a] = 1;
      const p = revealParents[a];
      if (p >= 0 && p < n) relax(a, p);
      for (const b of children[a]) relax(a, b);
    }
    for (let i = 0; i < n; i++) {
      chain[i] = settled[i] ? dist[i] : -1;
    }
  }
  // Helper influences resolve through their anatomical parent.
  for (let i = 0; i < n && i < names.length; i++) {
    if (isRevealHelper(i)) chain[i] = -1;
  }
  return { pos, chain, parents: revealParents };
}

/** A splat cloud's rest positions and its `k` bone influences per splat. */
export interface RevealSplats {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  z: ArrayLike<number>;
  indices: ArrayLike<number>;
  weights: ArrayLike<number>;
  numSplats: number;
}

/**
 * Write each splat's normalized distance, 0 at the feet and 1 at the far end
 * of the body, into `out`: its position projected onto the nearest bone
 * segment of its influences, interpolated along {@link RevealSkeleton.chain}.
 * Returns false, leaving `out` untouched, when the skeleton has no length.
 *
 * @param boneRemap - Splat bone index to skeleton bone, `-1` when unmapped,
 * or `null` when they already agree.
 */
export function bakeRevealDistances(
  out: Float32Array,
  splats: RevealSplats,
  skeleton: RevealSkeleton,
  boneRemap: ArrayLike<number> | null,
): boolean {
  const { pos: bindPositions, chain: chainDistance, parents } = skeleton;
  const n = chainDistance.length;
  if (n === 0 || bindPositions.length < n * 3 || parents.length < n) return false;
  let maxChain = 0;
  for (let i = 0; i < n; i++) if (chainDistance[i] > maxChain) maxChain = chainDistance[i];
  if (!(maxChain > 0)) return false;

  const { x: rx, y: ry, z: rz, indices, weights, numSplats } = splats;
  const k = Math.floor(indices.length / numSplats);
  const incidentEdges: number[][] = Array.from({ length: n }, () => []);
  const revealBone = (index: number): number => {
    let bone = boneRemap ? boneRemap[index] ?? -1 : index;
    while (bone >= 0 && bone < n && chainDistance[bone] < 0) bone = parents[bone];
    return bone;
  };
  for (let b = 0; b < n; b++) {
    const p = parents[b];
    if (p < 0 || p >= n || chainDistance[p] < 0 || chainDistance[b] < 0) continue;
    incidentEdges[p].push(p, b);
    incidentEdges[b].push(p, b);
  }
  for (let si = 0; si < numSplats; si++) {
    let bestDistanceSq = Infinity;
    let bestPathDistance = maxChain;
    let fallbackPathDistance = maxChain;
    for (let j = 0; j < k; j++) {
      const slot = si * k + j;
      if (weights[slot] <= 0.001) continue;
      const b = revealBone(indices[slot]);
      if (b < 0 || b >= n || chainDistance[b] < 0) continue;
      fallbackPathDistance = Math.min(fallbackPathDistance, chainDistance[b]);
      const edges = incidentEdges[b];
      for (let e = 0; e < edges.length; e += 2) {
        const a = edges[e];
        const c = edges[e + 1];
        const ax = bindPositions[a * 3];
        const ay = bindPositions[a * 3 + 1];
        const az = bindPositions[a * 3 + 2];
        const dx = bindPositions[c * 3] - ax;
        const dy = bindPositions[c * 3 + 1] - ay;
        const dz = bindPositions[c * 3 + 2] - az;
        const lengthSq = dx * dx + dy * dy + dz * dz;
        if (lengthSq <= 1e-8) continue;
        const t = Math.min(1, Math.max(0,
          ((rx[si] - ax) * dx + (ry[si] - ay) * dy + (rz[si] - az) * dz) / lengthSq,
        ));
        const qx = ax + dx * t;
        const qy = ay + dy * t;
        const qz = az + dz * t;
        const ex = rx[si] - qx;
        const ey = ry[si] - qy;
        const ez = rz[si] - qz;
        const distanceSq = ex * ex + ey * ey + ez * ez;
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestPathDistance = chainDistance[a] + (chainDistance[c] - chainDistance[a]) * t;
        }
      }
    }
    out[si] = Math.min(1, Math.max(0,
      (bestDistanceSq < Infinity ? bestPathDistance : fallbackPathDistance) / maxChain,
    ));
  }
  return true;
}
