import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ring, walkableOutline } from './outline.js';

const centre = { x: 0, y: 0, z: 0 };
const segs = (o: { segments: Float32Array }) => o.segments.length / 6;

test('open floor everywhere: no lines', () => {
  const o = walkableOutline(() => 0, { centre, radius: 2, step: 0.25, stepUp: 0.4 });
  assert.equal(segs(o), 0);
  assert.equal(o.probes, 17 * 17);
});

test('a wall at x = 1 gives one straight line along it, on the floor', () => {
  const o = walkableOutline((x) => (x < 1 ? 0 : null), { centre, radius: 2, step: 0.25, stepUp: 0.4, lift: 0 });
  assert.ok(segs(o) > 0);
  for (let k = 0; k < o.segments.length; k += 3) {
    assert.ok(o.segments[k]! > 0.74 && o.segments[k]! < 1.01, `x ${o.segments[k]}`);
    assert.equal(o.segments[k + 1], 0);
  }
  // Spans the probed square: 16 cells along z.
  assert.equal(segs(o), 16);
});

test('a round room gives a closed loop round it', () => {
  const o = walkableOutline((x, z) => (Math.hypot(x, z) < 1.2 ? 0 : null), { centre, radius: 2, step: 0.2, stepUp: 0.4 });
  // Every endpoint is shared by exactly two segments: closed.
  const key = (k: number) => `${o.segments[k]!.toFixed(3)},${o.segments[k + 2]!.toFixed(3)}`;
  const count = new Map<string, number>();
  for (let k = 0; k < o.segments.length; k += 3) count.set(key(k), (count.get(key(k)) ?? 0) + 1);
  assert.ok([...count.values()].every((c) => c === 2));
});

test('a ledge too high to step down gets a line though both sides are floor', () => {
  const o = walkableOutline((x) => (x < 0.5 ? 1 : 0), { centre, radius: 1, step: 0.25, stepUp: 0.3 });
  assert.ok(segs(o) > 0);
  // A step the walker can take does not.
  assert.equal(segs(walkableOutline((x) => (x < 0.5 ? 0.2 : 0), { centre, radius: 1, step: 0.25, stepUp: 0.3 })), 0);
});

test('ring: a closed circle of segments at its radius', () => {
  const r = ring(1, 2, 3, 0.5, 8);
  assert.equal(r.length, 8 * 6);
  for (let k = 0; k < r.length; k += 3) {
    assert.ok(Math.abs(Math.hypot(r[k]! - 1, r[k + 2]! - 3) - 0.5) < 1e-6);
    assert.equal(r[k + 1], 2);
  }
});
