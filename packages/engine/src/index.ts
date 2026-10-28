// ── Core scene + content (primitives - engine-stable surface) ──────────────
export { Scene, SceneDestroyedError } from './scene';
export type { CreateSceneOptions, RenderBackend } from './scene';
export { Character } from './character';
export type { LoadCharacterOptions } from './character';
// Body-part classifier - used by the DamageVariant preset, exported as a
// primitive so games can build their own per-region splat systems on the
// same bone-name patterns.
export {
  BodyPart,
  NUM_BODY_PARTS,
  ALL_BODY_PARTS,
  bodyPartLabel,
  classifyBone,
  buildBoneToGroup,
} from './skeletal/body-parts';
export { Animation } from './animation';
export type { AnimationEvent } from './animation';
export type { AnimEventCallback, CrossfadeOptions } from './skeletal/animation-player';
export { Pose } from './skeletal/pose';
export { Armature } from './armature';
export { MeshCharacter } from './mesh-character';
export type { MeshOverlay, MeshOverlayLook } from './mesh-character';
export type { PoseModifier, PoseProvider, RootMotionMode, RootOffsetProvider } from './armature';
export {
  UPPER_BODY_BONE_NAMES,
  LOWER_BODY_BONE_NAMES,
  resolveBoneIndices,
  makeRegionMask,
} from './skeletal/bone-mask';
export type { BoneMask, BodyRegion } from './skeletal/bone-mask';
export { Splat } from './splat/splat';
export { applyOverlaySplatStyle } from './splat/overlay-style';
export type { OverlaySplatStyle } from './splat/overlay-style';
export { DEFAULT_REVEAL_LOOK, DEFAULT_ENV_REVEAL_LOOK } from './splat/reveal-look';
export type { RevealLook } from './splat/reveal-look';
export type { RevealSkeleton } from './splat/reveal-bake';
// Default work-buffer modifier sources (palette + bone-blend + tint + relight + grade).
// Exported so games can compose custom GLSL/WGSL on top of the defaults
// (e.g. character scan-print, dissolve effects) without re-implementing
// the skinning/relight math.
export {
  WORK_BUFFER_MODIFIER_GLSL,
  WORK_BUFFER_MODIFIER_WGSL,
  ENV_WORK_BUFFER_MODIFIER_GLSL,
  ENV_WORK_BUFFER_MODIFIER_WGSL,
} from './splat/splat-shader';
export { loadSplatAsset, loadBinaryAsset, loadVsplatAsset } from './loader/shared/asset-loader';
export { warmCharacterDecoder, loadBinaryGsplat } from './loader/character/binary-gsplat';
export { setAssetFetch } from './loader/shared/asset-fetch';
export type { AssetFetch } from './loader/shared/asset-fetch';
export type { AssetSource } from './loader/shared/asset-source';
export type { LoadResult } from './loader/shared/asset-loader';
export { scanSplatOpacity, loadSplatPositions } from './loader/environment/opacity-scan';
export type { SplatOpacityStats } from './loader/environment/opacity-scan';
export { Environment } from './loader/environment';
export type {
  LoadEnvironmentOptions,
  LoadLodBundleOptions,
  EnvCameraCullParams,
  WorldPointSample,
} from './loader/environment';
export type { ArmatureData, BinaryGsplatResult, SplatWeights, SkeletonLibrary } from './types';

// ── Physics (primitives - only available when the scene opts into Ammo) ────
export { createConeTwistJoint, createHingeJoint, createGeneric6DofJoint } from './physics/joints';
export type {
  JointHandle,
  ConeTwistJointOptions,
  HingeJointOptions,
  Generic6DofJointOptions,
} from './physics/joints';

// ── Ragdoll (physics-driven pose; requires scene-level physics opt-in) ─────
export { Ragdoll } from './skeletal/ragdoll';
export type { LimbDetachedInfo } from './skeletal/ragdoll';
export { DEFAULT_HUMANOID_RAGDOLL } from './skeletal/ragdoll-config';
export type {
  RagdollConfig,
  RagdollBoneDesc,
  RagdollJointDesc,
} from './skeletal/ragdoll-config';

// ── Relight (component - voxelized proxy mesh lit by PlayCanvas, sampled by splats) ─
export { ENVIRONMENT_DEFAULT_LOD, ENVIRONMENT_PROXY_DEFAULTS, SplatRelight } from './relight/splat-relight';
export type {
  RelightLightOptions,
  RelightPointLightOptions,
  RelightPreviewMode,
  RelightProxySettings,
  RelightProxySource,
  RelightTarget,
  RelightTargetOptions,
  RelightTargetParams,
  SplatRelightOptions,
} from './relight/splat-relight';
export type { EnvironmentRefreshMode } from './relight/relight-pass';

// ── Outlines (primitive - per-object silhouette post-process) ──────────────
export { OutlineEffect } from './effects/outlines';
export type {
  OutlineAddOptions,
  OutlineEffectOptions,
} from './effects/outlines';

// ── Pixel-art (primitive - full-scene low-res RT + nearest upscale) ────────
export { PixelartEffect } from './effects/pixelart';
export type { PixelartEffectOptions } from './effects/pixelart';

// ── Stained glass (Voronoi-cellular variant of pixel-art) ───────────────────
export { StainedGlassEffect } from './effects/stainedglass';
export type { StainedGlassEffectOptions } from './effects/stainedglass';

// ── PostFX pipeline (host for multiple effects coexisting with CameraFrame) ─
export { PostFX, BaseCapturingPass } from './effects/postfx';
export type {
  PostFXPass,
  PostFXFrameConfig,
  PostFXInstallContext,
  BaseCapturingPassOptions,
} from './effects/postfx';

// ── CRT (capturing - barrel + scanlines + chromatic aberration) ──────────────
export { CRTEffect, CRT_FRAGMENT_GLSL, CRT_FRAGMENT_WGSL } from './effects/crt';
export type { CRTEffectOptions } from './effects/crt';

// ── VFX (primitives - pool/stage + JSON data runtime + plug-in renderers) ─
export {
  VfxPool,
  VfxStage,
  JsonVfxPrefab,
  prewarmJsonVfxPrefabs,
  VfxLayerRegistry,
  defaultLayerRegistry,
  ParticleLayerRenderer,
  MeshLayerRenderer,
  SpriteLayerRenderer,
  ShaderLayerRenderer,
  validateShaderGLSL,
  DEFAULT_SHADER_FRAGMENT,
  getVfxMesh,
  buildVfxSphereMesh,
  buildVfxRingMesh,
  buildVfxSpikeMesh,
  buildVfxQuadMesh,
} from './effects/vfx';
export type {
  IVfxPrefab,
  IVfxInstance,
  VfxSpawnOptions,
  VfxStageOptions,
  JsonVfxInstance,
  VfxLayerRenderer,
  VfxLayerInstance,
  VfxLayerBuildContext,
  VfxLayerUpdateContext,
} from './effects/vfx';
export type {
  VfxEffectData,
  VfxDataFile,
  VfxLayer,
  VfxLayerBase,
  VfxLayerTypeMap,
  VfxParticleLayer,
  VfxMeshLayer,
  VfxSpriteLayer,
  VfxShaderLayer,
  VfxShaderUniform,
  VfxShaderGeometry,
  VfxTrailConfig,
  VfxMeshInstancing,
  VfxSinPulse,
  MeshShape,
  InstancePattern,
  CurvePoint,
  ColorCurvePoint,
} from './effects/vfx';

// ── Proxy mesh (pure - splats in, a closed triangle surface out) ───────────
export {
  buildProxyMesh,
  buildVoxelGrid,
  extractSurface,
  defaultProxySettings,
  alphaFromLogits,
} from './proxy/voxelizer';
export type {
  ProxyMeshInput,
  ProxyMeshResult,
  ProxySettings,
  ProxySurfaceStyle,
  ProxyGridVec,
  VoxelGrid,
  VoxelGridSettings,
  SurfaceSettings,
  BoneIndexArray,
} from './proxy/voxelizer';

// ── Scene collider (walkable collider voxelized from an environment's splats) ─
// `buildSceneCollider` is the whole feature: it samples, filters by opacity,
// crops to the walkable band, voxelizes in a worker, and hands back a grid with
// synchronous queries on it. Consumers configure and call; nothing about the
// algorithm lives outside the engine.
export { buildSceneCollider, environmentColliderFrame } from './collider/environment-collider';
export type { BuildSceneColliderOptions } from './collider/environment-collider';
export {
  SceneCollider,
  capsuleForWalker,
  minStepLimit,
  GROUND_STEP_VOXELS,
  DEFAULT_SURFACE_SMOOTHING,
} from './collider/scene-collider';
export type {
  WalkerCapsule,
  ColliderOverlay,
  ColliderOverlayFaces,
  ColliderOverlayOptions,
  ColliderFrameSource,
} from './collider/scene-collider';
export {
  buildColliderData,
  clampColliderTuning,
  DEFAULT_COLLIDER_TUNING,
  COLLIDER_TUNING_LIMITS,
  COLLIDER_SAMPLE_POINTS,
  COLLIDER_VOXEL_METRES,
  COLLIDER_BAND_ABOVE_M,
  COLLIDER_BAND_BELOW_M,
  COLLIDER_OPACITY_THRESHOLD,
  COLLIDER_DILATE,
  COLLIDER_MAX_VOXELS,
  COLLIDER_ISLAND_KEEP_FRACTION,
  dropIslands,
  sealUnreachable,
} from './collider/collider-grid';
export type {
  ColliderTuning,
  ColliderFrame,
  ColliderSample,
  ColliderWalker,
  SceneColliderData,
  SceneColliderStats,
} from './collider/collider-grid';
export { SceneColliderDebug } from './collider/collider-debug';
export type {
  ColliderDebugMode,
  ColliderDebugStats,
  ColliderSurfaceStats,
  SceneColliderDebugOptions,
} from './collider/collider-debug';
// Getting a built collider out: an .obj a game engine's collider component
// eats, or the grid itself for `SceneCollider.fromData` to reload.
export {
  colliderSurfaceToObj,
  encodeSceneColliderData,
  decodeSceneColliderData,
  SCENE_COLLIDER_FILE_VERSION,
} from './collider/collider-io';
export type { ColliderObjOptions, SceneColliderFile } from './collider/collider-io';

// ── Input (primitives) ─────────────────────────────────────────────────────
export { Keyboard } from './input/keyboard';
export type { KeyEventListener, Unsubscribe } from './input/keyboard';

// ── TileGrid (primitive - gameplay-agnostic logic grid + picking on XZ) ────
export { TileGrid } from './tilegrid/tile-grid';
export type { TileGridOptions, Cell } from './tilegrid/tile-grid';
// Geometry helpers (pure - neighbours, ranges, line-of-sight, A*)
export {
  ORTHO_STEPS,
  DIAGONAL_STEPS,
  ALL_STEPS,
  manhattan,
  chebyshev,
  neighbors,
  cellsInRange,
  ray,
  line,
  hasLineOfSight,
  findPath,
} from './tilegrid/tile-grid-geometry';
export type { PathOptions } from './tilegrid/tile-grid-geometry';
// Serialization (snapshot ⇄ JSON for save / netcode / transcripts)
export {
  serializeTileGrid,
  deserializeTileGrid,
} from './tilegrid/tile-grid-serializer';
export type {
  TileGridSnapshot,
  SerializedCell,
  SerializeOptions,
  DeserializeOptions,
} from './tilegrid/tile-grid-serializer';
// Debug overlay (immediate-mode line drawing)
export { TileGridDebug } from './tilegrid/tile-grid-debug';

// ── Presets (opinionated game-shape components - built on primitives) ─────
// Camera presets
export { OrbitControls } from './presets/camera/orbit-controls';
export type { OrbitControlsOptions } from './presets/camera/orbit-controls';
export { ThirdPersonCamera } from './presets/camera/third-person-camera';
export type { ThirdPersonCameraOptions } from './presets/camera/third-person-camera';
export { FlyControls, defaultShouldIgnoreKeystroke } from './presets/camera/fly-controls';
export type { FlyControlsOptions } from './presets/camera/fly-controls';
export type { CameraHost, CameraPreset, TargetSupplier, Vec3Like } from './presets/camera/camera-preset';
// Character presets
export { DamageVariant } from './presets/character/damage-variant';
export type { DamageVariantOptions } from './presets/character/damage-variant';
export { playReveal, DEFAULT_REVEAL_PRESET } from './presets/character/character-reveal';
export type { RevealPreset, PlayRevealOptions, RevealRun, RevealTarget } from './presets/character/character-reveal';
export { BodyShapeVariant, BODY_PART_SLUGS, buildStretch } from './presets/character/body-shape';
export type { ProportionSpec } from './presets/character/body-shape';
export { computeBoneStretch } from './skeletal/bone-stretch';
export type { BoneStretch, BoneScale, BoneScaleInput } from './skeletal/bone-stretch';
// Socket loadout merge (pure - cross-game base⊕override socket layering)
export { mergeSocketLoadout, isSocketRemoval } from './presets/character/socket-loadout';
export type {
  SocketLoadout,
  SocketOverride,
  ResolvedSocketItem,
} from './presets/character/socket-loadout';
// Motor + controller presets
export { CharacterMotor } from './presets/motor/character-motor';
export type { CharacterMotorOptions } from './presets/motor/character-motor';
export { WasdController } from './presets/motor/wasd-controller';
export type { WasdControllerOptions } from './presets/motor/wasd-controller';
// Visual presets
export { BoneOverlay } from './presets/visual/bone-overlay';
export type { BoneOverlayOptions } from './presets/visual/bone-overlay';
export { Grid } from './presets/visual/grid';
export type { GridOptions, GridLook } from './presets/visual/grid';
export { GroundPlane } from './presets/visual/ground-plane';
export { MeshLights } from './presets/visual/mesh-lights';
export type { MeshLightsLook } from './presets/visual/mesh-lights';
export type { GroundPlaneOptions } from './presets/visual/ground-plane';
export { OriginGizmo } from './presets/visual/origin-gizmo';
export { StageMarks } from './presets/visual/stage-marks';
export type { StageMarksFrame, StageMarkPoint, StageMarkStrip, StageMarkSegment, StageMarkRing, StageMarkDot } from './presets/visual/stage-marks';
export type { OriginGizmoOptions } from './presets/visual/origin-gizmo';
export { SkyDome } from './presets/visual/sky-dome';
export type { SkyDomeOptions, SkyDomeLook } from './presets/visual/sky-dome';
// VFX presets (concrete IVfxPrefab implementations - opinionated, opt-in)
export { MeshFlash } from './presets/vfx/mesh-flash';
export type { MeshFlashOptions } from './presets/vfx/mesh-flash';

// Offscreen hole probing: how much of a view is gap rather than scene. Owns
// its own camera and render target, so it never disturbs the visible view.
//
// IT MEASURES ONE POSE AND NO LONGER SEARCHES. `sweep` and `ringPoses` ranked
// a ring of candidates here; that search moved to the scene build, which
// searches positions rather than one circle and records its answer with the
// scene. A GPU ring in a browser was a second, weaker implementation of a
// question answered upstream. `reach-field` went with it: the magnification
// bound it computed existed to keep that ring and an agent's camera inside
// the reconstruction, nothing enforces it now, and the rule itself lives
// where it is measured, in the view playground.
export { createSceneProbe } from './probe/scene-probe';
export type {
  ProbePose, ProbeResult, SceneCapture, SceneProbe, SceneProbeOptions,
} from './probe/scene-probe';
