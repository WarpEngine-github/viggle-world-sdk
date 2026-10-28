import { walkerAperture } from './floorIndex.js';
import type { WalkParams } from './controller.js';
import { JUMP_CLIP_AIR_S } from './locomotion.js';

/** The walk's feel, every number a multiple of the body's height so a child and a giant move alike. */
export const WALK_TUNING = {
  /** Walk speed, body heights a second. */
  pace: 0.8,
  runMultiplier: 2,
  /** Gravity, body heights a second squared. */
  gravity: 24,
  /** How much a move steers in the air, 0..1. */
  airControl: 0.7,
  /** Tallest step, as a fraction of the body: a 1.7 m body steps 0.42 m. */
  stepFraction: 0.25,
  /** Degrees a second the body turns toward its move. */
  turnRate: 540,
  /** How fast a step's height eases in, per second. */
  settle: 12,
} as const;

/** The jump's apex, in body heights, timed so the flight matches the jump clip's air section. */
const JUMP_APEX = (WALK_TUNING.gravity * (JUMP_CLIP_AIR_S / 2) ** 2) / 2;

/**
 * Walk parameters for a body `height` world units tall, on a floor index of
 * cell `cell`. `walls` turns on the step lookahead a voxel collider needs.
 */
export function walkParamsFor(height: number, cell: number, walls: boolean, speed = 1): WalkParams {
  const t = WALK_TUNING;
  return {
    speed: height * t.pace * speed,
    runMultiplier: t.runMultiplier,
    reach: walkerAperture(height, cell),
    stepLimit: height * t.stepFraction,
    turnRate: t.turnRate,
    settle: t.settle,
    jumpSpeed: Math.sqrt(2 * t.gravity * height * JUMP_APEX * height),
    gravity: t.gravity * height,
    airControl: t.airControl,
    // A rise over a fifth of her height is a wall, not a slope.
    lookahead: walls ? height * 0.2 : 0,
  };
}
