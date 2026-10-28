import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_REVEAL_LOOK, packRevealLook } from './reveal-look.ts';

const f32 = (values: number[]) => Array.from(new Float32Array(values));

describe('packRevealLook', () => {
  it('packs the default look into the shader uniforms', () => {
    const band = new Float32Array(4);
    const sketch = new Float32Array(4);
    const tint = new Float32Array(4);
    packRevealLook(DEFAULT_REVEAL_LOOK, band, sketch, tint);
    assert.deepEqual(Array.from(band), f32([0.07, 0.6, 2.5, 0]));
    assert.deepEqual(Array.from(sketch), f32([0.07, 0.15, 0.35, 0]));
    assert.deepEqual(Array.from(tint), f32([0.55, 0.9, 1.0, 0.5]));
  });

  it('keeps the fields a partial look leaves unset', () => {
    const band = new Float32Array([0.07, 0.6, 2.5, 0]);
    const sketch = new Float32Array(4);
    const tint = new Float32Array([0.55, 0.9, 1.0, 0.5]);
    packRevealLook({ bandWidth: 0.2, tint: { r: 1, g: 0, b: 0 } }, band, sketch, tint);
    assert.deepEqual(Array.from(band), f32([0.2, 0.6, 2.5, 0]));
    assert.deepEqual(Array.from(tint), f32([1, 0, 0, 0.5]));
  });
});
