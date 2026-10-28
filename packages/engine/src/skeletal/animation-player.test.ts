import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Animation } from '../animation';

import { AnimationPlayer } from './animation-player';
import { Pose } from './pose';
import type { Skeleton } from './skeleton';

function rig() {
  const skeleton = {
    numBones: 1, bindT: new Float32Array([0, 0, 0]), bindR: new Float32Array([0, 0, 0, 1]),
    restPose: { positions: [], rotations: [], scales: [] },
  } as unknown as Skeleton;
  const clip = (xs: number[]) => ({
    numFrames: xs.length,
    skeletalStore: { keyframes: new Map([[0, {
      frames: Float32Array.from(xs, (_, i) => i),
      positions: Float32Array.from(xs.flatMap(x => [x, 0, 0])),
      rotations: Float32Array.from(xs.flatMap(() => [0, 0, 0, 1])),
      scales: Float32Array.from(xs.flatMap(() => [1, 1, 1])),
    }]]) },
  }) as unknown as Animation;
  const clips = new Map([['talk', clip([0, 1, 2])], ['greet', clip([10, 10, 10])], ['idle', clip([20, 20, 20])]]);
  const pose = new Pose(1);
  const player = new AnimationPlayer({ skeleton, animationProvider: name => clips.get(name) ?? null, snapshotPose: new Pose(1) });
  player.frameRate = 1;
  player.play('talk'); player.evaluate(pose);
  return { player, pose };
}

describe('AnimationPlayer crossfades', () => {
  it('preserves snapshot blending for existing callers', () => {
    const { player, pose } = rig();
    player.crossfadeTo('greet', pose, { duration: 1 });
    player.tick(0.5); player.evaluate(pose);
    assert.equal(pose.positions[0].x, 5);
  });

  it('keeps the outgoing clip moving when requested', () => {
    const { player, pose } = rig();
    player.crossfadeTo('greet', pose, { duration: 1, continueSource: true });
    player.tick(0.5); player.evaluate(pose);
    assert.equal(pose.positions[0].x, 5.25);
  });

  it('eases the weight at the start of a smooth transition', () => {
    const { player, pose } = rig();
    player.crossfadeTo('greet', pose, { duration: 1, continueSource: true, easing: 'smoothstep' });
    player.tick(0.25); player.evaluate(pose);
    assert.equal(pose.positions[0].x, 1.7734375);
  });

  it('starts an interrupted blend from the visible mixture', () => {
    const { player, pose } = rig();
    player.crossfadeTo('greet', pose, { duration: 1, continueSource: true });
    player.tick(0.5); player.evaluate(pose);
    const before = pose.positions[0].x;
    player.crossfadeTo('idle', pose, { duration: 1, continueSource: true });
    player.evaluate(pose);
    assert.equal(pose.positions[0].x, before);
    player.tick(1); player.evaluate(pose);
    assert.equal(pose.positions[0].x, 20);
  });
});
