/**
 * CRT shader sources - GLSL (WebGL2) and WGSL (WebGPU) variants.
 *
 * Follows the post-fx shader convention documented in `postfx.ts` rules
 * 7 and 8: source-RT samples go through `texelFetch` / `textureLoad`
 * indexed by integer pixel coordinates derived from `gl_FragCoord` /
 * `input.position` - NOT from `vUv0`, which is Y-flipped on WebGPU.
 *
 * Uniforms consumed:
 *   uSourceTex   - input RT (bound by BaseCapturingPass).
 *   uResolution  - backbuffer size in pixels (width, height).
 *   uBarrel      - distortion strength, 0..0.3 (typical 0.18).
 *   uScanline    - scanline darkening intensity, 0..1.
 *   uAberration  - R/B horizontal split as a fraction of width, 0..0.01.
 *
 * @group CRT
 */

export const CRT_FRAGMENT_GLSL = /* glsl */ `
uniform sampler2D uSourceTex;
uniform vec2 uResolution;
uniform float uBarrel;
uniform float uScanline;
uniform float uAberration;

void main(void) {
  // Use gl_FragCoord (pixel coords, consistent across backends) for the
  // sampling math. See postfx.ts rule 7.
  vec2 uv = gl_FragCoord.xy / uResolution;

  // Barrel distortion - pinch UVs from the centre outward.
  vec2 centered = uv - 0.5;
  float r2 = dot(centered, centered);
  centered *= 1.0 + uBarrel * r2;
  vec2 d = centered + 0.5;
  vec2 c = clamp(d, vec2(0.0), vec2(1.0));

  // Map distorted UV → integer source pixel (clamped to last texel).
  ivec2 srcSize = ivec2(uResolution);
  ivec2 srcPx = ivec2(c * uResolution);
  srcPx = clamp(srcPx, ivec2(0), srcSize - ivec2(1));
  int aberrPx = int(uAberration * uResolution.x);

  vec3 col;
  col.r = texelFetch(uSourceTex,
    clamp(srcPx + ivec2( aberrPx, 0), ivec2(0), srcSize - ivec2(1)), 0).r;
  col.g = texelFetch(uSourceTex, srcPx, 0).g;
  col.b = texelFetch(uSourceTex,
    clamp(srcPx + ivec2(-aberrPx, 0), ivec2(0), srcSize - ivec2(1)), 0).b;

  // Bezel: blacken the area where the distorted UV walked off-screen.
  float inside = step(0.0, d.x) * step(d.x, 1.0) * step(0.0, d.y) * step(d.y, 1.0);
  col *= inside;

  // Scanlines - darken every other row in source pixels.
  float row = d.y * uResolution.y;
  float scan = 0.5 + 0.5 * cos(row * 3.14159);
  col *= mix(1.0, scan, uScanline);

  gl_FragColor = vec4(col, 1.0);
}
`;

export const CRT_FRAGMENT_WGSL = /* wgsl */ `
var uSourceTex: texture_2d<f32>;
uniform uResolution: vec2f;
uniform uBarrel: f32;
uniform uScanline: f32;
uniform uAberration: f32;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;

  // input.position.xy - pixel coords with consistent orientation across
  // backends. See postfx.ts rule 7.
  let uv = input.position.xy / uniform.uResolution;

  var centered = uv - 0.5;
  let r2 = dot(centered, centered);
  centered = centered * (1.0 + uniform.uBarrel * r2);
  let d = centered + 0.5;
  let c = clamp(d, vec2f(0.0), vec2f(1.0));

  let srcSize = vec2i(uniform.uResolution);
  var srcPx = vec2i(c * uniform.uResolution);
  srcPx = clamp(srcPx, vec2i(0), srcSize - vec2i(1));
  let aberrPx = i32(uniform.uAberration * uniform.uResolution.x);

  var col: vec3f;
  col.r = textureLoad(uSourceTex,
    clamp(srcPx + vec2i( aberrPx, 0), vec2i(0), srcSize - vec2i(1)), 0).r;
  col.g = textureLoad(uSourceTex, srcPx, 0).g;
  col.b = textureLoad(uSourceTex,
    clamp(srcPx + vec2i(-aberrPx, 0), vec2i(0), srcSize - vec2i(1)), 0).b;

  let inside = step(0.0, d.x) * step(d.x, 1.0) * step(0.0, d.y) * step(d.y, 1.0);
  col = col * inside;

  let row = d.y * uniform.uResolution.y;
  let scan = 0.5 + 0.5 * cos(row * 3.14159);
  col = col * mix(1.0, scan, uniform.uScanline);

  output.color = vec4f(col, 1.0);
  return output;
}
`;
