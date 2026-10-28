import {
  BONE_NAMES,
  SKELETON_1185_NAMES,
  REST_TRANSLATIONS,
  REST_ROTATIONS,
  PARENTS,
} from './skeleton-data';
import {
  BONE_NAMES_441,
  PARENTS_441,
  REST_TRANSLATIONS_441,
  REST_ROTATIONS_441,
} from './skeleton-data-441';

/** @group Characters & Animation */
export interface SkeletonLibrary {
  boneNames?: string[];
  skeleton1185Names?: string[];
  skeleton1185StrippedNames?: string[];
  stdMaleRestTranslations?: Float32Array;
  stdMaleRestRotations?: Float32Array;
  stdMaleParents?: Int32Array;
  // Full 441-bone rig (body + facial). Used when a bin declares numBones=441.
  boneNames441?: string[];
  restTranslations441?: Float32Array;
  restRotations441?: Float32Array;
  parents441?: Int32Array;
}

const FACIAL_PREFIX = 'FACIAL_';

export function getStripped1185Names(library: SkeletonLibrary): string[] | undefined {
  if (!library.skeleton1185Names) return undefined;
  if (!library.skeleton1185StrippedNames) {
    library.skeleton1185StrippedNames = library.skeleton1185Names.filter(
      (n) => !n.startsWith(FACIAL_PREFIX),
    );
  }
  return library.skeleton1185StrippedNames;
}

/**
 * Build the skeleton library from inlined data.
 * No network requests - all data is bundled in the engine.
 */
export function loadSkeletonLibrary(): SkeletonLibrary {
  return {
    boneNames: BONE_NAMES,
    skeleton1185Names: SKELETON_1185_NAMES,
    stdMaleRestTranslations: new Float32Array(REST_TRANSLATIONS),
    stdMaleRestRotations: new Float32Array(REST_ROTATIONS),
    stdMaleParents: new Int32Array(PARENTS),
    boneNames441: BONE_NAMES_441,
    restTranslations441: new Float32Array(REST_TRANSLATIONS_441),
    restRotations441: new Float32Array(REST_ROTATIONS_441),
    parents441: new Int32Array(PARENTS_441),
  };
}
