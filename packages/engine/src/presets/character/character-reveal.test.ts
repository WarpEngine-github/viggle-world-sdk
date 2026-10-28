import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { Character } from '../../character';
import { playReveal } from './character-reveal.ts';

/**
 * playReveal only touches a character through setReveal / setRevealLook and
 * the scene's update event, so a recording stand-in and a hand-cranked clock
 * are enough to check the timing.
 */
let now = 0;
let listeners: Array<() => void> = [];
const app = {
  on(_: string, fn: () => void) { listeners.push(fn); },
  off(_: string, fn: () => void) { listeners = listeners.filter((l) => l !== fn); },
};

/** Advance the clock by `ms` and run one update. */
function frame(ms: number) {
  now += ms;
  for (const fn of [...listeners]) fn();
}

function fakeCharacter() {
  const calls: Array<[number, boolean]> = [];
  const character = {
    armature: { scene: { app } },
    destroyed: false,
    setReveal(amount: number, inverse = false) { calls.push([amount, inverse]); },
    setRevealLook() {},
  } as unknown as Character;
  return { character, calls, last: () => calls[calls.length - 1] };
}

const linear = { ease: (t: number) => t };

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

beforeEach(() => {
  now = 0;
  listeners = [];
  mock.method(performance, 'now', () => now);
});
afterEach(() => mock.restoreAll());

describe('playReveal', () => {
  it('sweeps 0 to 1 over the duration and resolves true', async () => {
    const a = fakeCharacter();
    const run = playReveal(a.character, { preset: linear });
    assert.deepEqual(a.last(), [0, false]);
    frame(10);
    frame(10);
    frame(250);
    near(a.last()[0], 0.54);
    frame(16);
    frame(16);
    for (let i = 0; i < 20; i++) frame(16);
    assert.deepEqual(a.last(), [1, false]);
    assert.equal(await run.finished, true);
    assert.equal(listeners.length, 0, 'stops listening once done');
  });

  it('holds at the start while frames are slow, then gives up waiting', () => {
    const a = fakeCharacter();
    playReveal(a.character, { preset: linear });
    frame(100);
    frame(100);
    assert.equal(a.last()[0], 0, 'held through slow frames');
    frame(250);
    assert.ok(a.last()[0] > 0, 'past the settle timeout it moves regardless');
  });

  it('dissolves the outgoing character on the same clock', () => {
    const a = fakeCharacter();
    const b = fakeCharacter();
    const seen: number[] = [];
    playReveal(a.character, { outgoing: b.character, preset: linear, onProgress: (v) => seen.push(v) });
    frame(10);
    frame(240);
    near(a.last()[0], 0.5);
    assert.equal(a.last()[1], false);
    near(b.last()[0], 0.5);
    assert.equal(b.last()[1], true);
    assert.equal(seen.length, 3);
    [0, 0.02, 0.5].forEach((v, i) => near(seen[i], v));
  });

  it('speedUp finishes the rest at the interrupted pace', async () => {
    const a = fakeCharacter();
    const run = playReveal(a.character, { preset: linear });
    frame(10);
    frame(240);
    run.speedUp();
    frame(90);
    assert.equal(run.amount, 1);
    assert.equal(await run.finished, true);
  });

  it('continues part-way from `from`, over the remaining share of the duration', () => {
    const a = fakeCharacter();
    const run = playReveal(a.character, { from: 0.5, preset: { ...linear, settleTimeoutMs: 0 } });
    frame(125);
    near(run.amount, 0.75);
  });

  it('ends false, without touching either character, once one is destroyed', async () => {
    const a = fakeCharacter();
    const b = fakeCharacter();
    const run = playReveal(a.character, { outgoing: b.character, preset: linear });
    frame(10);
    const calls = a.calls.length + b.calls.length;
    (b.character as { destroyed: boolean }).destroyed = true;
    frame(16);
    assert.equal(a.calls.length + b.calls.length, calls);
    assert.equal(await run.finished, false);
    assert.equal(listeners.length, 0);
  });

  it('a zero-length sweep goes straight to 1 without setting the start', async () => {
    const a = fakeCharacter();
    const b = fakeCharacter();
    const run = playReveal(a.character, { outgoing: b.character, preset: { duration: 0 } });
    assert.deepEqual(a.calls, [[1, false]]);
    assert.deepEqual(b.calls, [[1, true]]);
    assert.equal(await run.finished, true);
  });

  it('cancel stops in place and resolves false', async () => {
    const a = fakeCharacter();
    const run = playReveal(a.character, { preset: linear });
    frame(10);
    run.cancel();
    const calls = a.calls.length;
    frame(16);
    assert.equal(a.calls.length, calls);
    assert.equal(await run.finished, false);
  });
});
