import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REST_TRANSLATIONS } from './skeleton-data.ts';
import { REST_TRANSLATIONS_441 } from './skeleton-data-441.ts';

/**
 * The two character containers ground differently, and every consumer of this
 * engine places characters assuming "model origin == ground contact". These pin
 * the facts that assumption rests on, because a `.vsplat` character silently
 * floated its whole bake shift when they drifted apart.
 *
 * The correction itself is `Character.bakedGroundShiftY` and the
 * `groundToEntityY` / `entityToGroundY` pair built on it - see the shim block
 * in `character.ts` for the measured numbers and for when to delete it.
 */
describe('ground contact convention', () => {
  it('the canonical rest root sits exactly at the origin', () => {
    // This is what makes "origin == ground contact" true for a legacy bundle:
    // bone 0 contributes nothing, so the rig hangs off world zero. A `VIGGCHAR`
    // v1 bundle puts its baked ground shift in this row instead, which is why a
    // v1 character needs that shift subtracted back out when placed.
    for (const [name, table] of [
      ['86-bone', REST_TRANSLATIONS],
      ['441-bone', REST_TRANSLATIONS_441],
    ] as const) {
      const t = table as unknown as number[];
      // `+ 0` normalises the -0 the 441 table stores; deepStrictEqual would
      // otherwise separate them, and a signed zero is still the origin.
      assert.deepEqual(
        [t[0] + 0, t[1] + 0, t[2] + 0],
        [0, 0, 0],
        `${name} rig: root row must be the origin`,
      );
    }
  });

  it('both rigs agree on the root and pelvis rows', () => {
    // Character.load picks between them on bone count; if they disagreed about
    // the root, the ground convention would depend on which rig a character
    // happened to use.
    // Compared with a tolerance: the two tables are authored to different
    // decimal precision (0.0233437 vs 0.023344), which is not a disagreement
    // about where the bones are.
    const a = REST_TRANSLATIONS as unknown as number[];
    const b = REST_TRANSLATIONS_441 as unknown as number[];
    for (let i = 0; i < 6; i++) {
      assert.ok(
        Math.abs(a[i] - b[i]) < 1e-5,
        `row ${Math.floor(i / 3)} component ${i % 3}: ${a[i]} vs ${b[i]}`,
      );
    }
  });
});
