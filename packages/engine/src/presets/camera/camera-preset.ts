import type { Entity } from 'playcanvas';

/**
 * Host context every camera preset attaches to. Both fields are provided by
 * whoever owns the scene - that is, whatever code constructed it.
 *
 * @group Presets
 * @category Camera
 */
export interface CameraHost {
  canvas: HTMLCanvasElement;
  cameraEntity: Entity;
}

/**
 * The shape every built-in (and agent-registered) camera conforms to.
 * Lets the loader treat all camera types uniformly: construct with config,
 * `attach` to the host, `update` each frame, `detach` on teardown.
 *
 * @group Presets
 * @category Camera
 */
export interface CameraPreset {
  attach(host: CameraHost): void;
  update(dt: number): void;
  detach(): void;
  /** Exposed so controllers can use camera yaw to interpret movement input. */
  readonly yaw: number;
}

/**
 * Position supplier - what a camera follows. Plain object so both
 * `Vec3`/`Vec3-like` values and ad-hoc literals satisfy it.
 *
 * @group Presets
 * @category Camera
 */
export type Vec3Like = { x: number; y: number; z: number };

/**
 * @group Presets
 * @category Camera
 */
export type TargetSupplier = () => Vec3Like;
