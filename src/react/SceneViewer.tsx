import type { CSSProperties, ReactNode } from 'react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

import type { ScenePose, ViggleScene } from '../core/types.js';
import type { LoadProgress, SceneRenderer, SceneRendererOptions } from '../viewer/renderer.js';

export interface SceneViewerHandle {
  /** Where the camera stands, in the pose frame - pass it to `expand`. Null before the scene shows. */
  getPose(): ScenePose | null;
  /** Cut the camera to a pose. */
  setPose(pose: ScenePose): void;
  resetCamera(): void;
  /** The camera's vertical field of view, degrees: send it with an expand. */
  readonly fov: number;
  /** The underlying renderer, once it exists. */
  readonly renderer: SceneRenderer | null;
}

export interface SceneViewerProps extends SceneRendererOptions {
  scene: ViggleScene | null | undefined;
  /** Which version to show (index into `scene.versions`). Default: the last. */
  versionIndex?: number | null;
  onLoadingChange?: (loading: boolean) => void;
  onProgress?: (p: LoadProgress) => void;
  onError?: (err: Error) => void;
  className?: string;
  style?: CSSProperties;
  /** Overlays drawn over the canvas (the box is `position: relative`). */
  children?: ReactNode;
}

/**
 * The 3D view of a scene: a WebGL canvas filling its box, with the free-fly
 * camera (drag to look, WASD / QE to move, right-drag to pan, wheel to dolly).
 *
 * THE ENGINE IS LOADED ON MOUNT, by dynamic import, not by importing this
 * module - so server rendering never touches WebGL and an app pays for the
 * engine only on the page that shows a scene.
 *
 * Changing the version swaps the splat in place and keeps the camera where it
 * is, so an expand and the version before it compare at one vantage. A new
 * session starts at the capture point.
 */
export const SceneViewer = forwardRef<SceneViewerHandle, SceneViewerProps>(function SceneViewer({
  scene, versionIndex, onLoadingChange, onProgress, onError,
  className, style, children, background, fov = 60, flySpeed,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderer, setRenderer] = useState<SceneRenderer | null>(null);
  const callbacks = useRef({ onLoadingChange, onProgress, onError });
  callbacks.current = { onLoadingChange, onProgress, onError };

  // One renderer per mount. The options are read once, at creation.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let made: SceneRenderer | null = null;
    let cancelled = false;
    import('../viewer/renderer.js')
      .then(({ SceneRenderer }) => SceneRenderer.create(canvas, { background, fov, flySpeed }))
      .then((r) => {
        if (cancelled) r.destroy();
        else setRenderer((made = r));
      })
      .catch((err) => { if (!cancelled) callbacks.current.onError?.(asError(err)); });
    return () => {
      cancelled = true;
      made?.destroy();
      setRenderer(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- creation-time options.
  }, []);

  const versions = scene?.versions ?? [];
  const version = versions[versionIndex ?? versions.length - 1];
  // The URL is re-signed on every read, so the key is the task that made the
  // file, not the URL.
  const loadKey = scene && version ? `${scene.sessionId}#${version.taskId}` : '';
  const urlRef = useRef(version?.splatUrl);
  urlRef.current = version?.splatUrl;
  const firstLoadRef = useRef(true);

  // A different session is a fresh start. Declared before the load below so
  // it runs first when both change.
  const sessionId = scene?.sessionId;
  useEffect(() => { firstLoadRef.current = true; }, [sessionId]);

  useEffect(() => {
    if (!renderer) return;
    let live = true;
    const isFirst = firstLoadRef.current;
    const url = urlRef.current;
    callbacks.current.onLoadingChange?.(true);
    renderer.load(url ? [url] : [], (p) => live && callbacks.current.onProgress?.(p))
      .then(() => {
        if (!live) return;
        if (isFirst && url) {
          renderer.resetCamera();
          firstLoadRef.current = false;
        }
        callbacks.current.onLoadingChange?.(false);
      })
      .catch((err) => {
        if (!live) return;
        callbacks.current.onLoadingChange?.(false);
        callbacks.current.onError?.(asError(err));
      });
    return () => { live = false; };
  }, [renderer, loadKey]);

  useImperativeHandle(ref, () => ({
    getPose: () => renderer?.getPose() ?? null,
    setPose: (pose) => renderer?.setPose(pose),
    resetCamera: () => renderer?.resetCamera(),
    get fov() { return renderer?.fov ?? fov; },
    get renderer() { return renderer; },
  }), [renderer, fov]);

  return (
    <div className={className} data-viggle-scene-viewer="" style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', ...style }}>
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
      />
      {children}
    </div>
  );
});

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
