import {
  BLENDEQUATION_ADD,
  BLENDMODE_ONE,
  BLENDMODE_ZERO,
  BlendState,
  Color,
  CULLFACE_BACK,
  FUNC_ALWAYS,
  StandardMaterial,
} from 'playcanvas';
import type { GraphicsDevice, Material } from 'playcanvas';

/**
 * Flat-white mark material for the outline effect.
 *
 * Previous revision used a custom `ShaderMaterial` with hand-written
 * GLSL/WGSL. On PC 2.18 the ShaderMaterial template pipeline injected
 * literal `undefined` into the compiled fragment output
 * (`ERROR: 0:57: 'undefined' : syntax error`)
 * which left every tagged mesh rendering as a black silhouette. The
 * fix is to stop bypassing PC's shader generator and just use a
 * `StandardMaterial` configured for unlit emissive - PC's built-in
 * forward pass compiles cleanly and emits `material_emissive`
 * per-pixel, which is exactly the flat-white we need.
 *
 * Setup:
 *   - emissive = white (1,1,1), so the forward-pass fragment output
 *     is emissive-only white (no diffuse because useLighting=false
 *     disables the lit path).
 *   - useLighting = false → no sky/ambient/point-light terms.
 *   - depthTest off, depthWrite off, FUNC_ALWAYS - outline is xray,
 *     renders wherever the mesh covers regardless of scene occlusion
 *     within the mask RT.
 *   - blendless overwrite.
 *
 * Cached per GraphicsDevice.
 */
const _cache = new WeakMap<GraphicsDevice, Material>();

export function getOutlineMarkMaterial(device: GraphicsDevice): Material {
  const existing = _cache.get(device);
  if (existing) return existing;

  const mat = new StandardMaterial();
  mat.name = 'outline-mark-v4';
  mat.useLighting = false;
  mat.emissive = new Color(1, 1, 1);
  mat.diffuse = new Color(0, 0, 0);

  // Opaque overwrite - no blending, no tone-mapped surprises.
  mat.blendState = new BlendState(
    /* blend */ false,
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ZERO,
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ZERO,
  );

  // Depth - xray. Outline ignores scene occlusion.
  mat.depthTest = false;
  mat.depthFunc = FUNC_ALWAYS;
  mat.depthWrite = false;

  mat.cull = CULLFACE_BACK;
  mat.update();

  _cache.set(device, mat);
  return mat;
}
