/**
 * VFX runtime primitives - pool/stage abstractions plus the data-driven
 * JSON prefab system that interprets {@link VfxEffectData} layers.
 *
 * Two ways to drive an effect, both built on the same {@link IVfxPrefab} /
 * {@link IVfxInstance} contract:
 *
 *  - **Gameplay (pool-backed, fire-and-forget):** register a prefab once with
 *    {@link VfxStage.register}, then trigger one-shots by name with
 *    {@link VfxStage.play}. The pool reuses entity slots once an effect finishes.
 *  - **Editor / cutscene (handle-controlled):** build a prefab from JSON via
 *    {@link VfxStage.buildPrefab}, instantiate one with {@link VfxStage.spawn},
 *    then drive it yourself.
 *
 * Layer types are plug-ins. The engine ships three generic renderers
 * (`particle`, `mesh`, `sprite`); consumers add stylized renderers (cloud,
 * shield, …) by extending {@link VfxLayerRegistry} and merging their layer
 * data interfaces into {@link VfxLayerTypeMap}.
 *
 * @group Effects
 * @category Vfx
 */

export { VfxPool } from './pool';
export type { VfxSpawnOptions } from './pool';
export { VfxStage } from './stage';
export type { VfxStageOptions } from './stage';
export type { IVfxPrefab, IVfxInstance } from './prefab';

// Data-driven prefab system (the production VFX runtime).
export { JsonVfxPrefab, JsonVfxInstance } from './json-vfx-prefab';
export { prewarmJsonVfxPrefabs } from './prewarm';

// Plug-in renderer surface
export {
  VfxLayerRegistry,
  defaultLayerRegistry,
} from './layer-renderer';
export type {
  VfxLayerRenderer,
  VfxLayerInstance,
  VfxLayerBuildContext,
  VfxLayerUpdateContext,
} from './layer-renderer';

// Shared layer data types (curves, VfxLayerBase, effect, trail, …)
export * from './data-types';

// Generic layer renderers + their layer types (engine ships these).
export { ParticleLayerRenderer } from './layers/particle';
export type { VfxParticleLayer } from './layers/particle';
export {
  MeshLayerRenderer,
  getVfxMesh,
  buildVfxSphereMesh,
  buildVfxRingMesh,
  buildVfxSpikeMesh,
  buildVfxQuadMesh,
} from './layers/mesh';
export type {
  VfxMeshLayer,
  MeshShape,
  InstancePattern,
  VfxMeshInstancing,
  VfxSinPulse,
} from './layers/mesh';
export { SpriteLayerRenderer } from './layers/sprite';
export type { VfxSpriteLayer } from './layers/sprite';
export {
  ShaderLayerRenderer,
  validateShaderGLSL,
  DEFAULT_SHADER_FRAGMENT,
} from './layers/shader';
export type {
  VfxShaderLayer,
  VfxShaderUniform,
  VfxShaderGeometry,
} from './layers/shader';
