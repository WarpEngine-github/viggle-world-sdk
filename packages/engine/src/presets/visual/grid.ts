import {
  BLENDEQUATION_ADD,
  BLENDMODE_ONE,
  BLENDMODE_ONE_MINUS_SRC_ALPHA,
  BLENDMODE_SRC_ALPHA,
  BlendState,
  DepthState,
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
 * Configuration for {@link Grid.create}.
 *
 * @group Presets
 * @category Visual
 */
export interface GridOptions {
  /** Grid size (half-extent, in world units). Default `50`. */
  size?: number;
  /** Number of divisions across the full grid size. Default `100`. */
  divisions?: number;
  /** Grid line color as CSS hex (e.g. `#b5b5b5`). Default `#b5b5b5`. */
  color?: string;
  /** Distance on XZ from the fade centre (the camera unless {@link Grid.fadeCentre} is set) where lines start to fade out. Default `3`. */
  fadeStart?: number;
  /** Distance from the fade centre where lines fade to full transparency. Default `18`. */
  fadeEnd?: number;
  /** World-space Y position of the grid plane. Default `0`. */
  y?: number;
  /** Show colored X (red) and Z (blue) axis lines. Default `true`. */
  showAxes?: boolean;
  /**
   * Physical width of a grid line as a fraction of one cell (`size /
   * divisions`), so `0.04` on a 1-unit cell is a 4 cm line. Default `0.04`.
   *
   * On screen the line is never heavier than one pixel of coverage, spread
   * over a two-pixel band, whatever the zoom or canvas size; the width only
   * decides how far away and how obliquely the line can be seen before it
   * thins out. Axis lines are drawn twice this wide.
   */
  lineWidth?: number;
  /** `lines` (default), `dots` in staggered (hex-packed) rows, or `rings` about the origin. */
  pattern?: 'lines' | 'dots' | 'rings';
  /** Pixels of ink a line may lay down. Default `1`: one pixel of coverage
   *  however close the camera; `2` draws a two-pixel line. */
  weight?: number;
  /** Pattern opacity, 0-1. Default `1`. */
  strength?: number;
}

/** The runtime-settable part of a {@link Grid}: everything the scene panel's
 *  floor presets change. `spacing` is world units between lines, dots or
 *  rings (it sets `divisions` from `size`).
 *
 * @group Presets
 * @category Visual
 */
export interface GridLook {
  color?: string;
  pattern?: 'lines' | 'dots' | 'rings';
  spacing?: number;
  weight?: number;
  strength?: number;
  fadeStart?: number;
  fadeEnd?: number;
}

const gridFS = /* glsl */ `
precision highp float;
uniform mat4 uInvViewProj;
uniform vec2 uFadeCentre;
uniform float uOrtho;
uniform float uLevel;
uniform vec3 uColor;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform float uGridY;
uniform float uSize;
uniform float uDivisions;
uniform float uShowAxes;
uniform float uLineWidth;
uniform float uPattern;
uniform float uWeight;
uniform float uStrength;
uniform float uTime;
uniform float uPulse;
uniform float uDrift;
uniform float uEmitUntil;
varying vec2 vUv0;

// Coverage of a line of physical width "width" centred at dist = 0, seen
// through pixels that are "deriv" wide in the same units.
//  - ink: a line can never lay down more than one pixel's worth of
//    coverage, so zooming in or a taller canvas does not fatten the grid;
//    a line thinner than a pixel keeps its true (smaller) ink.
//  - drawWidth: the band is at least two pixels wide, so full ink spreads
//    over two rows at half alpha instead of saturating the one row the
//    line happens to cross (the hard 1px core at a 1:1 backing store).
//  - ink / drawWidth: alpha scales so the ink is conserved over the band;
//    a line thinner than a pixel fades instead of aliasing, which also
//    kills far-field moire.
//  - smoothstep: a ~1.5 px edge rather than a hard cutoff.
float lineCoverage(float dist, float deriv, float width) {
    // uWeight pixels of ink at most (1 = the one-pixel grid described above).
    float ink = min(width, deriv * uWeight);
    float drawWidth = max(ink, deriv * 2.0);
    float aa = deriv * 1.5;
    float band = 1.0 - smoothstep(drawWidth - aa, drawWidth + aa, dist * 2.0);
    return band * (ink / drawWidth);
}

// Pixel footprint of a scalar field: how much it changes across one pixel
// in any screen direction (isotropic, unlike fwidth's |dx| + |dy|).
float pixelFootprint(float v) {
    return length(vec2(dFdx(v), dFdy(v)));
}

// Loading pulse (Canvas Loading studies, 2026-09-23): fronts leave the origin
// every 1.1 s at 3.2 m/s, 0.45 m wide, the newest brightest. The three
// patterns wear it differently below; uPulse (0..1) is its amplitude. Fronts
// start at uTime 0, and nothing new starts after uEmitUntil (seconds); what
// is already out plays through.
float front(float r) {
    float travel = 3.52;
    float phase = mod(uTime, 1.1) * 3.2;
    float f = 0.0;
    for (int n = 0; n < 4; n++) {
        float rn = phase + float(n) * travel;
        float born = (floor(uTime / 1.1) - float(n)) * 1.1;
        float x = (r - rn) / 0.45;
        f += exp(-x * x) * (1.0 - smoothstep(0.0, 4.0 * travel, rn)) * step(0.0, born) * step(born, uEmitUntil);
    }
    return f;
}
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// The pattern at one spacing: x its coverage, y the loading flash, z its strength.
vec3 floorPattern(vec3 hitPos, float spacing) {
    // Grid lines in cell units: distance to the nearest line on each axis,
    // the pixel footprint on each axis, then the line coverage per axis.
    vec2 uv = hitPos.xz / spacing;
    vec2 deriv = vec2(pixelFootprint(uv.x), pixelFootprint(uv.y));
    vec2 dist = abs(fract(uv + 0.5) - 0.5);
    float line;
    float extra = 0.0;
    float strength = uStrength;
    if (uPattern < 0.5) {
        vec2 g = vec2(
            lineCoverage(dist.x, deriv.x, uLineWidth),
            lineCoverage(dist.y, deriv.y, uLineWidth));
        // Once a cell is under two pixels wide the lines cannot be resolved:
        // blend to their average coverage instead of a moire pattern.
        vec2 ink = min(vec2(uLineWidth), deriv * uWeight);
        g = mix(g, ink, clamp(deriv * 2.0 - 1.0, 0.0, 1.0));
        // Union of the two directions, so crossings do not double up.
        line = mix(g.x, 1.0, g.y);
        // Loading: across the whole floor, cells flash on their own cycles - 80%
        // of them take part, a touch more near the spot; the lines keep still.
        if (uPulse > 0.0) {
            vec2 cellId = floor(uv);
            float ph = fract(uTime / 2.2 + hash2(cellId));
            float flash = exp(-pow((ph - 0.5) / 0.09, 2.0));
            // A flash spans ph 0.25..0.75; only one begun by uEmitUntil plays.
            float on = step(hash2(cellId + 7.3), 0.8)
                * step(uTime + (0.25 - ph) * 2.2, uEmitUntil);
            extra = uPulse * 0.22 * flash * on * (0.7 + 0.3 * exp(-length(hitPos.xz) / 6.0));
        }
    } else if (uPattern < 1.5) {
        // Staggered dots (dot floor studies, 2026-09-21): every other row
        // slides half a cell and rows sit √3/2 apart, a true hex packing, so
        // no straight column catches the eye. A dot is about uWeight × 1.4
        // pixels across, never smaller than 1.75 line widths, fading out
        // once a cell is under two pixels wide.
        float pitch = spacing * 0.8660254;
        vec2 h = vec2(hitPos.x / spacing, hitPos.z / pitch);
        float row = floor(h.y + 0.5);
        h.x += 0.5 * mod(row, 2.0);
        vec2 cell = vec2(fract(h.x + 0.5) - 0.5, h.y - row) * vec2(spacing, pitch);
        vec2 dw = vec2(pixelFootprint(hitPos.x), pixelFootprint(hitPos.z));
        float fw = length(dw) * 0.75;
        // Loading: each dot swells and brightens as a front passes it.
        float fr = uPulse * front(length(hitPos.xz));
        float rad = max(uLineWidth * 1.75 * spacing, fw * uWeight * 1.4) * (1.0 + 0.9 * fr);
        line = (1.0 - smoothstep(rad - fw, rad + fw, length(cell)))
            * (1.0 - clamp(length(deriv) * 2.0 - 1.0, 0.0, 1.0));
        strength = min(1.0, uStrength * (1.0 + 1.6 * fr));
    } else {
        // Rings about the origin, one per cell of radius, offset half a base
        // cell so the first sits close around the feet (and every ortho level
        // stays a subset). Loading: the rings travel outward (uDrift, metres),
        // each new one forming at the centre, which closes over 1.5 s once
        // the wait ends.
        float ro = length(hitPos.xz);
        float halfCell = 0.5 * uSize / uDivisions;
        float r = (ro - uDrift - halfCell) / spacing;
        line = lineCoverage(abs(fract(r + 0.5) - 0.5), pixelFootprint(r), uLineWidth);
        float hole = uPulse * (1.0 - clamp((uTime - uEmitUntil) / 1.5, 0.0, 1.0));
        line *= mix(1.0, smoothstep(0.0, halfCell * 0.7, ro), hole);
    }
    return vec3(line, extra, strength);
}

void main() {
    // Reconstruct world-space ray from screen UV
    vec2 ndc = vUv0 * 2.0 - 1.0;
    vec4 worldNear = uInvViewProj * vec4(ndc, -1.0, 1.0);
    vec4 worldFar  = uInvViewProj * vec4(ndc,  1.0, 1.0);
    vec3 rayOrigin = worldNear.xyz / worldNear.w;
    vec3 rayDir = normalize(worldFar.xyz / worldFar.w - rayOrigin);

    // Ray-plane intersection at y = uGridY
    float denom = rayDir.y;
    if (abs(denom) < 1e-6) discard;

    // In ortho the camera's place along its axis changes nothing on screen,
    // so the plane shows from either side.
    float t = (uGridY - rayOrigin.y) / denom;
    if (t < 0.0 && uOrtho < 0.5) discard;

    vec3 hitPos = rayOrigin + rayDir * t;

    float spacing = uSize / uDivisions;
    // Ortho, zoomed out: uLevel doublings coarser. Each level is a subset of
    // the one before, so between two the extra lines, dots or rings fade out.
    float level = floor(uLevel);
    float s0 = spacing * exp2(level);
    vec3 pat = mix(floorPattern(hitPos, s0), floorPattern(hitPos, s0 * 2.0), smoothstep(0.0, 1.0, uLevel - level));
    float line = pat.x;
    float extra = pat.y;
    float strength = pat.z;

    // Axis lines, twice the grid width: X axis along z=0, Z axis along x=0
    float axisWidth = uLineWidth * spacing * 2.0;
    float axisLineX = lineCoverage(abs(hitPos.z), pixelFootprint(hitPos.z), axisWidth);
    float axisLineZ = lineCoverage(abs(hitPos.x), pixelFootprint(hitPos.x), axisWidth);

    // Distance fade from the fade centre (the camera's XZ unless one is set)
    float d = distance(hitPos.xz, uFadeCentre);
    float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, d);

    // Compose color: grid lines in uColor, axes in red/blue
    vec3 col = uColor;
    float alpha = line * fade * strength + extra * fade;

    if (uShowAxes > 0.5) {
        if (axisLineX > 0.01) {
            col = vec3(0.8, 0.2, 0.2);  // X axis = red
            alpha = max(alpha, axisLineX * fade);
        }
        if (axisLineZ > 0.01) {
            col = vec3(0.2, 0.4, 0.8);  // Z axis = blue
            alpha = max(alpha, axisLineZ * fade);
        }
    }

    if (alpha < 0.001) discard;

    gl_FragColor = vec4(col, alpha);
}
`;

const gridWGSL = /* wgsl */ `
uniform uInvViewProj: mat4x4f;
uniform uFadeCentre: vec2f;
uniform uOrtho: f32;
uniform uLevel: f32;
uniform uColor: vec3f;
uniform uFadeStart: f32;
uniform uFadeEnd: f32;
uniform uGridY: f32;
uniform uSize: f32;
uniform uDivisions: f32;
uniform uShowAxes: f32;
uniform uLineWidth: f32;
uniform uPattern: f32;
uniform uWeight: f32;
uniform uStrength: f32;
uniform uTime: f32;
uniform uPulse: f32;
uniform uDrift: f32;
uniform uEmitUntil: f32;

varying vUv0: vec2f;

// Same maths as the GLSL variant; see the comments there.
fn lineCoverage(dist: f32, deriv: f32, width: f32) -> f32 {
    let ink = min(width, deriv * uniform.uWeight);
    let drawWidth = max(ink, deriv * 2.0);
    let aa = deriv * 1.5;
    let band = 1.0 - smoothstep(drawWidth - aa, drawWidth + aa, dist * 2.0);
    return band * (ink / drawWidth);
}

fn pixelFootprint(v: f32) -> f32 {
    return length(vec2f(dpdx(v), dpdy(v)));
}

fn front(r: f32) -> f32 {
    let travel = 3.52;
    let phase = (uniform.uTime - 1.1 * floor(uniform.uTime / 1.1)) * 3.2;
    var f = 0.0;
    for (var n = 0; n < 4; n = n + 1) {
        let rn = phase + f32(n) * travel;
        let born = (floor(uniform.uTime / 1.1) - f32(n)) * 1.1;
        let x = (r - rn) / 0.45;
        f = f + exp(-x * x) * (1.0 - smoothstep(0.0, 4.0 * travel, rn)) * step(0.0, born) * step(born, uniform.uEmitUntil);
    }
    return f;
}
fn hash2(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }

fn floorPattern(hitPos: vec3f, spacing: f32) -> vec3f {
    let uv = hitPos.xz / spacing;
    let deriv = vec2f(pixelFootprint(uv.x), pixelFootprint(uv.y));
    let dist = abs(fract(uv + vec2f(0.5)) - vec2f(0.5));
    var line: f32;
    var extra = 0.0;
    var strength = uniform.uStrength;
    if (uniform.uPattern < 0.5) {
        var g = vec2f(
            lineCoverage(dist.x, deriv.x, uniform.uLineWidth),
            lineCoverage(dist.y, deriv.y, uniform.uLineWidth));
        let ink = min(vec2f(uniform.uLineWidth), deriv * uniform.uWeight);
        g = mix(g, ink, clamp(deriv * 2.0 - vec2f(1.0), vec2f(0.0), vec2f(1.0)));
        line = mix(g.x, 1.0, g.y);
        if (uniform.uPulse > 0.0) {
            let cellId = floor(uv);
            let ph = fract(uniform.uTime / 2.2 + hash2(cellId));
            let flash = exp(-pow((ph - 0.5) / 0.09, 2.0));
            let on = step(hash2(cellId + vec2f(7.3)), 0.8)
                * step(uniform.uTime + (0.25 - ph) * 2.2, uniform.uEmitUntil);
            extra = uniform.uPulse * 0.22 * flash * on * (0.7 + 0.3 * exp(-length(hitPos.xz) / 6.0));
        }
    } else if (uniform.uPattern < 1.5) {
        let pitch = spacing * 0.8660254;
        var h = vec2f(hitPos.x / spacing, hitPos.z / pitch);
        let row = floor(h.y + 0.5);
        h.x = h.x + 0.5 * (row - 2.0 * floor(row / 2.0));
        let cell = vec2f(fract(h.x + 0.5) - 0.5, h.y - row) * vec2f(spacing, pitch);
        let dw = vec2f(pixelFootprint(hitPos.x), pixelFootprint(hitPos.z));
        let fw = length(dw) * 0.75;
        let fr = uniform.uPulse * front(length(hitPos.xz));
        let rad = max(uniform.uLineWidth * 1.75 * spacing, fw * uniform.uWeight * 1.4) * (1.0 + 0.9 * fr);
        line = (1.0 - smoothstep(rad - fw, rad + fw, length(cell)))
            * (1.0 - clamp(length(deriv) * 2.0 - 1.0, 0.0, 1.0));
        strength = min(1.0, uniform.uStrength * (1.0 + 1.6 * fr));
    } else {
        let ro = length(hitPos.xz);
        let halfCell = 0.5 * uniform.uSize / uniform.uDivisions;
        let r = (ro - uniform.uDrift - halfCell) / spacing;
        line = lineCoverage(abs(fract(r + 0.5) - 0.5), pixelFootprint(r), uniform.uLineWidth);
        let hole = uniform.uPulse * (1.0 - clamp((uniform.uTime - uniform.uEmitUntil) / 1.5, 0.0, 1.0));
        line = line * mix(1.0, smoothstep(0.0, halfCell * 0.7, ro), hole);
    }
    return vec3f(line, extra, strength);
}

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

    let t = (uniform.uGridY - rayOrigin.y) / denom;
    if (t < 0.0 && uniform.uOrtho < 0.5) { discard; }

    let hitPos = rayOrigin + rayDir * t;

    let spacing = uniform.uSize / uniform.uDivisions;
    let level = floor(uniform.uLevel);
    let s0 = spacing * exp2(level);
    let pat = mix(floorPattern(hitPos, s0), floorPattern(hitPos, s0 * 2.0), smoothstep(0.0, 1.0, uniform.uLevel - level));
    let line = pat.x;
    let extra = pat.y;
    let strength = pat.z;

    let axisWidth = uniform.uLineWidth * spacing * 2.0;
    let axisLineX = lineCoverage(abs(hitPos.z), pixelFootprint(hitPos.z), axisWidth);
    let axisLineZ = lineCoverage(abs(hitPos.x), pixelFootprint(hitPos.x), axisWidth);

    let d = distance(hitPos.xz, uniform.uFadeCentre);
    let fade = 1.0 - smoothstep(uniform.uFadeStart, uniform.uFadeEnd, d);

    var col = uniform.uColor;
    var alpha = line * fade * strength + extra * fade;

    if (uniform.uShowAxes > 0.5) {
        if (axisLineX > 0.01) {
            col = vec3f(0.8, 0.2, 0.2);
            alpha = max(alpha, axisLineX * fade);
        }
        if (axisLineZ > 0.01) {
            col = vec3f(0.2, 0.4, 0.8);
            alpha = max(alpha, axisLineZ * fade);
        }
    }

    if (alpha < 0.001) { discard; }

    output.color = vec4f(col, alpha);
    return output;
}
`;

const PATTERN_INDEX = { lines: 0, dots: 1, rings: 2 } as const;

function parseColor(css: string): [number, number, number] {
  const hex = css.replace('#', '');
  return [
    parseInt(hex.substring(0, 2), 16) / 255,
    parseInt(hex.substring(2, 4), 16) / 255,
    parseInt(hex.substring(4, 6), 16) / 255,
  ];
}

/**
 * Ground grid rendered via ray-plane intersection in a fullscreen shader.
 *
 * Depth-sorts correctly with gsplat content because the grid is drawn into
 * the main World layer at the moment the ray hits the plane, not as a mesh.
 * Construct via {@link Grid.create}.
 *
 * @example
 * ```ts
 * const grid = Grid.create(scene, { size: 50, divisions: 100 });
 * grid.enabled = false; // toggle off
 * ```
 *
 * @group Presets
 * @category Visual
 */
export class Grid {
  /** Toggle rendering without tearing down the shader. */
  enabled = true;
  /** The loading pulse's amplitude, 0..1: dots swell under travelling fronts,
   *  lines flash their cells, rings form at the centre. Off at 0. */
  pulse = 0;
  /** The pulse's clock, seconds, driven by the caller each frame. */
  pulseTime = 0;
  /** How far the rings have travelled outward, metres (rings only). */
  drift = 0;
  /** Pulse time after which nothing new starts; Infinity while waiting. */
  emitUntil = Infinity;
  /** World-space Y of the plane. */
  y = 0;
  /** Where the distance fade is measured from, on XZ. Null follows the camera. */
  fadeCentre: { x: number; z: number } | null = null;
  /** Ortho only: the narrowest a cell may draw, in pixels, before the
   *  pattern steps to double the spacing. 0 keeps the spacing fixed. */
  orthoMinCellPx = 16;

  private _color!: [number, number, number];
  private _u!: {
    size: number;
    divisions: number;
    fadeStart: number;
    fadeEnd: number;
    pattern: number;
    weight: number;
    strength: number;
  };

  private constructor() {}

  /** Update the grid line color at runtime. */
  setColor(css: string): void {
    const [r, g, b] = parseColor(css);
    this._color[0] = r; this._color[1] = g; this._color[2] = b;
  }

  /** Update the pattern, spacing, weight, strength, fades or colour at runtime. */
  setLook(look: GridLook): void {
    if (look.color) this.setColor(look.color);
    if (look.pattern) this._u.pattern = PATTERN_INDEX[look.pattern];
    if (look.spacing !== undefined) this._u.divisions = Math.max(1, Math.round(this._u.size / look.spacing));
    if (look.weight !== undefined) this._u.weight = look.weight;
    if (look.strength !== undefined) this._u.strength = look.strength;
    if (look.fadeStart !== undefined) this._u.fadeStart = look.fadeStart;
    if (look.fadeEnd !== undefined) this._u.fadeEnd = Math.max(look.fadeEnd, this._u.fadeStart + 0.5);
  }

  /** How many doublings coarser the ortho pattern draws (fractional; 0 in
   *  perspective): enough that a cell, foreshortened by the view's tilt,
   *  stays at least `orthoMinCellPx` wide. */
  private _orthoLevel(cam: CameraComponent, bufferHeight: number, forwardY: number): number {
    if (cam.projection !== PROJECTION_ORTHOGRAPHIC || this.orthoMinCellPx <= 0) return 0;
    const worldPerPx = 2 / (cam.projectionMatrix.data[5] * bufferHeight);
    const cellPx = (this._u.size / this._u.divisions) * Math.max(Math.abs(forwardY), 0.25) / worldPerPx;
    return Math.max(0, Math.log2(this.orthoMinCellPx / cellPx));
  }

  /** Create and install the grid shader on the scene's World layer. */
  static create(scene: Scene, opts?: GridOptions): Grid {
    const grid = new Grid();
    const device = scene.graphicsDevice;
    grid.y = opts?.y ?? 0;
    const color = parseColor(opts?.color ?? '#b5b5b5');
    grid._color = color;
    const showAxes = (opts?.showAxes ?? true) ? 1.0 : 0.0;
    const lineWidth = opts?.lineWidth ?? 0.04;
    const u = {
      size: opts?.size ?? 50,
      divisions: opts?.divisions ?? 100,
      fadeStart: opts?.fadeStart ?? 3,
      fadeEnd: opts?.fadeEnd ?? 18,
      pattern: PATTERN_INDEX[opts?.pattern ?? 'lines'],
      weight: opts?.weight ?? 1,
      strength: opts?.strength ?? 1,
    };
    grid._u = u;

    const shader = ShaderUtils.createShader(device, {
      uniqueName: 'engine-grid-raycast',
      attributes: { vertex_position: SEMANTIC_POSITION },
      vertexChunk: 'fullscreenQuadVS',
      fragmentGLSL: gridFS,
      fragmentWGSL: gridWGSL,
    });

    const quadRender = new QuadRender(shader);

    scene.app.scene.on(
      EVENT_PRERENDER_LAYER,
      (_camera: CameraComponent, layer: Layer, transparent: boolean) => {
        if (!grid.enabled) return;
        if (layer.name !== 'World' || transparent) return;

        const cam = scene.cameraEntity.camera;
        if (!cam) return;

        const viewMat = scene.cameraEntity.getWorldTransform().clone().invert();
        const projMat = cam.projectionMatrix;
        const viewProj = new Mat4().mul2(projMat, viewMat);
        const invViewProj = viewProj.clone().invert();
        const camPos = scene.cameraEntity.getPosition();
        const fc = grid.fadeCentre;

        device.scope.resolve('uInvViewProj').setValue(invViewProj.data);
        device.scope.resolve('uFadeCentre').setValue(fc ? [fc.x, fc.z] : [camPos.x, camPos.z]);
        device.scope.resolve('uOrtho').setValue(cam.projection === PROJECTION_ORTHOGRAPHIC ? 1 : 0);
        device.scope.resolve('uLevel').setValue(grid._orthoLevel(cam, device.height, scene.cameraEntity.forward.y));
        device.scope.resolve('uColor').setValue(color);
        device.scope.resolve('uFadeStart').setValue(u.fadeStart);
        device.scope.resolve('uFadeEnd').setValue(u.fadeEnd);
        device.scope.resolve('uGridY').setValue(grid.y);
        device.scope.resolve('uSize').setValue(u.size);
        device.scope.resolve('uDivisions').setValue(u.divisions);
        device.scope.resolve('uShowAxes').setValue(showAxes);
        device.scope.resolve('uLineWidth').setValue(lineWidth);
        device.scope.resolve('uPattern').setValue(u.pattern);
        device.scope.resolve('uWeight').setValue(u.weight);
        device.scope.resolve('uStrength').setValue(u.strength);
        device.scope.resolve('uTime').setValue(grid.pulseTime);
        device.scope.resolve('uPulse').setValue(grid.pulse);
        device.scope.resolve('uDrift').setValue(grid.drift);
        device.scope.resolve('uEmitUntil').setValue(Math.min(grid.emitUntil, 1e9));

        // Colour is a normal "over" blend. Alpha is ONE / ONE_MINUS_SRC_ALPHA
        // (not SRC_ALPHA, which would multiply the line's own alpha in
        // twice): over the sky's alpha of 1 the buffer stays at 1, so with
        // the premultiplied canvas nothing behind the canvas bleeds through
        // the line's soft edges. Over a transparent buffer it is the
        // correct compositing alpha.
        const blendState = new BlendState(
          true,
          BLENDEQUATION_ADD,
          BLENDMODE_SRC_ALPHA,
          BLENDMODE_ONE_MINUS_SRC_ALPHA,
          BLENDEQUATION_ADD,
          BLENDMODE_ONE,
          BLENDMODE_ONE_MINUS_SRC_ALPHA,
        );
        device.setBlendState(blendState);
        // Fullscreen quad VS writes gl_Position.z = 0.5; with a real depth
        // buffer that would stamp 0.5 across the screen and occlude world
        // geometry farther than mid-frustum. Grid is a background pass - no
        // depth test or write. World layer meshes render after and naturally
        // paint over the grid wherever they're closer to the camera.
        device.setDepthState(DepthState.NODEPTH);
        quadRender.render();
        device.setBlendState(BlendState.NOBLEND);
      },
    );

    return grid;
  }
}
