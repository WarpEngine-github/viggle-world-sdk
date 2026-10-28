/**
 * Walk mode's locomotion state machine (docs/SCENE_CANVAS_CHROME_PLAN.md,
 * Walk Locomotion studies 2026-09-22). Four premade clips, one machine:
 *
 *   Idle ⇄ Walk ⇄ Run          ground states, from the move vector + Shift
 *   any ground → Jump → ground  a one-shot in three phases: take-off, air, land
 *
 * The jump follows the clip, not the key: the press starts the take-off
 * (the clip's crouch), the controller launches the body when the clip's
 * feet leave the ground, and touching down seeks the clip to its landing
 * so the recovery plays on the floor. Measured on the baked Mixamo
 * "Jumping" (public/assets/locomotion/jumping.fbx, 1.9 s): feet leave at
 * 0.50 s, land at 1.10 s, upright by 1.70 s.
 *
 * Pure. The viewer feeds it the walker's state each frame and gets back
 * which clip to be on, how far into a blend it is, and what the controller
 * should do about gravity. Time is seconds; nothing else has a unit.
 */

export type GroundState = 'idle' | 'walk' | 'run';
export type JumpPhase = 'takeoff' | 'air' | 'land';
export type LocoState = GroundState | 'jump';

export interface LocoInput {
  moving: boolean;
  running: boolean;
  /** Space is held this frame. */
  jump: boolean;
  /** The walker is off the floor (its own vertical motion). */
  airborne: boolean;
}

export interface LocoMachine {
  state: LocoState;
  /** Set while `state === 'jump'`. */
  phase: JumpPhase | null;
  /** Seconds into the current jump phase. */
  phaseT: number;
  /** The state before the current one, for the blend. */
  prev: LocoState | null;
  /** Seconds since the last state change. */
  sinceChange: number;
}

export interface LocoStep {
  machine: LocoMachine;
  /** The clip the armature should be on now. */
  clip: LocoState;
  /** True on the frame the clip changed: crossfade with `blend` seconds. */
  changed: boolean;
  blend: number;
  /** True on the frame the take-off ends: the controller launches. */
  launch: boolean;
  /** True on the frame the walker touches down: seek the jump clip to
   *  {@link JUMP_CLIP_LAND_S} so the recovery plays on the floor. */
  landed: boolean;
  /** Playback rate for the ground clips (feet follow the actual speed). */
  rate: number;
}

/** Crossfade into each state, seconds (Walk Locomotion study 1). */
export const LOCO_BLEND: Record<LocoState, number> = { idle: 0.2, walk: 0.15, run: 0.2, jump: 0.08 };
/** Playback rate of the jump clip (Walker Jump Tuner, 2026-09-23). The
 *  phases and the flight scale by it, so the clip's feet still leave and
 *  land with the body. */
export const JUMP_RATE = 1.4;
/** Jump phase lengths, seconds of wall time, from the clip at JUMP_RATE:
 *  take-off = crouch until the feet leave (clip 0.50 s), land = touchdown
 *  until upright (clip 1.10 → 1.70 s). `air` is a cap: landing ends it early. */
export const JUMP_PHASE: Record<JumpPhase, number> = { takeoff: 0.5 / JUMP_RATE, air: 2.0, land: 0.6 / JUMP_RATE };
/** Clip time, seconds, where the jump clip's feet touch down. */
export const JUMP_CLIP_LAND_S = 1.1;
/** Flight time the clip's air section wants, seconds of wall time (clip
 *  0.50 → 1.10 s at JUMP_RATE). The controller's arc is tuned to it
 *  (Viewer3D JUMP_APEX). */
export const JUMP_CLIP_AIR_S = 0.6 / JUMP_RATE;
/** Ground clips speed up or slow down with the walker, within these bands. The walk's floor is low so a touch
 *  stick's gentle push walks slowly instead of sliding. */
const RATE_BAND: Record<GroundState, [number, number]> = { idle: [1, 1], walk: [0.6, 1.1], run: [0.9, 1.1] };

export function createLocoMachine(): LocoMachine {
  return { state: 'idle', phase: null, phaseT: 0, prev: null, sinceChange: 0 };
}

function groundFor(input: LocoInput): GroundState {
  if (!input.moving) return 'idle';
  return input.running ? 'run' : 'walk';
}

/**
 * Advance the machine by `dt`. `speedRatio` is the walker's actual ground
 * speed over the clip's nominal speed (1 when they match), used for the
 * playback rate.
 */
export function stepLocomotion(machine: LocoMachine, input: LocoInput, dt: number, speedRatio = 1): LocoStep {
  const m: LocoMachine = { ...machine, sinceChange: machine.sinceChange + dt };
  let launch = false;
  let landed = false;

  if (m.state === 'jump') {
    m.phaseT += dt;
    if (m.phase === 'takeoff' && m.phaseT >= JUMP_PHASE.takeoff) {
      // The clip's feet leave the ground now: the controller launches this
      // frame, so the walker is not airborne yet — the landing test below
      // waits for the next frame.
      m.phase = 'air'; m.phaseT = 0; launch = true;
    } else if (m.phase === 'air' && (!input.airborne || m.phaseT >= JUMP_PHASE.air)) {
      m.phase = 'land'; m.phaseT = 0; landed = true;
    }
    if (m.phase === 'land' && m.phaseT >= JUMP_PHASE.land) {
      m.prev = 'jump';
      m.state = groundFor(input);
      m.phase = null;
      m.phaseT = 0;
      m.sinceChange = 0;
    }
  } else if (input.jump && !input.airborne) {
    m.prev = m.state;
    m.state = 'jump';
    m.phase = 'takeoff';
    m.phaseT = 0;
    m.sinceChange = 0;
  } else {
    const next = groundFor(input);
    if (next !== m.state) {
      m.prev = m.state;
      m.state = next;
      m.sinceChange = 0;
    }
  }

  const changed = m.sinceChange === 0;
  const band = m.state === 'jump' ? null : RATE_BAND[m.state];
  const rate = band ? Math.min(band[1], Math.max(band[0], speedRatio || 1)) : 1;
  return { machine: m, clip: m.state, changed, blend: LOCO_BLEND[m.state], launch, landed, rate };
}
