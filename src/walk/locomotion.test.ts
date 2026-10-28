import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LocoInput } from './locomotion.js';
import { createLocoMachine, JUMP_PHASE, stepLocomotion } from './locomotion.js';

const still: LocoInput = { moving: false, running: false, jump: false, airborne: false };
const walk: LocoInput = { ...still, moving: true };
const run: LocoInput = { ...walk, running: true };

function runFor(m = createLocoMachine(), input: LocoInput, seconds: number, dt = 1 / 60) {
  let out = stepLocomotion(m, input, 0);
  for (let t = 0; t < seconds; t += dt) out = stepLocomotion(out.machine, input, dt);
  return out;
}

describe('stepLocomotion', () => {
  it('starts idle and walks, runs, stops', () => {
    let s = stepLocomotion(createLocoMachine(), walk, 1 / 60);
    assert.equal(s.clip, 'walk'); assert.ok(s.changed); assert.equal(s.blend, 0.15);
    s = stepLocomotion(s.machine, run, 1 / 60);
    assert.equal(s.clip, 'run'); assert.ok(s.changed);
    s = stepLocomotion(s.machine, still, 1 / 60);
    assert.equal(s.clip, 'idle'); assert.ok(s.changed);
    s = stepLocomotion(s.machine, still, 1 / 60);
    assert.equal(s.changed, false);
  });

  it('jumps as a one-shot: take-off, air until landed, land, then the keys decide', () => {
    let s = stepLocomotion(createLocoMachine(), { ...walk, jump: true }, 1 / 60);
    assert.equal(s.clip, 'jump'); assert.equal(s.launch, false); assert.equal(s.machine.phase, 'takeoff');
    // The crouch: on the floor, not launched yet, and a held Space changes nothing.
    s = runFor(s.machine, { ...walk, jump: true }, JUMP_PHASE.takeoff - 0.05);
    assert.equal(s.machine.phase, 'takeoff'); assert.equal(s.launch, false);
    // The clip's feet leave: launch fires once, on the transition frame, while
    // the walker is still on the floor.
    let launches = 0;
    for (let t = 0; t < 0.1; t += 1 / 60) { s = stepLocomotion(s.machine, { ...walk, jump: true, airborne: launches > 0 }, 1 / 60); if (s.launch) launches++; }
    assert.equal(launches, 1); assert.equal(s.machine.phase, 'air');
    // Holding space in the air does not re-launch.
    s = runFor(s.machine, { ...walk, jump: true, airborne: true }, 0.3);
    assert.equal(s.machine.phase, 'air'); assert.equal(s.launch, false);
    // Touch down: land phase (flagged once), then back to walk because W is still held.
    s = stepLocomotion(s.machine, { ...walk, airborne: false }, 1 / 60);
    assert.equal(s.machine.phase, 'land'); assert.ok(s.landed);
    s = stepLocomotion(s.machine, { ...walk, airborne: false }, 1 / 60);
    assert.equal(s.landed, false);
    s = runFor(s.machine, walk, JUMP_PHASE.land + 0.05);
    assert.equal(s.clip, 'walk');
    assert.equal(s.machine.prev, 'jump');
  });

  it('caps the air phase so a missing floor cannot hang the machine', () => {
    let s = stepLocomotion(createLocoMachine(), { ...still, jump: true }, 1 / 60);
    s = runFor(s.machine, { ...still, airborne: true }, JUMP_PHASE.takeoff + JUMP_PHASE.air + 0.1);
    assert.equal(s.machine.phase, 'land');
  });

  it('follows the walker speed with a bounded playback rate', () => {
    const slow = stepLocomotion(createLocoMachine(), walk, 1 / 60, 0.7);
    const crawl = stepLocomotion(createLocoMachine(), walk, 1 / 60, 0.2);
    const fast = stepLocomotion(createLocoMachine(), walk, 1 / 60, 3);
    const slowRun = stepLocomotion(createLocoMachine(), { ...walk, running: true }, 1 / 60, 0.5);
    assert.equal(slow.rate, 0.7); assert.equal(crawl.rate, 0.6); assert.equal(fast.rate, 1.1);
    assert.equal(slowRun.rate, 0.9);
  });
});
