import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bakeRevealDistances, buildRevealSkeleton } from './reveal-bake.ts';
import type { RevealSplats } from './reveal-bake.ts';

/**
 * A seven-bone stand-in rig: two feet under the pelvis, a spine, a twist
 * helper and a head hung off the helper. Bone positions are world bind-pose.
 */
const NAMES = ['root', 'pelvis', 'foot_l', 'foot_r', 'spine_01', 'spine_twist_01', 'head'];
const PARENTS = new Int32Array([-1, 0, 1, 1, 1, 4, 5]);
const POS = new Float32Array([
  0, 0, 0, // root
  0, 1, 0, // pelvis
  0.1, 0, 0, // foot_l
  -0.1, 0, 0, // foot_r
  0, 1.5, 0, // spine_01
  0, 1.6, 0, // spine_twist_01
  0, 2, 0, // head
]);
const FOOT_TO_PELVIS = Math.hypot(0.1, 1);
const FOOT_TO_HEAD = FOOT_TO_PELVIS + 1;

function skeleton() {
  const sk = buildRevealSkeleton(POS, PARENTS, NAMES, { x: 0, y: 1, z: 0 });
  assert.ok(sk);
  return sk;
}

/** One splat per point, fully weighted to the matching bone. */
function splats(points: [number, number, number, number][]): RevealSplats {
  const n = points.length;
  const indices = new Uint16Array(n * 4);
  const weights = new Float32Array(n * 4);
  points.forEach(([, , , bone], i) => { indices[i * 4] = bone; weights[i * 4] = 1; });
  return {
    x: points.map((p) => p[0]),
    y: points.map((p) => p[1]),
    z: points.map((p) => p[2]),
    indices,
    weights,
    numSplats: n,
  };
}

describe('buildRevealSkeleton', () => {
  it('measures the body from the nearest foot and drops helpers and off-body bones', () => {
    const { chain, parents } = skeleton();
    assert.equal(chain[2], 0);
    assert.equal(chain[3], 0);
    assert.ok(Math.abs(chain[1] - FOOT_TO_PELVIS) < 1e-5);
    assert.ok(Math.abs(chain[6] - FOOT_TO_HEAD) < 1e-5);
    assert.equal(chain[5], -1, 'the twist helper is off the reveal path');
    assert.equal(chain[0], -1, 'root sits above the pelvis, off the body graph');
    assert.equal(parents[6], 4, 'the head hangs off the spine once the helper is flattened');
  });

  it('takes the pelvis hint over names and the centre', () => {
    // A Mixamo-style rig: no "pelvis", and the bone nearest the centre is the spine.
    const names = ['Hips', 'LeftFoot', 'RightFoot', 'Spine', 'Head'];
    const parents = new Int32Array([-1, 0, 0, 0, 3]);
    const pos = new Float32Array([0, 1, 0, 0.1, 0, 0, -0.1, 0, 0, 0, 1.2, 0, 0, 2, 0]);
    const centre = { x: 0, y: 1.2, z: 0 };
    const guessed = buildRevealSkeleton(pos, parents, names, centre);
    assert.equal(guessed?.chain[1], -1, 'from the spine, the legs are off the body');
    const hinted = buildRevealSkeleton(pos, parents, names, centre, 0);
    assert.equal(hinted?.chain[1], 0);
    assert.ok(Math.abs((hinted?.chain[4] ?? 0) - (Math.hypot(0.1, 1) + 1)) < 1e-5);
  });
});

describe('bakeRevealDistances', () => {
  it('runs 0 at the feet to 1 at the head, along the bones', () => {
    const out = new Float32Array(3);
    const ok = bakeRevealDistances(out, splats([
      [0.1, 0, 0, 2],
      [0, 1.25, 0, 4],
      [0, 2, 0, 6],
    ]), skeleton(), null);
    assert.ok(ok);
    assert.ok(Math.abs(out[0]) < 1e-5);
    assert.ok(Math.abs(out[1] - (FOOT_TO_PELVIS + 0.25) / FOOT_TO_HEAD) < 1e-5);
    assert.ok(Math.abs(out[2] - 1) < 1e-5);
  });

  it('resolves a helper influence through its anatomical parent', () => {
    const out = new Float32Array(2);
    bakeRevealDistances(out, splats([[0, 1.25, 0, 4], [0, 1.25, 0, 5]]), skeleton(), null);
    assert.equal(out[1], out[0]);
  });

  it('maps splat bones through the remap, and parks unmapped splats at the end', () => {
    const out = new Float32Array(2);
    // Splat bone 0 is the armature's head; splat bone 1 has no counterpart.
    bakeRevealDistances(out, splats([[0, 2, 0, 0], [0, 0, 0, 1]]), skeleton(), [6, -1]);
    assert.ok(Math.abs(out[0] - 1) < 1e-5);
    assert.equal(out[1], 1);
  });

  it('leaves the output alone when the skeleton has no length', () => {
    const flat = buildRevealSkeleton(new Float32Array(6), new Int32Array([-1, 0]), ['pelvis', 'foot_l'], { x: 0, y: 0, z: 0 });
    assert.ok(flat);
    const out = new Float32Array([0.5]);
    assert.equal(bakeRevealDistances(out, splats([[0, 0, 0, 1]]), flat, null), false);
    assert.equal(out[0], 0.5);
  });
});
