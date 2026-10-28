/**
 * Pixel-art upscale shader - GLSL (WebGL2) + WGSL (WebGPU).
 *
 * Bound as a QuadRender by PixelartEffect. Samples the low-resolution
 * scene RT with nearest-neighbour integer-pixel math and writes one
 * output pixel per backbuffer pixel.
 *
 * Per-region pixel scale: a 1-channel mask RT (rendered by a separate
 * mask camera that shares the scene RT's depth attachment, so the mask
 * is depth-correctly occluded against the real scene) tells the shader
 * whether each output pixel belongs to a tagged "character" entity. The
 * RT is rendered at the FINE scale (= `scale` option). Character pixels
 * sample the RT directly at fine granularity. Non-character pixels snap
 * the source coord to a coarser grid (`uEnvSnap` × `uEnvSnap`) before
 * sampling, producing a coarser environment look without rendering a
 * second RT at a different size.
 *
 * Why texelFetch / textureLoad instead of UV sampling: WebGPU's render-
 * target origin convention differs from WebGL, and sampling a render-
 * target texture via UV ends up Y-flipped on WebGPU. The outline effect
 * hit the same issue and documents it (see outline-shaders.ts). Integer
 * pixel coordinates from gl_FragCoord / input.position bypass the
 * convention mismatch on both backends.
 *
 * Uniforms consumed:
 *   uSourceTex   - low-res scene RT (rgba8).
 *   uMaskTex     - char silhouette mask. Mask camera writes alpha = char
 *                  coverage where depth-tested against the shared scene
 *                  depth. uMaskTex.a > threshold ⇒ this pixel is char.
 *   uScale       - vec2 (srcW/dstW, srcH/dstH). Maps output pixel coord
 *                  to source texel coord.
 *   uEnvSnap     - integer snap factor for environment pixels (>= 1).
 *                  1 = no snap (env identical to char). 2 = env source
 *                  coord rounds to a 2×2 block, giving env an effective
 *                  scale of 2× the RT's native pixel.
 *   uQuantLevels - 0 = disabled. Otherwise N steps per channel.
 *   uDitherStrength - 0 = disabled. >0 applies Bayer-4×4 ordered dither
 *                  BEFORE quantization, so neighbouring "perceptual"
 *                  pixels straddle the quant step and blend back into
 *                  a smooth gradient at distance. Amplitude is in units
 *                  of the quant step (1.0 = ±0.5 step, the classic
 *                  setting). Only active when uQuantLevels > 0 - without
 *                  quantization there's no step to dither across.
 *                  Bayer cell is indexed by PERCEPTUAL pixel coord (i.e.
 *                  srcFine for char, srcFine/snap for env) so dither
 *                  cells are the same apparent size as the underlying
 *                  pixel blocks in each region.
 *   uGradeLift   - vec3 added to the final colour (pushes pure black up
 *                  toward this tint). Applied AFTER outline so the whole
 *                  frame - scene + outline alike - gets the grade.
 *                  Default (0,0,0) = no-op.
 *   uGradeGain   - vec3 multiplied with the final colour. Default
 *                  (1,1,1) = no-op. Tints highlights without lifting
 *                  blacks.
 */

// ─── Outline detection ───────────────────────────────────────────────
//
// When uOutlineThicknessPx > 0, the fragment also samples the mask in
// an 8-tap ring at output-pixel-space offsets.
//
//   uOutlineMode = 0  outer - center is env, ring touches char.
//                              Outline sits OUTSIDE the silhouette,
//                              making the character look slightly larger.
//   uOutlineMode = 1  inner - center is char, ring touches env.
//                              Outline sits INSIDE the silhouette,
//                              eating into the character's edge pixels.
//   uOutlineMode = 2  both  - either case fires. Draws a 2-thickness
//                              band straddling the silhouette boundary.
//
// The outline LINE is sharp at backbuffer resolution (1 BB pixel of
// transition). The outline silhouette follows the low-res mask, so its
// stair-steps match the chunky character outline - visually consistent
// with the pixel-art aesthetic.
//
// Ring offsets are in MASK space (= same as RT space): ringOff_mask =
// thicknessPx * uScale.{x,y}. Since the mask is sampled with nearest,
// the minimum useful thicknessPx is roughly `1/uScale.x` = scale BB
// pixels. Sub-pixel-thin outlines require a higher-res mask (not in v1).

export const upscaleFragmentGLSL = /* glsl */ `
precision highp float;
uniform highp sampler2D uSourceTex;
uniform highp sampler2D uMaskTex;
uniform vec2 uScale;
uniform float uEnvSnap;
uniform float uQuantLevels;
uniform float uDitherStrength;    // 0 disables. 1 = ±0.5 step amplitude (paired with uQuantLevels).
uniform vec4 uOutlineColor;
uniform float uOutlineThicknessPx;
uniform float uOutlineMode;       // 0 outer, 1 inner, 2 both
uniform float uOutlineSmoothness; // 0 = hard step. Larger = wider smoothstep window on ring alpha.
uniform vec3 uGradeLift;          // Added to final colour. Default (0,0,0).
uniform vec3 uGradeGain;          // Multiplied with final colour. Default (1,1,1).
uniform float uEnvDarken;         // 0 = no-op, 1 = env pixels fully black. Char pixels untouched.

void main() {
    ivec2 srcFine = ivec2(gl_FragCoord.xy * uScale);
    float maskAlpha = texelFetch(uMaskTex, srcFine, 0).a;
    bool isChar = maskAlpha > 0.5;

    // Perceptual pixel index - equals srcFine for char, srcFine/snap for
    // env. Used both as the source-sample coord (×snap) and as the Bayer
    // index for dither, so dither cells match the apparent pixel size
    // of whichever region we're in.
    int snap = 1;
    if (!isChar && uEnvSnap > 1.0) snap = int(uEnvSnap + 0.5);
    ivec2 perceptCoord = srcFine / snap;
    ivec2 src = perceptCoord * snap;

    // Scene color first - outline blends on top of it (smoothstep needs
    // both colors to mix). Tiny perf cost vs the old hard-early-return
    // path but the unified path keeps the smooth path clean.
    vec3 c = texelFetch(uSourceTex, src, 0).rgb;
    if (uQuantLevels > 0.5) {
        float lv = uQuantLevels - 1.0;
        if (uDitherStrength > 0.0) {
            // Bayer 4×4 - classic ordered dither. Threshold in [-0.5, +0.5)
            // is added to the colour before snapping to the quant grid, so
            // neighbouring perceptual pixels land on different rungs.
            const float bayer[16] = float[16](
                 0.0,  8.0,  2.0, 10.0,
                12.0,  4.0, 14.0,  6.0,
                 3.0, 11.0,  1.0,  9.0,
                15.0,  7.0, 13.0,  5.0
            );
            int bx = perceptCoord.x & 3;
            int by = perceptCoord.y & 3;
            float threshold = (bayer[by * 4 + bx] / 16.0) - 0.5;
            c += vec3(threshold / lv * uDitherStrength);
            c = clamp(c, 0.0, 1.0);
        }
        c = floor(c * lv + 0.5) / lv;
    }

    // Outline. Ring max → "ring touches char", ring min → "ring touches
    // env". For OUTER on env pixels: amt rises as ringMax approaches 1.
    // For INNER on char pixels: amt rises as (1-ringMin) approaches 1
    // (i.e. ring leaks out of silhouette). smoothstep window width is
    // uOutlineSmoothness - when 0 it collapses to a hard step.
    if (uOutlineThicknessPx > 0.5) {
        bool wantOuter = (uOutlineMode < 0.5 || uOutlineMode > 1.5) && !isChar;
        bool wantInner = (uOutlineMode > 0.5) && isChar;
        if (wantOuter || wantInner) {
            ivec2 off = ivec2(uOutlineThicknessPx * uScale + 0.5);
            off = ivec2(max(off.x, 1), max(off.y, 1));
            float ringMax = 0.0;
            float ringMin = 1.0;
            float s;
            s = texelFetch(uMaskTex, srcFine + ivec2( off.x,    0), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            s = texelFetch(uMaskTex, srcFine + ivec2(-off.x,    0), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            s = texelFetch(uMaskTex, srcFine + ivec2(    0,  off.y), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            s = texelFetch(uMaskTex, srcFine + ivec2(    0, -off.y), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            s = texelFetch(uMaskTex, srcFine + ivec2( off.x,  off.y), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            s = texelFetch(uMaskTex, srcFine + ivec2(-off.x,  off.y), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            s = texelFetch(uMaskTex, srcFine + ivec2( off.x, -off.y), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            s = texelFetch(uMaskTex, srcFine + ivec2(-off.x, -off.y), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            float t = max(uOutlineSmoothness, 0.001);
            float amt = 0.0;
            if (wantOuter) amt = max(amt, smoothstep(0.5 - t, 0.5 + t, ringMax));
            if (wantInner) amt = max(amt, smoothstep(0.5 - t, 0.5 + t, 1.0 - ringMin));
            c = mix(c, uOutlineColor.rgb, amt * uOutlineColor.a);
        }
    }

    // Env-only darken - multiplies env pixels by (1 - uEnvDarken). Used
    // by the death cutscene to fade the map (and untagged enemies) to
    // black while the player (still char-tagged) stays at full intensity.
    // Applied AFTER outline so outline colour fades with env, BEFORE
    // colour grade so the warm ambient still tints the dying frame.
    if (!isChar && uEnvDarken > 0.0) c *= (1.0 - uEnvDarken);

    // Colour grade - gain ◦ c + lift, clamped. Applied last so it acts
    // as a whole-frame LUT on top of scene + outline. Identity by default
    // (gain=(1,1,1), lift=(0,0,0)).
    c = clamp(c * uGradeGain + uGradeLift, 0.0, 1.0);

    gl_FragColor = vec4(c, 1.0);
}
`;

export const upscaleFragmentWGSL = /* wgsl */ `
var uSourceTex: texture_2d<f32>;
var uMaskTex: texture_2d<f32>;
uniform uScale: vec2f;
uniform uEnvSnap: f32;
uniform uQuantLevels: f32;
uniform uDitherStrength: f32;
uniform uOutlineColor: vec4f;
uniform uOutlineThicknessPx: f32;
uniform uOutlineMode: f32;
uniform uOutlineSmoothness: f32;
uniform uGradeLift: vec3f;
uniform uGradeGain: vec3f;
uniform uEnvDarken: f32;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let srcFine = vec2i(input.position.xy * uniform.uScale);
    let maskAlpha = textureLoad(uMaskTex, srcFine, 0).a;
    let isChar = maskAlpha > 0.5;

    // Perceptual pixel index - see GLSL twin for details.
    var snap: i32 = 1;
    if (!isChar && uniform.uEnvSnap > 1.0) { snap = i32(uniform.uEnvSnap + 0.5); }
    let perceptCoord = srcFine / snap;
    let src = perceptCoord * snap;

    // Scene first - outline blends on top so smooth and hard share the path.
    var c = textureLoad(uSourceTex, src, 0).rgb;
    if (uniform.uQuantLevels > 0.5) {
        let lv = uniform.uQuantLevels - 1.0;
        if (uniform.uDitherStrength > 0.0) {
            var bayer = array<f32, 16>(
                 0.0,  8.0,  2.0, 10.0,
                12.0,  4.0, 14.0,  6.0,
                 3.0, 11.0,  1.0,  9.0,
                15.0,  7.0, 13.0,  5.0
            );
            let bx = perceptCoord.x & 3;
            let by = perceptCoord.y & 3;
            let threshold = (bayer[by * 4 + bx] / 16.0) - 0.5;
            c = c + vec3f(threshold / lv * uniform.uDitherStrength);
            c = clamp(c, vec3f(0.0), vec3f(1.0));
        }
        c = floor(c * lv + 0.5) / lv;
    }

    if (uniform.uOutlineThicknessPx > 0.5) {
        let wantOuter = (uniform.uOutlineMode < 0.5 || uniform.uOutlineMode > 1.5) && !isChar;
        let wantInner = (uniform.uOutlineMode > 0.5) && isChar;
        if (wantOuter || wantInner) {
            var off = vec2i(uniform.uOutlineThicknessPx * uniform.uScale + 0.5);
            off = vec2i(max(off.x, 1), max(off.y, 1));
            var ringMax: f32 = 0.0;
            var ringMin: f32 = 1.0;
            var s: f32;
            s = textureLoad(uMaskTex, srcFine + vec2i( off.x,    0), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            s = textureLoad(uMaskTex, srcFine + vec2i(-off.x,    0), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            s = textureLoad(uMaskTex, srcFine + vec2i(    0,  off.y), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            s = textureLoad(uMaskTex, srcFine + vec2i(    0, -off.y), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            s = textureLoad(uMaskTex, srcFine + vec2i( off.x,  off.y), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            s = textureLoad(uMaskTex, srcFine + vec2i(-off.x,  off.y), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            s = textureLoad(uMaskTex, srcFine + vec2i( off.x, -off.y), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            s = textureLoad(uMaskTex, srcFine + vec2i(-off.x, -off.y), 0).a; ringMax = max(ringMax, s); ringMin = min(ringMin, s);
            let t = max(uniform.uOutlineSmoothness, 0.001);
            var amt: f32 = 0.0;
            if (wantOuter) { amt = max(amt, smoothstep(0.5 - t, 0.5 + t, ringMax)); }
            if (wantInner) { amt = max(amt, smoothstep(0.5 - t, 0.5 + t, 1.0 - ringMin)); }
            c = mix(c, uniform.uOutlineColor.rgb, amt * uniform.uOutlineColor.a);
        }
    }

    // Env-only darken - see GLSL twin.
    if (!isChar && uniform.uEnvDarken > 0.0) { c = c * (1.0 - uniform.uEnvDarken); }

    // Colour grade - see GLSL twin. Identity by default.
    c = clamp(c * uniform.uGradeGain + uniform.uGradeLift, vec3f(0.0), vec3f(1.0));

    output.color = vec4f(c, 1.0);
    return output;
}
`;
