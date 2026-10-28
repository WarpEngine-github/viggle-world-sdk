// Compose + blur for the proxy relight pass.
//
// Input: the two raw proxy renders (see `relight-pass.ts`).
//
//   uProxyLitTex   rgb = SUM over lights of colour * N.L * attenuation * shadow
//                  a   = proxy coverage (1 where the proxy drew, 0 elsewhere)
//   uProxyRawTex   rgb = the same sum with every shadow map ignored
//                  a   = the same coverage
//
// Both are rendered by a `StandardMaterial` whose `ambient` is black, so the
// rgb of each is the DIRECT light only - which is what makes the visibility
// ratio below come out as Unity's `weightLit / weightTotal` exactly, with the
// ambient term added back here rather than baked into either input.
//
// Output (MRT):
//
//   pcFragColor0 RGBA16F  rgb = full lighting (direct + ambient), a = coverage
//   pcFragColor1 RG16F    r   = shadow visibility, g = coverage
//
// The 3x3 tent (weights 1-2-1 x 1-2-1, total 16) is what keeps the lighting
// temporally stable while the proxy animates: a blocky proxy's silhouette and
// its self-shadow re-rasterize differently every frame at half resolution, and
// splats sampling those hard edges pop between values.
//
// ── Why there are two radii ───────────────────────────────────────────────
// The tap offsets are the proxy target's texel scaled by a radius, and the two
// inputs get their OWN radius. They carry different things and want different
// amounts:
//
//   lit  -> the lighting, shadow map included. Softening it softens the cast
//           shadow AND the terminator running across the subject, because both
//           live in the same channel. This is the one that matters when the
//           shadow is being read through `strength` alone.
//   raw  -> the same light with every shadow map ignored, which exists only to
//           divide into `lit` and leave the shadow VISIBILITY. Softening it
//           alone softens the cast shadow and nothing else.
//
// A radius of 1 is the original tent and the default. 0 is a single tap - the
// raw bake, which is what you want to look at and not what you want to ship.
// Above about 3 the nine taps stop overlapping and the tent starts reading as
// a sparse cross rather than a blur; bilinear filtering hides it for a while,
// and the knob's range says where that ends.
//
// Widening either one also widens the coverage ramp it carries, and coverage
// is what the un-premultiply divides by - so a large radius spreads a
// subject's lighting slightly past its own silhouette. At half resolution and
// a radius of a few texels that is a pixel or two, which is why this is a
// radius and not an arbitrary kernel.
//
// rgb is premultiplied by coverage on the way in (the bake writes rgb only
// where a = 1 and the target clears to 0), so averaging it raw would mix in the
// black outside the silhouette and put a dark rim exactly where edge splats
// sample. Un-premultiply on output: colour stays full strength to the very edge
// while the coverage alpha fades.

/** Shared preamble: the tent taps, as a function of one texel step. */
const COMPOSE_GLSL = /* glsl */ `
varying vec2 vUv0;

uniform mediump sampler2D uProxyLitTex;
uniform mediump sampler2D uProxyRawTex;
// xy = one texel of the proxy target in uv; z = the lighting tent's radius in
// texels, w = the shadow-visibility tent's. 0 on either is a single tap.
uniform vec4 uComposeParams;
// 1 when uProxyRawTex holds a real unshadowed render, 0 when it is a stand-in.
uniform float uComposeHasRaw;
uniform vec3 uComposeAmbient;

vec4 tent(mediump sampler2D src, vec2 uv, vec2 texel, float radius) {
    vec4 c = texture2DLod(src, uv, 0.0);
    if (radius <= 0.0) return c;
    vec2 t = texel * radius;
    vec4 sum = c * 4.0;
    sum += texture2DLod(src, uv + vec2(-t.x, -t.y), 0.0);
    sum += texture2DLod(src, uv + vec2( 0.0, -t.y), 0.0) * 2.0;
    sum += texture2DLod(src, uv + vec2( t.x, -t.y), 0.0);
    sum += texture2DLod(src, uv + vec2(-t.x,  0.0), 0.0) * 2.0;
    sum += texture2DLod(src, uv + vec2( t.x,  0.0), 0.0) * 2.0;
    sum += texture2DLod(src, uv + vec2(-t.x,  t.y), 0.0);
    sum += texture2DLod(src, uv + vec2( 0.0,  t.y), 0.0) * 2.0;
    sum += texture2DLod(src, uv + vec2( t.x,  t.y), 0.0);
    return sum / 16.0;
}

void main(void) {
    vec2 t = uComposeParams.xy;

    vec4 lit = tent(uProxyLitTex, vUv0, t, uComposeParams.z);
    float cov = clamp(lit.a, 0.0, 1.0);
    // Un-premultiply. Below the threshold there is no proxy here at all, and
    // the lighting value is never read (the consumer gates on coverage).
    vec3 direct = cov > 1e-4 ? lit.rgb / cov : vec3(0.0);

    pcFragColor0 = vec4(direct + uComposeAmbient, cov);

    float visibility = 1.0;
    if (uComposeHasRaw > 0.5) {
        vec4 raw = tent(uProxyRawTex, vUv0, t, uComposeParams.w);
        float rawCov = clamp(raw.a, 0.0, 1.0);
        vec3 unshadowed = rawCov > 1e-4 ? raw.rgb / rawCov : vec3(0.0);
        // Luminance of the direct sums, exactly Unity's
        //   weightTotal = Luminance(lightColor) * ndl * distanceAttenuation
        //   weightLit   = weightTotal * shadowAttenuation
        // summed over lights. The ratio therefore carries no N.L, no light
        // colour and no ambient of its own: a surface merely turned away from
        // every light has no light to lose and reports 1 (unshadowed) rather
        // than the darkness the relight path exists to express.
        float total = dot(unshadowed, vec3(0.2126, 0.7152, 0.0722));
        float reaching = dot(direct, vec3(0.2126, 0.7152, 0.0722));
        visibility = total > 1e-4 ? clamp(reaching / total, 0.0, 1.0) : 1.0;
    }
    pcFragColor1 = vec2(visibility, cov);
}
`;

const COMPOSE_WGSL = /* wgsl */ `
varying vUv0: vec2f;

var uProxyLitTex: texture_2d<f32>;
var uProxyLitTexSampler: sampler;
var uProxyRawTex: texture_2d<f32>;
var uProxyRawTexSampler: sampler;
uniform uComposeParams: vec4f;
uniform uComposeHasRaw: f32;
uniform uComposeAmbient: vec3f;

fn tentLit(uv: vec2f, texel: vec2f, radius: f32) -> vec4f {
    let c = textureSampleLevel(uProxyLitTex, uProxyLitTexSampler, uv, 0.0);
    if (radius <= 0.0) { return c; }
    let t = texel * radius;
    var sum = c * 4.0;
    sum = sum + textureSampleLevel(uProxyLitTex, uProxyLitTexSampler, uv + vec2f(-t.x, -t.y), 0.0);
    sum = sum + textureSampleLevel(uProxyLitTex, uProxyLitTexSampler, uv + vec2f( 0.0, -t.y), 0.0) * 2.0;
    sum = sum + textureSampleLevel(uProxyLitTex, uProxyLitTexSampler, uv + vec2f( t.x, -t.y), 0.0);
    sum = sum + textureSampleLevel(uProxyLitTex, uProxyLitTexSampler, uv + vec2f(-t.x,  0.0), 0.0) * 2.0;
    sum = sum + textureSampleLevel(uProxyLitTex, uProxyLitTexSampler, uv + vec2f( t.x,  0.0), 0.0) * 2.0;
    sum = sum + textureSampleLevel(uProxyLitTex, uProxyLitTexSampler, uv + vec2f(-t.x,  t.y), 0.0);
    sum = sum + textureSampleLevel(uProxyLitTex, uProxyLitTexSampler, uv + vec2f( 0.0,  t.y), 0.0) * 2.0;
    sum = sum + textureSampleLevel(uProxyLitTex, uProxyLitTexSampler, uv + vec2f( t.x,  t.y), 0.0);
    return sum / 16.0;
}

fn tentRaw(uv: vec2f, texel: vec2f, radius: f32) -> vec4f {
    let c = textureSampleLevel(uProxyRawTex, uProxyRawTexSampler, uv, 0.0);
    if (radius <= 0.0) { return c; }
    let t = texel * radius;
    var sum = c * 4.0;
    sum = sum + textureSampleLevel(uProxyRawTex, uProxyRawTexSampler, uv + vec2f(-t.x, -t.y), 0.0);
    sum = sum + textureSampleLevel(uProxyRawTex, uProxyRawTexSampler, uv + vec2f( 0.0, -t.y), 0.0) * 2.0;
    sum = sum + textureSampleLevel(uProxyRawTex, uProxyRawTexSampler, uv + vec2f( t.x, -t.y), 0.0);
    sum = sum + textureSampleLevel(uProxyRawTex, uProxyRawTexSampler, uv + vec2f(-t.x,  0.0), 0.0) * 2.0;
    sum = sum + textureSampleLevel(uProxyRawTex, uProxyRawTexSampler, uv + vec2f( t.x,  0.0), 0.0) * 2.0;
    sum = sum + textureSampleLevel(uProxyRawTex, uProxyRawTexSampler, uv + vec2f(-t.x,  t.y), 0.0);
    sum = sum + textureSampleLevel(uProxyRawTex, uProxyRawTexSampler, uv + vec2f( 0.0,  t.y), 0.0) * 2.0;
    sum = sum + textureSampleLevel(uProxyRawTex, uProxyRawTexSampler, uv + vec2f( t.x,  t.y), 0.0);
    return sum / 16.0;
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let t = uniform.uComposeParams.xy;

    let lit = tentLit(input.vUv0, t, uniform.uComposeParams.z);
    let cov = clamp(lit.a, 0.0, 1.0);
    var direct = vec3f(0.0);
    if (cov > 1e-4) { direct = lit.rgb / cov; }

    output.color = vec4f(direct + uniform.uComposeAmbient, cov);

    var visibility: f32 = 1.0;
    if (uniform.uComposeHasRaw > 0.5) {
        let raw = tentRaw(input.vUv0, t, uniform.uComposeParams.w);
        let rawCov = clamp(raw.a, 0.0, 1.0);
        var unshadowed = vec3f(0.0);
        if (rawCov > 1e-4) { unshadowed = raw.rgb / rawCov; }
        // See the GLSL twin for why this ratio carries no N.L and no ambient.
        let total = dot(unshadowed, vec3f(0.2126, 0.7152, 0.0722));
        let reaching = dot(direct, vec3f(0.2126, 0.7152, 0.0722));
        if (total > 1e-4) { visibility = clamp(reaching / total, 0.0, 1.0); }
    }
    output.color1 = vec2f(visibility, cov);
    return output;
}
`;

export { COMPOSE_GLSL, COMPOSE_WGSL };
