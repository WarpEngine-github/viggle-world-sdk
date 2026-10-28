/**
 * Sprite layer - animated spritesheet on a quad. Frames advance based on
 * progress through the layer's duration; can either billboard to the camera
 * or stay in world rotation.
 */

import {
  BLEND_ADDITIVE,
  BLEND_NORMAL,
  CULLFACE_BACK,
  CULLFACE_NONE,
  Color,
  Entity,
  MeshInstance,
  StandardMaterial,
  Texture,
  Vec2,
} from 'playcanvas';
import type { AppBase, GraphicsDevice, Vec3 } from 'playcanvas';

import { cachedFetch } from '../../../loader/shared/bin-cache';

import type {
  CurvePoint,
  VfxLayerBase,
} from '../data-types';
import type {
  VfxLayerBuildContext,
  VfxLayerInstance,
  VfxLayerRenderer,
  VfxLayerUpdateContext,
} from '../layer-renderer';
import { lerpCurve } from './shared';
import { buildVfxQuadMesh } from './mesh';

// ── Public data type ─────────────────────────────────────────────────────────

export interface VfxSpriteLayer extends VfxLayerBase {
  type: 'sprite';

  /** Path to the spritesheet image relative to public root. */
  spriteSheet: string;
  cols: number;
  rows: number;
  /** Total frame count (defaults to cols * rows). */
  frameCount?: number;
  fps: number;
  loop?: boolean;

  orientation: 'billboard' | 'world';

  color: [number, number, number];
  emissiveIntensity: number;
  opacity: number;
  blendMode: 'additive' | 'alpha';
  depthTest: boolean;
  depthWrite: boolean;
  cullFace: boolean;

  positionOffset: [number, number, number];
  rotation: [number, number, number];
  scale: number;

  opacityKeys?: CurvePoint[];
  scaleKeys?: CurvePoint[];
}

// ── Per-device sprite texture cache ──────────────────────────────────────────

const _spriteTexCache = new Map<GraphicsDevice, Map<string, { tex: Texture; loading: boolean; waiters: Array<(t: Texture) => void> }>>();

function loadSpriteTexture(device: GraphicsDevice, url: string): Promise<Texture> {
  let devCache = _spriteTexCache.get(device);
  if (!devCache) { devCache = new Map(); _spriteTexCache.set(device, devCache); }

  const entry = devCache.get(url);
  if (entry && !entry.loading) return Promise.resolve(entry.tex);
  if (entry && entry.loading) return new Promise<Texture>(r => entry.waiters.push(r));

  const rec = { tex: null as unknown as Texture, loading: true, waiters: [] as Array<(t: Texture) => void> };
  devCache.set(url, rec);

  return new Promise<Texture>((resolve, reject) => {
    rec.waiters.push(resolve);
    cachedFetch(url)
      .then(r => { if (!r.ok) throw new Error(`Sprite load failed: ${r.status}`); return r.blob(); })
      .then(blob => createImageBitmap(blob, { imageOrientation: 'flipY' }))
      .then(bitmap => {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
        bitmap.close();
        const tex = new Texture(device, {
          width: canvas.width,
          height: canvas.height,
          mipmaps: false,
        });
        tex.setSource(canvas);
        rec.tex = tex;
        rec.loading = false;
        for (const w of rec.waiters) w(tex);
        rec.waiters.length = 0;
      })
      // eslint-disable-next-line no-console
      .catch(err => { console.warn('[VFX] sprite texture load error:', err); reject(err); });
  });
}

// ── Instance + Renderer ──────────────────────────────────────────────────────

class SpriteLayerInstance implements VfxLayerInstance {
  private readonly _app: AppBase;
  private readonly _layer: VfxSpriteLayer;
  private readonly _entity: Entity;
  private readonly _material: StandardMaterial;
  private readonly _cols: number;
  private readonly _rows: number;
  private readonly _frameCount: number;
  private readonly _isBillboard: boolean;
  private _textureReady = false;

  constructor(
    app: AppBase,
    layer: VfxSpriteLayer,
    entity: Entity,
    material: StandardMaterial,
  ) {
    this._app = app;
    this._layer = layer;
    this._entity = entity;
    this._material = material;
    this._cols = layer.cols || 1;
    this._rows = layer.rows || 1;
    this._frameCount = layer.frameCount || (this._cols * this._rows);
    this._isBillboard = layer.orientation === 'billboard';
  }

  setTextureReady(): void {
    this._textureReady = true;
  }

  spawn(_pos: Vec3): void {
    // Visibility is driven by `update`; the prefab calls update(t=0) on spawn.
  }

  update(ctx: VfxLayerUpdateContext): void {
    const layer = this._layer;
    if (!layer.enabled || !this._textureReady) { this._entity.enabled = false; return; }

    // Sprite has its own per-layer loop flag - it stays alive past the
    // effect's duration when looping, even if the wider effect isn't.
    const localT = ctx.t;
    if (localT < 0 || (!ctx.loop && !layer.loop && localT > ctx.layerDuration)) {
      this._entity.enabled = false;
      return;
    }

    this._entity.enabled = true;
    const nt = ctx.layerDuration > 0 ? Math.min(localT / ctx.layerDuration, 1) : 0;

    let progress = ctx.layerDuration > 0 ? localT / ctx.layerDuration : 0;
    if (layer.loop && ctx.layerDuration > 0) progress = progress % 1;
    progress = Math.min(Math.max(progress, 0), 1);
    const frameIdx = Math.min(Math.floor(progress * this._frameCount), this._frameCount - 1);

    const col = frameIdx % this._cols;
    const row = Math.floor(frameIdx / this._cols);
    const uTile = 1 / this._cols;
    const vTile = 1 / this._rows;
    const uOff = col * uTile;
    // Texture is loaded with flipY, so row 0 of the sheet sits at v=0.
    const vOff = row * vTile;

    const tiling = new Vec2(uTile, vTile);
    const offset = new Vec2(uOff, vOff);
    this._material.emissiveMapTiling = tiling;
    this._material.emissiveMapOffset = offset;
    this._material.diffuseMapTiling = tiling;
    this._material.diffuseMapOffset = offset;
    this._material.opacityMapTiling = tiling;
    this._material.opacityMapOffset = offset;

    const o = (layer.opacity ?? 1) * lerpCurve(layer.opacityKeys ?? [[0, 1]], nt);
    this._material.opacity = o;
    this._material.update();

    const s = (layer.scale ?? 1) * lerpCurve(layer.scaleKeys ?? [[0, 1]], nt);
    this._entity.setLocalScale(s, s, s);

    if (this._isBillboard) {
      // Nothing in the engine tags a camera 'MainCamera'; fall back to the
      // first enabled camera so billboarding works out of the box.
      const cam = this._app.root.findByTag('MainCamera')[0]
        ?? this._app.systems.camera?.cameras[0]?.entity;
      if (cam) {
        this._entity.setRotation(cam.getRotation());
      }
    }
  }

  reset(): void {
    this._entity.enabled = false;
    this._material.opacity = 0;
    this._material.update();
  }

  dispose(): void {
    // Owned by prefab root entity.
  }
}

export class SpriteLayerRenderer implements VfxLayerRenderer<VfxSpriteLayer> {
  readonly type = 'sprite';

  build(layer: VfxSpriteLayer, ctx: VfxLayerBuildContext): VfxLayerInstance {
    const { app, parent, resolveUrl } = ctx;
    const device = app.graphicsDevice;
    const mesh = buildVfxQuadMesh(device);

    const mat = new StandardMaterial();
    mat.diffuse = new Color(0, 0, 0);
    mat.emissive = new Color(
      layer.color[0] * (layer.emissiveIntensity ?? 1),
      layer.color[1] * (layer.emissiveIntensity ?? 1),
      layer.color[2] * (layer.emissiveIntensity ?? 1),
    );
    mat.blendType = layer.blendMode === 'additive' ? BLEND_ADDITIVE : BLEND_NORMAL;
    mat.depthTest = layer.depthTest ?? true;
    mat.depthWrite = layer.depthWrite ?? false;
    mat.cull = layer.cullFace ? CULLFACE_BACK : CULLFACE_NONE;
    mat.opacity = 0;
    mat.useLighting = false;
    mat.update();

    const mi = new MeshInstance(mesh, mat);
    const ent = new Entity(`vfx_sprite_${layer.id}`);
    ent.addComponent('render', { meshInstances: [mi] });

    const [px, py, pz] = layer.positionOffset ?? [0, 0, 0];
    ent.setLocalPosition(px, py, pz);

    if (layer.orientation !== 'billboard') {
      const [rx, ry, rz] = layer.rotation ?? [0, 0, 0];
      ent.setLocalEulerAngles(rx, ry, rz);
    }

    parent.addChild(ent);

    const instance = new SpriteLayerInstance(app, layer, ent, mat);

    if (layer.spriteSheet) {
      loadSpriteTexture(device, resolveUrl(layer.spriteSheet)).then(tex => {
        mat.emissiveMap = tex;
        mat.diffuseMap = tex;
        mat.opacityMap = tex;
        mat.opacityMapChannel = 'a';
        mat.update();
        instance.setTextureReady();
      }).catch(() => { /* texture load failed – layer stays invisible */ });
    }

    return instance;
  }
}
