/**
 * Shader reads for quantized SPZ splats (`spz-quantized.ts`), verbatim from
 * PlayCanvas's `scripts/esm/parsers/spz-parser.mjs` (MIT, (c) PlayCanvas Ltd),
 * which doesn't export them. spz-quantized-shader.test.ts fails when an
 * upgrade changes them.
 */

export const SPZ_READ_GLSL = /* glsl */`
uniform float spzPositionScale;

// work values
uvec4 packedData;   // xyz: 24-bit position + 8-bit scale per component, w: rotation bits

vec3 getCenter() {
    packedData = loadPackedTexture();

    // sign-extend the 24-bit fixed point position
    ivec3 p = ivec3(packedData.xyz << 8u) >> 8;
    return vec3(p) * spzPositionScale;
}

vec4 getColor() {
    vec4 c = loadColorTexture();

    // rgb stores SH DC coefficients as c * 0.15 + 0.5, convert to color as 0.5 + SH_C0 * dc,
    // alpha is stored with sigmoid already applied
    const float scale = 0.28209479177387814 / 0.15;
    return vec4((c.rgb - 0.5) * scale + 0.5, c.a);
}

vec4 getRotation() {
    // smallest-three encoding: bits 30-31 store the index of the largest component, the
    // remaining three components are stored as 9-bit magnitude + sign bit, 10 bits each,
    // starting from the lowest bits for the highest component index
    uint comp = packedData.w;
    uint largest = comp >> 30u;
    float q[4];
    float sumSquares = 0.0;
    for (int i = 3; i >= 0; i--) {
        if (uint(i) != largest) {
            float v = float(comp & 0x1ffu) * (0.7071067811865476 / 511.0);
            if ((comp & 0x200u) != 0u) v = -v;
            comp = comp >> 10u;
            q[i] = v;
            sumSquares += v * v;
        }
    }
    q[largest] = sqrt(max(0.0, 1.0 - sumSquares));

    // spz stores the quaternion as (x, y, z, w), the engine expects (w, x, y, z)
    return vec4(q[3], q[0], q[1], q[2]);
}

vec3 getScale() {
    // 8-bit log encoded scale in the top byte of each position word
    vec3 s = vec3(packedData.xyz >> 24u);
    return exp(s / 16.0 - 10.0);
}

#if SH_BANDS > 0

// quantized SH bytes of the current splat, packed 4 to a word
uint shWords[12];

float unpackSH(int i) {
    uint b = (shWords[i >> 2] >> uint(8 * (i & 3))) & 0xffu;
    return (float(b) - 128.0) / 128.0;
}

void readSHData(out vec3 sh[SH_COEFFS], out float scale) {
    uvec4 d0 = loadShTexture0();
    shWords[0] = d0.x; shWords[1] = d0.y; shWords[2] = d0.z; shWords[3] = d0.w;
    #if SH_BANDS > 1
        uvec4 d1 = loadShTexture1();
        shWords[4] = d1.x; shWords[5] = d1.y; shWords[6] = d1.z; shWords[7] = d1.w;
    #endif
    #if SH_BANDS > 2
        uvec4 d2 = loadShTexture2();
        shWords[8] = d2.x; shWords[9] = d2.y; shWords[10] = d2.z; shWords[11] = d2.w;
    #endif

    for (int i = 0; i < SH_COEFFS; i++) {
        sh[i] = vec3(unpackSH(i * 3), unpackSH(i * 3 + 1), unpackSH(i * 3 + 2));
    }

    scale = 1.0;
}

#endif
`;

export const SPZ_READ_WGSL = /* wgsl */`
uniform spzPositionScale: f32;

// work values
var<private> packedData: vec4u;    // xyz: 24-bit position + 8-bit scale per component, w: rotation bits

fn getCenter() -> vec3f {
    packedData = loadPackedTexture();

    // sign-extend the 24-bit fixed point position
    let p = bitcast<vec3i>(packedData.xyz << vec3u(8u)) >> vec3u(8u);
    return vec3f(p) * uniform.spzPositionScale;
}

fn getColor() -> vec4f {
    let c = loadColorTexture();

    // rgb stores SH DC coefficients as c * 0.15 + 0.5, convert to color as 0.5 + SH_C0 * dc,
    // alpha is stored with sigmoid already applied
    const scale: f32 = 0.28209479177387814 / 0.15;
    return vec4f((c.rgb - 0.5) * scale + 0.5, c.a);
}

fn getRotation() -> vec4f {
    // smallest-three encoding: bits 30-31 store the index of the largest component, the
    // remaining three components are stored as 9-bit magnitude + sign bit, 10 bits each,
    // starting from the lowest bits for the highest component index
    var comp: u32 = packedData.w;
    let largest: u32 = comp >> 30u;
    var q = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
    var sumSquares: f32 = 0.0;
    for (var i: i32 = 3; i >= 0; i--) {
        if (u32(i) != largest) {
            var v: f32 = f32(comp & 0x1ffu) * (0.7071067811865476 / 511.0);
            if ((comp & 0x200u) != 0u) { v = -v; }
            comp = comp >> 10u;
            q[i] = v;
            sumSquares += v * v;
        }
    }
    q[largest] = sqrt(max(0.0, 1.0 - sumSquares));

    // spz stores the quaternion as (x, y, z, w), the engine expects (w, x, y, z)
    return vec4f(q[3], q[0], q[1], q[2]);
}

fn getScale() -> vec3f {
    // 8-bit log encoded scale in the top byte of each position word
    let s = vec3f(packedData.xyz >> vec3u(24u));
    return exp(s / 16.0 - 10.0);
}

#if SH_BANDS > 0

// quantized SH bytes of the current splat, packed 4 to a word
var<private> shWords: array<u32, 12>;

fn unpackSH(i: i32) -> f32 {
    let b = (shWords[i >> 2] >> u32(8 * (i & 3))) & 0xffu;
    return (f32(b) - 128.0) / 128.0;
}

fn readSHData(sh: ptr<function, array<half3, SH_COEFFS>>, scale: ptr<function, f32>) {
    let d0 = loadShTexture0();
    shWords[0] = d0.x; shWords[1] = d0.y; shWords[2] = d0.z; shWords[3] = d0.w;
    #if SH_BANDS > 1
        let d1 = loadShTexture1();
        shWords[4] = d1.x; shWords[5] = d1.y; shWords[6] = d1.z; shWords[7] = d1.w;
    #endif
    #if SH_BANDS > 2
        let d2 = loadShTexture2();
        shWords[8] = d2.x; shWords[9] = d2.y; shWords[10] = d2.z; shWords[11] = d2.w;
    #endif

    for (var i: i32 = 0; i < SH_COEFFS; i++) {
        sh[i] = half3(vec3f(unpackSH(i * 3), unpackSH(i * 3 + 1), unpackSH(i * 3 + 2)));
    }

    *scale = 1.0;
}

#endif
`;
