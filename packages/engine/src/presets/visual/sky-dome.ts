import {
  DepthState,
  Entity,
  EVENT_PRERENDER_LAYER,
  Mat4,
  PROJECTION_ORTHOGRAPHIC,
  QuadRender,
  SEMANTIC_POSITION,
  ShaderUtils,
} from 'playcanvas';
import type { CameraComponent, Layer } from 'playcanvas';
import type { Scene } from '../../scene';

/**
 * Configuration for {@link SkyDome.create}. The zenith and horizon pair is
 * the original two-stop sky (`mode` 0); the other modes read the ground and
 * warm colours too. See {@link SkyDomeLook}.
 *
 * @group Presets
 * @category Visual
 */
export interface SkyDomeOptions extends Partial<SkyDomeLook> {
  /** Colour at the zenith (view direction pointing up). CSS hex. Default `#c2f0ff`. */
  topColor?: string;
  /** Colour at the horizon / below. CSS hex. Default `#ffffff`. */
  bottomColor?: string;
}

/**
 * The runtime-settable sky. Modes: `0` the original linear two-stop ramp
 * (top over bottom, the horizon at the 50% mix); `1` a horizon-weighted
 * three-stop (zenith, horizon band, ground under the floor); `2` twilight
 * (the three-stop with a warm band at the horizon); `3` weather (the
 * three-stop with a cloud layer by day, a star field when `dark`).
 *
 * @group Presets
 * @category Visual
 */
export interface SkyDomeLook {
  mode: 0 | 1 | 2 | 3;
  /** Colour straight up. CSS hex. */
  zenith: string;
  /** Colour at eye level. CSS hex. */
  horizon: string;
  /** Colour below the horizon. CSS hex. */
  ground: string;
  /** The twilight band. CSS hex. */
  warm: string;
  /** Night twin (weather draws stars). */
  dark: boolean;
}

const skyFS = /* glsl */ `
precision highp float;
uniform float uMode;
uniform vec3 uColorTop;
uniform vec3 uColorBottom;
uniform vec3 uGround;
uniform vec3 uWarm;
uniform float uDark;
uniform float uDim;
uniform mat4 uInvViewProj;
varying vec2 vUv0;

float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
    return 0.5 * vnoise(p) + 0.25 * vnoise(p * 2.03 + 17.0) + 0.125 * vnoise(p * 4.1 + 31.0);
}
// The default framing only sees y in about -0.5..0.26, so the zenith has to
// arrive by y ≈ 0.36 or the sky reads as one pale horizon band.
vec3 threeStop(float y) {
    if (y >= 0.0) return mix(uColorBottom, uColorTop, pow(smoothstep(0.0, 0.36, y), 0.8));
    return mix(uColorBottom, uGround, smoothstep(0.0, 0.5, -y));
}

void main() {
    // Reconstruct world-space view direction from screen UV
    vec2 ndc = vUv0 * 2.0 - 1.0;
    vec4 clipNear = vec4(ndc, -1.0, 1.0);
    vec4 clipFar  = vec4(ndc,  1.0, 1.0);
    vec4 worldNear = uInvViewProj * clipNear;
    vec4 worldFar  = uInvViewProj * clipFar;
    vec3 dir = normalize(worldFar.xyz / worldFar.w - worldNear.xyz / worldNear.w);
    float y = dir.y;
    vec3 col;
    if (uMode < 0.5) {
        col = mix(uColorBottom, uColorTop, y / 2.05 + 0.5);
    } else if (uMode < 1.5) {
        col = threeStop(y);
    } else if (uMode < 2.5) {
        // Dusk: a warm band at the horizon, the cool zenith above, the floor
        // taking a little of the warmth with it.
        vec3 hz = mix(uColorBottom, uWarm, 0.7);
        col = y >= 0.0
            ? mix(hz, uColorTop, pow(smoothstep(0.0, 0.5, y), 0.7))
            : mix(hz, uGround, smoothstep(0.0, 0.5, -y));
        col = mix(col, uWarm, 0.25 * exp(-abs(y - 0.02) * 7.0));
    } else {
        col = threeStop(y);
        if (uDark < 0.5) {
            // Day: a cloud layer on a plane 1 unit up, thinning toward the horizon.
            vec2 p = dir.xz / max(y, 0.03) * 1.0;
            float n = fbm(p + vec2(3.1, 7.7));
            float cloud = smoothstep(0.42, 0.72, n) * smoothstep(0.0, 0.14, y);
            col = mix(col, mix(uColorBottom, vec3(1.0), 0.6), cloud * 0.85);
        } else {
            // Night: a hashed star field above the horizon.
            vec3 cell = dir * 240.0;
            float h = hash3(floor(cell));
            float disc = 1.0 - smoothstep(0.18, 0.4, length(fract(cell) - 0.5));
            float star = step(0.995, h) * disc * smoothstep(0.01, 0.16, y);
            col += vec3(0.85, 0.9, 1.0) * star * (0.35 + 0.65 * fract(h * 91.7));
        }
    }
    // Lights down (the loading look, 2026-09-23): a step darker and cooler.
    col = mix(col, col * vec3(0.72, 0.78, 0.86), uDim);
    // One-LSB dither against banding on the long ramps.
    float dither = fract(52.9829189 * fract(0.06711056 * gl_FragCoord.x + 0.00583715 * gl_FragCoord.y));
    col += (dither - 0.5) / 255.0 * 2.0;
    gl_FragColor = vec4(col, 1.0);
}
`;

const skyWGSL = /* wgsl */ `
uniform uMode: f32;
uniform uColorTop: vec3f;
uniform uColorBottom: vec3f;
uniform uGround: vec3f;
uniform uWarm: vec3f;
uniform uDark: f32;
uniform uDim: f32;
uniform uInvViewProj: mat4x4f;

varying vUv0: vec2f;

fn hash2(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn hash3(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453); }
fn vnoise(p: vec2f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(p: vec2f) -> f32 {
    return 0.5 * vnoise(p) + 0.25 * vnoise(p * 2.03 + 17.0) + 0.125 * vnoise(p * 4.1 + 31.0);
}
fn threeStop(y: f32) -> vec3f {
    if (y >= 0.0) { return mix(uniform.uColorBottom, uniform.uColorTop, pow(smoothstep(0.0, 0.36, y), 0.8)); }
    return mix(uniform.uColorBottom, uniform.uGround, smoothstep(0.0, 0.5, -y));
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    let ndc = input.vUv0 * 2.0 - vec2f(1.0);
    let clipNear = vec4f(ndc, -1.0, 1.0);
    let clipFar  = vec4f(ndc,  1.0, 1.0);
    let worldNear = uniform.uInvViewProj * clipNear;
    let worldFar  = uniform.uInvViewProj * clipFar;
    let dir = normalize(worldFar.xyz / worldFar.w - worldNear.xyz / worldNear.w);
    let y = dir.y;
    var col: vec3f;
    if (uniform.uMode < 0.5) {
        col = mix(uniform.uColorBottom, uniform.uColorTop, vec3f(y / 2.05 + 0.5));
    } else if (uniform.uMode < 1.5) {
        col = threeStop(y);
    } else if (uniform.uMode < 2.5) {
        let hz = mix(uniform.uColorBottom, uniform.uWarm, vec3f(0.7));
        if (y >= 0.0) {
            col = mix(hz, uniform.uColorTop, vec3f(pow(smoothstep(0.0, 0.5, y), 0.7)));
        } else {
            col = mix(hz, uniform.uGround, vec3f(smoothstep(0.0, 0.5, -y)));
        }
        col = mix(col, uniform.uWarm, vec3f(0.25 * exp(-abs(y - 0.02) * 7.0)));
    } else {
        col = threeStop(y);
        if (uniform.uDark < 0.5) {
            let p = dir.xz / max(y, 0.03) * 1.0;
            let n = fbm(p + vec2f(3.1, 7.7));
            let cloud = smoothstep(0.42, 0.72, n) * smoothstep(0.0, 0.14, y);
            col = mix(col, mix(uniform.uColorBottom, vec3f(1.0), vec3f(0.6)), vec3f(cloud * 0.85));
        } else {
            let cell = dir * 240.0;
            let h = hash3(floor(cell));
            let disc = 1.0 - smoothstep(0.18, 0.4, length(fract(cell) - vec3f(0.5)));
            let star = step(0.995, h) * disc * smoothstep(0.01, 0.16, y);
            col = col + vec3f(0.85, 0.9, 1.0) * star * (0.35 + 0.65 * fract(h * 91.7));
        }
    }
    col = mix(col, col * vec3f(0.72, 0.78, 0.86), vec3f(uniform.uDim));
    let px = input.vUv0 * 2048.0;
    let dither = fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y));
    col = col + vec3f((dither - 0.5) / 255.0 * 2.0);
    output.color = vec4f(col, 1.0);
    return output;
}
`;

function parseColor(css: string): [number, number, number] {
  const hex = css.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  return [r, g, b];
}

/**
 * View-direction-aware gradient sky background.
 *
 * Renders a fullscreen shader before the World layer that maps the screen
 * ray's Y component (-1…1) to a `bottomColor`…`topColor` gradient. The
 * gradient follows the camera as it pitches, giving a horizon that stays
 * roughly level regardless of look direction.
 *
 * @example
 * ```ts
 * const sky = SkyDome.create(scene, {
 *   topColor: '#c2f0ff', bottomColor: '#ffffff',
 * });
 * sky.enabled = false; // hide
 * ```
 *
 * @group Presets
 * @category Visual
 */
export class SkyDome {
  /** Toggle rendering without tearing down the shader. */
  enabled = true;
  /** Underlying PlayCanvas entity attached to the scene's content root. */
  entity: Entity;

  private _topColor!: [number, number, number];
  private _bottomColor!: [number, number, number];
  private _ground!: [number, number, number];
  private _warm!: [number, number, number];
  private _mode = 0;
  private _dark = 0;
  /** Lights down, 0..1: the sky a step darker and cooler (the loading look). */
  dim = 0;

  private constructor(entity: Entity) {
    this.entity = entity;
  }

  /** Update the zenith color at runtime. */
  setTopColor(css: string): void {
    const [r, g, b] = parseColor(css);
    this._topColor[0] = r; this._topColor[1] = g; this._topColor[2] = b;
  }

  /** Update the horizon color at runtime. */
  setBottomColor(css: string): void {
    const [r, g, b] = parseColor(css);
    this._bottomColor[0] = r; this._bottomColor[1] = g; this._bottomColor[2] = b;
  }

  /** Update the whole look at runtime: mode, the four colours, the night flag. */
  setLook(look: Partial<SkyDomeLook>): void {
    if (look.zenith) this.setTopColor(look.zenith);
    if (look.horizon) this.setBottomColor(look.horizon);
    if (look.ground) {
      const [r, g, b] = parseColor(look.ground);
      this._ground[0] = r; this._ground[1] = g; this._ground[2] = b;
    }
    if (look.warm) {
      const [r, g, b] = parseColor(look.warm);
      this._warm[0] = r; this._warm[1] = g; this._warm[2] = b;
    }
    if (look.mode !== undefined) this._mode = look.mode;
    if (look.dark !== undefined) this._dark = look.dark ? 1 : 0;
  }

  /** Create and install the sky shader on the scene's World layer. */
  static create(scene: Scene, opts?: SkyDomeOptions): SkyDome {
    const device = scene.graphicsDevice;
    const topColor = parseColor(opts?.zenith ?? opts?.topColor ?? '#c2f0ff');
    const bottomColor = parseColor(opts?.horizon ?? opts?.bottomColor ?? '#ffffff');
    const ground = parseColor(opts?.ground ?? opts?.horizon ?? opts?.bottomColor ?? '#ffffff');
    const warm = parseColor(opts?.warm ?? '#ffd9a6');

    const shader = ShaderUtils.createShader(device, {
      uniqueName: 'engine-sky-gradient',
      attributes: { vertex_position: SEMANTIC_POSITION },
      vertexChunk: 'fullscreenQuadVS',
      fragmentGLSL: skyFS,
      fragmentWGSL: skyWGSL,
    });

    const quadRender = new QuadRender(shader);
    const skyLens = new Mat4();
    const entity = new Entity('skyDome');
    scene.contentRoot.addChild(entity);
    const sky = new SkyDome(entity);
    // Wire instance fields to the same arrays the render callback captures,
    // so the setters mutate what the shader reads each frame.
    sky._topColor = topColor;
    sky._bottomColor = bottomColor;
    sky._ground = ground;
    sky._warm = warm;
    sky._mode = opts?.mode ?? 0;
    sky._dark = opts?.dark ? 1 : 0;

    scene.app.scene.on(
      EVENT_PRERENDER_LAYER,
      (_camera: CameraComponent, layer: Layer, transparent: boolean) => {
        if (!sky.enabled) return;
        if (layer.name !== 'World' || transparent) return;

        const cam = scene.cameraEntity.camera;
        if (!cam) return;
        const viewMat = scene.cameraEntity.getWorldTransform().clone().invert();
        // Ortho rays are parallel, so every pixel would read one colour: draw
        // the sky through the camera's perspective lens. Near and far are
        // arbitrary; the shader only reads the direction between them.
        const projMat = cam.projection === PROJECTION_ORTHOGRAPHIC
          ? skyLens.setPerspective(cam.fov, cam.aspectRatio, 0.1, 1000, cam.horizontalFov)
          : cam.projectionMatrix;
        const viewProj = new Mat4().mul2(projMat, viewMat);
        const invViewProj = viewProj.clone().invert();

        device.scope.resolve('uMode').setValue(sky._mode);
        device.scope.resolve('uColorTop').setValue(topColor);
        device.scope.resolve('uColorBottom').setValue(bottomColor);
        device.scope.resolve('uGround').setValue(ground);
        device.scope.resolve('uWarm').setValue(warm);
        device.scope.resolve('uDark').setValue(sky._dark);
        device.scope.resolve('uDim').setValue(sky.dim);
        device.scope.resolve('uInvViewProj').setValue(invViewProj.data);
        // The fullscreen quad VS writes gl_Position.z = 0.5; if the graphics
        // device has a depth buffer (Scene `depth: true`) the default
        // write-depth state would stamp 0.5 across the screen here and
        // occlude any world geometry farther than mid-frustum.
        device.setDepthState(DepthState.NODEPTH);
        quadRender.render();
      },
    );

    return sky;
  }
}
