/**
 * Stained-glass compose shader - GLSL (WebGL2) + WGSL (WebGPU).
 *
 * Sibling of `pixelart-shaders.ts`. Where the pixel-art shader snaps to a
 * regular square grid, this one snaps to **Voronoi cells** seeded on a
 * jittered grid, producing irregular polygonal "shards" that read as
 * stained glass or low-poly painterly tiles.
 *
 * Per fragment:
 *   1. Map to cell-space coord  p = fragCoord / uCellSize.
 *   2. 3×3 neighbourhood Worley search → nearest seed (F1) + second
 *      nearest (F2). Seeds live at `cell + 0.5 + jitter * (hash(cell) - 0.5)`.
 *   3. Source-sample the scene RT at the nearest seed's BB-pixel position
 *      → one flat colour per cell, regardless of how many output pixels
 *      that cell covers.
 *   4. Optional lead caming - pixels where `F2 - F1 < uLeadHalfWidth` are
 *      blended toward `uLeadColor`, drawing dark gaps at cell boundaries
 *      (like the lead between panes of stained glass).
 *   5. Optional whole-frame colour grade (matches PixelartEffect).
 *
 * Why texelFetch / textureLoad instead of UV sampling - same WebGPU
 * render-target Y-flip issue documented in `pixelart-shaders.ts` and
 * `outline-shaders.ts`. Integer pixel coords from gl_FragCoord /
 * input.position bypass the convention mismatch on both backends.
 *
 * Uniforms consumed:
 *   uSourceTex   - captured scene RT (rgba8). Bound by BaseCapturingPass.
 *   uOutputSize  - vec2 backbuffer / output px (used to scale the seed
 *                  position into source-RT pixel space).
 *   uSourceSize  - vec2 source RT px.
 *   uCellSize    - average cell size in BB px (= output px).
 *   uJitter      - 0..1. 0 = square grid (degenerate stained-glass look,
 *                  identical to a chunky pixel render). 1 = seeds free to
 *                  roam anywhere inside their cell - maximum irregularity
 *                  but neighbouring seeds can almost collide. 0.7-0.9 is
 *                  the sweet spot for a glass-shard look.
 *   uLeadColor   - rgba lead colour. .a is the blend strength.
 *   uLeadHalfWidth - in cell-space units (i.e. BB-px / cellSize). 0
 *                  disables the caming pass entirely.
 *   uLeadSoftness - smoothstep softness around the lead edge. 0 = hard.
 *   uGradeLift   - vec3 added to the final colour. Default (0,0,0).
 *   uGradeGain   - vec3 multiplied with the final colour. Default (1,1,1).
 */

// Cheap 2D hash. fract(sin(...)) is the classic but sin is expensive on
// some mobile GPUs; this multiply-and-fold variant produces visually
// equivalent noise for our purposes (uniform-looking jitter, no obvious
// banding at integer cell coords) and is friendlier to WebGL2 mediump.
const HASH_GLSL = /* glsl */ `
float sg_hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
vec2 sg_seed(vec2 cell) {
    float a = sg_hash21(cell);
    float b = sg_hash21(cell + vec2(17.13, 31.41));
    return cell + 0.5 + (vec2(a, b) - 0.5) * uJitter;
}
`;

const HASH_WGSL = /* wgsl */ `
fn sg_hash21(p_in: vec2f) -> f32 {
    var p = fract(p_in * vec2f(123.34, 456.21));
    p = p + vec2f(dot(p, p + vec2f(45.32)));
    return fract(p.x * p.y);
}
fn sg_seed(cell: vec2f) -> vec2f {
    let a = sg_hash21(cell);
    let b = sg_hash21(cell + vec2f(17.13, 31.41));
    return cell + vec2f(0.5) + (vec2f(a, b) - vec2f(0.5)) * uniform.uJitter;
}
`;

export const stainedGlassFragmentGLSL = /* glsl */ `
precision highp float;
uniform highp sampler2D uSourceTex;
uniform vec2 uOutputSize;
uniform vec2 uSourceSize;
uniform float uCellSize;
uniform float uJitter;
uniform vec4 uLeadColor;
uniform float uLeadHalfWidth;
uniform float uLeadSoftness;
uniform vec3 uGradeLift;
uniform vec3 uGradeGain;

${HASH_GLSL}

void main() {
    vec2 p = gl_FragCoord.xy / max(uCellSize, 1.0);
    vec2 baseCell = floor(p);

    vec2 bestSeed = baseCell + vec2(0.5);
    float F1 = 1e9;
    float F2 = 1e9;
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            vec2 cell = baseCell + vec2(float(dx), float(dy));
            vec2 seed = sg_seed(cell);
            float dist = length(seed - p);
            if (dist < F1) {
                F2 = F1;
                F1 = dist;
                bestSeed = seed;
            } else if (dist < F2) {
                F2 = dist;
            }
        }
    }

    // Seed lives in cell-space; convert to BB px, then to source RT px.
    vec2 seedBB = bestSeed * uCellSize;
    vec2 srcPxF = seedBB * (uSourceSize / max(uOutputSize, vec2(1.0)));
    ivec2 srcI = clamp(ivec2(srcPxF), ivec2(0), ivec2(uSourceSize) - ivec2(1));
    vec3 c = texelFetch(uSourceTex, srcI, 0).rgb;

    // Lead caming - darken near cell boundaries where F2 - F1 → 0.
    if (uLeadHalfWidth > 0.0) {
        float gap = F2 - F1;
        float soft = max(uLeadSoftness, 0.001);
        float leadAmt = 1.0 - smoothstep(
            uLeadHalfWidth - soft,
            uLeadHalfWidth + soft,
            gap
        );
        c = mix(c, uLeadColor.rgb, leadAmt * uLeadColor.a);
    }

    c = clamp(c * uGradeGain + uGradeLift, 0.0, 1.0);
    gl_FragColor = vec4(c, 1.0);
}
`;

export const stainedGlassFragmentWGSL = /* wgsl */ `
var uSourceTex: texture_2d<f32>;
uniform uOutputSize: vec2f;
uniform uSourceSize: vec2f;
uniform uCellSize: f32;
uniform uJitter: f32;
uniform uLeadColor: vec4f;
uniform uLeadHalfWidth: f32;
uniform uLeadSoftness: f32;
uniform uGradeLift: vec3f;
uniform uGradeGain: vec3f;

${HASH_WGSL}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let p = input.position.xy / max(uniform.uCellSize, 1.0);
    let baseCell = floor(p);

    var bestSeed = baseCell + vec2f(0.5);
    var F1: f32 = 1e9;
    var F2: f32 = 1e9;
    for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
        for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
            let cell = baseCell + vec2f(f32(dx), f32(dy));
            let seed = sg_seed(cell);
            let dist = length(seed - p);
            if (dist < F1) {
                F2 = F1;
                F1 = dist;
                bestSeed = seed;
            } else if (dist < F2) {
                F2 = dist;
            }
        }
    }

    let seedBB = bestSeed * uniform.uCellSize;
    let srcPxF = seedBB * (uniform.uSourceSize / max(uniform.uOutputSize, vec2f(1.0)));
    let srcI = clamp(
        vec2i(srcPxF),
        vec2i(0),
        vec2i(uniform.uSourceSize) - vec2i(1),
    );
    var c = textureLoad(uSourceTex, srcI, 0).rgb;

    if (uniform.uLeadHalfWidth > 0.0) {
        let gap = F2 - F1;
        let soft = max(uniform.uLeadSoftness, 0.001);
        let leadAmt = 1.0 - smoothstep(
            uniform.uLeadHalfWidth - soft,
            uniform.uLeadHalfWidth + soft,
            gap,
        );
        c = mix(c, uniform.uLeadColor.rgb, leadAmt * uniform.uLeadColor.a);
    }

    c = clamp(c * uniform.uGradeGain + uniform.uGradeLift, vec3f(0.0), vec3f(1.0));
    output.color = vec4f(c, 1.0);
    return output;
}
`;
