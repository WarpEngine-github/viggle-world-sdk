import type { Character } from '../../character';
import type { RevealLook } from '../../splat/reveal-look';

/**
 * What {@link playReveal} drives: a splat {@link Character} or a mesh
 * character, on either side of a handoff.
 *
 * @group Characters & Animation
 */
export type RevealTarget = Pick<Character, 'armature' | 'destroyed' | 'setReveal' | 'setRevealLook'>;

/**
 * How {@link playReveal} animates. Times are milliseconds of wall clock, so a
 * reveal keeps its length through dropped frames.
 *
 * @group Characters & Animation
 */
export interface RevealPreset {
  /** Length of a full 0 → 1 sweep. */
  duration: number;
  /** Maps linear progress in [0, 1] to reveal amount in [0, 1]. */
  ease: (t: number) => number;
  /**
   * While any frame takes longer than this, the sweep holds at its start - a
   * character's first frames after loading drop several in a row, and
   * advancing through them would spend the sweep in a few jumps.
   */
  settleFrameMs: number;
  /** Longest the sweep waits for frames to settle. 0 starts at once. */
  settleTimeoutMs: number;
  /** Length {@link RevealRun.speedUp} shortens a full sweep to. */
  interruptedDuration: number;
  /** Applied to both characters when the run starts. Unset keeps their own. */
  look?: RevealLook;
}

/** Quadratic ease-out. */
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

/**
 * The engine's default reveal timing.
 *
 * @group Characters & Animation
 */
export const DEFAULT_REVEAL_PRESET: Readonly<RevealPreset> = Object.freeze({
  duration: 500,
  ease: easeOut,
  settleFrameMs: 24,
  settleTimeoutMs: 400,
  interruptedDuration: 180,
});

/**
 * Options for {@link playReveal}.
 *
 * @group Characters & Animation
 */
export interface PlayRevealOptions {
  /** Dissolves on the same clock as the incoming character appears. */
  outgoing?: RevealTarget | null;
  /** Reveal amount to start from, so an interrupted sweep continues. Default 0. */
  from?: number;
  /** Overrides on {@link DEFAULT_REVEAL_PRESET}. */
  preset?: Partial<RevealPreset>;
  /** Called every frame with the incoming character's reveal amount. */
  onProgress?: (amount: number) => void;
}

/**
 * A running {@link playReveal}.
 *
 * @group Characters & Animation
 */
export interface RevealRun {
  /** Resolves true once the sweep completes, false if cancelled first. */
  readonly finished: Promise<boolean>;
  /** The incoming character's current reveal amount. */
  readonly amount: number;
  /** Finish the rest of the sweep at the pace of a `ms` full sweep. */
  speedUp(ms?: number): void;
  /** Stop where it is. Both characters keep their current reveal amount. */
  cancel(): void;
}

interface UpdateSource {
  on(event: 'update', fn: () => void): unknown;
  off(event: 'update', fn: () => void): unknown;
}

/**
 * Reveal `incoming` - a bright front walking its skeleton from feet to head -
 * and, given an `outgoing` character, dissolve that one on the same clock so
 * one character hands off to the next. Runs on the scene's update loop.
 *
 * The caller keeps ownership: nothing is destroyed or hidden when the run
 * ends. Call {@link Character.prepareReveal} after loading so the first frame
 * of the sweep does not pay the one-time setup.
 *
 * @example
 * ```ts
 * const next = await Character.load(scene, url);
 * next.setReveal(0);
 * const run = playReveal(next, { outgoing: current });
 * if (await run.finished) current.destroy();
 * ```
 *
 * @group Characters & Animation
 */
export function playReveal(incoming: RevealTarget, options: PlayRevealOptions = {}): RevealRun {
  const preset: RevealPreset = { ...DEFAULT_REVEAL_PRESET, ...options.preset };
  const outgoing = options.outgoing ?? null;
  const from = Math.min(1, Math.max(0, options.from ?? 0));
  const app = incoming.armature.scene?.app as UpdateSource | undefined;

  if (preset.look) {
    incoming.setRevealLook(preset.look);
    outgoing?.setRevealLook(preset.look);
  }

  let amount = from;
  // A sweep that starts part-way is shorter by the part already shown.
  let duration = preset.duration * (1 - from);
  let progress = 0;
  let previous = performance.now();
  const started = previous;
  let done = false;
  let resolve!: (completed: boolean) => void;
  const finished = new Promise<boolean>((r) => { resolve = r; });

  const apply = (value: number) => {
    amount = value;
    incoming.setReveal(value);
    outgoing?.setReveal(value, true);
    options.onProgress?.(value);
  };
  const end = (completed: boolean) => {
    if (done) return;
    done = true;
    app?.off('update', tick);
    resolve(completed);
  };
  function tick() {
    if (done) return;
    // A destroyed character's textures are gone; writing its reveal would throw.
    if (incoming.destroyed || outgoing?.destroyed) {
      end(false);
      return;
    }
    const now = performance.now();
    const gap = now - previous;
    previous = now;
    if (progress === 0 && gap > preset.settleFrameMs
        && now - started < preset.settleTimeoutMs) {
      return;
    }
    progress = duration > 0 ? Math.min(1, progress + Math.max(0, gap) / duration) : 1;
    apply(from + (1 - from) * preset.ease(progress));
    if (progress >= 1) end(true);
  }

  if (!app || duration <= 0) {
    // Straight to the end: setting `from` first would opt both characters in.
    apply(1);
    end(true);
  } else {
    apply(from);
    app.on('update', tick);
  }

  return {
    finished,
    get amount() { return amount; },
    speedUp(ms = preset.interruptedDuration) {
      duration = Math.min(duration, ms * (1 - from));
    },
    cancel() { end(false); },
  };
}
