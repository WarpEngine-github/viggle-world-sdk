// Shader sources for the work-buffer modifier hooked in via
// `GSplatComponent.setWorkBufferModifier`. Both GLSL (WebGL2) and WGSL
// (WebGPU) variants are provided - PlayCanvas picks the right one via
// `device.isWebGPU`.
//
// Two modifier flavours:
//
// - workBufferModifier{GLSL,WGSL} - for character splats. Applies the
//   per-splat palette transform (optionally bone-blended) in modifySplatCenter,
//   pushes the palette's linear part into modifySplatRotationScale, and
//   tints, relights and grades the baked splat colour.
//
// - envWorkBufferModifier{GLSL,WGSL} - for environment splats. No palette,
//   no bone blending (those samplers wouldn't be bound). Identity transforms
//   for center/rotation/scale; colour is the baked colour through the relight
//   chunk, then the tint channel, and - once a scene has opted in - the
//   radial reveal.
//
// Both flavours share the relightChunk{GLSL,WGSL} defined below.

// Cache-bust fingerprint - PC caches compiled work-buffer shader programs
// by modifier source hash. Bump this string when the shader body changes
// so in-flight scenes compile the new version instead of reusing the old
// cached program across HMR reloads.
const SHADER_REV = '2026-07-22-derive-from-matrix-model-v9+tint-v1+variant-v2+grade-v2+camcull-v1+relight-v3+env-relight-only-v1+no-legacy-lighting-v1+reveal-v1+envclipdist-v1+env-tint-v1+env-reveal-v1+env-shock-v1+env-reveal-inverse-v1+reveal-pulse-v1+env-shock-removed-v1';

const relightChunkGLSL = /* glsl */ `
// rev: ${SHADER_REV}
// ── Relight: screen-space lighting sampled from a proxy mesh ───────────────
//
// Produced by RelightPass (engine/src/relight/): a proxy mesh of the same
// subject is rendered with PlayCanvas's real lights into a half-resolution
// texture, and every splat samples the texel it projects to. Every splat along
// a view ray therefore reads the SAME lighting, which is what keeps overlapping
// semi-transparent splats in agreement - a per-splat N.L instead makes the
// bright back and the dark front of a head disagree, and the per-frame depth
// re-sort reshuffles that mix into visible flicker.
//
// mediump on the samplers, not highp: PlayCanvas's GLSL processor
// classifies a highp sampler as unfilterable-float, and this read has to be
// BILINEAR. An animated splat's screen position drifts across the half-res
// texture every frame and a point load pops to a new texel each time it crosses
// a boundary - visible as flicker wherever neighbouring texels differ, which is
// exactly the shadow edges.
uniform mediump sampler2D uRelightTex;        // rgb = lighting, a = proxy coverage
uniform mediump sampler2D uRelightShadowTex;  // r = shadow visibility, g = coverage
uniform mat4 uRelightVP;    // the view-projection the texture was rendered with
uniform vec4 uRelightParams; // xy = 1/size, z = 1/referenceLuminance, w = 1 when valid
uniform float uRelightStrength;
uniform vec3 uRelightTint;
uniform float uRelightAmbient;
uniform float uRelightShadowStrength;
uniform float uRelightFlipY;
uniform float uRelightDebug;

void applyRelight(vec3 worldCenter, inout vec4 color) {
    float strength = clamp(uRelightStrength, 0.0, 1.0);
    float shadowStrength = clamp(uRelightShadowStrength, 0.0, 1.0);
    // 1 = paint the lighting sample, 2 = paint the shadow-visibility sample.
    bool debug = uRelightDebug > 0.5;
    bool debugVis = uRelightDebug > 1.5;
    // Strength 0 skips the texture fetch entirely, so the effect costs nothing
    // until it is dialled up.
    if (!debug && strength <= 0.0 && shadowStrength <= 0.0) return;

    // No texture published this frame (pass disabled, or its first frame).
    if (uRelightParams.w <= 0.0) {
        if (debug) { color.rgb = vec3(1.0, 0.0, 1.0); color.a = 1.0; }
        return;
    }

    vec4 clipPos = uRelightVP * vec4(worldCenter, 1.0);
    // Reject behind-camera splats BEFORE the divide: a negative w flips the
    // sign of both NDC components, which can land a splat that is behind the
    // viewer squarely inside [0,1] and have it steal an unrelated pixel's
    // lighting.
    if (clipPos.w <= 0.0) {
        if (debug) { color.rgb = vec3(1.0, 1.0, 0.0); color.a = 1.0; }
        return;
    }

    vec2 uv = clipPos.xy / clipPos.w * 0.5 + 0.5;
    // Render-target y orientation. PlayCanvas 2.18 round-trips
    // render-to-texture the same way on both backends, so the producer leaves
    // this at 0; it is here because the moment that stops being true this is
    // the one-line fix, and the debug paint's orange case is how you find out.
    if (uRelightFlipY > 0.5) uv.y = 1.0 - uv.y;

    // Off-screen splats have no proxy pixel to read. Keep the baked colour -
    // clamping to an edge texel would smear it across the border.
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        if (debug) { color.rgb = vec3(1.0, 0.0, 0.0); color.a = 1.0; }
        return;
    }

    if (debugVis) {
        // Greys = the visibility ratio at this splat; magenta = the texel has
        // no proxy coverage, so the shadow term is a no-op there by design.
        vec2 dv = texture2DLod(uRelightShadowTex, uv, 0.0).rg;
        color.rgb = dv.g > 0.0 ? vec3(clamp(dv.r, 0.0, 1.0)) : vec3(1.0, 0.0, 1.0);
        color.a = 1.0;
        return;
    }

    vec4 s = texture2DLod(uRelightTex, uv, 0.0);

    if (debug) {
        if (s.a > 0.0) {
            // Greys: exactly what the real path multiplies in.
            color.rgb = s.rgb;
        } else {
            // No coverage at the computed texel - check the vertically
            // mirrored one. Coverage THERE (orange) convicts the y-flip
            // specifically; coverage nowhere (blue) says the alpha channel is
            // never written, or the proxy is not aligned with the splats.
            vec2 mirrored = vec2(uv.x, 1.0 - uv.y);
            color.rgb = texture2DLod(uRelightTex, mirrored, 0.0).a > 0.0
                ? vec3(1.0, 0.5, 0.0)
                : vec3(0.0, 0.0, 1.0);
        }
        color.a = 1.0;
        return;
    }

    if (strength > 0.0) {
        // .a is the proxy coverage mask. Splats outside the proxy silhouette
        // (stray hair, the edge of a skirt) fall back to their baked colour
        // rather than to black, which is what keeps the character from getting
        // a hard lit/unlit seam at its outline.
        float mask = clamp(s.a, 0.0, 1.0);
        // Normalize against the reference luminance so "correctly lit" comes
        // out near 1 and the blend below changes lighting CONTRAST rather than
        // overall brightness.
        vec3 lighting = max(s.rgb * uRelightParams.z, vec3(uRelightAmbient)) * uRelightTint;
        color.rgb = mix(color.rgb, color.rgb * lighting, strength * mask);
    }

    // Cast shadow, AFTER relighting: occlusion multiplies whatever surface
    // colour came out above, lit or baked. There is deliberately no ambient
    // floor here - the slider IS the floor, since strength s leaves a fully
    // shadowed splat at (1 - s) of its colour.
    if (shadowStrength > 0.0) {
        vec2 v = texture2DLod(uRelightShadowTex, uv, 0.0).rg;
        color.rgb *= mix(1.0, clamp(v.r, 0.0, 1.0), shadowStrength * clamp(v.g, 0.0, 1.0));
    }
}
`;
const relightChunkWGSL = /* wgsl */ `
// rev: ${SHADER_REV}
// See the GLSL twin for the full contract. The sampler declaration must follow
// its texture immediately - PlayCanvas's WGSL processor pairs them by position.
var uRelightTex: texture_2d<f32>;
var uRelightTexSampler: sampler;
var uRelightShadowTex: texture_2d<f32>;
var uRelightShadowTexSampler: sampler;
uniform uRelightVP: mat4x4f;
uniform uRelightParams: vec4f;
uniform uRelightStrength: f32;
uniform uRelightTint: vec3f;
uniform uRelightAmbient: f32;
uniform uRelightShadowStrength: f32;
uniform uRelightFlipY: f32;
uniform uRelightDebug: f32;

fn applyRelight(worldCenter: vec3f, color: ptr<function, vec4f>) {
    let strength = clamp(uniform.uRelightStrength, 0.0, 1.0);
    let shadowStrength = clamp(uniform.uRelightShadowStrength, 0.0, 1.0);
    let debug = uniform.uRelightDebug > 0.5;
    let debugVis = uniform.uRelightDebug > 1.5;
    if (!debug && strength <= 0.0 && shadowStrength <= 0.0) { return; }

    if (uniform.uRelightParams.w <= 0.0) {
        if (debug) { *color = vec4f(1.0, 0.0, 1.0, 1.0); }
        return;
    }

    let clipPos = uniform.uRelightVP * vec4f(worldCenter, 1.0);
    if (clipPos.w <= 0.0) {
        if (debug) { *color = vec4f(1.0, 1.0, 0.0, 1.0); }
        return;
    }

    var uv = clipPos.xy / clipPos.w * 0.5 + vec2f(0.5);
    if (uniform.uRelightFlipY > 0.5) { uv.y = 1.0 - uv.y; }

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        if (debug) { *color = vec4f(1.0, 0.0, 0.0, 1.0); }
        return;
    }

    if (debugVis) {
        // See the GLSL twin.
        let dv = textureSampleLevel(uRelightShadowTex, uRelightShadowTexSampler, uv, 0.0).rg;
        if (dv.g > 0.0) {
            *color = vec4f(vec3f(clamp(dv.r, 0.0, 1.0)), 1.0);
        } else {
            *color = vec4f(1.0, 0.0, 1.0, 1.0);
        }
        return;
    }

    let s = textureSampleLevel(uRelightTex, uRelightTexSampler, uv, 0.0);

    if (debug) {
        if (s.a > 0.0) {
            *color = vec4f(s.rgb, 1.0);
        } else {
            let mirrored = vec2f(uv.x, 1.0 - uv.y);
            let mirroredCoverage = textureSampleLevel(uRelightTex, uRelightTexSampler, mirrored, 0.0).a;
            if (mirroredCoverage > 0.0) {
                *color = vec4f(1.0, 0.5, 0.0, 1.0);
            } else {
                *color = vec4f(0.0, 0.0, 1.0, 1.0);
            }
        }
        return;
    }

    var rgb = (*color).rgb;
    if (strength > 0.0) {
        let mask = clamp(s.a, 0.0, 1.0);
        let lighting = max(s.rgb * uniform.uRelightParams.z, vec3f(uniform.uRelightAmbient)) * uniform.uRelightTint;
        rgb = mix(rgb, rgb * lighting, strength * mask);
    }
    if (shadowStrength > 0.0) {
        let v = textureSampleLevel(uRelightShadowTex, uRelightShadowTexSampler, uv, 0.0).rg;
        rgb = rgb * mix(1.0, clamp(v.r, 0.0, 1.0), shadowStrength * clamp(v.g, 0.0, 1.0));
    }
    *color = vec4f(rgb, (*color).a);
}
`;

const WORK_BUFFER_MODIFIER_GLSL = /* glsl */ `
${relightChunkGLSL}

// iOS WebGL2 (GLSL ES 3.00) is strict:
//   - references must be declaration-first (fails on "undeclared identifier"
//     if we use a uniform declared later in the outer shader)
//   - and rejects any duplicate uniform declaration ("redefinition")
//
// model_rotation and model_scale are declared AFTER the modifier include
// site in gsplatCopyToWorkbuffer.frag, so BOTH paths fail on iOS (forward-
// decl -> redefinition; no decl -> undeclared). Sidestep by not referencing
// them at all - matrix_model IS declared before the modifier (via
// gsplatCenterVS), so we can derive the world-space skinning rotation by
// multiplying matrix_model * palette and extracting the rotation.

uniform highp sampler2D transformPalette;
uniform highp sampler2D splatTintTex;
uniform highp sampler2D splatGradeTex;

#ifdef USE_BONE_BLENDING
uniform highp sampler2D boneIndices;
uniform highp sampler2D boneWeights;
#endif

// Reveal - opted into per-Splat on first use (Splat.setReveal /
// Armature.prepareReveal), so a splat that is never revealed compiles none of
// it. Look uniforms, from RevealLook (see Splat.setRevealLook):
//   uRevealBand   x = width, y = hold, z = max stretch
//   uRevealSketch x = lead, y = density, z = dot scale
//   uRevealTint   rgb = tint, a = luminance floor
#ifdef USE_REVEAL
#ifdef USE_BONE_BLENDING
uniform highp sampler2D splatRevealDistanceTex;
#endif
uniform vec4 uRevealBand;
uniform vec4 uRevealSketch;
uniform vec4 uRevealTint;
#endif

// Variant mask - per-splat group ID + per-group visibility texture. Splats
// whose group bit is <0.5 are collapsed (scale → 0) in the work-buffer
// shader. Opted into per-Splat via setSplatGroups; off by default so the
// non-variant rendering path pays zero (no samplers bound, no per-pixel
// texelFetch). See Splat.setSplatGroups + DamageVariant preset.
#ifdef USE_VARIANT_MASK
uniform highp sampler2D splatGroupIds;
uniform highp sampler2D splatVariantMask;

bool isSplatHiddenByVariantMask() {
    float gidF = texelFetch(splatGroupIds, splat.uv, 0).r;
    int gid = int(gidF + 0.5);
    float bit = texelFetch(splatVariantMask, ivec2(gid, 0), 0).r;
    return bit < 0.5;
}
#endif

bool isReasonablePaletteTransform(mat4 t) {
    mat3 linear = mat3(t);
    vec3 s = vec3(
        length(linear[0]),
        length(linear[1]),
        length(linear[2])
    );
    // Reject only when EVERY column is near-zero (truly empty palette slot).
    // Linear-blend skinning of two significantly different bone rotations
    // produces a candy-wrapper matrix with one short column; that result is
    // still a valid mid-rotation transform we want to keep. Requiring all
    // columns to pass collapsed joint-spanning splats (notably neck) back to
    // identity → bind pose → splat stranded outside the moved model.
    // Threshold 1e-4 (vs WGSL's 1e-6) keeps clear of iOS mediump precision.
    return any(greaterThan(s, vec3(1e-4)));
}

mat4 readTransformFromPalette(uint paletteIndex) {
    if (paletteIndex == 0u) {
        return mat4(1.0);
    }

    int u = int(paletteIndex % 512u) * 3;
    int v = int(paletteIndex / 512u);

    mat4 t;
    t[0] = texelFetch(transformPalette, ivec2(u, v), 0);
    t[1] = texelFetch(transformPalette, ivec2(u + 1, v), 0);
    t[2] = texelFetch(transformPalette, ivec2(u + 2, v), 0);
    t[3] = vec4(0.0, 0.0, 0.0, 1.0);

    mat4 result = transpose(t);
    if (!isReasonablePaletteTransform(result)) {
        return mat4(1.0);
    }
    return result;
}

mat4 getSplatPaletteTransform() {
    #ifdef USE_BONE_BLENDING
    vec4 boneIdxVec = texelFetch(boneIndices, splat.uv, 0);
    vec4 boneWeightVec = texelFetch(boneWeights, splat.uv, 0);
    float totalWeight = dot(boneWeightVec, vec4(1.0));
    if (totalWeight > 0.001) {
        mat4 blended = mat4(0.0);
        for (int i = 0; i < 4; i++) {
            float w = boneWeightVec[i];
            if (w > 0.001) {
                uint idx = uint(boneIdxVec[i] + 0.5);
                blended += readTransformFromPalette(idx) * w;
            }
        }
        mat4 result = blended / totalWeight;
        if (isReasonablePaletteTransform(result)) {
            return result;
        }
    }
    #endif

    return mat4(1.0);
}

vec4 mat3ToQuatXYZW(mat3 R) {
    vec4 q;
    float trace = R[0][0] + R[1][1] + R[2][2];
    if (trace > 0.0) {
        float s = sqrt(trace + 1.0) * 2.0;
        q.w = 0.25 * s;
        q.x = (R[1][2] - R[2][1]) / s;
        q.y = (R[2][0] - R[0][2]) / s;
        q.z = (R[0][1] - R[1][0]) / s;
    } else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
        float s = sqrt(1.0 + R[0][0] - R[1][1] - R[2][2]) * 2.0;
        q.w = (R[1][2] - R[2][1]) / s;
        q.x = 0.25 * s;
        q.y = (R[1][0] + R[0][1]) / s;
        q.z = (R[2][0] + R[0][2]) / s;
    } else if (R[1][1] > R[2][2]) {
        float s = sqrt(1.0 + R[1][1] - R[0][0] - R[2][2]) * 2.0;
        q.w = (R[2][0] - R[0][2]) / s;
        q.x = (R[1][0] + R[0][1]) / s;
        q.y = 0.25 * s;
        q.z = (R[2][1] + R[1][2]) / s;
    } else {
        float s = sqrt(1.0 + R[2][2] - R[0][0] - R[1][1]) * 2.0;
        q.w = (R[0][1] - R[1][0]) / s;
        q.x = (R[2][0] + R[0][2]) / s;
        q.y = (R[2][1] + R[1][2]) / s;
        q.z = 0.25 * s;
    }
    return q;
}

#if defined(USE_REVEAL) && defined(GSPLAT_CENTER_NOPROJ)
// Per-splat distance along the skeleton, feet (0) to head (1).
float splatRevealDistance() {
    #ifdef USE_BONE_BLENDING
    return texelFetch(splatRevealDistanceTex, splat.uv, 0).r;
    #else
    return 1.0;
    #endif
}

// Signed distance behind the moving front.
float splatRevealX(float reveal) {
    float front = mix(-uRevealBand.x, 1.0 + uRevealBand.x, reveal);
    return front - splatRevealDistance();
}

// Bright edge colour derived from the splat's own colour.
vec3 splatRevealHot(vec3 base) {
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

// Stable sparse dots just ahead of the front.
float splatRevealSketch(float x) {
    float lead = uRevealSketch.x;
    if (x >= 0.0 || x < -lead) return 0.0;
    vec3 rest = getCenter();
    float h = fract(sin(dot(rest, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    // >=: the hash can be exactly 0, and density 0 must still draw nothing.
    if (h >= uRevealSketch.y) return 0.0;
    return smoothstep(-lead, -lead * 0.7, x);
}

void splatRevealApply(float reveal, bool inverse, inout vec4 color) {
    float x = splatRevealX(reveal);
    float bandWidth = uRevealBand.x;
    vec3 base = clamp(color.rgb, 0.0, 1.0);
    vec3 hot = splatRevealHot(base);
    if (inverse) {
        if (x < 0.0) return;
        float band = 1.0 - smoothstep(0.0, bandWidth, x);
        color.rgb = mix(base, hot, band);
        color.a = band * 0.95;
        return;
    }
    if (x >= 0.0) {
        float band = 1.0 - smoothstep(bandWidth * uRevealBand.y, bandWidth, x);
        color.rgb = mix(base, hot, band);
        color.a = max(color.a, band * 0.95);
    } else {
        float sketch = splatRevealSketch(x);
        color.rgb = hot;
        color.a = sketch;
    }
}

// The band alone over a whole body (Splat.setRevealPulse): recolours, never hides.
void splatRevealPulse(float front, float strength, inout vec4 color) {
    float x = abs(splatRevealX(front));
    float bandWidth = uRevealBand.x;
    if (x >= bandWidth) return;
    float band = 1.0 - smoothstep(bandWidth * uRevealBand.y, bandWidth, x);
    color.rgb = mix(color.rgb, splatRevealHot(clamp(color.rgb, 0.0, 1.0)), band * strength);
}
#endif

// PC calls modifySplatCenter + modifySplatRotationScale in TWO places:
//   1. gsplatCopyToWorkbuffer.frag -- writes the skinned splat into the
//      work buffer. We want our palette/bone math to run HERE.
//   2. gsplatCorner.vert -- reads the already-skinned value back from the
//      work buffer and feeds it to the covariance math. Running the
//      palette again at this stage applies skinning twice (fatal: for an
//      entity with yaw ~ 180, mr^2 = I so the second pass cancels the
//      first and splats render in rest orientation while their centers are
//      in the animated pose, producing the radial limb streaks).
//
// GSPLAT_CENTER_NOPROJ is defined ONLY in the copy-to-wb fragment shader
// (PC convention, see gsplatCopyToWorkbuffer.js line 2). Gate the modifier
// body behind it so the render-pass call is a no-op.
void modifySplatCenter(inout vec3 center) {
    #ifdef GSPLAT_CENTER_NOPROJ
    mat4 palette = getSplatPaletteTransform();
    vec3 modelCenter = getCenter();
    vec3 modelDeformed = (palette * vec4(modelCenter, 1.0)).xyz;
    center = (matrix_model * vec4(modelDeformed, 1.0)).xyz;
    #endif
}

// Extract rotation quat from the shared blended palette matrix and force
// paletteScale to (1,1,1). A host's armature animation pipeline can stamp
// non-unit scale into bone TRS (localScale.copy(skeletalPose.scale)) while
// the bind pose is always unit, so (current * inv(bind)) column lengths
// drift from 1 and multiplying srcScale by them amplifies the Gaussian
// ellipsoids into the radial streaks seen on fists/hands. Rigid skinning
// doesn't need bone scale blended into splat sigmas; treat paletteScale as
// identity and let the rotation do all the pose work.
void getBlendedSplatRotationScale(out vec4 qOut, out vec3 sOut) {
    sOut = vec3(1.0);
    #ifdef USE_BONE_BLENDING
    mat4 palette = getSplatPaletteTransform();
    mat3 lin = mat3(palette);
    vec3 s = vec3(length(lin[0]), length(lin[1]), length(lin[2]));
    if (s.x > 1e-5 && s.y > 1e-5 && s.z > 1e-5) {
        mat3 rot = mat3(
            lin[0] / s.x,
            lin[1] / s.y,
            lin[2] / s.z
        );
        qOut = mat3ToQuatXYZW(rot);
        return;
    }
    #endif
    qOut = vec4(0.0, 0.0, 0.0, 1.0);
}

void modifySplatRotationScale(
    vec3 originalCenter,
    vec3 modifiedCenter,
    inout vec4 rotation,
    inout vec3 scale
) {
    #ifdef GSPLAT_CENTER_NOPROJ
    // Compute the full world-space skinning rotation from the combined
    // matrix_model * palette transform, then compose with the splat-local
    // rotation. Equivalent to (model_rotation * paletteQuat * srcRotation)
    // when matrix_model has no scale, but reads from matrix_model directly
    // (which IS declared before this chunk, unlike model_rotation).
    mat4 palette = getSplatPaletteTransform();
    mat4 combined = matrix_model * palette;
    mat3 lin = mat3(combined);
    vec3 s = vec3(length(lin[0]), length(lin[1]), length(lin[2]));
    if (s.x > 1e-5 && s.y > 1e-5 && s.z > 1e-5) {
        mat3 rot = mat3(
            lin[0] / s.x,
            lin[1] / s.y,
            lin[2] / s.z
        );
        vec4 worldSkinQuat = mat3ToQuatXYZW(rot);
        vec4 srcRotation = getRotation().yzwx;
        vec4 composed = quatMul(worldSkinQuat, srcRotation);
        composed = normalize(composed);
        if (composed.w < 0.0) composed = -composed;
        rotation = composed;
    }
    #ifdef USE_NONRIGID_COV
    // Bone-length scaling: propagate the palette's per-axis scale (s, the
    // column lengths just measured) into the Gaussian sigma so covariances
    // stretch along the bone - consistent with the rotation extracted above.
    // Requires the CPU palette to keep its scale (SplatSkinning.covStretch).
    scale *= s;
    #endif
    // (default) scale left alone - paletteScale is unit by design (CPU
    // rigid-skin normalization strips scale before building the palette).

    #ifdef USE_VARIANT_MASK
    // Variant-mask cull: collapse splats whose group bit is masked out.
    // Writing scale=0 into the work buffer makes the covariance go to zero
    // on the render-pass side, so the gaussian contributes no pixels.
    if (isSplatHiddenByVariantMask()) {
        scale = vec3(0.0);
    }
    #endif

    #ifdef USE_REVEAL
    // Reveal: ahead of the front draws small (only the sparse sketch subset
    // has alpha there, see splatRevealApply); inside the band, elongated
    // splats are squashed so the edge stays a stroke rather than sparks.
    vec4 revealGrade = texelFetch(splatGradeTex, ivec2(0, 0), 0);
    if (revealGrade.a > 1.5) {
        // A pulse leaves the shape alone.
    } else if (revealGrade.a > 0.5) {
        float x = splatRevealX(revealGrade.b);
        if (x >= 0.0 && x < uRevealBand.x) {
            float m = min(scale.x, min(scale.y, scale.z));
            scale = min(scale, vec3(m * uRevealBand.z));
        }
    } else if (revealGrade.b < 1.0) {
        float x = splatRevealX(revealGrade.b);
        if (x < 0.0) {
            scale *= uRevealSketch.z;
        } else if (x < uRevealBand.x) {
            float m = min(scale.x, min(scale.y, scale.z));
            scale = min(scale, vec3(m * uRevealBand.z));
        }
    }
    #endif
    #endif
}

void modifySplatColor(vec3 center, inout vec4 color) {
    // Same dual-call issue as center/rotation: write pass bakes the colour
    // into the workbuffer, render pass would then apply it AGAIN. Gate.
    #ifdef GSPLAT_CENTER_NOPROJ
    vec4 tintTex = texelFetch(splatTintTex, ivec2(0, 0), 0);
    vec3 tintColor = tintTex.rgb;
    float tintAmt = clamp(tintTex.a, 0.0, 1.0);
    color.rgb = mix(color.rgb, tintColor, tintAmt);
    // Relight: tint, then light the tinted colour. Ordered before the grade so
    // contrast/saturation act on the lit result, the way a grade would on a
    // rendered frame.
    applyRelight(center, color);
    // Color grade: gradeTex.r = contrast, gradeTex.g = saturation. Identity
    // (1,1) is a TRUE no-op - skip the math + clamp so HDR splat colours are
    // preserved (clamping them to [0,1] turns bright splats into white specks).
    vec4 gradeTex = texelFetch(splatGradeTex, ivec2(0, 0), 0);
    float contrast = gradeTex.r;
    float saturation = gradeTex.g;
    if (contrast != 1.0 || saturation != 1.0) {
        color.rgb = (color.rgb - 0.5) * contrast + 0.5;
        float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
        color.rgb = mix(vec3(luma), color.rgb, saturation);
        color.rgb = clamp(color.rgb, 0.0, 1.0);
    }
    #ifdef USE_REVEAL
    // Reveal front (gradeTex.b, 1 = identity). See Splat.setReveal.
    if (gradeTex.a > 1.5) {
        splatRevealPulse(gradeTex.b, gradeTex.a - 2.0, color);
    } else if (gradeTex.b < 1.0 || gradeTex.a > 0.5) {
        splatRevealApply(gradeTex.b, gradeTex.a > 0.5, color);
    }
    #endif
    // Opacity (texel 1). See Splat.setOpacity.
    color.a *= texelFetch(splatTintTex, ivec2(1, 0), 0).r;
    #endif
}
`;

const WORK_BUFFER_MODIFIER_WGSL = /* wgsl */ `
${relightChunkWGSL}

var transformPalette: texture_2d<f32>;
var splatTintTex: texture_2d<f32>;
var splatGradeTex: texture_2d<f32>;

#ifdef USE_BONE_BLENDING
var boneIndices: texture_2d<f32>;
var boneWeights: texture_2d<f32>;
#endif

// Reveal - see GLSL twin.
#ifdef USE_REVEAL
#ifdef USE_BONE_BLENDING
var splatRevealDistanceTex: texture_2d<f32>;
#endif
uniform uRevealBand: vec4f;
uniform uRevealSketch: vec4f;
uniform uRevealTint: vec4f;
#endif

// See GLSL twin for semantics. Opted in via Splat.setSplatGroups.
#ifdef USE_VARIANT_MASK
var splatGroupIds: texture_2d<f32>;
var splatVariantMask: texture_2d<f32>;

fn isSplatHiddenByVariantMask() -> bool {
    let gidF = textureLoad(splatGroupIds, splat.uv, 0).r;
    let gid = i32(gidF + 0.5);
    let bit = textureLoad(splatVariantMask, vec2i(gid, 0), 0).r;
    return bit < 0.5;
}
#endif

fn identityMat4() -> mat4x4f {
    return mat4x4f(
        vec4f(1.0, 0.0, 0.0, 0.0),
        vec4f(0.0, 1.0, 0.0, 0.0),
        vec4f(0.0, 0.0, 1.0, 0.0),
        vec4f(0.0, 0.0, 0.0, 1.0)
    );
}

fn isReasonablePaletteTransform(t: mat4x4f) -> bool {
    let s = vec3f(
        length(t[0].xyz),
        length(t[1].xyz),
        length(t[2].xyz)
    );
    // Reject only when EVERY column is near-zero. See GLSL twin for the
    // candy-wrapper / neck-splat rationale. WGSL uses 1e-6 since WebGPU
    // doesn't have iOS mediump precision concerns.
    return any(s > vec3f(1e-6));
}

fn readTransformFromPalette(paletteIndex: u32) -> mat4x4f {
    if (paletteIndex == 0u) {
        return identityMat4();
    }

    let u: i32 = i32(paletteIndex % 512u) * 3;
    let v: i32 = i32(paletteIndex / 512u);

    var t: mat4x4f;
    t[0] = textureLoad(transformPalette, vec2i(u, v), 0);
    t[1] = textureLoad(transformPalette, vec2i(u + 1, v), 0);
    t[2] = textureLoad(transformPalette, vec2i(u + 2, v), 0);
    t[3] = vec4f(0.0, 0.0, 0.0, 1.0);

    let result = transpose(t);
    if (!isReasonablePaletteTransform(result)) {
        return identityMat4();
    }
    return result;
}

fn getSplatPaletteTransform() -> mat4x4f {
    #ifdef USE_BONE_BLENDING
    let boneIdxVec = textureLoad(boneIndices, splat.uv, 0);
    let boneWeightVec = textureLoad(boneWeights, splat.uv, 0);
    let totalWeight = dot(boneWeightVec, vec4f(1.0));
    if (totalWeight > 0.001) {
        var blended = mat4x4f(
            vec4f(0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0)
        );
        for (var i: i32 = 0; i < 4; i = i + 1) {
            let w = boneWeightVec[i];
            if (w > 0.001) {
                let idx = u32(boneIdxVec[i] + 0.5);
                let m = readTransformFromPalette(idx);
                blended[0] = blended[0] + m[0] * w;
                blended[1] = blended[1] + m[1] * w;
                blended[2] = blended[2] + m[2] * w;
                blended[3] = blended[3] + m[3] * w;
            }
        }
        let invW = 1.0 / totalWeight;
        let result = mat4x4f(
            blended[0] * invW,
            blended[1] * invW,
            blended[2] * invW,
            blended[3] * invW
        );
        if (isReasonablePaletteTransform(result)) {
            return result;
        }
    }
    #endif

    return identityMat4();
}

fn mat3ToQuatXYZW(R: mat3x3f) -> vec4f {
    var q: vec4f;
    let trace = R[0][0] + R[1][1] + R[2][2];
    if (trace > 0.0) {
        let s = sqrt(trace + 1.0) * 2.0;
        q.w = 0.25 * s;
        q.x = (R[1][2] - R[2][1]) / s;
        q.y = (R[2][0] - R[0][2]) / s;
        q.z = (R[0][1] - R[1][0]) / s;
    } else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
        let s = sqrt(1.0 + R[0][0] - R[1][1] - R[2][2]) * 2.0;
        q.w = (R[1][2] - R[2][1]) / s;
        q.x = 0.25 * s;
        q.y = (R[1][0] + R[0][1]) / s;
        q.z = (R[2][0] + R[0][2]) / s;
    } else if (R[1][1] > R[2][2]) {
        let s = sqrt(1.0 + R[1][1] - R[0][0] - R[2][2]) * 2.0;
        q.w = (R[2][0] - R[0][2]) / s;
        q.x = (R[1][0] + R[0][1]) / s;
        q.y = 0.25 * s;
        q.z = (R[2][1] + R[1][2]) / s;
    } else {
        let s = sqrt(1.0 + R[2][2] - R[0][0] - R[1][1]) * 2.0;
        q.w = (R[0][1] - R[1][0]) / s;
        q.x = (R[2][0] + R[0][2]) / s;
        q.y = (R[2][1] + R[1][2]) / s;
        q.z = 0.25 * s;
    }
    return q;
}

#if defined(USE_REVEAL) && defined(GSPLAT_CENTER_NOPROJ)
fn splatRevealDistance() -> f32 {
    #ifdef USE_BONE_BLENDING
    return textureLoad(splatRevealDistanceTex, splat.uv, 0).r;
    #else
    return 1.0;
    #endif
}

fn splatRevealX(reveal: f32) -> f32 {
    let front = mix(-uniform.uRevealBand.x, 1.0 + uniform.uRevealBand.x, reveal);
    return front - splatRevealDistance();
}

fn splatRevealHot(base: vec3f) -> vec3f {
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

fn splatRevealSketch(x: f32) -> f32 {
    let lead = uniform.uRevealSketch.x;
    if (x >= 0.0 || x < -lead) { return 0.0; }
    let rest = getCenter();
    let h = fract(sin(dot(rest, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
    if (h >= uniform.uRevealSketch.y) { return 0.0; }
    return smoothstep(-lead, -lead * 0.7, x);
}

// See GLSL twin: hard cutoff, hot band behind the edge, sketch dots ahead.
fn splatRevealApply(reveal: f32, inverse: bool, color: vec4f) -> vec4f {
    let x = splatRevealX(reveal);
    let bandWidth = uniform.uRevealBand.x;
    let base = clamp(color.rgb, vec3f(0.0), vec3f(1.0));
    let hot = splatRevealHot(base);
    if (inverse) {
        if (x < 0.0) { return color; }
        let band = 1.0 - smoothstep(0.0, bandWidth, x);
        return vec4f(mix(base, hot, band), band * 0.95);
    }
    if (x >= 0.0) {
        let band = 1.0 - smoothstep(bandWidth * uniform.uRevealBand.y, bandWidth, x);
        return vec4f(mix(base, hot, band), max(color.a, band * 0.95));
    }
    let sketch = splatRevealSketch(x);
    return vec4f(hot, sketch);
}

// See GLSL twin.
fn splatRevealPulse(front: f32, strength: f32, color: vec4f) -> vec4f {
    let x = abs(splatRevealX(front));
    let bandWidth = uniform.uRevealBand.x;
    if (x >= bandWidth) { return color; }
    let band = 1.0 - smoothstep(bandWidth * uniform.uRevealBand.y, bandWidth, x);
    let hot = splatRevealHot(clamp(color.rgb, vec3f(0.0), vec3f(1.0)));
    return vec4f(mix(color.rgb, hot, band * strength), color.a);
}
#endif

// GSPLAT_CENTER_NOPROJ gate - see GLSL version. Skip palette math on the
// render-pass call so skinning isn't applied twice.
fn modifySplatCenter(center: ptr<function, vec3f>) {
    #ifdef GSPLAT_CENTER_NOPROJ
    let palette = getSplatPaletteTransform();
    let modelCenter = getCenter();
    let modelDeformed = (palette * vec4f(modelCenter, 1.0)).xyz;
    *center = (uniform.matrix_model * vec4f(modelDeformed, 1.0)).xyz;
    #endif
}

// See GLSL version: paletteScale forced to (1,1,1) to prevent bone-scale
// drift from amplifying splat sigmas.
fn getBlendedSplatRotationScale(qOut: ptr<function, vec4f>, sOut: ptr<function, vec3f>) {
    *sOut = vec3f(1.0);
    #ifdef USE_BONE_BLENDING
    let palette = getSplatPaletteTransform();
    let lin = mat3x3f(palette[0].xyz, palette[1].xyz, palette[2].xyz);
    let s = vec3f(length(lin[0]), length(lin[1]), length(lin[2]));
    if (s.x > 1e-5 && s.y > 1e-5 && s.z > 1e-5) {
        let rot = mat3x3f(
            lin[0] / s.x,
            lin[1] / s.y,
            lin[2] / s.z
        );
        *qOut = mat3ToQuatXYZW(rot);
        return;
    }
    #endif
    *qOut = vec4f(0.0, 0.0, 0.0, 1.0);
}

fn modifySplatRotationScale(
    originalCenter: vec3f,
    modifiedCenter: vec3f,
    rotation: ptr<function, vec4f>,
    scale: ptr<function, vec3f>
) {
    #ifdef GSPLAT_CENTER_NOPROJ
    // See GLSL: compute world-skin rotation from matrix_model * palette
    // directly, avoid the model_rotation uniform (iOS WebGL2 refuses both
    // forward-decl and no-decl).
    let palette = getSplatPaletteTransform();
    let combined = uniform.matrix_model * palette;
    let lin = mat3x3f(combined[0].xyz, combined[1].xyz, combined[2].xyz);
    let s = vec3f(length(lin[0]), length(lin[1]), length(lin[2]));
    if (s.x > 1e-5 && s.y > 1e-5 && s.z > 1e-5) {
        let rot = mat3x3f(
            lin[0] / s.x,
            lin[1] / s.y,
            lin[2] / s.z
        );
        let worldSkinQuat = mat3ToQuatXYZW(rot);
        let srcRotation = getRotation().yzwx;
        var composed = vec4f(quatMul(half4(worldSkinQuat), half4(srcRotation)));
        composed = normalize(composed);
        if (composed.w < 0.0) {
            composed = -composed;
        }
        *rotation = composed;
    }
    #ifdef USE_NONRIGID_COV
    // Bone-length scaling: see GLSL twin - stretch covariance by palette scale.
    *scale = *scale * s;
    #endif

    #ifdef USE_VARIANT_MASK
    // Variant-mask cull. See GLSL twin.
    if (isSplatHiddenByVariantMask()) {
        *scale = vec3f(0.0);
    }
    #endif

    #ifdef USE_REVEAL
    // Reveal: small ahead of the front, squashed inside the band. See GLSL twin.
    let revealGrade = textureLoad(splatGradeTex, vec2i(0, 0), 0);
    if (revealGrade.a > 1.5) {
        // A pulse leaves the shape alone.
    } else if (revealGrade.a > 0.5) {
        let x = splatRevealX(revealGrade.b);
        if (x >= 0.0 && x < uniform.uRevealBand.x) {
            let m = min((*scale).x, min((*scale).y, (*scale).z));
            *scale = min(*scale, vec3f(m * uniform.uRevealBand.z));
        }
    } else if (revealGrade.b < 1.0) {
        let x = splatRevealX(revealGrade.b);
        if (x < 0.0) {
            *scale = *scale * uniform.uRevealSketch.z;
        } else if (x < uniform.uRevealBand.x) {
            let m = min((*scale).x, min((*scale).y, (*scale).z));
            *scale = min(*scale, vec3f(m * uniform.uRevealBand.z));
        }
    }
    #endif
    #endif
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    #ifdef GSPLAT_CENTER_NOPROJ
    let tintTex = textureLoad(splatTintTex, vec2i(0, 0), 0);
    let tintColor = tintTex.rgb;
    let tintAmt = clamp(tintTex.a, 0.0, 1.0);
    var rgb = mix((*color).rgb, tintColor, tintAmt);
    // Relight - see the GLSL twin for the ordering rationale. Written back
    // through the pointer so the debug paint's alpha override survives.
    (*color) = vec4f(rgb, (*color).a);
    applyRelight(center, color);
    rgb = (*color).rgb;
    // Color grade: identity (1,1) is a TRUE no-op - preserve HDR colours.
    let gradeTex = textureLoad(splatGradeTex, vec2i(0, 0), 0);
    if (gradeTex.r != 1.0 || gradeTex.g != 1.0) {
        rgb = (rgb - vec3f(0.5)) * gradeTex.r + vec3f(0.5);
        let luma = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
        rgb = mix(vec3f(luma), rgb, gradeTex.g);
        rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
    }
    (*color) = vec4f(rgb, (*color).a);
    #ifdef USE_REVEAL
    // Reveal front (gradeTex.b, 1 = identity). See Splat.setReveal.
    if (gradeTex.a > 1.5) {
        (*color) = splatRevealPulse(gradeTex.b, gradeTex.a - 2.0, *color);
    } else if (gradeTex.b < 1.0 || gradeTex.a > 0.5) {
        (*color) = splatRevealApply(gradeTex.b, gradeTex.a > 0.5, *color);
    }
    #endif
    // Opacity (texel 1). See Splat.setOpacity.
    (*color).a *= textureLoad(splatTintTex, vec2i(1, 0), 0).r;
    #endif
}
`;

// Environment variant: no palette, no bone blending, identity transforms.
// Colour is the baked capture, changed only by the relight chunk - which is
// what SplatRelight drives, down to "keep the capture's colours, darken only
// where a character blocks the light" at strength 0 and shadow strength 1.
//
// Clip bounds: when an environment's `clipBoundsMin` / `clipBoundsMax` is
// finite on any axis, splats whose world-space center falls outside that
// box are zero-scaled (collapsed to a point) so they don't contribute any
// pixels. Defaults are ±BIG (~1e9) which means "no clipping" in practice
// - using ±Infinity would propagate as NaN through the matrix multiplies.
const ENV_WORK_BUFFER_MODIFIER_GLSL = /* glsl */ `
// rev: ${SHADER_REV}
${relightChunkGLSL}

// No forward-decl needed in the env modifier - matrix_model is already
// declared by gsplatCenterVS (included before this chunk), and the env
// modifier doesn't reference model_rotation / model_scale.

uniform vec3 uEnvClipMin;
uniform vec3 uEnvClipMax;

// Radial clip band, squared. A splat whose center is nearer than
// sqrt(uEnvClipDistMinSq), or at or beyond sqrt(uEnvClipDistMaxSq), from
// uEnvClipDistOrigin is collapsed to zero scale - the radial twin of the
// uEnvClipMin/Max box, for the shells a box cannot describe (see
// Environment.setClipDistance). Half-open [min, max) so successive bands
// tile without drawing a seam twice. Neutral defaults (0, 1e18) keep
// every splat.
uniform float uEnvClipDistMinSq;
uniform float uEnvClipDistMaxSq;
uniform vec3 uEnvClipDistOrigin;

// Size cap: each splat axis (in the splat file's own units) is clamped to
// uEnvSplatSizeMax (see Environment.setSplatSizeMax). The 1e9 sentinel leaves
// every splat alone.
uniform float uEnvSplatSizeMax;

// Camera occlusion cutaway. Splats nearer to the camera than uCamCullMaxT
// along uCamCullDir AND above the uCamCullFloorY gate are faded to zero
// scale, so walls between the camera and the characters vanish while the
// floor stays. Neutral when uCamCullMaxT is the -1e9 sentinel: the along-
// view smoothstep then saturates to "keep" for every real-world position.
// uCamCullFade = (along-view band, floor-gate band) in metres; the caller
// clamps both to >= 1e-3 (smoothstep with edge0 == edge1 is undefined).
uniform vec3 uCamCullPos;
uniform vec3 uCamCullDir;
uniform float uCamCullMaxT;
uniform float uCamCullFloorY;
uniform vec2 uCamCullFade;

// Tint - the env twin of the character's splatTintTex, and the same blend:
// mix(colour, tint.rgb, tint.a), so a=0 leaves the capture alone whatever
// sits in rgb. A UNIFORM rather than the character's 1x1 texture, because the
// value is one global number either way and a sampler is not free here: every
// sampler a work-buffer shader declares must be bound on every draw under
// WebGPU, and this chunk compiles into every scene whether or not it ever
// tints. See Environment.setTint.
uniform vec4 uEnvTint;

// Reveal - opted into per-Environment on first use (Environment.prepareReveal
// / setReveal), so a scene that never reveals compiles none of it and
// allocates no distance texture. uEnvReveal is the front's position, 1 =
// fully revealed; uEnvRevealInverse (>0.5) reads that same front the other
// way round, for the capture a replacement is dissolving. The look uniforms
// carry the same packing as the character's (see RevealLook / packRevealLook).
#ifdef USE_REVEAL
uniform highp sampler2D splatRevealDistanceTex;
uniform float uEnvReveal;
uniform float uEnvRevealInverse;
uniform vec4 uRevealBand;
uniform vec4 uRevealSketch;
uniform vec4 uRevealTint;
#endif

// Gated on GSPLAT_CENTER_NOPROJ for the reason the character's twin is: PC
// calls these modifiers in the copy-to-work-buffer pass AND again in the
// render pass, and the reveal's scale work is a min/multiply, so letting it
// run twice would shrink the sketch dots twice over. The clip and cutaway
// above it are idempotent, which is why they are not gated.
#if defined(USE_REVEAL) && defined(GSPLAT_CENTER_NOPROJ)
// Per-splat radial distance from the capture point, 0 at it and 1 at the
// room's outer shell. Baked by bakeEnvRevealDistances; 1 until it has run,
// which keeps an unbaked scene hidden rather than showing garbage.
float splatRevealDistance() {
    return texelFetch(splatRevealDistanceTex, splat.uv, 0).r;
}

// Signed distance behind the moving front.
float splatRevealX(float reveal) {
    float front = mix(-uRevealBand.x, 1.0 + uRevealBand.x, reveal);
    return front - splatRevealDistance();
}

// Bright edge colour derived from the splat's own colour. Character twin.
vec3 splatRevealHot(vec3 base) {
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

// Stable sparse dots just ahead of the front. Hashed off the rest position so
// a splat is a dot or is not for the whole sweep, rather than flickering.
float splatRevealSketch(float x) {
    float lead = uRevealSketch.x;
    if (x >= 0.0 || x < -lead) return 0.0;
    vec3 rest = getCenter();
    float h = fract(sin(dot(rest, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    // >=: the hash can be exactly 0, and density 0 must still draw nothing.
    if (h >= uRevealSketch.y) return 0.0;
    return smoothstep(-lead, -lead * 0.7, x);
}

// Whether the reveal has anything to say this frame. The INVERSE pass is
// active at every amount, including 1: a dissolve that has finished has to
// render as nothing, where a forward sweep that has finished renders as
// itself.
bool envRevealInverse() { return uEnvRevealInverse > 0.5; }
bool envRevealActive() { return uEnvReveal < 1.0 || envRevealInverse(); }

// Hard cutoff, hot band behind the front, sketch dots ahead.
//
// The INVERSE pass is the same front read the other way round: ahead of it
// the capture is untouched, behind it the band fades the splat out and then
// it is gone. That is what makes a scene gaining a new version ONE effect
// instead of two - the replaced capture dissolves on the replacement's clock
// and against the replacement's front, exactly as an outgoing character does
// (see the character twin's inverse flag). Both fronts are a NORMALISED
// radius of the same room, so the two tile it: inside the front only the new
// version draws, outside it only the old one, and the reader never sees the
// place leave before it arrives.
void splatRevealApply(float reveal, bool inverse, inout vec4 color) {
    float x = splatRevealX(reveal);
    float bandWidth = uRevealBand.x;
    vec3 base = clamp(color.rgb, 0.0, 1.0);
    vec3 hot = splatRevealHot(base);
    if (inverse) {
        if (x < 0.0) return;
        float band = 1.0 - smoothstep(0.0, bandWidth, x);
        color.rgb = mix(base, hot, band);
        color.a = band * 0.95;
        return;
    }
    if (x >= 0.0) {
        float band = 1.0 - smoothstep(bandWidth * uRevealBand.y, bandWidth, x);
        color.rgb = mix(base, hot, band);
        color.a = max(color.a, band * 0.95);
    } else {
        float sketch = splatRevealSketch(x);
        color.rgb = hot;
        color.a = sketch;
    }
}
#endif

void modifySplatCenter(inout vec3 center) {
    #ifdef GSPLAT_CENTER_NOPROJ
    vec3 modelCenter = getCenter();
    center = (matrix_model * vec4(modelCenter, 1.0)).xyz;
    #endif
}

void modifySplatRotationScale(
    vec3 originalCenter,
    vec3 modifiedCenter,
    inout vec4 rotation,
    inout vec3 scale
) {
    scale = min(scale, vec3(uEnvSplatSizeMax));
    if (any(lessThan(modifiedCenter, uEnvClipMin)) ||
        any(greaterThan(modifiedCenter, uEnvClipMax))) {
        scale = vec3(0.0);
    }
    vec3 clipDistDelta = modifiedCenter - uEnvClipDistOrigin;
    float clipDistSq = dot(clipDistDelta, clipDistDelta);
    if (clipDistSq < uEnvClipDistMinSq || clipDistSq >= uEnvClipDistMaxSq) {
        scale = vec3(0.0);
    }
    float t = dot(modifiedCenter - uCamCullPos, uCamCullDir);
    float along = 1.0 - smoothstep(uCamCullMaxT - uCamCullFade.x, uCamCullMaxT, t);
    float above = smoothstep(uCamCullFloorY, uCamCullFloorY + uCamCullFade.y, modifiedCenter.y);
    scale *= 1.0 - along * above;

    #if defined(USE_REVEAL) && defined(GSPLAT_CENTER_NOPROJ)
    // Reveal: ahead of the front draws small (only the sparse sketch subset
    // has alpha out there, see splatRevealApply); inside the band, elongated
    // splats are squashed so the front stays a stroke rather than sparks.
    // The inverse pass only squashes: AHEAD of its front the capture it is
    // dissolving is untouched, so nothing may shrink it there.
    if (envRevealActive()) {
        float revealX = splatRevealX(uEnvReveal);
        bool inBand = revealX >= 0.0 && revealX < uRevealBand.x;
        if (envRevealInverse()) {
            if (inBand) {
                float m = min(scale.x, min(scale.y, scale.z));
                scale = min(scale, vec3(m * uRevealBand.z));
            }
        } else if (revealX < 0.0) {
            scale *= uRevealSketch.z;
        } else if (inBand) {
            float m = min(scale.x, min(scale.y, scale.z));
            scale = min(scale, vec3(m * uRevealBand.z));
        }
    }
    #endif
}

void modifySplatColor(vec3 center, inout vec4 color) {
    #ifdef GSPLAT_CENTER_NOPROJ
    // Tint, then light the tinted colour, then the reveal on top - the
    // character's order, so the two subjects answer a selection the same way.
    color.rgb = mix(color.rgb, uEnvTint.rgb, clamp(uEnvTint.a, 0.0, 1.0));
    applyRelight(center, color);
    #ifdef USE_REVEAL
    if (envRevealActive()) {
        splatRevealApply(uEnvReveal, envRevealInverse(), color);
    }
    #endif
    #endif
}
`;

const ENV_WORK_BUFFER_MODIFIER_WGSL = /* wgsl */ `
// rev: ${SHADER_REV}
${relightChunkWGSL}

uniform uEnvClipMin: vec3f;
uniform uEnvClipMax: vec3f;

// Radial clip band - see the GLSL variant for the full contract.
uniform uEnvClipDistMinSq: f32;
uniform uEnvClipDistMaxSq: f32;
uniform uEnvClipDistOrigin: vec3f;

// Size cap - see the GLSL variant.
uniform uEnvSplatSizeMax: f32;

// Camera occlusion cutaway - see the GLSL variant for the full contract.
uniform uCamCullPos: vec3f;
uniform uCamCullDir: vec3f;
uniform uCamCullMaxT: f32;
uniform uCamCullFloorY: f32;
uniform uCamCullFade: vec2f;

// Tint - see the GLSL variant for why this is a uniform and not a texture.
uniform uEnvTint: vec4f;

// Reveal - see the GLSL twin.
#ifdef USE_REVEAL
var splatRevealDistanceTex: texture_2d<f32>;
uniform uEnvReveal: f32;
uniform uEnvRevealInverse: f32;
uniform uRevealBand: vec4f;
uniform uRevealSketch: vec4f;
uniform uRevealTint: vec4f;
#endif

#if defined(USE_REVEAL) && defined(GSPLAT_CENTER_NOPROJ)
fn splatRevealDistance() -> f32 {
    return textureLoad(splatRevealDistanceTex, splat.uv, 0).r;
}

fn splatRevealX(reveal: f32) -> f32 {
    let front = mix(-uniform.uRevealBand.x, 1.0 + uniform.uRevealBand.x, reveal);
    return front - splatRevealDistance();
}

fn splatRevealHot(base: vec3f) -> vec3f {
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

fn splatRevealSketch(x: f32) -> f32 {
    let lead = uniform.uRevealSketch.x;
    if (x >= 0.0 || x < -lead) { return 0.0; }
    let rest = getCenter();
    let h = fract(sin(dot(rest, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
    if (h >= uniform.uRevealSketch.y) { return 0.0; }
    return smoothstep(-lead, -lead * 0.7, x);
}

// See the GLSL twin.
fn envRevealInverse() -> bool { return uniform.uEnvRevealInverse > 0.5; }
fn envRevealActive() -> bool { return uniform.uEnvReveal < 1.0 || envRevealInverse(); }

// See the GLSL twin: hot band behind the front, sketch dots ahead, and an
// inverse pass that dissolves the capture a replacement is taking over from,
// on the replacement's own front.
fn splatRevealApply(reveal: f32, inverse: bool, color: vec4f) -> vec4f {
    let x = splatRevealX(reveal);
    let bandWidth = uniform.uRevealBand.x;
    let base = clamp(color.rgb, vec3f(0.0), vec3f(1.0));
    let hot = splatRevealHot(base);
    if (inverse) {
        if (x < 0.0) { return color; }
        let band = 1.0 - smoothstep(0.0, bandWidth, x);
        return vec4f(mix(base, hot, band), band * 0.95);
    }
    if (x >= 0.0) {
        let band = 1.0 - smoothstep(bandWidth * uniform.uRevealBand.y, bandWidth, x);
        return vec4f(mix(base, hot, band), max(color.a, band * 0.95));
    }
    let sketch = splatRevealSketch(x);
    return vec4f(hot, sketch);
}
#endif

fn modifySplatCenter(center: ptr<function, vec3f>) {
    #ifdef GSPLAT_CENTER_NOPROJ
    let modelCenter = getCenter();
    *center = (uniform.matrix_model * vec4f(modelCenter, 1.0)).xyz;
    #endif
}

fn modifySplatRotationScale(
    originalCenter: vec3f,
    modifiedCenter: vec3f,
    rotation: ptr<function, vec4f>,
    scale: ptr<function, vec3f>
) {
    *scale = min(*scale, vec3f(uniform.uEnvSplatSizeMax));
    let mn = uniform.uEnvClipMin;
    let mx = uniform.uEnvClipMax;
    if (modifiedCenter.x < mn.x || modifiedCenter.y < mn.y || modifiedCenter.z < mn.z
     || modifiedCenter.x > mx.x || modifiedCenter.y > mx.y || modifiedCenter.z > mx.z) {
        *scale = vec3f(0.0);
    }
    let clipDistDelta = modifiedCenter - uniform.uEnvClipDistOrigin;
    let clipDistSq = dot(clipDistDelta, clipDistDelta);
    if (clipDistSq < uniform.uEnvClipDistMinSq || clipDistSq >= uniform.uEnvClipDistMaxSq) {
        *scale = vec3f(0.0);
    }
    let t = dot(modifiedCenter - uniform.uCamCullPos, uniform.uCamCullDir);
    let along = 1.0 - smoothstep(uniform.uCamCullMaxT - uniform.uCamCullFade.x, uniform.uCamCullMaxT, t);
    let above = smoothstep(uniform.uCamCullFloorY, uniform.uCamCullFloorY + uniform.uCamCullFade.y, modifiedCenter.y);
    *scale = (*scale) * (1.0 - along * above);

    #if defined(USE_REVEAL) && defined(GSPLAT_CENTER_NOPROJ)
    // Reveal: small ahead of the front, squashed inside the band, and the
    // inverse pass squashing only inside it. GLSL twin.
    if (envRevealActive()) {
        let revealX = splatRevealX(uniform.uEnvReveal);
        let inBand = revealX >= 0.0 && revealX < uniform.uRevealBand.x;
        if (envRevealInverse()) {
            if (inBand) {
                let m = min((*scale).x, min((*scale).y, (*scale).z));
                *scale = min(*scale, vec3f(m * uniform.uRevealBand.z));
            }
        } else if (revealX < 0.0) {
            *scale = *scale * uniform.uRevealSketch.z;
        } else if (inBand) {
            let m = min((*scale).x, min((*scale).y, (*scale).z));
            *scale = min(*scale, vec3f(m * uniform.uRevealBand.z));
        }
    }
    #endif
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    #ifdef GSPLAT_CENTER_NOPROJ
    // Tint, relight, reveal - see the GLSL twin for the ordering.
    var tinted = mix((*color).rgb, uniform.uEnvTint.rgb, clamp(uniform.uEnvTint.a, 0.0, 1.0));
    (*color) = vec4f(tinted, (*color).a);
    applyRelight(center, color);
    #ifdef USE_REVEAL
    if (envRevealActive()) {
        (*color) = splatRevealApply(uniform.uEnvReveal, envRevealInverse(), *color);
    }
    #endif
    #endif
}
`;

export {
  WORK_BUFFER_MODIFIER_GLSL,
  WORK_BUFFER_MODIFIER_WGSL,
  ENV_WORK_BUFFER_MODIFIER_GLSL,
  ENV_WORK_BUFFER_MODIFIER_WGSL,
};
