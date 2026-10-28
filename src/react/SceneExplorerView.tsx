import type { CSSProperties, ReactNode } from 'react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

import type { ActionOptions, CollisionView, ExplorerLoadOptions, ExplorerProgress, SceneExplorer, SceneExplorerOptions, WalkerPose } from '../explorer/SceneExplorer.js';
import type { SceneLighting, SceneLightingOptions, SunLight } from '../lighting/SceneLighting.js';

export interface SceneExplorerHandle {
  /** Where the walker stands (world metres), or null before the scene shows. */
  getWalker(): WalkerPose | null;
  teleport(position: readonly [number, number, number], heading?: number): void;
  /** Back to the spawn point, camera and all. See `SceneExplorer.respawn`. */
  respawn(): void;
  /** Play a clip (`.glb` / `.anim`) on the walker; `null` stops it. See `SceneExplorer.playAction`. */
  playAction(url: string | null, opts?: ActionOptions): Promise<void>;
  /** The underlying explorer, once it exists. */
  readonly explorer: SceneExplorer | null;
}

export interface SceneExplorerViewProps extends SceneExplorerOptions, ExplorerLoadOptions {
  /**
   * A sun and the walker's shadow (`@viggle/scene-sdk/lighting`). Omit for the
   * scene's own light alone. A change to `azimuth`, `elevation` or
   * `intensity` alone moves the sun in place - smooth enough for a slider.
   */
  light?: SunLight | null;
  /** Draw the walls the walker collides with, for tuning (see `SceneExplorer.showCollision`). Default 'off'. */
  showCollision?: CollisionView;
  lightQuality?: SceneLightingOptions['quality'];
  /** A stick and a jump button over the canvas. Default: on a touch screen. */
  touchControls?: boolean;
  onReady?: () => void;
  onProgress?: (p: ExplorerProgress) => void;
  /** The action playing (its URL), or null when the walker is back to walking or standing. */
  onActionChange?: (url: string | null) => void;
  onError?: (err: Error) => void;
  className?: string;
  style?: CSSProperties;
  /** Overlays drawn over the canvas (the box is `position: relative`). */
  children?: ReactNode;
}

/**
 * Walk a character through a splat scene: WASD / arrows to walk, Shift to
 * run, Space to jump, drag to look round, wheel or pinch to zoom.
 *
 * THE ENGINE IS LOADED ON MOUNT, by dynamic import, so server rendering never
 * touches WebGL. A change to `scene`, `character` or `clips` loads again;
 * `light` alone relights in place.
 */
export const SceneExplorerView = forwardRef<SceneExplorerHandle, SceneExplorerViewProps>(function SceneExplorerView({
  background, fov,
  scene, character, clips, collision, walkerBehind, camera, speed,
  light, lightQuality, touchControls, showCollision = 'off',
  onReady, onProgress, onActionChange, onError, className, style, children,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [explorer, setExplorer] = useState<SceneExplorer | null>(null);
  const [loaded, setLoaded] = useState(0);
  const callbacks = useRef({ onReady, onProgress, onActionChange, onError });
  callbacks.current = { onReady, onProgress, onActionChange, onError };
  const touch = useCoarsePointer(touchControls);

  // One explorer per mount. The options are read once, at creation.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let made: SceneExplorer | null = null;
    let cancelled = false;
    import('../explorer/SceneExplorer.js')
      .then(({ SceneExplorer }) => SceneExplorer.create(canvas, { background, fov }))
      .then((e) => {
        if (cancelled) return e.destroy();
        e.onActionChange((url) => callbacks.current.onActionChange?.(url));
        setExplorer((made = e));
      })
      .catch((err) => { if (!cancelled) callbacks.current.onError?.(asError(err)); });
    return () => {
      cancelled = true;
      made?.destroy();
      setExplorer(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- creation-time options.
  }, []);

  // Inline objects are new every render: the load follows their content. The
  // character's URL is left out: a new one alone swaps the body in place.
  const load: ExplorerLoadOptions = { scene, character, clips, collision, walkerBehind, camera, speed };
  const loadKey = JSON.stringify({ ...load, character: { ...character, url: void 0 } });
  const loadRef = useRef(load);
  loadRef.current = load;
  /** The character on screen. */
  const shownCharacter = useRef<string | null>(null);
  useEffect(() => {
    if (!explorer) return;
    let live = true;
    const opts = loadRef.current;
    explorer.load(opts, (p) => live && callbacks.current.onProgress?.(p))
      .then(() => {
        if (!live) return;
        shownCharacter.current = opts.character.url;
        setLoaded((n) => n + 1);
        callbacks.current.onReady?.();
      })
      .catch((err) => { if (live) callbacks.current.onError?.(asError(err)); });
    return () => { live = false; };
  }, [explorer, loadKey]);

  useEffect(() => {
    const url = character.url;
    if (!explorer || !loaded || url === shownCharacter.current) return;
    shownCharacter.current = url;
    explorer.setCharacter({ url }).catch((err) => callbacks.current.onError?.(asError(err)));
  }, [explorer, loaded, character.url]);

  // The sun's direction and strength move the light in place; anything else builds it again.
  const lightKey = light ? JSON.stringify({ ...light, azimuth: 0, elevation: 0, intensity: 0 }) : '';
  const lightRef = useRef(light);
  lightRef.current = light;
  const lighting = useRef<SceneLighting | null>(null);
  useEffect(() => {
    const sun = lightRef.current;
    if (!explorer || !loaded || !sun) return;
    let live = true;
    import('../lighting/SceneLighting.js')
      .then(({ SceneLighting }) => {
        if (!live) return;
        lighting.current = SceneLighting.create(explorer, lightRef.current ?? sun, { quality: lightQuality });
      })
      .catch((err) => { if (live) callbacks.current.onError?.(asError(err)); });
    return () => {
      live = false;
      lighting.current?.destroy();
      lighting.current = null;
    };
  }, [explorer, loaded, lightKey, lightQuality]);
  useEffect(() => {
    if (light) lighting.current?.setSun({ azimuth: light.azimuth, elevation: light.elevation, intensity: light.intensity ?? 1.8 });
  }, [light?.azimuth, light?.elevation, light?.intensity]);

  useEffect(() => {
    explorer?.showCollision(showCollision);
  }, [explorer, showCollision]);

  useImperativeHandle(ref, () => ({
    getWalker: () => explorer?.getWalker() ?? null,
    teleport: (position, heading) => explorer?.teleport(position, heading),
    respawn: () => explorer?.respawn(),
    playAction: (url, opts) => explorer ? explorer.playAction(url, opts) : Promise.resolve(),
    get explorer() { return explorer; },
  }), [explorer]);

  return (
    <div className={className} data-viggle-scene-explorer="" style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', ...style }}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', touchAction: 'none', outline: 'none' }}
      />
      {touch && explorer && loaded > 0 && <TouchControls explorer={explorer} />}
      {children}
    </div>
  );
});

/** Stick radius, CSS px. */
const STICK = 56;

/** A stick bottom-left that walks (runs past the rim's edge), a jump button bottom-right. */
function TouchControls({ explorer }: { explorer: SceneExplorer }) {
  const [knob, setKnob] = useState<{ x: number; y: number } | null>(null);
  const origin = useRef<{ x: number; y: number; id: number } | null>(null);
  useEffect(() => () => explorer.setMove(null), [explorer]);

  const moveTo = (e: React.PointerEvent) => {
    const o = origin.current;
    if (!o || e.pointerId !== o.id) return;
    let dx = e.clientX - o.x, dy = e.clientY - o.y;
    const d = Math.hypot(dx, dy);
    if (d > STICK) { dx *= STICK / d; dy *= STICK / d; }
    setKnob({ x: dx, y: dy });
    explorer.setMove({ x: dx / STICK, z: -dy / STICK, run: d > STICK * 1.15 });
  };
  const release = (e: React.PointerEvent) => {
    if (origin.current?.id !== e.pointerId) return;
    origin.current = null;
    setKnob(null);
    explorer.setMove(null);
  };
  const pad: CSSProperties = { position: 'absolute', bottom: 24, width: STICK * 2, height: STICK * 2, borderRadius: '50%', touchAction: 'none', userSelect: 'none' };
  return (
    <>
      <div
        data-viggle-part="stick"
        style={{ ...pad, left: 24, background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.3)' }}
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          origin.current = { x: r.left + r.width / 2, y: r.top + r.height / 2, id: e.pointerId };
          e.currentTarget.setPointerCapture(e.pointerId);
          moveTo(e);
        }}
        onPointerMove={moveTo}
        onPointerUp={release}
        onPointerCancel={release}
      >
        <div style={{ position: 'absolute', left: STICK - 22, top: STICK - 22, width: 44, height: 44, borderRadius: '50%', background: 'rgba(255,255,255,0.5)', transform: `translate(${knob?.x ?? 0}px, ${knob?.y ?? 0}px)`, pointerEvents: 'none' }} />
      </div>
      <button
        type="button"
        data-viggle-part="jump"
        aria-label="Jump"
        style={{ ...pad, right: 24, width: 72, height: 72, border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.12)', color: '#fff', font: '600 13px system-ui' }}
        onPointerDown={(e) => { e.preventDefault(); explorer.jump(); }}
      >
        Jump
      </button>
    </>
  );
}

function useCoarsePointer(forced: boolean | undefined): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (forced !== undefined || typeof matchMedia === 'undefined') return;
    const q = matchMedia('(pointer: coarse)');
    const update = () => setCoarse(q.matches);
    update();
    q.addEventListener('change', update);
    return () => q.removeEventListener('change', update);
  }, [forced]);
  return forced ?? coarse;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
