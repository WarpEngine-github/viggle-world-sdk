import {
  ADDRESS_CLAMP_TO_EDGE,
  Color,
  Entity,
  EVENT_PRERENDER_LAYER,
  FILTER_LINEAR,
  Layer,
  LAYERID_WORLD,
  MeshInstance,
  PIXELFORMAT_RGBA8,
  QuadRender,
  RenderTarget,
  SEMANTIC_POSITION,
  ShaderUtils,
  Texture,
} from 'playcanvas';
import type { CameraComponent, GraphicsDevice } from 'playcanvas';

import type { Scene } from '../../scene';
import { getOutlineMarkMaterial } from './outline-mark-material';
import {
  expandFragmentGLSL,
  expandFragmentWGSL,
} from './outline-shaders';
import {
  createSplatMarkClone,
  type SplatCloneHandle,
} from './outline-splat-path';
import type {
  OutlineAddOptions,
  OutlineEffectOptions,
} from './outline-types';

interface TagEntry {
  entity: Entity;
  markMeshInstances: MeshInstance[];
  splatClones: SplatCloneHandle[];
}

/**
 * Per-object outline effect (v4 - custom post-processing system).
 *
 * Runs a three-step pipeline each frame any entity is tagged:
 *
 *   1. A dedicated **mask camera**, parented to the main camera so
 *      world transforms stay locked, renders the **mark layer** into
 *      an offscreen `maskRT`. The mark layer contains clone mesh
 *      instances of every tagged entity's meshes, drawn with a
 *      flat-white unlit material (see `outline-mark-material.ts`), plus
 *      every tagged `gsplat` component, which is put on the mark layer
 *      as well (see `outline-splat-path.ts`). Result: the mask RT holds
 *      alpha ≈1 inside each tagged silhouette and 0 elsewhere.
 *
 *   2. On `EVENT_PRERENDER_LAYER` for `(mainCamera, World, transparent)`
 *      - fired after World-opaque + sky but before any transparent
 *      scene geometry - a **fullscreen quad** runs the expand
 *      fragment shader (`outline-shaders.ts:expandFragmentGLSL`). The
 *      shader samples the mask in an 8-tap ring of `thicknessPx`
 *      pixels, discards pixels whose centre is inside the silhouette
 *      (fill) or whose ring never touches the silhouette (untagged
 *      area), and emits the outline colour for the remaining boundary
 *      pixels.
 *
 *   3. The quad writes directly onto the main backbuffer at that
 *      event, alpha-blending the outline over whatever the main
 *      camera has rendered so far.
 *
 * ── Why not use PC's `OutlineRenderer` ──
 * PC 2.18 ships `OutlineRenderer` but it has a shader-option bug:
 * `onUpdateShader` returns a `StandardMaterialOptions` without
 * `emissiveMap`, so the outline pass shader compiles without emissive
 * texture sampling and always outputs black. v4 sidesteps the whole
 * issue by writing our own mark material + post-process shader, which
 * is standard practice for per-object selection outlines (Unity Quick
 * Outline, Godot custom outline, etc.).
 *
 * ── Limitations ──
 * 1. **Only alpha is a real mask.** The gsplat path re-renders the
 *    existing component on the mark layer rather than a flat-white
 *    clone, so the mask RT carries the splat's lit colour in RGB. The
 *    expand shader reads `.a` only, which is why that is harmless -
 *    but the mask is not a clean binary image.
 * 2. **Skinned meshes share their source's skin.** The mark clone takes
 *    the source mesh instance's `skinInstance`, so the mark material's
 *    standard shader skins it and the outline follows the pose.
 * 3. **Xray only.** Outline is always drawn over the scene. No
 *    option to hide the outline where the object is occluded by
 *    walls. The mask camera has its own depth buffer (not the main
 *    scene's) and sharing depth buffers across cameras isn't exposed
 *    in PC 2.18 without custom render passes.
 * 4. **Single colour.** One `uOutlineColor` is shared across every
 *    tagged entity. Per-entity colours would need multiple mask RTs
 *    or R/G/B channel packing.
 */
export class OutlineEffect {
  private scene: Scene;
  private device: GraphicsDevice;

  private color: Color;
  private thicknessPx: number;
  /** Blend strength 0..1 on top of the colour's alpha. */
  private strength = 1;
  /** 0..1: how much of a soft band travelling up the screen modulates the line. */
  private shimmer = 0;
  private time = 0;

  private maskRT: RenderTarget | null = null;
  private maskTex: Texture | null = null;
  private maskW = 0;
  private maskH = 0;

  private markLayer: Layer;
  private markLayerId: number;

  private mainCameraEntity: Entity;
  private maskCameraEntity: Entity | null;

  private postQuad: QuadRender;

  private tags = new Map<Entity, TagEntry>();

  private _prerenderLayerHandler: (camera: CameraComponent, layer: Layer, transparent: boolean) => void;
  private _appPrerenderHandler: () => void;
  private _resizeHandler: () => void;
  private _mainCameraDestroyHandler: () => void;
  private _destroyed = false;

  constructor(scene: Scene, opts: OutlineEffectOptions) {
    this.scene = scene;
    this.device = scene.graphicsDevice;
    this.color = opts.color ?? new Color(0.6, 0.2, 1.0, 1.0);
    this.thicknessPx = Math.max(1, opts.thicknessPx ?? 3);
    this.mainCameraEntity = opts.mainCamera;

    // ── Mark layer ──────────────────────────────────────────────────
    // Added to the composition so the mask camera can find it, but NOT
    // to the main camera's layers array - so the main camera never
    // renders these clones into the backbuffer. `clearColorBuffer`
    // false: the mask camera does the clearing via its own clearColor
    // / clearColorBuffer settings.
    this.markLayer = new Layer({
      name: 'outline-mark-v4',
      clearColorBuffer: false,
      clearDepthBuffer: false,
      passThrough: false,
    });
    const composition = scene.app.scene.layers;
    composition.push(this.markLayer);
    this.markLayerId = this.markLayer.id;

    // ── Mask RT ─────────────────────────────────────────────────────
    this._ensureMaskRT();

    // ── Mask camera ─────────────────────────────────────────────────
    // Parenting to the main camera keeps position / rotation locked
    // without manual per-frame sync. Projection params still need
    // copying each frame (fov can change, aspect on resize, etc.) -
    // see _appPrerenderHandler below.
    this.maskCameraEntity = new Entity('outline-mask-camera-v4');
    this.mainCameraEntity.addChild(this.maskCameraEntity);
    this.maskCameraEntity.addComponent('camera', {
      clearColor: new Color(0, 0, 0, 0),
      clearColorBuffer: true,
      clearDepthBuffer: true,
      clearStencilBuffer: false,
      layers: [this.markLayerId],
      priority: (this.mainCameraEntity.camera?.priority ?? 0) - 1,
    });
    // Set here, not in the addComponent options, which have dropped it.
    // `maskRT` is non-null: `_ensureMaskRT()` ran above.
    this.maskCameraEntity.camera!.renderTarget = this.maskRT!;

    // ── Expand shader + fullscreen quad ─────────────────────────────
    const expandShader = ShaderUtils.createShader(this.device, {
      uniqueName: 'outline-expand-v4',
      attributes: { vertex_position: SEMANTIC_POSITION },
      vertexChunk: 'fullscreenQuadVS',
      fragmentGLSL: expandFragmentGLSL,
      fragmentWGSL: expandFragmentWGSL,
    });
    this.postQuad = new QuadRender(expandShader);

    // ── Event hooks ─────────────────────────────────────────────────
    this._appPrerenderHandler = this._syncCameras.bind(this);
    scene.app.on('prerender', this._appPrerenderHandler);

    this._prerenderLayerHandler = this._onPrerenderLayer.bind(this);
    scene.app.scene.on(EVENT_PRERENDER_LAYER, this._prerenderLayerHandler);

    this._resizeHandler = () => {
      this._ensureMaskRT();
      if (this.maskCameraEntity?.camera && this.maskRT) {
        this.maskCameraEntity.camera.renderTarget = this.maskRT;
      }
    };
    this.device.on('resizecanvas', this._resizeHandler);

    // Self-destruct if the main camera entity is destroyed out from under
    // us. PC's recursive destroy would otherwise free the parented mask
    // camera silently while the prerender / resize listeners kept firing
    // against a freed RT - visually the outline goes black-empty with no
    // diagnostic. PC's Entity extends EventHandler and emits 'destroy'
    // synchronously from `Entity.destroy()`.
    this._mainCameraDestroyHandler = () => this.destroy();
    if (this.mainCameraEntity?.once) {
      this.mainCameraEntity.once('destroy', this._mainCameraDestroyHandler);
    } else if (this.mainCameraEntity?.on) {
      this.mainCameraEntity.on('destroy', this._mainCameraDestroyHandler);
    }

    // Idle: no tags → no offscreen render.
    this.maskCameraEntity.enabled = false;
  }

  /** Live-tunable outline colour. Takes effect next frame. */
  get outlineColor(): Color { return this.color; }
  set outlineColor(c: Color) { this.color = c; }

  /** Live-tunable thickness (pixels). */
  get outlineThickness(): number { return this.thicknessPx; }
  set outlineThickness(px: number) { this.thicknessPx = Math.max(1, px); }

  /** Tag an entity for outline rendering. Idempotent - re-tagging
   *  rebuilds the mask clones. */
  add(entity: Entity, opts: OutlineAddOptions = {}): void {
    if (this._destroyed) return;
    if (this.tags.has(entity)) this.remove(entity);

    const recursive = opts.recursive ?? true;
    const entry: TagEntry = {
      entity,
      markMeshInstances: [],
      splatClones: [],
    };
    const markMat = getOutlineMarkMaterial(this.device);

    const visit = (node: Entity) => {
      // Skip disabled entities - their clone mesh instances would render
      // unconditionally in the mark layer even after the entity is hidden,
      // producing phantom outlines (e.g. weapons parked in idle position).
      if (node.enabled === false) return;


      // Snapshot the children list BEFORE any clone creation. The splat
      // path below parents a clone entity UNDER `node`, which would
      // otherwise land in `node.children` immediately and the recursion
      // would find it, treat it as another gsplat to clone, and spiral
      // infinitely - blowing the stack and spawning hundreds of gsplat
      // sorter workers (one of which promise-rejects and takes the host
      // app down with it). Snapshotting freezes the iteration list to
      // pre-clone state.
      const childrenSnapshot = recursive ? [...(node.children ?? [])] : [];

      // ── mesh path ──────────────────────────────────────────────────
      const render = node.render;
      if (render?.meshInstances) {
        for (const srcInstance of render.meshInstances) {
          const maskInst = new MeshInstance(
            srcInstance.mesh!,
            markMat,
            srcInstance.node ?? node,
          );
          // No frustum-cull on the clone - we want the whole silhouette
          // to reach the mask even near edges. Main camera's cull is
          // unaffected since the clone is on its own layer.
          maskInst.cull = false;
          // A skinned source's clone shares its skin, so the mask follows the pose.
          maskInst.skinInstance = srcInstance.skinInstance;
          maskInst.castShadow = false;
          maskInst.receiveShadow = false;
          entry.markMeshInstances.push(maskInst);
          this.markLayer.addMeshInstances([maskInst]);
        }
      }

      // ── splat path ─────────────────────────────────────────────────
      // gsplat components can't be "cloned" the mesh-instance way -
      // they own a work-buffer + sort state. createSplatMarkClone
      // parents a fresh gsplat entity under `node` with a flat-white
      // modifier, bound to the same bone textures so skinning follows.
      // Wrapped in try/catch so a PC-internal init failure (async
      // sorter init, texture size overflow, etc.) doesn't tear down
      // the rest of the tag.
      if (node.gsplat) {
        try {
          const handle = createSplatMarkClone(this.markLayerId, node);
          if (handle) entry.splatClones.push(handle);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[OutlineEffect] splat clone failed:', err);
        }
      }

      if (!recursive) return;
      for (const child of childrenSnapshot) {
        if (child.tags !== undefined) visit(child as Entity);
      }
    };
    visit(entity);

    this.tags.set(entity, entry);

    this._syncMaskCamera();
  }

  /** Whether `entity` is currently tagged. */
  has(entity: Entity): boolean {
    return this.tags.has(entity);
  }

  /** The silhouette mask of everything tagged, alpha ≈ 1 inside; null until the first frame. */
  get maskTexture(): Texture | null {
    return this.maskTex;
  }

  /**
   * The line's look, changed per frame by a state machine: colour (alpha is the
   * base blend), thickness in px, a strength 0..1 that multiplies the alpha
   * (0 draws nothing, so a hover can fade the line in), and a shimmer 0..1
   * that lets a soft band travel up the screen at `time` seconds.
   */
  setLook(look: { color?: { r: number; g: number; b: number; a?: number }; thicknessPx?: number; strength?: number; shimmer?: number; time?: number }): void {
    if (look.color) this.color.set(look.color.r, look.color.g, look.color.b, look.color.a ?? this.color.a);
    if (look.thicknessPx !== undefined) this.thicknessPx = Math.max(1, look.thicknessPx);
    if (look.strength !== undefined) this.strength = Math.max(0, Math.min(1, look.strength));
    if (look.shimmer !== undefined) this.shimmer = Math.max(0, Math.min(1, look.shimmer));
    if (look.time !== undefined) this.time = look.time;
  }

  /**
   * The mask camera runs whenever anything is tagged, even at strength 0. It
   * costs a second rasterize of the tagged splats, but a camera woken on
   * demand hands back a stale or empty mask until the layer's sorter catches
   * up (measured at 300-1200 ms on a 1.2M-splat body), and a line that
   * arrives that long after the hover is the lag the user feels. Hosts that
   * want the saving untag instead.
   */
  private _syncMaskCamera(): void {
    if (!this.maskCameraEntity) return;
    this.maskCameraEntity.enabled = this.tags.size > 0;
  }

  /** Remove outline tag. No-op if not tagged. */
  remove(entity: Entity): void {
    const entry = this.tags.get(entity);
    if (!entry) return;

    if (entry.markMeshInstances.length > 0) {
      this.markLayer.removeMeshInstances(entry.markMeshInstances);
      for (const mi of entry.markMeshInstances) {
        // A skinned clone shares its source's skin; destroying it breaks the source.
        mi.skinInstance = null;
        mi.destroy();
      }
      entry.markMeshInstances.length = 0;
    }

    for (const h of entry.splatClones) {
      try { h.destroy(); } catch { /* ignore */ }
    }
    entry.splatClones.length = 0;

    this.tags.delete(entity);

    // Power down the mask camera when nothing is tagged.
    this._syncMaskCamera();
  }

  /** Remove every tag at once. */
  clear(): void {
    for (const e of Array.from(this.tags.keys())) this.remove(e);
  }

  /** Tear down everything. Safe to call multiple times. Auto-fires if
   *  the main camera entity is destroyed first (see constructor). */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;

    this.clear();

    this.scene.app.off('prerender', this._appPrerenderHandler);
    this.scene.app.scene.off(EVENT_PRERENDER_LAYER, this._prerenderLayerHandler);
    this.device.off('resizecanvas', this._resizeHandler);

    // Detach the main-camera destroy listener. Guarded for the case
    // where the listener is what TRIGGERED this destroy() - PC's
    // EventHandler tolerates `off` from inside a handler.
    if (this.mainCameraEntity?.off && this._mainCameraDestroyHandler) {
      this.mainCameraEntity.off('destroy', this._mainCameraDestroyHandler);
    }

    if (this.maskCameraEntity) {
      // If the main camera was already destroyed, PC's recursive teardown
      // already freed our mask camera; the entity ref is stale. Guard the
      // parent walk + destroy so we don't double-free.
      if (this.maskCameraEntity.parent) {
        this.maskCameraEntity.parent.removeChild(this.maskCameraEntity);
      }
      try { this.maskCameraEntity.destroy(); } catch { /* already freed */ }
      this.maskCameraEntity = null;
    }

    const composition = this.scene.app.scene.layers;
    if (composition?.remove) composition.remove(this.markLayer);
    if (this.maskRT) this.maskRT.destroy();
    if (this.maskTex) this.maskTex.destroy();
    this.maskRT = null;
    this.maskTex = null;
  }

  // ── internals ────────────────────────────────────────────────────────

  private _ensureMaskRT(): void {
    const w = Math.max(1, Math.floor(this.device.width));
    const h = Math.max(1, Math.floor(this.device.height));
    if (this.maskRT && w === this.maskW && h === this.maskH) return;

    if (this.maskRT) this.maskRT.destroy();
    if (this.maskTex) this.maskTex.destroy();

    this.maskTex = new Texture(this.device, {
      name: 'outline-mask-v4',
      width: w,
      height: h,
      format: PIXELFORMAT_RGBA8,
      mipmaps: false,
      minFilter: FILTER_LINEAR,
      magFilter: FILTER_LINEAR,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE,
    });
    this.maskRT = new RenderTarget({
      name: 'outline-mask-v4-rt',
      colorBuffer: this.maskTex,
      depth: true,
      stencil: false,
      samples: 1,
    });

    this.maskW = w;
    this.maskH = h;
  }

  private _syncCameras(): void {
    // Before any camera renders: tagged splats keep their mark layer however
    // the host re-layers them (a character joining an environment's layer
    // assigns a fresh list and would drop ours, emptying the mask).
    for (const entry of this.tags.values()) for (const h of entry.splatClones) h.ensure();
    if (this._destroyed) return;
    const mainCam = this.mainCameraEntity?.camera;
    const maskCam = this.maskCameraEntity?.camera;
    if (!mainCam || !maskCam) return;
    // Parenting handles position/rotation; copy projection each frame
    // so fov changes / aspect on resize / ortho toggles propagate.
    maskCam.fov = mainCam.fov;
    maskCam.nearClip = mainCam.nearClip;
    maskCam.farClip = mainCam.farClip;
    maskCam.aspectRatio = mainCam.aspectRatio;
    maskCam.aspectRatioMode = mainCam.aspectRatioMode;
    maskCam.projection = mainCam.projection;
    maskCam.orthoHeight = mainCam.orthoHeight;
    maskCam.horizontalFov = mainCam.horizontalFov;
    maskCam.priority = (mainCam.priority ?? 0) - 1;
  }

  private _onPrerenderLayer(_camera: CameraComponent, layer: Layer, transparent: boolean): void {
    if (this._destroyed) return;
    if (this.tags.size === 0) return;
    if (!this.maskTex) return;
    if (this.strength <= 0) return;
    // Fire once per frame at World+transparent → outline lands on top
    // of opaque scene geometry, under transparent UI and particle
    // effects on higher layers.
    if (layer?.id !== LAYERID_WORLD) return;
    if (!transparent) return;

    const texel = [1 / this.maskW, 1 / this.maskH];
    const colorVec = [
      this.color.r,
      this.color.g,
      this.color.b,
      this.color.a,
    ];

    const scope = this.device.scope;
    scope.resolve('uMask').setValue(this.maskTex);
    scope.resolve('uTexelSize').setValue(texel);
    scope.resolve('uThicknessPx').setValue(this.thicknessPx);
    scope.resolve('uOutlineColor').setValue(colorVec);
    scope.resolve('uStrength').setValue(this.strength);
    scope.resolve('uShimmer').setValue(this.shimmer);
    scope.resolve('uTime').setValue(this.time);

    this.postQuad.render();
  }
}
