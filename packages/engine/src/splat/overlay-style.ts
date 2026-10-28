import { SHADERLANGUAGE_GLSL, SHADERLANGUAGE_WGSL } from 'playcanvas';
import type { AppBase, CameraComponent, Layer, ShaderMaterial } from 'playcanvas';

import type { Scene } from '../scene';

/**
 * How the overlay layer's splats read where they paint over the scene.
 *  - `ghost`: a fine 4×4 ordered dither keeping `alpha` of the pixels -
 *    the body shows through, faded.
 *  - `screendoor`: one 2px cell in four of the cloud at full alpha - a
 *    quarter of the pixels, the game vernacular for "behind".
 */
export interface OverlaySplatStyle {
  mode: 'ghost' | 'screendoor';
  /** Ghost only: fraction of pixels kept, 0-1. */
  alpha: number;
}

// Ghost is an ordered dither, not an alpha multiply: the cloud stacks many
// splats deep, so per-fragment alpha compounds toward opaque (or, set low
// enough to read, drops thin limbs first). Keeping a fixed fraction of the
// pixels through a 4×4 Bayer threshold composites right at any depth and
// reads as translucency at device pixel ratios ≥ 2.
//
// uOverlayMode: 0 off (every other splat layer), 1 ghost, 2 screen-door.
const GLSL_MODIFY = `
uniform float uOverlayMode;
uniform float uOverlayAlpha;
void modifySplatColor(vec2 gaussianUV, inout vec4 color) {
    if (uOverlayMode < 0.5) return;
    vec2 fc = floor(gl_FragCoord.xy);
    if (uOverlayMode > 1.5) {
        // Screen-door: keep one 2px cell in four (both cell coords even).
        vec2 cell = floor(fc * 0.5);
        if (mod(cell.x, 2.0) > 0.5 || mod(cell.y, 2.0) > 0.5) discard;
    } else {
        // Ghost: 4×4 Bayer, keep the fraction uOverlayAlpha.
        float b2 = fract(fc.x * 0.5 + fc.y * fc.y * 0.75);
        vec2 h = floor(fc * 0.5);
        float b4 = fract(h.x * 0.5 + h.y * h.y * 0.75) * 0.25 + b2;
        if (b4 >= uOverlayAlpha) discard;
    }
}
`;
const WGSL_MODIFY = `
uniform uOverlayMode: f32;
uniform uOverlayAlpha: f32;
fn modifySplatColor(gaussianUV: vec2f, color: ptr<function, vec4f>) {
    if (uniform.uOverlayMode < 0.5) { return; }
    let fc = floor(pcPosition.xy);
    if (uniform.uOverlayMode > 1.5) {
        let cell = floor(fc * 0.5);
        if ((cell.x % 2.0) > 0.5 || (cell.y % 2.0) > 0.5) { discard; }
    } else {
        let b2 = fract(fc.x * 0.5 + fc.y * fc.y * 0.75);
        let h = floor(fc * 0.5);
        let b4 = fract(h.x * 0.5 + h.y * h.y * 0.75) * 0.25 + b2;
        if (b4 >= uniform.uOverlayAlpha) { discard; }
    }
}
`;

/**
 * Put the see-through hook on `app.scene.gsplat.material`. PC
 * copies it, with uOverlayMode 0, into every layer's gsplat material, so it is
 * a no-op except where {@link applyOverlaySplatStyle} sets the mode. Call it
 * before splats load: changing the source chunks later recompiles every gsplat
 * material in the scene.
 */
export function installOverlaySplatHook(app: AppBase): void {
  const source = app.scene.gsplat.material as ShaderMaterial;
  source.getShaderChunks(SHADERLANGUAGE_GLSL).set('gsplatModifyPS', GLSL_MODIFY);
  source.getShaderChunks(SHADERLANGUAGE_WGSL).set('gsplatModifyPS', WGSL_MODIFY);
  source.setParameter('uOverlayMode', 0);
  source.setParameter('uOverlayAlpha', 1);
  source.update();
}

/**
 * Drive the see-through fragment style on the scene's overlay layer. The
 * overlay layer's mode is set on `prerender:layer`: after PC's per-frame gsplat
 * update (where the source material is copied into each layer's) and before
 * the draw, so the first frame of a new material is styled too. Returns a
 * disposer.
 */
export function applyOverlaySplatStyle(scene: Scene, getStyle: () => OverlaySplatStyle): () => void {
  const overlayLayer = scene.app.scene.layers.getLayerById(scene.overlayLayerId);

  const onPrerenderLayer = (camera: CameraComponent, layer: Layer) => {
    if (layer !== overlayLayer) return;
    const layerData = scene.app.renderer?.gsplatDirector?.camerasMap?.get(camera.camera)?.layersMap?.get(layer);
    const material = layerData?.gsplatManager?.material;
    if (!material) return;
    const style = getStyle();
    material.setParameter('uOverlayMode', style.mode === 'screendoor' ? 2 : 1);
    material.setParameter('uOverlayAlpha', style.mode === 'screendoor' ? 1 : style.alpha);
  };
  scene.app.scene.on('prerender:layer', onPrerenderLayer);
  return () => { scene.app.scene.off('prerender:layer', onPrerenderLayer); };
}
