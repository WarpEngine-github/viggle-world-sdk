import {
  BLENDEQUATION_ADD,
  BLENDMODE_ONE_MINUS_SRC_ALPHA,
  BLENDMODE_SRC_ALPHA,
  BlendState,
  DepthState,
  EVENT_PRERENDER_LAYER,
  Mat4,
  QuadRender,
  SEMANTIC_POSITION,
  ShaderUtils,
} from 'playcanvas';
import type { Scene } from '../../scene';

/**
 * Configuration for {@link GroundPlane.create}.
 *
 * @group Presets
 * @category Visual
 */
export interface GroundPlaneOptions {
  /** Fill color as CSS hex (e.g. `#9aa0aa`). Default `#9aa0aa`. */
  color?: string;
  /** Fill opacity at the center, `0..1`. Default `0.9`. */
  opacity?: number;
  /** Distance from camera (XZ) where the fill starts fading out. Default `6`. */
  fadeStart?: number;
  /** Distance from camera where the fill reaches full transparency. Default `24`. */
  fadeEnd?: number;
  /** World-space Y position of the ground plane. Default `0`. */
  y?: number;
  /** Start enabled. Default `false`. */
  enabled?: boolean;
}

const groundFS = /* glsl */ `
precision highp float;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform float uGroundY;
varying vec2 vUv0;

void main() {
    vec2 ndc = vUv0 * 2.0 - 1.0;
    vec4 worldNear = uInvViewProj * vec4(ndc, -1.0, 1.0);
    vec4 worldFar  = uInvViewProj * vec4(ndc,  1.0, 1.0);
    vec3 rayOrigin = worldNear.xyz / worldNear.w;
    vec3 rayDir = normalize(worldFar.xyz / worldFar.w - rayOrigin);

    float denom = rayDir.y;
    if (abs(denom) < 1e-6) discard;

    float t = (uGroundY - rayOrigin.y) / denom;
    if (t < 0.0) discard;

    vec3 hitPos = rayOrigin + rayDir * t;
    float d = distance(hitPos.xz, uCamPos.xz);
    float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, d);
    float alpha = uOpacity * fade;
    if (alpha < 0.001) discard;

    gl_FragColor = vec4(uColor, alpha);
}
`;

const groundWGSL = /* wgsl */ `
uniform uInvViewProj: mat4x4f;
uniform uCamPos: vec3f;
uniform uColor: vec3f;
uniform uOpacity: f32;
uniform uFadeStart: f32;
uniform uFadeEnd: f32;
uniform uGroundY: f32;

varying vUv0: vec2f;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    let ndc = input.vUv0 * 2.0 - vec2f(1.0);
    let worldNear = uniform.uInvViewProj * vec4f(ndc, -1.0, 1.0);
    let worldFar  = uniform.uInvViewProj * vec4f(ndc,  1.0, 1.0);
    let rayOrigin = worldNear.xyz / worldNear.w;
    let rayDir = normalize(worldFar.xyz / worldFar.w - rayOrigin);

    let denom = rayDir.y;
    if (abs(denom) < 1e-6) { discard; }

    let t = (uniform.uGroundY - rayOrigin.y) / denom;
    if (t < 0.0) { discard; }

    let hitPos = rayOrigin + rayDir * t;
    let d = distance(hitPos.xz, uniform.uCamPos.xz);
    let fade = 1.0 - smoothstep(uniform.uFadeStart, uniform.uFadeEnd, d);
    let alpha = uniform.uOpacity * fade;
    if (alpha < 0.001) { discard; }

    output.color = vec4f(uniform.uColor, alpha);
    return output;
}
`;

function parseColor(css: string): [number, number, number] {
  const hex = css.replace('#', '');
  return [
    Number.parseInt(hex.substring(0, 2), 16) / 255,
    Number.parseInt(hex.substring(2, 4), 16) / 255,
    Number.parseInt(hex.substring(4, 6), 16) / 255,
  ];
}

/**
 * Opaque ground fill rendered via ray-plane intersection in a fullscreen
 * shader - the filled twin of {@link Grid}. Sorts correctly with gsplat
 * content the same way (drawn in the World layer's opaque prerender, before
 * the character paints over it), so it reads as a floor the character stands
 * on. A reference for judging vertical placement during motion clean-up.
 *
 * @group Presets
 * @category Visual
 */
export class GroundPlane {
  /** Toggle rendering without tearing down the shader. */
  enabled: boolean;

  private _color: [number, number, number];

  private constructor(enabled: boolean, color: [number, number, number]) {
    this.enabled = enabled;
    this._color = color;
  }

  /** Update the fill color at runtime. */
  setColor(css: string): void {
    const [r, g, b] = parseColor(css);
    this._color[0] = r; this._color[1] = g; this._color[2] = b;
  }

  /** Create and install the ground shader on the scene's World layer. */
  static create(scene: Scene, opts?: GroundPlaneOptions): GroundPlane {
    const color = parseColor(opts?.color ?? '#9aa0aa');
    const ground = new GroundPlane(opts?.enabled ?? false, color);
    const device = scene.graphicsDevice;
    const opacity = opts?.opacity ?? 0.9;
    const fadeStart = opts?.fadeStart ?? 6;
    const fadeEnd = opts?.fadeEnd ?? 24;
    const y = opts?.y ?? 0;

    const shader = ShaderUtils.createShader(device, {
      uniqueName: 'engine-ground-raycast',
      attributes: { vertex_position: SEMANTIC_POSITION },
      vertexChunk: 'fullscreenQuadVS',
      fragmentGLSL: groundFS,
      fragmentWGSL: groundWGSL,
    });

    const quadRender = new QuadRender(shader);

    scene.app.scene.on(
      EVENT_PRERENDER_LAYER,
      (_camera: unknown, layer: { name: string }, transparent: boolean) => {
        if (!ground.enabled) return;
        if (layer.name !== 'World' || transparent) return;

        const cam = scene.cameraEntity.camera;
        if (!cam) return;

        const viewMat = scene.cameraEntity.getWorldTransform().clone().invert();
        const projMat = cam.projectionMatrix;
        const viewProj = new Mat4().mul2(projMat, viewMat);
        const invViewProj = viewProj.clone().invert();
        const camPos = scene.cameraEntity.getPosition();

        device.scope.resolve('uInvViewProj').setValue(invViewProj.data);
        device.scope.resolve('uCamPos').setValue([camPos.x, camPos.y, camPos.z]);
        device.scope.resolve('uColor').setValue(ground._color);
        device.scope.resolve('uOpacity').setValue(opacity);
        device.scope.resolve('uFadeStart').setValue(fadeStart);
        device.scope.resolve('uFadeEnd').setValue(fadeEnd);
        device.scope.resolve('uGroundY').setValue(y);

        const blendState = new BlendState(
          true,
          BLENDEQUATION_ADD,
          BLENDMODE_SRC_ALPHA,
          BLENDMODE_ONE_MINUS_SRC_ALPHA,
        );
        device.setBlendState(blendState);
        // Background pass - no depth test/write, like Grid. World-layer
        // meshes and the gsplat character render after and paint over.
        device.setDepthState(DepthState.NODEPTH);
        quadRender.render();
        device.setBlendState(BlendState.NOBLEND);
      },
    );

    return ground;
  }
}
