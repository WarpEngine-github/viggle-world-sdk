import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PushOut, WalkerState, WalkParams, WallResolver } from './controller.js';
import { EMPTY_INPUT, stepWalker, walkInputFromKeys } from './controller.js';

const params: WalkParams = { speed: 2, runMultiplier: 2, reach: 0.4, stepLimit: 0.35, turnRate: 720, settle: 12, jumpSpeed: 4, gravity: 12, airControl: 0.7 };
const flat = () => 0;
const start = (): WalkerState => ({ x: 0, y: 0, z: 0, heading: 0, moving: false, running: false, vy: 0, airborne: false });

describe('stepWalker', () => {
  it('walks away from the camera on W', () => {
    let s = start();
    for (let i = 0; i < 10; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 0.1, 0, params, flat);
    assert.ok(s.z < -1.9 && Math.abs(s.x) < 1e-6, `${s.x},${s.z}`);
    assert.ok(s.moving);
    assert.ok(Math.abs(s.heading) < 1e-6, 'faces −Z');
  });

  it('strafes relative to the camera yaw', () => {
    const s = stepWalker(start(), { ...EMPTY_INPUT, right: true }, 1, 90, params, flat);
    // Camera yawed +90 looks down −X; its right is −Z.
    assert.ok(s.z < -1.9 && Math.abs(s.x) < 1e-6, `${s.x},${s.z}`);
  });

  it('runs twice as fast with Shift', () => {
    const w = stepWalker(start(), { ...EMPTY_INPUT, forward: true }, 1, 0, params, flat);
    const r = stepWalker(start(), { ...EMPTY_INPUT, forward: true, run: true }, 1, 0, params, flat);
    assert.ok(Math.abs(r.z / w.z - 2) < 1e-6);
    assert.ok(r.running && !w.running);
  });

  it('an analog move walks any direction at its share of the pace', () => {
    // 30° right of forward, at half the pace: x right, z forward.
    const a = 30 * Math.PI / 180;
    const s = stepWalker(start(), { ...EMPTY_INPUT, move: { x: Math.sin(a) * 0.5, z: Math.cos(a) * 0.5 } }, 1, 0, params, flat);
    assert.ok(Math.abs(Math.hypot(s.x, s.z) - 1) < 1e-6, `${s.x},${s.z}`);
    assert.ok(Math.abs(Math.atan2(s.x, -s.z) - a) < 1e-6);
    assert.ok(s.moving && !s.running);
  });

  it('a zero analog move stands still', () => {
    const s = stepWalker(start(), { ...EMPTY_INPUT, move: { x: 0, z: 0 } }, 1, 0, params, flat);
    assert.ok(!s.moving && s.x === 0 && s.z === 0);
  });

  it('slides along a wall at an angle when walls push her out', () => {
    // A wall along the line x = z - 1 (beyond it, x > z - 1, is solid). The
    // floor probe alone refuses it; the resolver pushes her back onto the line.
    const n = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };
    const past = (x: number, z: number) => (x - z + 1) * Math.SQRT1_2;
    const floor = (x: number, z: number) => (past(x, z) > 1e-6 ? null : 0);
    const walls: WallResolver = (x, z) => {
      const d = past(x, z);
      return d > 0 ? { x: x - n.x * d, z: z - n.z * d } : { x, z };
    };
    let s = { ...start(), x: -1 };
    // Camera yaw 30: forward is (-0.5, -0.87), into the wall at 15 degrees.
    for (let i = 0; i < 20; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 0.1, 30, params, floor, { active: true, generation: 0, resolve: walls, groundAt: floor, overlap: () => 0, bodyHeight: 1.7 });
    assert.ok(past(s.x, s.z) <= 1e-6, `inside the wall: ${s.x},${s.z}`);
    assert.ok(Math.hypot(s.x + 1, s.z) > 0.9 * 4 * Math.cos(Math.PI / 12), `slid ${Math.hypot(s.x + 1, s.z)}`);
  });

  it('walks off a ledge onto detected floor and lands', () => {
    const ledge = (_x: number, z: number) => (z > -1 ? 1 : 0);
    let s = { ...start(), y: 1 };
    for (let i = 0; i < 20; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 0.1, 0, params, ledge);
    assert.ok(s.z < -2 && s.y === 0 && !s.airborne, `${s.z},${s.y},${s.airborne}`);
  });

  it('gets down off a lamp: walls at her height, floor read alone', () => {
    // A shade 0.6 wide at the brim with a 0.2 top at height 1. The body test
    // on the floor below reads the brim zone as a wall (floorAt's null),
    // which is what used to hold her up there.
    const d = (x: number, z: number) => Math.hypot(x, z);
    const floorAt = (x: number, z: number) => (d(x, z) < 0.2 ? 1 : d(x, z) < 0.6 ? null : 0);
    const groundAt = (x: number, z: number) => (d(x, z) < 0.2 ? 1 : 0);
    const resolve: WallResolver = (x, z, y) => {
      const r = d(x, z);
      if (y >= 1 || r >= 0.6 || r === 0) return { x, z };
      const k = (0.6 + 1e-9) / r;
      return { x: x * k, z: z * k };
    };
    let s = { ...start(), y: 1 };
    for (let i = 0; i < 20; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 0.1, 0, params, floorAt, { active: true, generation: 0, resolve, groundAt, overlap: () => 0, bodyHeight: 1.7 });
    assert.ok(s.y === 0 && !s.airborne && d(s.x, s.z) >= 0.6, `${s.x},${s.z},${s.y}`);
  });

  it('a ceiling stops a jump: her head does not go into it', () => {
    // Head room to 0.5 above the floor, and a thin ceiling: the overlap is the
    // same however far into it she is.
    const overlap = (_x: number, _z: number, y: number) => (y > 0.5 ? 3 : 0);
    let s = start();
    let top = 0;
    for (let i = 0; i < 40; i++) {
      s = stepWalker(s, { ...EMPTY_INPUT, jump: i === 0 }, 0.05, 0, params, flat, { active: true, generation: 0, resolve: (x, z) => ({ x, z }), groundAt: flat, overlap, bodyHeight: 1.7 });
      top = Math.max(top, s.y);
    }
    assert.ok(top <= 0.5 && top > 0.3, `apex ${top}`);
    assert.ok(s.y === 0 && !s.airborne, `landed at ${s.y}`);
  });

  it('does not step up onto something with no headroom above it', () => {
    // A kerb within the step limit, under a ceiling too low to stand on it.
    const kerb = (_x: number, z: number) => (z < -1 ? 0.3 : 0);
    const overlap = (_x: number, z: number, y: number) => (z < -1 && y > 0.2 ? 4 : 0);
    let s = start();
    for (let i = 0; i < 30; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 0.1, 0, params, kerb, { active: true, generation: 0, resolve: (x, z) => ({ x, z }), groundAt: kerb, overlap, bodyHeight: 1.7 });
    assert.ok(s.z >= -1.05 && s.y < 0.01, `climbed onto it: ${s.z},${s.y}`);
  });

  it('beside something too low to stand under, she walks on at her own level', () => {
    // A ledge 0.3 up within her reach to +x, with no headroom on it. Every
    // nearby spot reads the ledge; she must still be able to walk away.
    const ledge = (x: number, _z: number, reach: number, fromY: number) => (x + reach > 0.5 && fromY >= 0.3 ? 0.3 : 0);
    const overlap = (x: number, _z: number, y: number) => (x + 0.4 > 0.5 && y > 0.2 ? 3 : 0);
    let s = { ...start(), x: 0.2 };
    for (let i = 0; i < 10; i++) s = stepWalker(s, { ...EMPTY_INPUT, back: true }, 0.1, 0, params, ledge, { active: true, generation: 0, resolve: (x, z) => ({ x, z }), groundAt: ledge, overlap, bodyHeight: 1.7 });
    assert.ok(s.z > 1.5 && s.y < 0.01, `held at ${s.z},${s.y}`);
  });

  it('falling past a flared shade slides her off it instead of landing on it', () => {
    // A shade whose skirt widens as it goes down: at height y it fills r < 0.6 - y/2.
    // Its top is at 1 within r < 0.1.
    const d = (x: number, z: number) => Math.hypot(x, z);
    const ground = (x: number, z: number, _r: number, fromY: number) => (d(x, z) < 0.1 && fromY >= 1 ? 1 : 0);
    const overlap = (x: number, z: number, y: number) => (y < 1 && d(x, z) < 0.6 - y / 2 ? 5 : 0);
    const resolve: WallResolver = (x, z, y) => {
      const r = d(x, z); const need = 0.6 - y / 2 + 1e-6;
      return y < 1 && r < need && r > 0 ? { x: (x / r) * need, z: (z / r) * need } : { x, z };
    };
    // Dropped just beside the top, already falling.
    let s = { ...start(), x: 0.12, y: 1.05, airborne: true };
    for (let i = 0; i < 40; i++) s = stepWalker(s, { ...EMPTY_INPUT }, 1 / 30, 0, params, ground, { active: true, generation: 0, resolve, groundAt: ground, overlap, bodyHeight: 1.7 });
    assert.ok(s.y === 0 && !s.airborne && overlap(s.x, s.z, s.y) === 0, `${s.x},${s.y}`);
  });

  it('standing beside a steep slope, she does not ride up it', () => {
    // The probe answers the highest surface in reach below fromY, as the
    // collider does: a steep flank just inside her reach.
    const slope = (x: number, _z: number, reach: number, fromY: number) => Math.min(Math.max(0, (x + reach - 0.1) * 5), fromY);
    let s = start();
    for (let i = 0; i < 30; i++) s = stepWalker(s, { ...EMPTY_INPUT }, 0.1, 0, params, slope);
    // At most the first floor reading (one step), never the whole flank.
    assert.ok(s.y <= params.stepLimit + 1e-6, `rode up to ${s.y}`);
  });

  it('a walk spawned below the probed floor rises to it and walks on', () => {
    // Orbit stood her at 0; the street there is 0.3 up and rises both ways
    // she can step, so from her sunk height the look ahead refuses every
    // move. Like the floor index, a probe asked from below the street finds
    // only what is under it.
    const street = (x: number, z: number, _r: number, fromY: number) => {
      const h = 0.3 + 0.3 * Math.max(0, -z) + 0.3 * Math.max(0, -x);
      return fromY >= h ? h : 0;
    };
    let s = start();
    // Diagonally, as on the street: neither per-axis fallback is a no-op.
    for (let i = 0; i < 30; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 0.1, 45, { ...params, lookahead: 0.3 }, street);
    assert.ok(s.z < -3.5, `stuck at z=${s.z}, y=${s.y}`);
  });

  it('jumping inside foliage does not climb it', () => {
    // Foliage: the probe finds a floor just under wherever it is asked from.
    const foliage = (_x: number, _z: number, _r: number, fromY: number) => Math.max(0, fromY - 0.05);
    let s = start();
    let top = 0;
    for (let i = 0; i < 120; i++) {
      s = stepWalker(s, { ...EMPTY_INPUT, forward: true, jump: i % 20 === 0 }, 1 / 30, 0, params, foliage);
      if (!s.airborne) top = Math.max(top, s.y);
    }
    assert.ok(top < 0.4, `stood at ${top}`);
  });

  it('stuck under a ceiling, she does not climb a wall she walks into', () => {
    // A solid wall beyond z = -0.5: the probe reads its face as a floor right
    // up to the asking height.
    const ground = (_x: number, z: number, _r: number, fromY: number) => (z < -0.5 ? fromY : 1);
    const overlap = (_x: number, z: number, y: number, h = 1.7) => (y + h > 2.45 ? 5 : 0) + (z < -0.5 ? 10 : 0);
    let s: WalkerState = { ...start(), y: 1, floor: 1 };
    for (let i = 0; i < 20; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 0.1, 0, params, ground, { active: true, generation: 0, resolve: (x, z) => ({ x, z }), groundAt: ground, overlap, bodyHeight: 1.7 });
    assert.ok(s.y < 1.05 && s.z > -0.6, `climbed to ${s.y} at ${s.z}`);
  });

  it('stuck with her head in the ceiling, a wall still stops her legs', () => {
    // On a ledge under the ceiling (her top 0.25 in it), a wall beyond z = -0.5
    // the whole way down.
    const ground = () => 1;
    const overlap = (_x: number, z: number, y: number, h = 1.7) => (y + h > 2.45 ? 5 : 0) + (z < -0.5 ? 10 : 0);
    let s: WalkerState = { ...start(), y: 1, floor: 1 };
    for (let i = 0; i < 20; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 0.1, 0, params, ground, { active: true, generation: 0, resolve: (x, z) => ({ x, z }), groundAt: ground, overlap, bodyHeight: 1.7 });
    assert.ok(s.z > -0.55, `walked through the wall to ${s.z}`);
  });

  it('wholly inside something rough, she still walks out of it', () => {
    // No part of her clear, and the overlap bumps up and down as she goes.
    const overlap = (x: number, z: number) => {
      const d = Math.hypot(x, z);
      return d < 0.6 ? 20 + (Math.round(d * 40) % 7) : 0;
    };
    let s = start();
    for (let i = 0; i < 30; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 1 / 30, 0, params, flat, { active: true, generation: 0, resolve: (x, z) => ({ x, z }), groundAt: flat, overlap, bodyHeight: 1.7 });
    assert.ok(Math.hypot(s.x, s.z) >= 0.6, `held at ${s.z}`);
  });

  it('a rebuilt collider starts her overlap count again', () => {
    // Counted 2 against the old walls; the new ones count everything higher.
    const overlap = (x: number, z: number) => (Math.hypot(x, z) < 0.6 ? 60 + (Math.round(Math.hypot(x, z) * 40) % 7) : 0);
    let s: WalkerState = { ...start(), stuckBase: { cells: 2, y: 0, walls: 0 } };
    for (let i = 0; i < 30; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 1 / 30, 0, params, flat, { active: true, generation: 1, resolve: (x, z) => ({ x, z }), groundAt: flat, overlap, bodyHeight: 1.7 });
    assert.ok(Math.hypot(s.x, s.z) >= 0.6, `held at ${s.z}`);
  });

  it('a step up along a wall does not put her into it while she rises', () => {
    // A ledge 0.3 up at z < -1, and a wall at z < -1.2 that her body reaches
    // only while she is still below the ledge's height.
    const ledge = (_x: number, z: number) => (z < -1 ? 0.3 : 0);
    const overlap = (_x: number, z: number, y: number) => (z < -1.2 && y < 0.25 ? 4 : z < -1.4 ? 9 : 0);
    let s = start();
    for (let i = 0; i < 40; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 0.1, 0, params, ledge, { active: true, generation: 0, resolve: (x, z) => ({ x, z }), groundAt: ledge, overlap, bodyHeight: 1.7 });
    assert.ok(overlap(s.x, s.z, s.y) === 0, `in the wall at ${s.z},${s.y}`);
  });

  it('stuck in a wall, she cannot walk deeper into it', () => {
    const ground = () => 0;
    const overlap = (_x: number, z: number) => (z < 0 ? Math.round(-z * 100) : 0);
    let s: WalkerState = { ...start(), z: -0.02 };
    for (let i = 0; i < 20; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 0.1, 0, params, ground, { active: true, generation: 0, resolve: (x, z) => ({ x, z }), groundAt: ground, overlap, bodyHeight: 1.7 });
    assert.ok(s.z > -0.1, `walked in to ${s.z}`);
  });

  it('a fall into nothing puts her back where she last stood', () => {
    const none = (x: number) => (x < 1 ? 0 : null);
    let s: WalkerState = { ...start(), x: 1.5, y: -0.1, airborne: true, safe: { x: 0, y: 0, z: 0 } };
    for (let i = 0; i < 60; i++) s = stepWalker(s, { ...EMPTY_INPUT }, 1 / 30, 0, params, none);
    assert.ok(s.x === 0 && s.y === 0 && !s.airborne, `${s.x},${s.y},${s.airborne}`);
  });

  it('falling onto a floor beside a wall, she lands pushed clear of it', () => {
    // A wall over x < 0.1 at every height; she comes down 0.05 into it.
    const overlap = (x: number) => (x < 0.1 ? 4 : 0);
    const resolve = (x: number, z: number) => ({ x: Math.max(x, 0.1), z });
    let s: WalkerState = { ...start(), x: 0.05, y: 0.5, airborne: true, safe: { x: 1, y: 0, z: 0 } };
    for (let i = 0; i < 30; i++) s = stepWalker(s, { ...EMPTY_INPUT }, 1 / 30, 0, params, flat, { active: true, generation: 0, resolve, groundAt: flat, overlap, bodyHeight: 1.7 });
    assert.ok(s.x === 0.1 && s.y === 0 && !s.airborne, `${s.x},${s.y},${s.airborne}`);
  });

  it('walking straight into a wall does not lift her where she stands', () => {
    // Foliage-like: the probe finds a floor just under wherever it is asked
    // from, and a wall straight ahead refuses the move.
    const ground = (_x: number, z: number, _r: number, fromY: number) => (z < -0.1 ? null : Math.max(0, fromY - 0.3));
    let s: WalkerState = { ...start(), z: -0.099, floor: 0 };
    for (let i = 0; i < 30; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 1 / 30, 0, params, ground);
    assert.ok(s.y === 0, `rose to ${s.y}`);
  });

  it('a fall puts her back clear of a wall that has appeared on her last spot', () => {
    const none = (x: number) => (x < 1 ? 0 : null);
    // A wall over x < 0.2, which the walls push her out of in +X.
    const overlap = (x: number) => (x < 0.2 ? 10 : 0);
    const resolve = (x: number, z: number) => ({ x: Math.max(x, 0.2), z });
    let s: WalkerState = { ...start(), x: 1.5, y: -0.1, airborne: true, safe: { x: 0, y: 0, z: 0 } };
    for (let i = 0; i < 60; i++) s = stepWalker(s, { ...EMPTY_INPUT }, 1 / 30, 0, params, none, { active: true, generation: 0, resolve, groundAt: none, overlap, bodyHeight: 1.7 });
    assert.ok(s.x === 0.2 && s.y === 0 && !s.airborne, `${s.x},${s.y},${s.airborne}`);
  });

  it('a long frame does not carry her through a thin wall', () => {
    // A 0.3 thick wall over z in [-1.3, -1]; her body is 0.25 wide, and the
    // push-out sends her to whichever face is nearer.
    const near = (z: number) => z < -0.75 && z > -1.55;
    const overlap = (_x: number, z: number) => (near(z) ? 10 : 0);
    const resolve = (x: number, z: number) => (near(z) ? { x, z: z > -1.15 ? -0.75 : -1.55 } : { x, z });
    let s: WalkerState = { ...start(), z: -0.6 };
    // 6 per second at 10 fps: 0.6 a frame, past the wall's middle in one.
    for (let i = 0; i < 10; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 0.1, 0, { ...params, speed: 6 }, flat, { active: true, generation: 0, resolve, groundAt: flat, overlap, bodyHeight: 1.7 });
    assert.ok(s.z >= -0.75, `through to ${s.z}`);
  });

  it('after three seconds in the air she is put back, even with a floor reading below', () => {
    // Beyond x = 1 the probe keeps answering a floor far below her, so the
    // no-floor rule never fires.
    const deep = (x: number) => (x < 1 ? 0 : -1000);
    let s: WalkerState = { ...start(), x: 2, y: -0.1, airborne: true, safe: { x: 0, y: 0, z: 0 } };
    for (let i = 0; i < 100; i++) s = stepWalker(s, { ...EMPTY_INPUT }, 1 / 30, 0, params, deep);
    assert.ok(s.x === 0 && s.y === 0 && !s.airborne, `${s.x},${s.y},${s.airborne}`);
  });

  it('gets off a lamp with her head in the ceiling', () => {
    // On the lamp her head is in the ceiling everywhere; on the floor it is not.
    const d = (x: number, z: number) => Math.hypot(x, z);
    const ground = (x: number, z: number) => (d(x, z) < 0.3 ? 1 : 0);
    // A rough ceiling at 2.45: where she stands is a local minimum of the overlap.
    const overlap = (x: number, z: number, y: number, h = 1.7) => (y + h > 2.45 ? 5 + Math.round(d(x, z) * 40) % 7 : 0);
    let s = { ...start(), y: 1 };
    for (let i = 0; i < 20; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 0.1, 0, params, ground, { active: true, generation: 0, resolve: (x, z) => ({ x, z }), groundAt: ground, overlap, bodyHeight: 1.7 });
    assert.ok(s.y === 0 && !s.airborne && d(s.x, s.z) > 0.3, `${s.x},${s.z},${s.y}`);
    assert.ok(s.y === 0 && !s.airborne && d(s.x, s.z) >= 0.6, `${s.x},${s.z},${s.y}`);
  });

  it('slides round a person at the edge of their disc instead of stalling on it', () => {
    // A person 1 m ahead and a little to the right, 0.6 m of footprint: walking at them diagonally.
    const person = { x: 0.6, z: -1.2, r: 0.6 };
    const refuse = (x: number, z: number) => (Math.hypot(x - person.x, z - person.z) < person.r ? null : 0);
    const push: PushOut = (x, z) => {
      const d = Math.hypot(x - person.x, z - person.z);
      return d >= person.r ? null : { x: person.x + ((x - person.x) / d) * person.r, z: person.z + ((z - person.z) / d) * person.r };
    };
    const run = (slide?: PushOut) => {
      let s = start(); const speeds: number[] = [];
      for (let i = 0; i < 80; i++) {
        const before = s;
        s = stepWalker(s, { ...EMPTY_INPUT, forward: true, left: true }, 1 / 60, 0, params, refuse, undefined, slide);
        speeds.push(Math.hypot(s.x - before.x, s.z - before.z) * 60);
      }
      return { s, speeds, entered: Math.hypot(s.x - person.x, s.z - person.z) < person.r - 1e-6 };
    };
    const slid = run(push);
    assert.ok(!slid.entered, 'never inside the person');
    // once it has met the person it keeps moving at a steady, useful speed (the part of the step along the edge)
    const met = slid.speeds.slice(30);
    assert.ok(Math.min(...met) > 0.2 * params.speed, `no stall, slowest ${Math.min(...met).toFixed(2)}`);
    assert.ok(Math.max(...met) < 1.05 * params.speed, `no lurch, fastest ${Math.max(...met).toFixed(2)}`);
  });

  it('refuses a wall and follows a step', () => {
    const wall = (_x: number, z: number) => (z < -1 ? null : 0);
    let s = start();
    for (let i = 0; i < 30; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 0.1, 0, params, wall);
    assert.ok(s.z >= -1.05, `stopped at the wall, z=${s.z}`);

    const step = (_x: number, z: number) => (z < -1 ? 0.3 : 0);
    let t = start();
    for (let i = 0; i < 40; i++) t = stepWalker(t, { ...EMPTY_INPUT, forward: true }, 0.1, 0, params, step);
    assert.ok(t.z < -2 && t.y > 0.25, `climbed the step, z=${t.z} y=${t.y}`);

    const cliff = (_x: number, z: number) => (z < -1 ? 2 : 0);
    let c = start();
    for (let i = 0; i < 30; i++) c = stepWalker(c, { ...EMPTY_INPUT, forward: true }, 0.1, 0, params, cliff);
    assert.ok(c.z >= -1.05, `too tall, stays, z=${c.z}`);
  });

  it('with a lookahead, climbs a stair but not a steep slope', () => {
    const p = { ...params, lookahead: 0.3 };
    // A ramp rising 2 per unit: every frame's few centimetres are inside the
    // step limit, so without the lookahead it is climbed like a staircase.
    const steep = (_x: number, z: number, _r: number, fromY: number) => Math.min(fromY, Math.max(0, (-z - 1) * 2));
    let s = start();
    for (let i = 0; i < 40; i++) s = stepWalker(s, { ...EMPTY_INPUT, forward: true }, 0.1, 0, p, steep);
    assert.ok(s.y < 0.35, `stopped at the foot of the slope, y=${s.y}`);
    let u = start();
    for (let i = 0; i < 40; i++) u = stepWalker(u, { ...EMPTY_INPUT, forward: true }, 0.1, 0, params, steep);
    assert.ok(u.y > 1, `without it, climbed, y=${u.y}`);

    const stair = (_x: number, z: number) => (z < -1 ? 0.3 : 0);
    let t = start();
    for (let i = 0; i < 40; i++) t = stepWalker(t, { ...EMPTY_INPUT, forward: true }, 0.1, 0, p, stair);
    assert.ok(t.z < -2 && t.y > 0.25, `climbed the stair, z=${t.z} y=${t.y}`);
  });

  it('stands still with no input and reports idle', () => {
    const s = stepWalker({ ...start(), moving: true }, EMPTY_INPUT, 0.1, 0, params, flat);
    assert.equal(s.moving, false);
    assert.equal(s.x, 0); assert.equal(s.z, 0);
  });

  it('maps keys, including arrows, shift and space', () => {
    const i = walkInputFromKeys(new Set(['w', 'shift', 'arrowleft', ' ']));
    assert.deepEqual(i, { forward: true, back: false, left: true, right: false, run: true, jump: true });
  });

  it('jumps in an arc and lands back on the floor, once per press', () => {
    let s = stepWalker(start(), { ...EMPTY_INPUT, jump: true }, 1 / 60, 0, params, flat);
    assert.ok(s.airborne && s.vy > 0);
    let peak = 0; let frames = 0;
    while (s.airborne && frames < 600) { s = stepWalker(s, { ...EMPTY_INPUT, jump: true }, 1 / 60, 0, params, flat); peak = Math.max(peak, s.y); frames++; }
    assert.ok(!s.airborne, 'landed');
    assert.ok(peak > 0.5 && peak < 0.8, `peak ${peak}`);
    assert.equal(s.y, 0);
    // Space still held on landing: the next frame launches again (one press, one jump is the machine's job).
    const again = stepWalker(s, { ...EMPTY_INPUT, jump: true }, 1 / 60, 0, params, flat);
    assert.ok(again.airborne);
  });
});
