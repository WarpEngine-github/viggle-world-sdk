import type { GraphicsDevice } from 'playcanvas';
import { ShaderChunks, SHADERLANGUAGE_GLSL, SHADERLANGUAGE_WGSL } from 'playcanvas';

/*
 * PlayCanvas skips the behind-the-camera cull for orthographic cameras ("frustum
 * culling handles it"), then clamps every splat's depth into the frustum, so
 * nothing is ever near-clipped: a splat behind an ortho camera draws in front
 * of everything. This culls ortho splats nearer than the near plane instead.
 * A negative near (the orbit's ortho default) still keeps what lies behind the lens.
 */
const GLSL_OUT = 'camera_params.w != 1.0 && centerView.z > 0.0';
const GLSL_PATCH = '(camera_params.w != 1.0 ? centerView.z > 0.0 : -centerView.z < camera_params.z)';
const WGSL_OUT = 'uniform.camera_params.w != 1.0 && centerView.z > 0.0';
const WGSL_PATCH = 'select(-centerView.z < uniform.camera_params.z, centerView.z > 0.0, uniform.camera_params.w != 1.0)';

/** Patch the device's splat centre chunk: after the app inits, before any splat shader compiles. */
export function installOrthoNearCull(device: GraphicsDevice): void {
  const patches = [
    [SHADERLANGUAGE_GLSL, GLSL_OUT, GLSL_PATCH],
    [SHADERLANGUAGE_WGSL, WGSL_OUT, WGSL_PATCH],
  ] as const;
  for (const [lang, out, patch] of patches) {
    const chunks = ShaderChunks.get(device, lang);
    const src = chunks.get('gsplatCenterVS') as string | undefined;
    if (!src?.includes(out)) {
      // eslint-disable-next-line no-console -- chunk missing (called before GSplatComponentSystem) or moved upstream
      console.warn(`[SplatEngine] ortho near cull not installed (${lang})`);
      continue;
    }
    chunks.set('gsplatCenterVS', src.replace(out, patch));
  }
}
