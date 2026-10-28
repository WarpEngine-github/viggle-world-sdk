/**
 * The splat character reveal on a skinned mesh: the same feet-to-head front,
 * hot band and sketch dots, drawn by patching a StandardMaterial's lit hooks.
 * Each vertex's distance along the skeleton is baked once, as a splat's is,
 * and read in the vertex shader by vertex index.
 *
 * What a mesh cannot copy: splats stretch inside the band and shrink ahead of
 * it. Ahead of the front, sketch dots are discs cut out of the surface on a
 * bind-space grid; the band's fade and the outgoing dissolve stipple, since
 * the body draws opaque.
 */
import type { GraphicsDevice, GraphNode, Mesh, MeshInstance, StandardMaterial } from 'playcanvas';
import {
  ADDRESS_CLAMP_TO_EDGE,
  FILTER_NEAREST,
  Mat4,
  PIXELFORMAT_R32F,
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  Texture,
  Vec3,
} from 'playcanvas';

import { bakeRevealDistances, buildRevealSkeleton } from './splat/reveal-bake';
import { DEFAULT_REVEAL_LOOK, packRevealLook } from './splat/reveal-look';
import type { RevealLook } from './splat/reveal-look';

/** One skinned mesh, in its skin's bind space. */
export interface RevealSurface {
  mesh: Mesh;
  bones: GraphNode[];
  inverseBindPose: Mat4[];
  vertexCount: number;
  /** xyz per vertex. */
  positions: Float32Array;
  /** Four bone slots and four weights per vertex. */
  joints: Float32Array;
  weights: Float32Array;
}

/** Sketch grid cell, as a share of the body's bind-space diagonal. */
const SKETCH_CELL = 0.012;
/** Widest a distance texture gets; rows take the rest. */
const MAX_TEXTURE_WIDTH = 4096;

/**
 * The reveal state of one {@link MeshCharacter}: a distance texture per mesh
 * and the uniforms every patched instance shares. Instances hold the arrays
 * by reference, so writing them is all a frame costs.
 */
export class MeshReveal {
  /** x = amount, y = inverse, z = sketch cell size in bind units, w = pulse strength. */
  readonly state = new Float32Array([1, 0, 1, 0]);
  readonly band = new Float32Array(4);
  readonly sketch = new Float32Array(4);
  readonly tint = new Float32Array(4);
  private readonly _textures = new Map<Mesh, Texture>();
  /** For instances with no skin of their own: everything at the head end. */
  private readonly _fallback: Texture;

  constructor(device: GraphicsDevice, surfaces: RevealSurface[], rigBones: GraphNode[], parents: Int32Array, pelvis: number) {
    packRevealLook(DEFAULT_REVEAL_LOOK, this.band, this.sketch, this.tint);
    const { distances, diagonal } = bakeSurfaces(surfaces, rigBones, parents, pelvis);
    this.state[2] = Math.max(diagonal * SKETCH_CELL, 1e-6);
    surfaces.forEach((s, i) => {
      if (!this._textures.has(s.mesh)) this._textures.set(s.mesh, distanceTexture(device, distances[i]));
    });
    this._fallback = distanceTexture(device, new Float32Array([1]));
  }

  setLook(look: RevealLook): void {
    packRevealLook(look, this.band, this.sketch, this.tint);
  }

  /** Point an instance at its mesh's distances and the shared uniforms. */
  bind(mi: MeshInstance): void {
    mi.setParameter('uRevealDistance', (mi.mesh && this._textures.get(mi.mesh)) ?? this._fallback);
    mi.setParameter('uRevealState', this.state);
    mi.setParameter('uRevealBand', this.band);
    mi.setParameter('uRevealSketch', this.sketch);
    mi.setParameter('uRevealTint', this.tint);
  }

  destroy(): void {
    for (const t of this._textures.values()) t.destroy();
    this._textures.clear();
    this._fallback.destroy();
  }
}

/**
 * Per-vertex distances, 0 at the feet and 1 at the far end of the body. A
 * bone sits at its inverse bind pose's inverse, the space the vertices are in.
 */
function bakeSurfaces(
  surfaces: RevealSurface[],
  rigBones: GraphNode[],
  parents: Int32Array,
  pelvis: number,
): { distances: Float32Array[]; diagonal: number } {
  const index = new Map(rigBones.map((b, i) => [b, i]));
  const pos = new Float32Array(rigBones.length * 3);
  const m = new Mat4();
  const t = new Vec3();
  for (const s of surfaces) {
    s.bones.forEach((b, j) => {
      const i = index.get(b);
      if (i === undefined) return;
      m.copy(s.inverseBindPose[j]).invert().getTranslation(t);
      pos[i * 3] = t.x; pos[i * 3 + 1] = t.y; pos[i * 3 + 2] = t.z;
    });
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const s of surfaces) {
    for (let v = 0; v < s.vertexCount; v++) {
      for (let a = 0; a < 3; a++) {
        const p = s.positions[v * 3 + a];
        if (p < min[a]) min[a] = p;
        if (p > max[a]) max[a] = p;
      }
    }
  }
  const empty = !(min[0] <= max[0]);
  const diagonal = empty ? 1 : Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const centre = empty
    ? { x: 0, y: 0, z: 0 }
    : { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 };
  const skeleton = buildRevealSkeleton(pos, parents, rigBones.map((b) => b.name), centre, pelvis);

  const distances = surfaces.map((s) => {
    // A missing bake shows the surface only as the sweep completes.
    const out = new Float32Array(s.vertexCount).fill(1);
    if (!skeleton) return out;
    const n = s.vertexCount;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const z = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      x[v] = s.positions[v * 3]; y[v] = s.positions[v * 3 + 1]; z[v] = s.positions[v * 3 + 2];
    }
    const remap = s.bones.map((b) => index.get(b) ?? -1);
    bakeRevealDistances(out, { x, y, z, indices: s.joints, weights: s.weights, numSplats: n }, skeleton, remap);
    return out;
  });
  return { distances, diagonal };
}

function distanceTexture(device: GraphicsDevice, d: Float32Array): Texture {
  const width = Math.max(1, Math.min(d.length, MAX_TEXTURE_WIDTH));
  const height = Math.max(1, Math.ceil(d.length / width));
  const texture = new Texture(device, {
    name: 'meshRevealDistance',
    width,
    height,
    format: PIXELFORMAT_R32F,
    mipmaps: false,
    minFilter: FILTER_NEAREST,
    magFilter: FILTER_NEAREST,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
  });
  const data = texture.lock() as Float32Array;
  data.fill(1);
  data.set(d);
  texture.unlock();
  return texture;
}

/** Patch a material's lit hooks with the reveal. Its instances need {@link MeshReveal.bind}. */
export function revealChunks(material: StandardMaterial): void {
  const glsl = material.getShaderChunks(SHADERLANGUAGE_GLSL);
  glsl.set('litUserDeclarationVS', GLSL_DECL_VS);
  glsl.set('litUserMainEndVS', GLSL_END_VS);
  glsl.set('litUserDeclarationPS', GLSL_DECL_PS);
  glsl.set('litUserMainEndPS', GLSL_END_PS);
  const wgsl = material.getShaderChunks(SHADERLANGUAGE_WGSL);
  wgsl.set('litUserDeclarationVS', WGSL_DECL_VS);
  wgsl.set('litUserMainEndVS', WGSL_END_VS);
  wgsl.set('litUserDeclarationPS', WGSL_DECL_PS);
  wgsl.set('litUserMainEndPS', WGSL_END_PS);
  material.shaderChunksVersion = '2.23';
  material.update();
}

// Uniforms: uRevealState x = amount, y = inverse, z = sketch cell size,
// w = pulse strength (the band over a whole model, nothing discarded);
// uRevealBand / uRevealSketch / uRevealTint as on a splat (see RevealLook).
// The forward pass recolours; every pass discards, so shadows and picking
// match what is on screen.

const GLSL_DECL_VS = `
uniform highp sampler2D uRevealDistance;
varying float vRevealD;
varying vec3 vRevealP;
`;

const GLSL_END_VS = `
    ivec2 revealSize = textureSize(uRevealDistance, 0);
    vRevealD = texelFetch(uRevealDistance, ivec2(gl_VertexID % revealSize.x, min(gl_VertexID / revealSize.x, revealSize.y - 1)), 0).r;
    vRevealP = vertex_position.xyz;
`;

const GLSL_DECL_PS = `
uniform vec4 uRevealState;
uniform vec4 uRevealBand;
uniform vec4 uRevealSketch;
uniform vec4 uRevealTint;
varying float vRevealD;
varying vec3 vRevealP;

float revealHash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}

// The splat reveal's bright edge colour, from the shaded colour.
vec3 revealHot(vec3 base) {
    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    vec3 tint = uRevealTint.rgb;
    float floorLuma = max(uRevealTint.a, 1e-4);
    float luma = dot(base, LUMA);
    vec3 hot = clamp(mix(vec3(luma), base, 2.2) * 1.9, 0.0, 1.0);
    hot = mix(hot, tint * max(luma, 0.35) * 2.0, 0.3);
    hot = clamp(hot, 0.0, 1.0);
    float lift = clamp((floorLuma - dot(hot, LUMA)) / floorLuma, 0.0, 1.0);
    return mix(hot, tint, lift);
}

// A disc per kept bind-space cell, jittered inside it, so the dots ride the body.
float revealSketch(float x) {
    float lead = uRevealSketch.x;
    if (x >= 0.0 || x < -lead) return 0.0;
    vec3 p = vRevealP / uRevealState.z;
    vec3 cell = floor(p);
    // >=: the hash can be exactly 0, and density 0 must still draw nothing.
    if (revealHash(cell) >= uRevealSketch.y) return 0.0;
    float r = clamp(uRevealSketch.z, 0.05, 0.5);
    vec3 jitter = vec3(revealHash(cell + 17.0), revealHash(cell + 31.0), revealHash(cell + 47.0));
    if (distance(p, cell + r + jitter * (1.0 - 2.0 * r)) > r) return 0.0;
    return smoothstep(-lead, -lead * 0.7, x);
}

// Screen-space threshold in [0, 1): a partial keep stipples.
float revealDither() {
    return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
}
`;

const GLSL_END_PS = `
    if (uRevealState.w > 0.0) {
        #ifdef FORWARD_PASS
        float bandWidth = uRevealBand.x;
        float x = abs(mix(-bandWidth, 1.0 + bandWidth, uRevealState.x) - vRevealD);
        float heat = (1.0 - smoothstep(bandWidth * uRevealBand.y, bandWidth, x)) * uRevealState.w;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, revealHot(clamp(gl_FragColor.rgb, 0.0, 1.0)), heat);
        #endif
    } else if (uRevealState.x < 1.0 || uRevealState.y > 0.5) {
        float bandWidth = uRevealBand.x;
        float x = mix(-bandWidth, 1.0 + bandWidth, uRevealState.x) - vRevealD;
        float keep = 1.0;
        float heat = 0.0;
        if (uRevealState.y > 0.5) {
            if (x >= 0.0) {
                heat = 1.0 - smoothstep(0.0, bandWidth, x);
                keep = heat * 0.95;
            }
        } else if (x >= 0.0) {
            heat = 1.0 - smoothstep(bandWidth * uRevealBand.y, bandWidth, x);
        } else {
            keep = revealSketch(x);
            heat = 1.0;
        }
        if (keep <= revealDither()) discard;
        #ifdef FORWARD_PASS
        gl_FragColor.rgb = mix(gl_FragColor.rgb, revealHot(clamp(gl_FragColor.rgb, 0.0, 1.0)), heat);
        #endif
    }
`;

const WGSL_DECL_VS = `
var uRevealDistance: texture_2d<f32>;
varying vRevealD: f32;
varying vRevealP: vec3f;
`;

const WGSL_END_VS = `
    let revealSize = vec2i(textureDimensions(uRevealDistance, 0));
    let revealId = i32(pcVertexIndex);
    output.vRevealD = textureLoad(uRevealDistance, vec2i(revealId % revealSize.x, min(revealId / revealSize.x, revealSize.y - 1)), 0).r;
    output.vRevealP = vertex_position.xyz;
`;

const WGSL_DECL_PS = `
uniform uRevealState: vec4f;
uniform uRevealBand: vec4f;
uniform uRevealSketch: vec4f;
uniform uRevealTint: vec4f;
varying vRevealD: f32;
varying vRevealP: vec3f;

fn revealHash(p: vec3f) -> f32 {
    return fract(sin(dot(p, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
}

fn revealHot(base: vec3f) -> vec3f {
    let LUMA = vec3f(0.2126, 0.7152, 0.0722);
    let tint = uniform.uRevealTint.rgb;
    let floorLuma = max(uniform.uRevealTint.a, 1e-4);
    let luma = dot(base, LUMA);
    var hot = clamp(mix(vec3f(luma), base, 2.2) * 1.9, vec3f(0.0), vec3f(1.0));
    hot = mix(hot, tint * max(luma, 0.35) * 2.0, 0.3);
    hot = clamp(hot, vec3f(0.0), vec3f(1.0));
    let lift = clamp((floorLuma - dot(hot, LUMA)) / floorLuma, 0.0, 1.0);
    return mix(hot, tint, lift);
}

fn revealSketch(x: f32) -> f32 {
    let lead = uniform.uRevealSketch.x;
    if (x >= 0.0 || x < -lead) { return 0.0; }
    let p = vRevealP / uniform.uRevealState.z;
    let cell = floor(p);
    if (revealHash(cell) >= uniform.uRevealSketch.y) { return 0.0; }
    let r = clamp(uniform.uRevealSketch.z, 0.05, 0.5);
    let jitter = vec3f(revealHash(cell + 17.0), revealHash(cell + 31.0), revealHash(cell + 47.0));
    if (distance(p, cell + r + jitter * (1.0 - 2.0 * r)) > r) { return 0.0; }
    return smoothstep(-lead, -lead * 0.7, x);
}

fn revealDither() -> f32 {
    return fract(52.9829189 * fract(dot(pcPosition.xy, vec2f(0.06711056, 0.00583715))));
}
`;

const WGSL_END_PS = `
    if (uniform.uRevealState.w > 0.0) {
        #ifdef FORWARD_PASS
        let bandWidth = uniform.uRevealBand.x;
        let x = abs(mix(-bandWidth, 1.0 + bandWidth, uniform.uRevealState.x) - vRevealD);
        let heat = (1.0 - smoothstep(bandWidth * uniform.uRevealBand.y, bandWidth, x)) * uniform.uRevealState.w;
        let revealBase = output.color.rgb;
        output.color = vec4f(mix(revealBase, revealHot(clamp(revealBase, vec3f(0.0), vec3f(1.0))), heat), output.color.a);
        #endif
    } else if (uniform.uRevealState.x < 1.0 || uniform.uRevealState.y > 0.5) {
        let bandWidth = uniform.uRevealBand.x;
        let x = mix(-bandWidth, 1.0 + bandWidth, uniform.uRevealState.x) - vRevealD;
        var keep = 1.0;
        var heat = 0.0;
        if (uniform.uRevealState.y > 0.5) {
            if (x >= 0.0) {
                heat = 1.0 - smoothstep(0.0, bandWidth, x);
                keep = heat * 0.95;
            }
        } else if (x >= 0.0) {
            heat = 1.0 - smoothstep(bandWidth * uniform.uRevealBand.y, bandWidth, x);
        } else {
            keep = revealSketch(x);
            heat = 1.0;
        }
        if (keep <= revealDither()) { discard; }
        #ifdef FORWARD_PASS
        let revealBase = output.color.rgb;
        output.color = vec4f(mix(revealBase, revealHot(clamp(revealBase, vec3f(0.0), vec3f(1.0))), heat), output.color.a);
        #endif
    }
`;
