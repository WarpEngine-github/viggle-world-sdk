/**
 * How a character reveal looks: a bright band that walks the skeleton from
 * feet to head, with sparse sketch dots just ahead of it. Distances are
 * fractions of that feet-to-head path. Every field is optional; unset fields
 * keep their current value. See {@link Character.setReveal}.
 *
 * @group Splats
 */
export interface RevealLook {
  /** Width of the bright band behind the front. */
  bandWidth?: number;
  /** Share of the band held at full brightness before it fades, 0-1. */
  bandHold?: number;
  /** Longest a splat may stretch inside the band, in multiples of its shortest axis. */
  bandMaxStretch?: number;
  /** How far ahead of the front the sketch dots start. */
  sketchLead?: number;
  /** Share of splats drawn as sketch dots, 0-1. */
  sketchDensity?: number;
  /** Size of a sketch dot relative to its splat. */
  sketchScale?: number;
  /** Colour the band leans toward, 0-1 per channel. */
  tint?: { r: number; g: number; b: number };
  /** Luminance below which the band is lifted toward {@link tint}. */
  tintFloor?: number;
}

/** The engine's default reveal look. */
export const DEFAULT_REVEAL_LOOK: Readonly<Required<RevealLook>> = Object.freeze({
  bandWidth: 0.07,
  bandHold: 0.6,
  bandMaxStretch: 2.5,
  sketchLead: 0.07,
  sketchDensity: 0.15,
  sketchScale: 0.35,
  tint: Object.freeze({ r: 0.55, g: 0.9, b: 1.0 }),
  tintFloor: 0.5,
});

/**
 * The default look for an ENVIRONMENT reveal, where the sweep is radial
 * distance from the capture point rather than a path up a body. Distances are
 * fractions of the room's radius either way, so these are the same numbers
 * read against a different subject - and the subject is what moves them.
 *
 * A body's feet-to-head coordinate is a line: a narrow band shows a thin ring
 * of it, and a sweep up it is legible. A room's radius is a SHELL, and a
 * Flow2D capture keeps most of its splats in the one shell that is its walls,
 * so the character's 0.07 band crosses nearly the whole room in a single
 * instant - a flashbulb, not an assembly. The band is wider here and holds
 * less of its width at full brightness, which turns that slab into a front
 * with a falloff behind it; a wide band at the character's 0.6 hold would be
 * a wall of white across the entire frame instead.
 *
 * The dots thin out for the same reason. A character is a few hundred
 * thousand splats in the middle of the frame, where 15% of them reads as a
 * sketch; a scene is millions of them filling it edge to edge, where 15%
 * reads as fog. They also lead by more than the band is wide, so the shape of
 * the room is legible just before it lands.
 *
 * The colour is deliberately the character's, unchanged: the two reveals are
 * one effect seen on two subjects, and a scene that assembled in a different
 * hue would say they were not.
 */
export const DEFAULT_ENV_REVEAL_LOOK: Readonly<Required<RevealLook>> = Object.freeze({
  bandWidth: 0.16,
  bandHold: 0.35,
  bandMaxStretch: 2.5,
  sketchLead: 0.18,
  sketchDensity: 0.08,
  sketchScale: 0.3,
  tint: Object.freeze({ r: 0.55, g: 0.9, b: 1.0 }),
  tintFloor: 0.5,
});

/**
 * Write the set fields of `look` into the shader's three uniforms:
 * `band` = (width, hold, max stretch), `sketch` = (lead, density, dot scale),
 * `tint` = (r, g, b, luminance floor).
 */
export function packRevealLook(
  look: RevealLook,
  band: Float32Array,
  sketch: Float32Array,
  tint: Float32Array,
): void {
  if (look.bandWidth !== undefined) band[0] = look.bandWidth;
  if (look.bandHold !== undefined) band[1] = look.bandHold;
  if (look.bandMaxStretch !== undefined) band[2] = look.bandMaxStretch;
  if (look.sketchLead !== undefined) sketch[0] = look.sketchLead;
  if (look.sketchDensity !== undefined) sketch[1] = look.sketchDensity;
  if (look.sketchScale !== undefined) sketch[2] = look.sketchScale;
  if (look.tint) { tint[0] = look.tint.r; tint[1] = look.tint.g; tint[2] = look.tint.b; }
  if (look.tintFloor !== undefined) tint[3] = look.tintFloor;
}
