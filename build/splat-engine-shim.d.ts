// The slice of @viggle/splat-engine this package uses, for the declaration
// build only (tsconfig.build.json). Typecheck and the bundle use the real one.

interface ShimVec3 { x: number; y: number; z: number }

interface ShimEntity {
  getPosition(): ShimVec3;
  setPosition(x: number, y: number, z: number): void;
  readonly forward: ShimVec3;
  destroy(): void;
}

export declare class Scene {
  static create(canvas: HTMLCanvasElement, opts?: Record<string, unknown>): Promise<Scene>;
  readonly app: { on(event: 'update', cb: (dt: number) => void): void };
  readonly cameraEntity: ShimEntity;
  start(): void;
  destroy(): void;
}

export declare class Environment {
  static load(scene: Scene, url: string, opts?: Record<string, unknown>): Promise<Environment>;
  readonly entity: ShimEntity;
  destroy(): void;
}

export declare class FlyControls {
  constructor(opts?: Record<string, unknown>);
  attach(host: { canvas: HTMLCanvasElement; cameraEntity: ShimEntity }): void;
  detach(): void;
  update(dt: number): void;
  setOrientation(yaw: number, pitch: number): void;
  syncFromCamera(): void;
}
