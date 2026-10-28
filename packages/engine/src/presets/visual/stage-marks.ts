import {
  BLEND_NORMAL,
  CULLFACE_NONE,
  Entity,
  LAYERID_IMMEDIATE,
  Mesh,
  MeshInstance,
  PRIMITIVE_TRIANGLES,
  SEMANTIC_COLOR,
  SEMANTIC_POSITION,
  SEMANTIC_TEXCOORD0,
  ShaderMaterial,
  Texture,
  Vec3,
} from 'playcanvas';

import type { Scene } from '../../scene';

/** A world point. */
export interface StageMarkPoint { x: number; y: number; z: number }

/** A polyline of constant pixel width. */
export interface StageMarkStrip {
  pts: StageMarkPoint[];
  widthPx: number;
  alpha: number;
  /** Hidden where the subject's silhouette mask covers it. */
  masked: boolean;
}

/** One straight dash. */
export interface StageMarkSegment {
  a: StageMarkPoint;
  b: StageMarkPoint;
  widthPx: number;
  alpha: number;
  masked: boolean;
}

/** A camera-facing hollow ring. */
export interface StageMarkRing {
  center: StageMarkPoint;
  radiusPx: number;
  widthPx: number;
  alpha: number;
  masked: boolean;
}

/** A camera-facing filled disc. `color` overrides the frame's colour. */
export interface StageMarkDot {
  center: StageMarkPoint;
  radiusPx: number;
  alpha: number;
  masked: boolean;
  color?: [number, number, number];
}

/** Everything the stage draws this frame. One colour: the marks are one voice. */
export interface StageMarksFrame {
  color: [number, number, number];
  strips: StageMarkStrip[];
  segments: StageMarkSegment[];
  rings: StageMarkRing[];
  dots: StageMarkDot[];
}

const RING_POINTS = 24;
const DOT_POINTS = 12;

const vertexGLSL = /* glsl */ `
attribute vec3 vertex_position;
attribute vec4 vertex_color;
attribute vec2 vertex_texCoord0;
uniform mat4 matrix_viewProjection;
varying vec4 vColor;
varying float vMasked;
void main() {
  vColor = vertex_color;
  vMasked = vertex_texCoord0.x;
  gl_Position = matrix_viewProjection * vec4(vertex_position, 1.0);
}
`;

const fragmentGLSL = /* glsl */ `
precision mediump float;
varying vec4 vColor;
varying float vMasked;
uniform sampler2D uMask;
uniform float uHasMask;
void main() {
  float m = 0.0;
  if (uHasMask > 0.5 && vMasked > 0.5) {
    m = texelFetch(uMask, ivec2(gl_FragCoord.xy), 0).a;
  }
  if (m > 0.5) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * (1.0 - m));
}
`;

// The same pair for WebGPU: without it the material has no shader there and
// nothing draws - the connector and the floor mark vanish once the engine
// picks WebGPU over WebGL2.
const vertexWGSL = /* wgsl */ `
attribute vertex_position: vec3f;
attribute vertex_color: vec4f;
attribute vertex_texCoord0: vec2f;
uniform matrix_viewProjection: mat4x4f;
varying vColor: vec4f;
varying vMasked: f32;
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.vColor = input.vertex_color;
  output.vMasked = input.vertex_texCoord0.x;
  output.position = uniform.matrix_viewProjection * vec4f(input.vertex_position, 1.0);
  return output;
}
`;

const fragmentWGSL = /* wgsl */ `
varying vColor: vec4f;
varying vMasked: f32;
var uMask: texture_2d<f32>;
uniform uHasMask: f32;
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  var m: f32 = 0.0;
  if (uniform.uHasMask > 0.5 && input.vMasked > 0.5) {
    m = textureLoad(uMask, vec2i(input.position.xy), 0).a;
  }
  if (m > 0.5) { discard; }
  output.color = vec4f(input.vColor.rgb, input.vColor.a * (1.0 - m));
  return output;
}
`;

/**
 * The stage's in-world marks (docs/SPATIAL_UI_UPDATE_PLAN.md): the
 * connectors' dots and the floor mark under the character,
 * rebuilt every frame from a {@link StageMarksFrame} as camera-facing quads of
 * constant pixel width, alpha-blended on the IMMEDIATE layer (the one that
 * reliably draws after the splats - see `collider-debug.ts`).
 *
 * A splat scene has no depth to test against, so "behind the body" is read
 * off a silhouette mask instead: the {@link OutlineEffect}'s mask texture,
 * sampled at the fragment's own pixel. Marks flagged `masked` vanish where
 * the mask is set, which is how a connector is seen to leave the silhouette.
 */
export class StageMarks {
  private readonly _scene: Scene;
  private readonly _entity: Entity;
  private readonly _material: ShaderMaterial;
  private _mesh: Mesh | null = null;
  private _instance: MeshInstance | null = null;
  private _frame: StageMarksFrame | null = null;
  private _mask: Texture | null = null;
  /** Bound while there is no mask: WebGPU will not draw with a texture slot left empty. */
  private readonly _noMask: Texture;
  private readonly _update: () => void;
  private _destroyed = false;

  static create(scene: Scene): StageMarks {
    return new StageMarks(scene);
  }

  private constructor(scene: Scene) {
    this._scene = scene;
    const material = new ShaderMaterial({
      uniqueName: 'stage-marks',
      vertexGLSL,
      fragmentGLSL,
      vertexWGSL,
      fragmentWGSL,
      attributes: {
        vertex_position: SEMANTIC_POSITION,
        vertex_color: SEMANTIC_COLOR,
        vertex_texCoord0: SEMANTIC_TEXCOORD0,
      },
    });
    material.blendType = BLEND_NORMAL;
    material.depthTest = false;
    material.depthWrite = false;
    material.cull = CULLFACE_NONE;
    this._noMask = new Texture(scene.graphicsDevice, { name: 'stage-marks-no-mask', width: 1, height: 1, mipmaps: false });
    material.setParameter('uHasMask', 0);
    material.setParameter('uMask', this._noMask);
    material.update();
    this._material = material;

    this._entity = new Entity('stage-marks');
    scene.app.root.addChild(this._entity);

    this._update = () => this._draw();
    scene.app.on('update', this._update);
  }

  /** The silhouette mask the masked marks hide behind; null draws them unmasked. */
  setMask(mask: Texture | null): void {
    this._mask = mask;
  }

  /** What to draw from now on; null draws nothing. The frame is read on the next update. */
  set(frame: StageMarksFrame | null): void {
    this._frame = frame;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._scene.app.off('update', this._update);
    if (this._instance) { this._entity.removeComponent('render'); this._instance = null; }
    this._mesh?.destroy();
    this._mesh = null;
    this._material.destroy();
    this._noMask.destroy();
    this._entity.destroy();
  }

  // ── internals ────────────────────────────────────────────────────────

  private _draw(): void {
    if (this._destroyed) return;
    const frame = this._frame;
    const cam = this._scene.cameraEntity.camera;
    if (!frame || !cam || (frame.strips.length === 0 && frame.segments.length === 0 && frame.rings.length === 0 && frame.dots.length === 0)) {
      if (this._instance) this._instance.visible = false;
      return;
    }

    const camEntity = this._scene.cameraEntity;
    const eye = camEntity.getPosition();
    const right = camEntity.right;
    const up = camEntity.up;
    const canvas = this._scene.graphicsDevice.canvas as HTMLCanvasElement;
    const cssH = canvas.clientHeight || this._scene.graphicsDevice.height || 1;
    // World units per CSS pixel at a distance: perspective scales with the
    // distance, ortho does not.
    const perspective = cam.projection === 0;
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
    const unitPerPx = (p: StageMarkPoint): number => {
      if (!perspective) return (2 * cam.orthoHeight) / cssH;
      const d = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
      return (2 * tanHalf * d) / cssH;
    };

    const pos: number[] = [];
    const col: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const [r, g, b] = frame.color;
    const tmp = new Vec3();
    const perp = new Vec3();

    const scrA = new Vec3();
    const scrB = new Vec3();
    const pushStrip = (pts: StageMarkPoint[], widthPx: number, alpha: number, masked: boolean) => {
      const n = pts.length;
      if (n < 2) return;
      const base = pos.length / 3;
      const m = masked ? 1 : 0;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const prev = pts[Math.max(i - 1, 0)];
        const next = pts[Math.min(i + 1, n - 1)];
        // The line's direction ON SCREEN, from the projected neighbours. Not
        // the world direction dotted with the camera's right and up: that
        // reads a line running into the depth - a floor line pointing away
        // from the eye - as having no screen direction at all, and the quad
        // collapses to nothing where perspective still shows a line
        // converging to the horizon. Behind the eye the projection is
        // meaningless, and the camera-plane reading stands in.
        tmp.set(next.x - prev.x, next.y - prev.y, next.z - prev.z);
        let dx = tmp.dot(right);
        let dy = tmp.dot(up);
        if (perspective) {
          cam.worldToScreen(tmp.set(prev.x, prev.y, prev.z), scrA);
          cam.worldToScreen(tmp.set(next.x, next.y, next.z), scrB);
          if (scrA.z > 0 && scrB.z > 0) {
            dx = scrB.x - scrA.x;
            dy = scrA.y - scrB.y;
          }
        }
        const l = Math.hypot(dx, dy) || 1;
        // The screen-space perpendicular of the direction, back in world.
        perp.copy(right).mulScalar(-dy / l).add(tmp.copy(up).mulScalar(dx / l));
        const w = unitPerPx(p) * widthPx * 0.5;
        pos.push(p.x + perp.x * w, p.y + perp.y * w, p.z + perp.z * w);
        pos.push(p.x - perp.x * w, p.y - perp.y * w, p.z - perp.z * w);
        col.push(r, g, b, alpha, r, g, b, alpha);
        uv.push(m, 0, m, 0);
      }
      for (let i = 0; i < n - 1; i++) {
        const a = base + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    };

    for (const s of frame.strips) pushStrip(s.pts, s.widthPx, s.alpha, s.masked);
    for (const s of frame.segments) pushStrip([s.a, s.b], s.widthPx, s.alpha, s.masked);
    for (const ring of frame.rings) {
      const c = ring.center;
      const rad = unitPerPx(c) * ring.radiusPx;
      const pts: StageMarkPoint[] = [];
      for (let i = 0; i <= RING_POINTS; i++) {
        const a = (i / RING_POINTS) * Math.PI * 2;
        const ca = Math.cos(a) * rad;
        const sa = Math.sin(a) * rad;
        pts.push({ x: c.x + right.x * ca + up.x * sa, y: c.y + right.y * ca + up.y * sa, z: c.z + right.z * ca + up.z * sa });
      }
      pushStrip(pts, ring.widthPx, ring.alpha, ring.masked);
    }
    for (const dot of frame.dots) {
      // A fan about the centre, in the camera's plane.
      const c = dot.center;
      const rad = unitPerPx(c) * dot.radiusPx;
      const m = dot.masked ? 1 : 0;
      const [dr, dg, db] = dot.color ?? frame.color;
      const base = pos.length / 3;
      pos.push(c.x, c.y, c.z);
      col.push(dr, dg, db, dot.alpha);
      uv.push(m, 0);
      for (let i = 0; i < DOT_POINTS; i++) {
        const a = (i / DOT_POINTS) * Math.PI * 2;
        const ca = Math.cos(a) * rad;
        const sa = Math.sin(a) * rad;
        pos.push(c.x + right.x * ca + up.x * sa, c.y + right.y * ca + up.y * sa, c.z + right.z * ca + up.z * sa);
        col.push(dr, dg, db, dot.alpha);
        uv.push(m, 0);
        idx.push(base, base + 1 + i, base + 1 + ((i + 1) % DOT_POINTS));
      }
    }

    if (idx.length === 0) {
      if (this._instance) this._instance.visible = false;
      return;
    }

    const device = this._scene.graphicsDevice;
    const mesh = this._mesh ?? new Mesh(device);
    mesh.setPositions(pos, 3, pos.length / 3);
    mesh.setColors(col, 4, col.length / 4);
    mesh.setUvs(0, uv, 2, uv.length / 2);
    mesh.setIndices(idx);
    mesh.update(PRIMITIVE_TRIANGLES);
    // The marks live anywhere on screen; never let a stale bound cull them.
    mesh.aabb.center.set(0, 0, 0);
    mesh.aabb.halfExtents.set(1e6, 1e6, 1e6);
    this._mesh = mesh;

    this._material.setParameter('uHasMask', this._mask ? 1 : 0);
    this._material.setParameter('uMask', this._mask ?? this._noMask);
    this._material.update();

    if (!this._instance) {
      this._instance = new MeshInstance(mesh, this._material, this._entity);
      this._instance.cull = false;
      this._entity.addComponent('render', {
        meshInstances: [this._instance],
        layers: [LAYERID_IMMEDIATE],
        castShadows: false,
        receiveShadows: false,
      });
    }
    this._instance.visible = true;
  }
}
