/**
 * VFX data types - JSON-serializable definitions for data-driven VFX.
 *
 * Each VFX effect consists of one or more layers. The engine ships three
 * built-in layer types (declared via `VfxLayerTypeMap` below):
 *   - "particle" - PlayCanvas `ParticleSystemComponent` wrapper
 *   - "mesh"     - Procedural mesh primitive (sphere/ring/spike/quad)
 *   - "sprite"   - Animated spritesheet on a quad
 *
 * Consumers extend the layer union by registering more renderers with
 * `VfxLayerRegistry` AND declaration-merging their layer types into
 * `VfxLayerTypeMap`. GameEditor does this for cloud / ribbon / shield / etc.
 */

import type { VfxParticleLayer } from './layers/particle';
import type { VfxMeshLayer, MeshShape } from './layers/mesh';
import type { VfxSpriteLayer } from './layers/sprite';
import type { VfxShaderLayer } from './layers/shader';

// ── Curve types ──────────────────────────────────────────────────────────────

/** [normalizedTime, value] - time is 0..1 over the layer's duration. */
export type CurvePoint = [number, number];

/** [normalizedTime, r, g, b] - RGB 0..1 */
export type ColorCurvePoint = [number, number, number, number];

// ── Shared base ──────────────────────────────────────────────────────────────

export interface VfxLayerBase {
  id: string;
  name: string;
  enabled: boolean;
  startDelay: number;
  duration: number;
}

// ── Open layer union via declaration merging ─────────────────────────────────

/**
 * Map of `layer.type` → concrete layer interface. Engine seeds the three
 * built-in types; consumers extend this via declaration merging so
 * `VfxLayer` widens to include their custom layer types:
 *
 * ```ts
 * // In the consumer (e.g. GameEditor):
 * import type { VfxCloudLayer } from './renderers/cloud';
 * declare module '@viggle/splat-engine' {
 *   interface VfxLayerTypeMap { cloud: VfxCloudLayer; }
 * }
 * ```
 */
export interface VfxLayerTypeMap {
  particle: VfxParticleLayer;
  mesh: VfxMeshLayer;
  sprite: VfxSpriteLayer;
  /** Generic data-driven GLSL layer (see `layers/shader.ts`). */
  shader: VfxShaderLayer;
}

export type VfxLayer = VfxLayerTypeMap[keyof VfxLayerTypeMap];

// ── Trail (root-position history, shared across all layer types) ─────────────

export interface VfxTrailConfig {
  count: number;
  sampleInterval: number;
  shape: MeshShape;
  radius: number;
  color: [number, number, number];
  emissiveIntensity: number;
  maxOpacity: number;
  shrinkFactor: number;
  blendMode: 'additive' | 'alpha';
}

// ── Top-level effect ─────────────────────────────────────────────────────────

export interface VfxEffectData {
  name: string;
  duration: number;
  loop?: boolean;
  rootRotationSpeed?: [number, number, number];
  trail?: VfxTrailConfig;
  layers: VfxLayer[];
}

export type VfxDataFile = Record<string, VfxEffectData>;

// Per-layer default-value factories deliberately do NOT live here - they
// only seed UI form state in editor "+ New layer" menus. Runtime never
// builds layers from scratch (data comes from saved JSON). The factories
// live in the editor that uses them.
