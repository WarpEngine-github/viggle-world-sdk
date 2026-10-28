import assert from 'node:assert/strict';
import { describe, it } from 'node:test';


import type { BoomCollider, BoomView } from './cameraArm.js';
import { armReach, boomFor, boomLimit, eyeAt, fadeFor, insideReach, stepBoom, stepFade } from './cameraArm.js';

type Vec3 = { x: number; y: number; z: number };
type Box = { min: Vec3; max: Vec3 };

const box = (x0: number, x1: number, z0: number, z1: number, y0 = -10, y1 = 10): Box =>
  ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });

/** Solid `boxes`, as a collider sees them. */
function world(...boxes: Box[]): BoomCollider {
  const inside = (p: Vec3, b: Box) =>
    p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;
  const raycast = (o: Vec3, dir: Vec3, maxT: number): number | null => {
    const l = Math.hypot(dir.x, dir.y, dir.z);
    let best: number | null = null;
    for (const b of boxes) {
      if (inside(o, b)) continue;
      let t0 = 0;
      let t1 = maxT;
      for (const k of ['x', 'y', 'z'] as const) {
        const d = dir[k] / l;
        if (d === 0) {
          if (o[k] < b.min[k] || o[k] > b.max[k]) t0 = Infinity;
          continue;
        }
        const a = (b.min[k] - o[k]) / d;
        const c = (b.max[k] - o[k]) / d;
        t0 = Math.max(t0, Math.min(a, c));
        t1 = Math.min(t1, Math.max(a, c));
      }
      if (t0 <= t1 && (best === null || t0 < best)) best = t0;
    }
    return best;
  };
  const isClear = (p: Vec3, r: number): boolean => boxes.every((b) => {
    const g = (k: 'x' | 'y' | 'z') => Math.max(b.min[k] - p[k], 0, p[k] - b.max[k]);
    return Math.hypot(g('x'), g('y'), g('z')) > r;
  });
  return { raycast, isClear } as unknown as BoomCollider;
}

const H = 1.8;
const BOOM = boomFor(H);
const pivot = { x: 0, y: 1, z: 0 };
const eye = { x: 0, y: 1, z: 3 };

describe('armReach', () => {
  it('stops the eye\'s ball short of the wall', () => {
    const reach = armReach(world(box(-5, 5, 1, 2)), pivot, eye, BOOM);
    assert.ok(Math.abs(reach - (1 - BOOM.radius)) < 1e-9, String(reach));
  });

  it('keeps the whole boom with nothing behind it', () => {
    assert.equal(armReach(world(), pivot, eye, BOOM), 3);
  });

  it('comes right up to her head, not into the wall, when the wall is that close', () => {
    // 0.25 behind her head: closer than the shortest boom.
    const reach = armReach(world(box(-5, 5, 0.25, 2)), pivot, eye, BOOM);
    assert.ok(reach < BOOM.min && reach <= 0.25 - BOOM.radius + 1e-9, String(reach));
  });

  it('keeps the eye off a wall it would only skim', () => {
    // The side wall is 0.1 off the line: the line misses it, the eye's ball
    // (0.18) touches its corner from z = 1.5 - sqrt(0.18² - 0.1²) = 1.35 on.
    const reach = armReach(world(box(0.1, 5, 1.5, 5)), pivot, eye, BOOM);
    assert.ok(reach > 1.34 && reach <= 1.35, String(reach));
  });
});

describe('insideReach', () => {
  it('pulls an eye inside a wall back to its near side', () => {
    const reach = insideReach(world(box(-5, 5, 2.5, 3.5)), pivot, eye, BOOM);
    assert.ok(reach > 2.31 && reach <= 2.32, String(reach));
  });

  it('leaves an eye in the open alone, whatever is in between', () => {
    assert.equal(insideReach(world(box(-5, 5, 1.4, 1.6)), pivot, eye, BOOM), 3);
  });
});

describe('boomLimit', () => {
  // Her head at 1.53, the orbit looking level at her middle from 3 behind.
  const view = (over: Partial<BoomView> = {}): BoomView => {
    const target = { x: 0, y: 0.9, z: 0 };
    return {
      pivot: { x: 0, y: 1.53, z: 0 },
      eye: eyeAt(target, 0, 0, 3),
      target,
      yaw: 0,
      pitch: 0,
      distance: 3,
      velocity: { x: 0, y: 0, z: 0 },
      yawRate: 0,
      lastEye: null,
      ...over,
    };
  };
  const full = Math.hypot(1.53 - 0.9, 3);
  const post = world(box(-0.05, 0.05, 1.4, 1.6));
  const wall = world(box(-5, 5, 1.4, 1.6));

  it('ignores a post her head is only partly behind', () => {
    assert.equal(boomLimit(post, view(), BOOM, H), full);
  });

  it('ignores a post she is walking past', () => {
    assert.equal(boomLimit(post, view({ velocity: { x: 1.5, y: 0, z: 0 } }), BOOM, H), full);
  });

  it('comes in for a wall that hides her, standing or walking along it', () => {
    assert.ok(boomLimit(wall, view(), BOOM, H) < 1.4);
    assert.ok(boomLimit(wall, view({ velocity: { x: 1.5, y: 0, z: 0 } }), BOOM, H) < 1.4);
  });

  it('comes in for a post the eye just passed through', () => {
    const passed = view({ lastEye: { x: 0, y: 0.9, z: 1 }, velocity: { x: 1.5, y: 0, z: 0 } });
    assert.ok(boomLimit(post, passed, BOOM, H) < 1.4);
  });

  it('always comes in out of a wall the eye is inside', () => {
    const limit = boomLimit(world(box(-5, 5, 2.5, 3.5)), view({ velocity: { x: 1.5, y: 0, z: 0 } }), BOOM, H);
    assert.ok(limit < 2.5);
  });
});

describe('stepBoom', () => {
  it('sets off from rest and settles without overshooting', () => {
    let [x, v] = stepBoom(1, 0, 3, 1 / 60);
    const first = x - 1;
    const [second] = stepBoom(x, v, 3, 1 / 60);
    assert.ok(second - x > first, `${first} ${second - x}`);
    let peak = x;
    for (let i = 0; i < 120; i++) {
      [x, v] = stepBoom(x, v, 3, 1 / 60);
      peak = Math.max(peak, x);
    }
    assert.ok(peak <= 3 + 1e-9 && x > 2.99, `${peak} ${x}`);
  });
});

describe('fadeFor / stepFade', () => {
  const head = { x: 0, y: 1.53, z: 0 };
  const at = (d: number) => fadeFor({ x: 0, y: 1.53, z: d }, head, H);

  it('is whole clear of her head, half at the edge, gone right at it', () => {
    assert.equal(at(0.5), 1);
    assert.ok(Math.abs(at(0.36) - 1 / 3) < 1e-9);
    assert.equal(at(0.1), 0);
  });

  it('eases while partly shown, and snaps into and out of gone', () => {
    assert.ok(Math.abs(stepFade(1, 0.4, 1 / 60) - (1 - 2.8 / 60)) < 1e-9);
    assert.equal(stepFade(1, 0, 1 / 60), 0);
    assert.equal(stepFade(0, 1, 1 / 60), 1);
  });
});
