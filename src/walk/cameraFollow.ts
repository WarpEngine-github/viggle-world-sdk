/**
 * The follow camera's lazy swing, as a third-person game has it: while the player walks, the camera drifts round behind the way
 * they are going, slowly, so the view leads where they head without ever snapping. Walking back toward the camera leaves it where
 * it is (swinging there would spin the view), and a turn by the reader holds it off for a moment. Pure arithmetic on degrees and
 * metres a second; the rig measures the walk and writes the yaw.
 */
export const FOLLOW = {
  /** Metres a second below which the player is standing, and the camera stays put. */
  minSpeed: 0.4,
  /** Metres a second at which the swing reaches its full rate (a walk; a run swings no faster). */
  fullSpeed: 1.5,
  /** Per second, at full speed: the share of the way round still to go that is closed in a second (a 90 degree swing starts at 45 degrees a second). */
  rate: 0.5,
  /** Degrees off "behind" past which the player is walking toward the camera: no swing. */
  maxSwing: 120,
  /** Seconds a turn by the reader holds the swing off. */
  holdSeconds: 1.5,
  /** Seconds the walk's velocity is smoothed over, so a stride's sway or a footstep on a stair does not twitch the view. */
  smoothSeconds: 0.25,
} as const;

/** `a` in (-180, 180]. */
export const wrapDeg = (a: number): number => {
  const w = ((a + 180) % 360 + 360) % 360 - 180;
  return w === -180 ? 180 : w;
};

/** The orbit yaw of a camera straight behind a player moving along (vx, vz): the orbit puts its eye at target + d (sin yaw, cos yaw). */
export const yawBehind = (vx: number, vz: number): number => (Math.atan2(-vx, -vz) * 180) / Math.PI;

/** The orbit's yaw one frame later, swung toward behind a player walking at (vx, vz) metres a second. */
export function followYaw(yaw: number, vx: number, vz: number, dt: number, options: typeof FOLLOW = FOLLOW): number {
  const speed = Math.hypot(vx, vz);
  if (speed < options.minSpeed || dt <= 0) return yaw;
  const off = wrapDeg(yawBehind(vx, vz) - yaw);
  if (Math.abs(off) > options.maxSwing) return yaw;
  const k = 1 - Math.exp(-options.rate * Math.min(1, speed / options.fullSpeed) * dt);
  return yaw + off * k;
}
