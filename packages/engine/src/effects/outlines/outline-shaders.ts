/**
 * Outline effect shaders (v4 - custom post-processing).
 *
 * One shader - EXPAND - with GLSL (WebGL2) + WGSL (WebGPU) variants: a
 * fullscreen fragment that samples the mask RT in an 8-tap ring at
 * `thicknessPx` pixels, discards pixels outside the silhouette that have no
 * neighbour inside, discards pixels inside the silhouette (the outline is the
 * ring, not the fill), and outputs the outline colour for the remaining
 * boundary pixels. Bound as a QuadRender and executed during
 * EVENT_PRERENDER_LAYER on (World, transparent) via OutlineEffect's hook.
 *
 * The MARK half of the pipeline (painting the silhouette into that RT) has no
 * shader here: meshes go through a `StandardMaterial` configured for unlit
 * emissive - see `outline-mark-material.ts` for why hand-written mark shaders
 * were abandoned - and splats re-render their own component on the mark layer.
 *
 * Uniforms consumed:
 *   uMask (sampler2D), uTexelSize (vec2), uOutlineColor (vec4),
 *   uThicknessPx (float), uStrength (float), uShimmer (float), uTime (float).
 */

// ── Expand + composite shader (fullscreen quad) ─────────────────────
//
// The vertex shader is PC's built-in `fullscreenQuadVS` chunk (supplied
// via ShaderUtils.createShader's `vertexChunk` option). It emits
// positions covering the viewport and `vUv0` sampling coords in [0,1].
// We only define the fragment.

export const expandFragmentGLSL = /* glsl */ `
precision mediump float;
varying vec2 vUv0;
uniform sampler2D uMask;
uniform vec2 uTexelSize;     // (1/w, 1/h) of the mask RT
uniform vec4 uOutlineColor;  // rgba - a = blend strength
uniform float uThicknessPx;
uniform float uStrength;     // 0..1, multiplies the alpha
uniform float uShimmer;      // 0..1, how much the travelling band modulates
uniform float uTime;         // seconds

void main() {
    // Use integer pixel coordinates instead of vUv0 so mask and present
    // stay in the same screen-space orientation on both WebGL and WebGPU.
    // Sampling the mask RT with vUv0 was visually Y-flipped under WebGPU
    // (render-target origin convention differs), which made the outline
    // render upside-down relative to the character.
    ivec2 texel = ivec2(gl_FragCoord.xy);
    float center = texelFetch(uMask, texel, 0).a;
    // Inside the silhouette → the outline belongs on the boundary, not
    // the fill. Discard so the scene underneath shows through.
    if (center > 0.5) discard;

    int off = int(uThicknessPx + 0.5);

    // 8-tap ring. Hard step - any ring sample inside the silhouette
    // means this pixel is within thicknessPx of the silhouette
    // boundary, so we emit the outline colour.
    float s = 0.0;
    s = max(s, texelFetch(uMask, texel + ivec2( off,   0), 0).a);
    s = max(s, texelFetch(uMask, texel + ivec2(-off,   0), 0).a);
    s = max(s, texelFetch(uMask, texel + ivec2(   0,  off), 0).a);
    s = max(s, texelFetch(uMask, texel + ivec2(   0, -off), 0).a);
    s = max(s, texelFetch(uMask, texel + ivec2( off,  off), 0).a);
    s = max(s, texelFetch(uMask, texel + ivec2(-off,  off), 0).a);
    s = max(s, texelFetch(uMask, texel + ivec2( off, -off), 0).a);
    s = max(s, texelFetch(uMask, texel + ivec2(-off, -off), 0).a);

    if (s < 0.5) discard;

    // A soft band travelling up the screen while selected: the line breathes
    // along the body instead of sitting dead on it.
    float band = 0.5 + 0.5 * sin(vUv0.y * 18.0 - uTime * 1.6);
    float shimmer = mix(1.0, 0.55 + 0.45 * band, uShimmer);
    gl_FragColor = vec4(uOutlineColor.rgb, uOutlineColor.a * uStrength * shimmer);
}
`;

// ── Expand WGSL ─────────────────────────────────────────────────────

export const expandFragmentWGSL = /* wgsl */ `
var uMask: texture_2d<f32>;
uniform uTexelSize: vec2f;
uniform uOutlineColor: vec4f;
uniform uThicknessPx: f32;
uniform uStrength: f32;
uniform uShimmer: f32;
uniform uTime: f32;

varying vUv0: vec2f;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    // Use integer pixel coordinates (from @builtin(position)) so mask and
    // present stay in the same screen-space orientation. Sampling the mask
    // RT via UV was visually Y-flipped under WebGPU (render-target origin
    // convention differs), producing an upside-down outline.
    let texel = vec2i(input.position.xy);
    let center = textureLoad(uMask, texel, 0).a;
    if (center > 0.5) { discard; }

    let off = i32(uniform.uThicknessPx + 0.5);

    var s: f32 = 0.0;
    s = max(s, textureLoad(uMask, texel + vec2i( off,   0), 0).a);
    s = max(s, textureLoad(uMask, texel + vec2i(-off,   0), 0).a);
    s = max(s, textureLoad(uMask, texel + vec2i(   0,  off), 0).a);
    s = max(s, textureLoad(uMask, texel + vec2i(   0, -off), 0).a);
    s = max(s, textureLoad(uMask, texel + vec2i( off,  off), 0).a);
    s = max(s, textureLoad(uMask, texel + vec2i(-off,  off), 0).a);
    s = max(s, textureLoad(uMask, texel + vec2i( off, -off), 0).a);
    s = max(s, textureLoad(uMask, texel + vec2i(-off, -off), 0).a);

    if (s < 0.5) { discard; }

    let band = 0.5 + 0.5 * sin(input.vUv0.y * 18.0 - uniform.uTime * 1.6);
    let shimmer = mix(1.0, 0.55 + 0.45 * band, uniform.uShimmer);
    output.color = vec4f(uniform.uOutlineColor.rgb, uniform.uOutlineColor.a * uniform.uStrength * shimmer);
    return output;
}
`;
