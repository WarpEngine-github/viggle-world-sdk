/**
 * The environment reveal's per-splat bake: radial distance from the capture
 * point, normalised to 0..1. Pure, so it runs without a GPU.
 *
 * A Flow2D capture is reconstructed OUTWARD from one point, and that point is
 * the entity-local origin, so radius is the order the room was built in: the
 * near floor and the surfaces either side of the camera resolve first, the far
 * wall last. The character's bake walks a bone chain instead
 * (`bakeRevealDistances`) because a body has a path through it; a room
 * has a centre.
 */

/**
 * Share of the distances the sweep is scaled to - see
 * {@link envRevealRadius}.
 */
export const ENV_REVEAL_PERCENTILE = 0.98;

/**
 * Most distances {@link envRevealRadius} estimates its percentile from. A
 * percentile is a rank, and a rank converges on a few tens of thousands of
 * samples: sorting four million of them to move the answer by less than a
 * centimetre would cost a visible hitch on the frame the scene lands.
 */
const PERCENTILE_SAMPLE = 1 << 16;

/**
 * The radius the sweep is normalised against: the
 * {@link ENV_REVEAL_PERCENTILE} distance from the local origin, estimated from
 * a strided sample. `0` when there is nothing to measure.
 *
 * NOT the maximum. Every capture we see carries a handful of floaters - a
 * reconstruction artefact flung out past the room, sometimes a hundred times
 * its radius - and normalising against those puts the entire room inside the
 * first percent of the sweep, so the reveal is over before it is visible and
 * then spends the rest of its time crossing empty space. This is the same trap
 * `computeEnvPointStats` takes a p95 to avoid when it sizes a camera.
 *
 * Why so high a percentile when that one takes 0.95: a clip plane that cuts
 * five percent of a cloud is invisible, but this number decides WHEN real
 * geometry appears, and a Flow2D room keeps a large share of its splats in the
 * outer shell that is its walls. Cutting at p95 would bunch metres of real
 * wall into the sweep's last instant. p98 is still past any floater count we
 * have measured and leaves the far wall inside the sweep.
 */
export function envRevealRadius(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  z: ArrayLike<number>,
  numSplats: number,
  percentile = ENV_REVEAL_PERCENTILE,
): number {
  if (numSplats <= 0) return 0;
  const stride = Math.max(1, Math.ceil(numSplats / PERCENTILE_SAMPLE));
  const m = Math.floor((numSplats + stride - 1) / stride);
  const sample = new Float32Array(m);
  for (let i = 0, k = 0; i < m; i++, k += stride) {
    sample[i] = Math.sqrt(x[k] * x[k] + y[k] * y[k] + z[k] * z[k]);
  }
  sample.sort();
  const at = Math.min(m - 1, Math.max(0, Math.round((m - 1) * percentile)));
  return sample[at];
}

/**
 * Write each splat's normalised radial distance - 0 at the capture point, 1 at
 * {@link envRevealRadius} and beyond - into `out`, which must hold at least
 * `numSplats` entries in the same order the shader indexes them.
 *
 * Returns false, leaving `out` untouched, when the cloud has no radius to
 * normalise against (no splats, or every splat sitting on the origin). The
 * caller's allocation is pre-filled with 1, so a refusal leaves the scene
 * hidden until the reveal completes rather than showing garbage.
 */
export function bakeEnvRevealDistances(
  out: Float32Array,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  z: ArrayLike<number>,
  numSplats: number,
  radius = envRevealRadius(x, y, z, numSplats),
): boolean {
  if (!(radius > 0) || !Number.isFinite(radius)) return false;
  const inv = 1 / radius;
  const n = Math.min(numSplats, out.length);
  for (let i = 0; i < n; i++) {
    // Not Math.hypot: several times slower in V8, and this runs once per splat.
    const d = Math.sqrt(x[i] * x[i] + y[i] * y[i] + z[i] * z[i]) * inv;
    out[i] = d > 1 ? 1 : d;
  }
  return true;
}
