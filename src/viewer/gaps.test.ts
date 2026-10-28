import assert from 'node:assert/strict';
import { test } from 'node:test';

import { yawPitchOf } from '../core/pose.js';
import { gapCandidates, horizontalFov, pickGaps, wallDistances } from './gaps.js';

/** A ring of wall splats at `radius`, from the floor to over head height. */
function roundRoom(radius: number, height: number): Float32Array {
  const out: number[] = [];
  for (let a = 0; a < 360; a += 2) {
    for (let y = -height; y <= height; y += height / 4) {
      const t = (a * Math.PI) / 180;
      out.push(Math.cos(t) * radius, y, Math.sin(t) * radius);
    }
  }
  return Float32Array.from(out);
}

test('wallDistances: a round room is the same distance everywhere', () => {
  const walls = wallDistances(roundRoom(4, 1), 1);
  assert.equal(walls.length, 36);
  for (const w of walls) assert.ok(Math.abs(w - 4) < 0.01, `wall ${w}`);
});

test('wallDistances: the shell, not a person standing in front of the capture point', () => {
  const pts = [...roundRoom(4, 1)];
  // A small cluster just in front, at head height.
  for (let k = 0; k < 40; k++) pts.push(0.5 + (k % 5) * 0.02, 0.2, -0.05 + Math.floor(k / 5) * 0.01);
  const walls = wallDistances(Float32Array.from(pts), 1);
  for (const w of walls) assert.ok(Math.abs(w - 4) < 0.01, `wall ${w}`);
});

test('wallDistances: no splats in a direction is open; floor and ceiling are not walls', () => {
  // A floor and a ceiling only.
  const pts: number[] = [];
  for (let x = -5; x <= 5; x += 0.5) for (let z = -5; z <= 5; z += 0.5) pts.push(x, -1, z, x, 2, z);
  for (const w of wallDistances(Float32Array.from(pts), 1)) assert.equal(w, Infinity);
});

test('gapCandidates: rings round the capture point, each looking back at it', () => {
  const c = gapCandidates(1, null);
  assert.equal(c.length, 12 * 2);
  for (const k of c) {
    assert.equal(k.position[1], 0);
    const r = Math.hypot(k.position[0], k.position[2]);
    assert.ok(Math.abs(r - 0.75) < 1e-9 || Math.abs(r - 1.5) < 1e-9);
    // Looking towards the middle, a little down.
    const toward = -(k.position[0] * k.forward[0] + k.position[2] * k.forward[2]) / r;
    assert.ok(toward > 0.95, `toward ${toward}`);
    assert.ok(k.forward[1] < 0);
    // Yaw and pitch say the same as the forward vector, in the camera's convention.
    const { yaw, pitch } = yawPitchOf(k.forward);
    const dy = Math.abs((((yaw - k.yawDeg) % 360) + 540) % 360 - 180);
    assert.ok(dy < 1e-6, `yaw ${yaw} vs ${k.yawDeg}`);
    assert.ok(Math.abs(pitch - k.pitchDeg) < 1e-6);
  }
});

test('gapCandidates: a near wall pulls the ring in, and rings that land together are one camera', () => {
  const c = gapCandidates(1, wallDistances(roundRoom(1, 1), 1));
  // Both radii clamp to half the wall distance: one camera per direction.
  assert.equal(c.length, 12);
  for (const k of c) assert.ok(Math.abs(Math.hypot(k.position[0], k.position[2]) - 0.5) < 0.01);
  // A room too small to step off the capture point has no candidates at all.
  assert.equal(gapCandidates(1, wallDistances(roundRoom(0.4, 1), 1)).length, 0);
});

test('pickGaps: emptiest first, one per gap, nothing under the floor', () => {
  const at = (yawDeg: number, holeFraction: number) => {
    const a = (yawDeg * Math.PI) / 180;
    return { holeFraction, candidate: { position: [-Math.sin(a), 0, -Math.cos(a)] as [number, number, number], forward: [0, 0, 1] as [number, number, number], yawDeg: 0, pitchDeg: 0 } };
  };
  const picked = pickGaps([at(0, 0.1), at(20, 0.3), at(180, 0.2), at(90, 0.005), at(270, 0.05)]);
  assert.deepEqual(picked.map((p) => p.holeFraction), [0.3, 0.2, 0.05]);
  assert.equal(pickGaps([at(0, 0.3), at(120, 0.2), at(240, 0.1)], { maxGaps: 2 }).length, 2);
});

test('horizontalFov: 60 vertical at 16:9 is about 91.5', () => {
  assert.ok(Math.abs(horizontalFov(60, 16 / 9) - 91.49) < 0.05);
  assert.ok(Math.abs(horizontalFov(60, 1) - 60) < 1e-9);
});
