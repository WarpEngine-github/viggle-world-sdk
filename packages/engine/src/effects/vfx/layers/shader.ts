/**
 * Generic data-driven shader layer.
 *
 * Unlike the other layer types, this one carries its GLSL *in the layer JSON*.
 * That makes it the substrate for fully data-driven VFX: a tool authors a
 * fragment shader per effect and it renders without any new TypeScript - the
 * program is just serialized data, so it round-trips through any storage and
 * any consumer that has this renderer registered.
 *
 * The renderer supplies:
 *   - one of three meshes (`billboard` camera-facing quad, flat `quad`, `sphere`)
 *   - a sensible default vertex shader per geometry (so most effects only need
 *     a fragment shader), overridable via `vertexGLSL`
 *   - standard uniforms every frame: uProgress (0..1 lifecycle), uTime
 *     (seconds), uDuration, uOpacity, plus any custom uniforms declared in
 *     `layer.uniforms`
 *
 * GLSL is GLSL ES 1.00 (attribute / varying / gl_FragColor), matching the
 * engine's other shader materials. We pre-compile-check the source on build so
 * syntax errors surface to the caller instead of silently rendering nothing.
 */

import {
  BLEND_ADDITIVE,
  BLEND_NORMAL,
  CULLFACE_BACK,
  CULLFACE_NONE,
  Entity,
  MeshInstance,
  ShaderMaterial,
} from 'playcanvas';
import type { GraphicsDevice, Mesh, Vec3 } from 'playcanvas';

import type { CurvePoint, VfxLayerBase } from '../data-types';
import type {
  VfxLayerBuildContext,
  VfxLayerInstance,
  VfxLayerRenderer,
  VfxLayerUpdateContext,
} from '../layer-renderer';
import { lerpCurve } from './shared';
import { buildVfxQuadMesh, buildVfxSphereMesh } from './mesh';

// ── Public data type ─────────────────────────────────────────────────────────

export type VfxShaderGeometry = 'billboard' | 'quad' | 'sphere';

/** float | vec2 | vec3 | vec4 - passed straight to material.setParameter. */
export interface VfxShaderUniform {
  value: number | number[];
}

export interface VfxShaderLayer extends VfxLayerBase {
  type: 'shader';

  /** Mesh the shader draws on. billboard = camera-facing quad. */
  geometry: VfxShaderGeometry;

  /** GLSL ES 1.00 fragment shader. Required. */
  fragmentGLSL: string;
  /** Optional GLSL ES 1.00 vertex shader. Defaults to the per-geometry VS. */
  vertexGLSL?: string;

  /** Custom uniforms, keyed by GLSL name (must be declared in the shader). */
  uniforms?: Record<string, VfxShaderUniform>;

  /** Global opacity multiplier exposed to the shader as `uOpacity`. */
  opacity: number;
  opacityKeys?: CurvePoint[];
  scaleKeys?: CurvePoint[];

  blendMode: 'additive' | 'alpha';
  depthTest: boolean;
  depthWrite: boolean;
  /** false → double-sided (CULLFACE_NONE), recommended for transparent FX. */
  cullFace: boolean;

  scale: number;
  positionOffset: [number, number, number];
  rotation: [number, number, number];
}

/**
 * Starter fragment shader (soft additive radial glow on a billboard that fades
 * out over the layer lifetime). Exported so editors/generators can seed a new
 * shader layer and use it as a canonical example.
 */
export const DEFAULT_SHADER_FRAGMENT = /* glsl */ `precision highp float;
varying vec2 vUv;
uniform float uProgress;   // 0..1 over the layer's lifetime
uniform float uOpacity;    // multiply final alpha by this
uniform vec3 uColor;       // custom uniform (see "uniforms" below)
void main() {
    vec2 p = vUv * 2.0 - 1.0;          // -1..1
    float d = length(p);
    float glow = pow(smoothstep(1.0, 0.0, d), 2.0);
    float fade = 1.0 - uProgress;       // fade out as the effect ends
    float alpha = glow * fade * uOpacity;
    gl_FragColor = vec4(uColor * glow * 3.0, alpha);
}`;

// ── default vertex shaders, one per geometry ────────────────────────────────
// Each exposes the same varying contract to the fragment shader:
//   vUv (vec2 0..1), vLocalPos (vec3), vWorldPos (vec3), vNormal (vec3 world).

const BILLBOARD_VS = /* glsl */ `
attribute vec3 vertex_position;
attribute vec2 vertex_texCoord0;
uniform mat4 matrix_model;
uniform mat4 matrix_view;
uniform mat4 matrix_viewProjection;
varying vec2 vUv;
varying vec3 vLocalPos;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
    vec3 center = matrix_model[3].xyz;
    float sx = length(matrix_model[0].xyz);
    float sy = length(matrix_model[1].xyz);
    vec3 camRight = vec3(matrix_view[0][0], matrix_view[1][0], matrix_view[2][0]);
    vec3 camUp    = vec3(matrix_view[0][1], matrix_view[1][1], matrix_view[2][1]);
    vec3 worldPos = center + (vertex_position.x * sx) * camRight + (vertex_position.y * sy) * camUp;
    vUv = vertex_texCoord0;
    vLocalPos = vertex_position;
    vWorldPos = worldPos;
    vNormal = normalize(cross(camRight, camUp));
    gl_Position = matrix_viewProjection * vec4(worldPos, 1.0);
}
`;

const QUAD_VS = /* glsl */ `
attribute vec3 vertex_position;
attribute vec3 vertex_normal;
attribute vec2 vertex_texCoord0;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
varying vec2 vUv;
varying vec3 vLocalPos;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
    vec4 wp = matrix_model * vec4(vertex_position, 1.0);
    vUv = vertex_texCoord0;
    vLocalPos = vertex_position;
    vWorldPos = wp.xyz;
    vNormal = normalize((matrix_model * vec4(vertex_normal, 0.0)).xyz);
    gl_Position = matrix_viewProjection * wp;
}
`;

const SPHERE_VS = /* glsl */ `
attribute vec3 vertex_position;
attribute vec3 vertex_normal;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
varying vec2 vUv;
varying vec3 vLocalPos;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
    vec4 wp = matrix_model * vec4(vertex_position, 1.0);
    vLocalPos = vertex_position;
    vWorldPos = wp.xyz;
    vNormal = normalize((matrix_model * vec4(vertex_normal, 0.0)).xyz);
    vec3 d = normalize(vertex_position);
    vUv = vec2(atan(d.z, d.x) / 6.28318530718 + 0.5, asin(clamp(d.y, -1.0, 1.0)) / 3.14159265359 + 0.5);
    gl_Position = matrix_viewProjection * wp;
}
`;

function defaultVS(geometry: VfxShaderGeometry): string {
  switch (geometry) {
    case 'sphere': return SPHERE_VS;
    case 'quad': return QUAD_VS;
    case 'billboard':
    default: return BILLBOARD_VS;
  }
}

function attributesFor(geometry: VfxShaderGeometry): Record<string, string> {
  if (geometry === 'sphere') {
    return { vertex_position: 'POSITION', vertex_normal: 'NORMAL' };
  }
  // billboard + quad both carry UVs; quad also uses the normal.
  return { vertex_position: 'POSITION', vertex_normal: 'NORMAL', vertex_texCoord0: 'TEXCOORD0' };
}

function meshFor(geometry: VfxShaderGeometry, device: GraphicsDevice): Mesh {
  return geometry === 'sphere' ? buildVfxSphereMesh(device, 32, 32) : buildVfxQuadMesh(device);
}

// ── GLSL pre-compile validation ─────────────────────────────────────────────
// Best-effort: compile the raw source against the device's WebGL context so
// the actual driver error log can be surfaced. The engine accepts ES 1.00
// shaders that declare their own uniforms, so a standalone compile is a
// faithful syntax check. Skipped on non-WebGL devices.

function compileLog(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  type: number,
  src: string,
): string | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
  const log = ok ? null : (gl.getShaderInfoLog(sh) || 'unknown compile error');
  gl.deleteShader(sh);
  return log;
}

/** Returns a human-readable error string, or null when both stages compile. */
export function validateShaderGLSL(device: GraphicsDevice, vs: string, fs: string): string | null {
  const gl = (device as unknown as { gl?: WebGLRenderingContext | WebGL2RenderingContext }).gl;
  if (!gl) return null; // headless / WebGPU device - skip
  const fsSrc = /precision\s+(low|medium|high)p\s+float/.test(fs) ? fs : `precision highp float;\n${fs}`;
  const vlog = compileLog(gl, gl.VERTEX_SHADER, vs);
  if (vlog) return `Vertex shader compile error:\n${vlog}`;
  const flog = compileLog(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (flog) return `Fragment shader compile error:\n${flog}`;
  return null;
}

// ── instance ────────────────────────────────────────────────────────────────

class ShaderLayerInstance implements VfxLayerInstance {
  private readonly _layer: VfxShaderLayer;
  private readonly _entity: Entity;
  private readonly _material: ShaderMaterial;

  // Explicit fields, not parameter properties: consumers compiling this source
  // with `erasableSyntaxOnly` reject the parameter-property form.
  constructor(layer: VfxShaderLayer, entity: Entity, material: ShaderMaterial) {
    this._layer = layer;
    this._entity = entity;
    this._material = material;
  }

  spawn(_pos: Vec3): void {}

  update(ctx: VfxLayerUpdateContext): void {
    const layer = this._layer;
    if (!layer.enabled || !ctx.alive) { this._entity.enabled = false; return; }
    this._entity.enabled = true;

    const nt = ctx.layerDuration > 0 ? Math.min(1, Math.max(0, ctx.t / ctx.layerDuration)) : 0;
    const scale = lerpCurve(layer.scaleKeys ?? [], nt);
    const opacity = lerpCurve(layer.opacityKeys ?? [], nt);

    const s = layer.scale * scale;
    this._entity.setLocalScale(s, s, s);

    const m = this._material;
    m.setParameter('uTime', ctx.t);
    m.setParameter('uProgress', nt);
    m.setParameter('uDuration', ctx.layerDuration);
    m.setParameter('uOpacity', layer.opacity * opacity);
    m.update();
  }

  reset(): void {
    this._entity.enabled = false;
    this._material.setParameter('uOpacity', 0);
    this._material.update();
  }

  dispose(): void {}
}

// ── renderer ──────────────────────────────────────────────────────────────

export class ShaderLayerRenderer implements VfxLayerRenderer<VfxShaderLayer> {
  readonly type = 'shader';

  build(layer: VfxShaderLayer, ctx: VfxLayerBuildContext): VfxLayerInstance {
    const device = ctx.app.graphicsDevice;
    const geometry = layer.geometry ?? 'billboard';
    const vs = layer.vertexGLSL && layer.vertexGLSL.trim() ? layer.vertexGLSL : defaultVS(geometry);
    const fs = layer.fragmentGLSL;

    if (!fs || !fs.trim()) {
      throw new Error(`shader layer "${layer.name}" has no fragmentGLSL`);
    }

    const err = validateShaderGLSL(device, vs, fs);
    if (err) throw new Error(`Shader layer "${layer.name}": ${err}`);

    const mat = new ShaderMaterial({
      uniqueName: `VfxShader_${layer.id}`,
      vertexGLSL: vs,
      fragmentGLSL: fs,
      attributes: attributesFor(geometry),
    });

    // Standard, always-present uniforms.
    mat.setParameter('uTime', 0);
    mat.setParameter('uProgress', 0);
    mat.setParameter('uDuration', layer.duration ?? 0);
    mat.setParameter('uOpacity', layer.opacity ?? 1);

    // Custom uniforms declared in the layer data.
    if (layer.uniforms) {
      for (const [name, spec] of Object.entries(layer.uniforms)) {
        if (spec && spec.value != null) mat.setParameter(name, spec.value as number | number[]);
      }
    }

    mat.blendType = layer.blendMode === 'alpha' ? BLEND_NORMAL : BLEND_ADDITIVE;
    mat.depthTest = layer.depthTest ?? false;
    mat.depthWrite = layer.depthWrite ?? false;
    mat.cull = layer.cullFace ? CULLFACE_BACK : CULLFACE_NONE;
    mat.update();

    const mi = new MeshInstance(meshFor(geometry, device), mat);
    const ent = new Entity(`vfx_shader_${layer.id}`);
    ent.addComponent('render', { meshInstances: [mi] });

    const [px, py, pz] = layer.positionOffset ?? [0, 0, 0];
    ent.setLocalPosition(px, py, pz);
    const [rx, ry, rz] = layer.rotation ?? [0, 0, 0];
    ent.setLocalEulerAngles(rx, ry, rz);
    const sc = layer.scale ?? 1;
    ent.setLocalScale(sc, sc, sc);

    ctx.parent.addChild(ent);

    return new ShaderLayerInstance(layer, ent, mat);
  }
}
