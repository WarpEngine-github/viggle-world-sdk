import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FOLLOW, followYaw, wrapDeg, yawBehind } from './cameraFollow.js';

describe('yawBehind', () => {
  it('puts the camera opposite the way the player walks', () => {
    // Walking toward -z: the camera sits at +z, which is yaw 0.
    assert.ok(Math.abs(yawBehind(0, -1)) < 1e-9);
    assert.ok(Math.abs(yawBehind(1, 0) - -90) < 1e-9);
  });
});

describe('followYaw', () => {
  it('leaves the camera alone while the player stands', () => {
    assert.equal(followYaw(30, 0.1, 0, 1 / 30), 30);
  });

  it('swings slowly round behind a player walking across the view', () => {
    let yaw = 0;
    const next = followYaw(yaw, 1.5, 0, 1 / 30);
    assert.ok(next < 0 && next > -2, `${next}`);
    for (let i = 0; i < 30 * 9; i++) yaw = followYaw(yaw, 1.5, 0, 1 / 30);
    assert.ok(Math.abs(yaw - -90) < 2, `${yaw}`);
  });

  it('swings the short way round', () => {
    const next = followYaw(170, 1, 0, 1 / 30);
    const behind = yawBehind(1, 0);
    assert.ok(Math.abs(wrapDeg(behind - next)) < Math.abs(wrapDeg(behind - 170)));
  });

  it('does not spin when the player walks toward the camera', () => {
    assert.equal(followYaw(0, 0, 1.5, 1 / 30), 0);
    assert.equal(followYaw(0, 0.3, 1.5, 1 / 30), 0);
  });

  it('swings slower at a stroll than at a walk', () => {
    const stroll = Math.abs(followYaw(0, FOLLOW.minSpeed + 0.1, 0, 1 / 30));
    const walk = Math.abs(followYaw(0, FOLLOW.fullSpeed, 0, 1 / 30));
    assert.ok(stroll < walk);
  });
});
