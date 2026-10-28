/**
 * Splats in, a closed triangle surface out.
 *
 * A splat cloud is not lit geometry. Anything that needs a SURFACE from it -
 * relighting, cast shadows, coverage masks - needs the same thing first: the
 * boundary of the volume the splats occupy, closed, welded and cheap. This
 * module is that step and nothing else. It touches no GPU, no scene and no
 * PlayCanvas type, so it can be called from a worker, from a test, or from a
 * build script with equal safety.
 *
 * WHY VOXELS AND NOT A HULL OR A POINT-CLOUD RECONSTRUCTION. The surface only
 * has to be closed and roughly in the right place - it is never seen, only lit.
 * A voxel grid is the one reconstruction whose error is bounded by a number the
 * caller sets ({@link ProxySettings.voxelSize}) and whose output is watertight
 * by construction: the boundary of a set of cells is always a closed manifold.
 * Convex hulls lose every concavity, which is where the self-shadows are.
 *
 * CLOSED, NOT MANIFOLD. The output has no boundary edges - no holes, so no
 * light leaks - but two cells that meet only along a grid edge leave that edge
 * shared by four faces instead of two. A character at voxel 0.05 comes out
 * with a couple of those out of some seven thousand edges. Harmless for
 * lighting, and inherited from the Unity original; a collision cook or a mesh
 * simplifier that assumes a manifold is where it would bite, and a collider
 * wants its own simplified mesh anyway.
 *
 * ## The two finishes
 *
 * The Unity original this is ported from served two consumers from one mesh,
 * and they wanted different finishes:
 *
 * - **Proxy (relight)** - `smooth`, voxel 0.025, dilate 0, smooth 3, no merge.
 *   Smoothing melts the cube staircase so the coverage silhouette and the
 *   self-shadows stay stable while the mesh animates. Vertices stay on the
 *   shared grid, so the Laplacian has neighbours to average over.
 * - **Collider** - `smooth` (Surface Nets), dilate 1, a relaxation pass or
 *   two. One vertex per boundary cell, free to sit anywhere inside it, so a
 *   sloped surface comes out sloped instead of as steps. The lighter mesh.
 *
 * We are lighting-only, so {@link defaultProxySettings} is the RELIGHT finish.
 * A collider here would want a simplified mesh built a different way anyway.
 *
 * `blocky` is not a lesser `smooth`. It is the exact boundary of the occupied
 * cells, which is what you want when the CELLS are the thing being looked at -
 * tuning voxel size against the splats. The two answer different questions.
 *
 * ## Which knob actually moves the fit
 *
 * Measured on two shipped characters, over eight yaws, by asking of every
 * splat whether the view line through it hits the proxy at all - which is
 * exactly the relight pass's coverage rule, since that lookup is screen-space
 * with no depth test:
 *
 * - **`voxelSize` is the only knob that changes what the surface resolves.**
 *   At 0.05 m a person comes out as one lump: chin welded to chest, forearm
 *   welded to torso. At 0.03 the neck and the elbow gap come back, the surface
 *   moves from ~69 mm off the nearest splat to ~41 mm, and coverage is
 *   unchanged at exact. At 0.02 a sparse capture starts to leak.
 * - **`dilate` buys nothing above 1 and fuses below the voxel scale.** At 1 no
 *   splat escapes on either character, from any of the eight yaws. At 0 a
 *   thousandth of them do, by up to 14 mm. At 2 the volume grows by half and
 *   coverage is still exact - the same number, bought twice.
 * - **`smoothIterations` costs 1.4% of enclosed volume a pass and no
 *   coverage.** Eight passes still lose no splat.
 * - **`opacityThreshold` is nearly inert on a character.** Raising it from 0
 *   to 0.2 drops 42% of the splats and 0.3% of the occupied cells, because the
 *   faint ones sit on top of bright ones. It is a knob for a capture with a
 *   real floater halo, not for tuning fit.
 *
 * So a proxy that looks melted is a voxel-size problem every time, and reading
 * it as an erosion problem points at `dilate` and `smoothIterations`, which is
 * the wrong end of the mesh.
 *
 * ## Merging and smoothing are mutually exclusive
 *
 * By construction, not by convention: greedy merging destroys the uniform grid
 * the Laplacian averages over, leaving long thin quads whose interiors have no
 * vertices to move. {@link buildProxyMesh} throws on the combination rather
 * than quietly producing a surface that is neither merged well nor smoothed
 * well.
 *
 * ## The grid is a product of its own
 *
 * {@link buildVoxelGrid} stops after the occupancy and hands the grid back.
 * That is not a convenience wrapper - it is the half of this module a COLLIDER
 * wants, and the mesh is the half it must not have. The extracted surface is
 * closed but not manifold (see above), so a physics cook or a simplifier
 * chokes on it, while a grid lookup - topmost occupied cell in a column is the
 * floor, an occupied cell at knee height is a wall - needs no cook at all. So
 * the collider reads the grid, the extraction it would throw away never runs,
 * and neither consumer is paying for the other's finish. See
 * `../collider/scene-collider.ts`.
 *
 * @module
 */

/** How the occupied set is turned into triangles. */
export type ProxySurfaceStyle = 'blocky' | 'smooth';

/**
 * How a splat cloud should be turned into a surface. Every field is optional;
 * omitted fields take the relight finish from {@link defaultProxySettings}.
 */
export interface ProxySettings {
  /**
   * `blocky` = the exact cell boundary, every face a square on the grid.
   * `smooth` = Surface Nets: one vertex per boundary cell, free to sit
   * anywhere inside it, so a sloped surface comes out sloped rather than as
   * steps - truer AND lighter, and the right choice for a collider.
   *
   * Default `blocky`, the relight finish. See the module header.
   */
  surface?: ProxySurfaceStyle;

  /**
   * Edge length of one voxel, in metres. THE knob, and the only one that
   * changes what the surface can RESOLVE. Too coarse seals gaps that should
   * stay open and inflates the silhouette; too fine explodes the triangle
   * count and eventually leaks, because a one-voxel dilation stops being
   * enough to close the pinholes a sparse capture leaves.
   *
   * Default `0.025`. On a 1.9 m character that is ~76 cells of height, 25k
   * triangles and an ~11 ms build. The knee is real: 0.05 fuses the neck, the
   * chin and the gap between a forearm and the torso into one lump at ~69 mm
   * off the nearest splat, 0.03 brings those gaps back at ~40 mm, and 0.02
   * starts to leak on a sparse capture. See the module header.
   */
  voxelSize?: number;

  /**
   * Splats fainter than this do not fill a voxel. Raise it to drop the wispy
   * halo of near-transparent floaters that otherwise inflates the volume well
   * past the real surface. This is an ALPHA in `[0,1]`, not a logit - see
   * {@link ProxyMeshInput.opacities}. Default `0.04` - low, because 0.2 drops
   * the faint splats that carry a capture's thin geometry. See
   * {@link defaultProxySettings}.
   */
  opacityThreshold?: number;

  /**
   * Grow the volume outward this many voxels. One step closes the pinholes a
   * sparse surface leaves. For LIGHTING this wants to be at least 1, so edge
   * splats land inside the coverage mask rather than on its rim. Default `1`.
   *
   * It is also the knob that FUSES: a dilation of one bridges every gap
   * narrower than two voxels, so at a coarse voxel size it is what welds an
   * arm to a torso. Raising it does not buy coverage - coverage is already
   * exact at 1 on a character - it only inflates. When the proxy looks like a
   * melted lump, this is not the knob; {@link voxelSize} is.
   */
  dilate?: number;

  /**
   * Laplacian relaxation passes. On `smooth` this polishes an already-smooth
   * surface and 1-2 passes is plenty. On `blocky` it is the ONLY thing that
   * rounds the cubes and needs more passes to do it. Every pass shrinks the
   * surface slightly, which is why the volume is dilated outward first.
   * Default `3`.
   */
  smoothIterations?: number;

  /**
   * Fill every column solid from the grid floor up to its lowest occupied
   * voxel. A raw voxelization of an exterior capture is a SHELL: the ground is
   * one voxel thick. Filling underneath turns the shell into ground with
   * substance below it. Meaningless for a character or a prop, where there is
   * no "underneath" - leave it off. Default `false`.
   */
  floorFill?: boolean;

  /**
   * Greedily merge coplanar faces into the largest rectangles that tile them.
   * Cuts the triangle count of a blocky surface by an order of magnitude at no
   * fidelity cost - the merged surface is geometrically IDENTICAL, it just
   * stops spending four vertices on every one-voxel square.
   *
   * Rejected together with {@link smoothIterations}, and ignored entirely on
   * `smooth` (Surface Nets emits no coplanar squares to merge). Default
   * `false`.
   */
  mergeCoplanar?: boolean;

  /**
   * Grid ceiling, in cells. A bad voxel size on a large capture would
   * otherwise allocate a pathological grid; the build coarsens the voxel size
   * by 1.5x until it fits, because a coarser surface is still a usable surface
   * and an out-of-memory is not. Default `4_000_000`.
   */
  maxVoxels?: number;
}

/**
 * Clear cells the surface extraction needs on every side of the occupied set.
 *
 * `emitPerVoxel` reads a cell's six neighbours and treats anything off the grid
 * as empty, so one would do for it. Surface Nets reads the 2x2x2 block of
 * lattice points around each dual cell and emits a quad only where all four
 * cells around a sign-changing edge produced a vertex, so it needs a clear cell
 * one FURTHER out: with a single clear layer its boundary quads are never
 * emitted and the surface comes out with holes, which is a light leak and the
 * one invariant this module promises.
 *
 * Two places have to respect it - the bounding pad, and the floor fill, which
 * writes downward and would otherwise run into the floor of the grid. Both went
 * unseen while the defaults were `blocky` + `dilate: 1`, where the dilation's
 * own pad covered the first and the finish hid the second.
 */
const EXTRACTION_MARGIN = 2;

/**
 * The relight finish: `smooth`, voxel 0.025, opacity 0.04, dilate 0, smooth 3,
 * no merge.
 *
 * Tuned on screen against the bundled character and capture, which is the only
 * test that sees what a reader sees. The measurements are what a future change
 * has to beat rather than rediscover, so they are kept here next to the number
 * that disagreed with them:
 *
 * - **`voxelSize` 0.025.** The measurement always said fine: at 0.05 a person
 *   comes out as one lump, chin welded to chest and forearm welded to torso,
 *   and the surface sits ~69 mm off the nearest splat; at 0.03 the neck and
 *   the elbow gap come back at ~41 mm. This briefly read 0.05 to match the
 *   Unity component's default, and that was the wrong thing to match - the
 *   Unity number was itself carried over unexamined, and agreeing with it cost
 *   the resolution the measurement had already paid for. 0.025 is a step finer
 *   again, and on the bundled character it is 7.5k voxels, 25k triangles and
 *   an ~11 ms build. Below 0.02 a sparse capture starts to leak.
 * - **`surface` `smooth`, not `blocky`.** Surface Nets puts one vertex per
 *   boundary cell free to sit anywhere inside it, so a sloped surface comes
 *   out sloped rather than as steps. `blocky` remains the right pick for
 *   LOOKING at the cells - it is the exact occupied boundary - which is what
 *   the `voxels` preview draws.
 * - **`opacityThreshold` 0.04, not 0.2.** 0.2 drops the faint splats that
 *   carry a capture's thin geometry, and the proxy loses surfaces the splats
 *   plainly have. 0.04 still filters the near-transparent halo.
 * - **`dilate` 0, not 1.** One ring closes pinholes a sparse capture leaves,
 *   and measured, 0 lets a thousandth of the splats escape coverage by up to
 *   14 mm. But a ring is a whole voxel of inflation on a surface that is
 *   already outside the splats, and the silhouette reads as a character
 *   wearing its proxy. Smoothing and the fine cell absorb what escapes.
 *
 * `floorFill` stays off here and is turned on per target: it is for a capture
 * read as a one-voxel shell, not for a character. See
 * {@link ENVIRONMENT_PROXY_DEFAULTS}.
 */
export const defaultProxySettings: Required<ProxySettings> = Object.freeze({
  surface: 'smooth',
  voxelSize: 0.025,
  opacityThreshold: 0.04,
  dilate: 0,
  smoothIterations: 3,
  floorFill: false,
  mergeCoplanar: false,
  maxVoxels: 4_000_000,
});

/** Integer bone indices, in whatever width the source happened to use. */
export type BoneIndexArray = Uint8Array | Uint16Array | Uint32Array | Int32Array;

/** What to voxelize. The bone arrays are optional and drive skinning when present. */
export interface ProxyMeshInput {
  /** `[x,y,z] * numSplats`, in the space the caller wants the mesh in. */
  positions: Float32Array;
  /**
   * Per-splat ALPHA in `[0,1]`, one per splat. Omit to count every splat.
   *
   * Our `.vsplat` containers store the LOGIT, not the alpha, so a caller
   * reading `splatData.getProp('opacity')` has to push it through a sigmoid
   * first - {@link alphaFromLogits} does that. Thresholding a logit against
   * 0.2 would keep everything down to alpha 0.55, which is the opposite of
   * what the knob is for.
   */
  opacities?: Float32Array;
  /** `[b0,b1,b2,b3] * numSplats` rig bone indices. Omit for an unskinned build. */
  boneIndices?: BoneIndexArray;
  /** `[w0,w1,w2,w3] * numSplats`, matching {@link boneIndices}. */
  boneWeights?: Float32Array;
}

/** Grid dimensions or a grid-space point. Plain object: this module has no vector type. */
export interface ProxyGridVec {
  x: number;
  y: number;
  z: number;
}

/**
 * The settings that shape the OCCUPANCY, which is every setting except the
 * ones that only describe a finish. {@link buildVoxelGrid} takes these; the
 * mesh-only knobs (`surface`, `smoothIterations`, `mergeCoplanar`) would have
 * nothing to act on.
 */
export type VoxelGridSettings = Pick<
  ProxySettings, 'voxelSize' | 'opacityThreshold' | 'dilate' | 'floorFill' | 'maxVoxels'
>;

/**
 * The settings that shape the SURFACE, which is the finish and nothing else.
 * {@link extractSurface} takes these; the occupancy already happened by then, so
 * `voxelSize`, `dilate`, `floorFill` and `opacityThreshold` have nothing left to
 * act on.
 */
export type SurfaceSettings = Pick<
  ProxySettings, 'surface' | 'smoothIterations' | 'mergeCoplanar'
>;

/**
 * A voxelized splat cloud, before any surface is extracted from it.
 *
 * What {@link buildProxyMesh} builds first and {@link buildVoxelGrid} stops at.
 * A collider wants exactly this and nothing after it - see the module header.
 */
export interface VoxelGrid {
  /**
   * `dims.x * dims.y * dims.z` bytes, 1 where the cell is solid, after
   * dilation and the floor fill. Indexed `(z * dims.y + y) * dims.x + x`.
   * Zero length when the run produced no grid at all.
   */
  occupancy: Uint8Array;
  /** Grid dimensions, in cells. */
  dims: ProxyGridVec;
  /** World position of cell `(0,0,0)`'s low corner. */
  origin: ProxyGridVec;
  /** Cell edge actually used - larger than requested if the grid had to coarsen. */
  voxelSize: number;
  /** Cell edge asked for. Differs from {@link voxelSize} when the grid coarsened. */
  requestedVoxelSize: number;
  /**
   * The grid hit `maxVoxels` and the cell size was raised. User-visible: a
   * reader colliding with a 2.6 m grid they believe is 0.1 m has no way to
   * make sense of what they are walking into.
   */
  coarsened: boolean;
  /** Solid cells after dilation and the floor fill. */
  occupiedVoxels: number;
  /** Splats that passed the opacity threshold. */
  splatsUsed: number;
  /** Milliseconds this build took. */
  buildMs: number;
}

/** The mesh, plus what the run decided along the way. */
export interface ProxyMeshResult {
  /** `[x,y,z] * vertexCount`. Empty when nothing was occupied. */
  positions: Float32Array;
  /** `[x,y,z] * vertexCount`, area-weighted from the faces that share each vertex. */
  normals: Float32Array;
  /** Triangle list, 3 indices a triangle. */
  indices: Uint32Array;
  /**
   * The same surface as {@link indices}, 4 indices a face, before
   * triangulation. Both extraction styles are natively quad-based; this is
   * what a wireframe should walk, because the triangulation diagonals are an
   * artefact of the triangle list and not edges of the surface.
   */
  quads: Uint32Array;
  /** `[b0,b1,b2,b3] * vertexCount` as FLOATS, or `null` when the run was unskinned. */
  boneIndices: Float32Array | null;
  /** `[w0,w1,w2,w3] * vertexCount`, summing to 1 per weighted vertex, or `null`. */
  boneWeights: Float32Array | null;

  /** Voxel size actually used - larger than requested if the grid had to coarsen. */
  voxelSize: number;
  /** Grid dimensions, in voxels. */
  dims: ProxyGridVec;
  /** World position of the grid's minimum corner, i.e. of cell `(0,0,0)`'s low corner. */
  origin: ProxyGridVec;
  /** Occupied voxels after dilation and floor fill. */
  occupiedVoxels: number;
  /** Splats that passed the opacity threshold. */
  splatsUsed: number;
  /** `positions.length / 3`. */
  vertexCount: number;
  /** `indices.length / 3`. */
  triangleCount: number;
  /** Milliseconds this build took. */
  buildMs: number;
}

/**
 * Sigmoid a `.vsplat` opacity column into the alpha
 * {@link ProxyMeshInput.opacities} wants.
 *
 * Allocates. Call it once per capture, not once per rebuild - the voxel knobs
 * are what move while tuning, and the alphas are not among them.
 */
export function alphaFromLogits(logits: Float32Array): Float32Array {
  const out = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) out[i] = 1 / (1 + Math.exp(-logits[i]));
  return out;
}

/**
 * Bone-index keys are packed as `slot * BONE_KEY_STRIDE + bone` into one map,
 * rather than a map per voxel: the per-voxel maps are what made the Unity
 * version allocate a dictionary per occupied cell. The widest rig we ship is
 * 1185 bones, so a 2^20 stride leaves four orders of magnitude of headroom,
 * and the largest key a 4M-cell grid can produce is ~4.2e12 - comfortably an
 * exact integer in a double.
 */
const BONE_KEY_STRIDE = 1 << 20;

/** Influences carried per vertex. Matches the four the skinning shader reads. */
const INFLUENCES = 4;

/**
 * Voxelize a splat cloud and stop there: the occupancy grid, no surface.
 *
 * Everything {@link buildProxyMesh} does up to the extraction - the opacity
 * threshold, the padded bounds, the coarsen loop, the dilation, the floor fill
 * - and none of what comes after. On a scanned room at a collider's voxel size
 * the extraction is most of the build and all of it would be thrown away; see
 * the module header for why a collider must not have the mesh anyway.
 *
 * Pure. Bone influences on `input` are ignored - a grid has no vertices to
 * weight.
 *
 * @throws RangeError when `voxelSize <= 0`.
 */
export function buildVoxelGrid(input: ProxyMeshInput, settings: VoxelGridSettings = {}): VoxelGrid {
  const t0 = now();
  const s = { ...defaultProxySettings, ...stripUndefined(settings) };
  if (!(s.voxelSize > 0)) {
    throw new RangeError(`[buildVoxelGrid] voxelSize must be > 0, got ${s.voxelSize}`);
  }
  const grid = voxelize(input, s, false, t0, '[buildVoxelGrid]');
  return {
    occupancy: grid.occupancy,
    dims: grid.dims,
    origin: grid.origin,
    voxelSize: grid.voxelSize,
    requestedVoxelSize: grid.requestedVoxelSize,
    coarsened: grid.coarsened,
    occupiedVoxels: grid.occupiedVoxels,
    splatsUsed: grid.splatsUsed,
    buildMs: grid.buildMs,
  };
}

/**
 * Voxelize a splat cloud into a closed triangle surface.
 *
 * Pure: it reads the input arrays and returns fresh ones. The input is never
 * written to and nothing is retained.
 *
 * @param input - Splat centres, opacity, and optionally per-splat bone
 *   influences. When both bone arrays are present the result carries
 *   per-vertex weights and can be handed straight to `ArmatureSkinAdapter`.
 * @param settings - Overrides on {@link defaultProxySettings}.
 * @throws RangeError when `voxelSize <= 0`, when the bone arrays are the wrong
 *   length, or when `mergeCoplanar` is combined with `smoothIterations > 0`.
 */
export function buildProxyMesh(
  input: ProxyMeshInput,
  settings: ProxySettings = {},
): ProxyMeshResult {
  const t0 = now();
  const s = { ...defaultProxySettings, ...stripUndefined(settings) };

  // Refused rather than silently reconciled: see the module header. Only
  // `blocky` can hit this - Surface Nets never consults mergeCoplanar.
  if (s.surface === 'blocky' && s.mergeCoplanar && s.smoothIterations > 0) {
    throw new RangeError(
      '[buildProxyMesh] mergeCoplanar and smoothIterations are mutually exclusive - '
      + 'merging destroys the uniform grid the Laplacian needs. Pick a finish: '
      + 'merge for a raw blocky surface, smooth for the relight proxy.',
    );
  }
  if (!(s.voxelSize > 0)) {
    throw new RangeError(`[buildProxyMesh] voxelSize must be > 0, got ${s.voxelSize}`);
  }

  const skinned = !!input.boneIndices && !!input.boneWeights;
  const grid = voxelize(input, s, skinned, t0, '[buildProxyMesh]');
  return extract(grid, s, skinned, t0);
}

/**
 * Turn a {@link VoxelGrid} into a surface, with no splats and no voxelization.
 *
 * The other half of {@link buildProxyMesh}, callable on its own so a consumer
 * that already holds a grid can ask for the surface WITHOUT re-reading the
 * splats. The collider is that consumer: it keeps the grid (that is what its
 * queries read) and extracts a surface only when something wants to look at one
 * or write one out - and because both of those come from this one call over the
 * one grid, the picture and the exported file cannot be different geometry.
 *
 * Pure. The grid is not written to. Unskinned by construction: a grid carries no
 * bone accumulation, so {@link ProxyMeshResult.boneIndices} comes back null.
 *
 * @param settings - only the finish matters here; `voxelSize`, `dilate`,
 *   `floorFill` and the rest already happened and are ignored.
 * @throws RangeError when `mergeCoplanar` is combined with `smoothIterations > 0`.
 */
export function extractSurface(grid: VoxelGrid, settings: SurfaceSettings = {}): ProxyMeshResult {
  const t0 = now();
  const s = { ...defaultProxySettings, ...stripUndefined(settings) };
  if (s.surface === 'blocky' && s.mergeCoplanar && s.smoothIterations > 0) {
    throw new RangeError(
      '[extractSurface] mergeCoplanar and smoothIterations are mutually exclusive - '
      + 'merging destroys the uniform grid the Laplacian needs. Pick a finish: '
      + 'merge for a raw blocky surface, smooth for the relight proxy.',
    );
  }
  return extract({ ...grid, boneSlot: null, slotIndices: null, slotWeights: null }, s, false, t0);
}

/** The extraction itself. `skinned` decides whether vertices carry weights. */
function extract(
  grid: VoxelizeResult,
  s: Required<ProxySettings>,
  skinned: boolean,
  t0: number,
): ProxyMeshResult {
  const { occupancy: occ, splatsUsed, occupiedVoxels } = grid;
  const nx = grid.dims.x, ny = grid.dims.y, nz = grid.dims.z;
  const mnx = grid.origin.x, mny = grid.origin.y, mnz = grid.origin.z;
  const voxel = grid.voxelSize;
  const idx = (x: number, y: number, z: number) => (z * ny + y) * nx + x;
  const { boneSlot, slotIndices, slotWeights } = grid;

  if (occupiedVoxels === 0) {
    const empty = emptyResult(voxel, t0);
    empty.dims = { x: nx, y: ny, z: nz };
    empty.origin = { x: mnx, y: mny, z: mnz };
    empty.splatsUsed = splatsUsed;
    return empty;
  }

  // ── Surface extraction.
  const verts: number[] = [];
  const quads: number[] = [];
  const vertBoneIndices: number[] | null = skinned ? [] : null;
  const vertBoneWeights: number[] | null = skinned ? [] : null;

  /** Copy a voxel's four influences onto the vertex just pushed. */
  const pushWeights = (sourceVoxel: number) => {
    if (!vertBoneIndices || !vertBoneWeights) return;
    const slot = boneSlot ? boneSlot[sourceVoxel] : -1;
    if (slot < 0 || !slotIndices || !slotWeights) {
      // All-zero: bound to bone 0 with weight 0, which the skinning shader
      // reads as "no influence" rather than as "pinned to the root".
      for (let j = 0; j < INFLUENCES; j++) { vertBoneIndices.push(0); vertBoneWeights.push(0); }
      return;
    }
    const base = slot * INFLUENCES;
    for (let j = 0; j < INFLUENCES; j++) {
      vertBoneIndices.push(slotIndices[base + j]);
      vertBoneWeights.push(slotWeights[base + j]);
    }
  };

  const solid = (x: number, y: number, z: number) =>
    x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && occ[idx(x, y, z)] !== 0;

  // WELDED vertices, keyed by grid corner. Sharing is what makes the Laplacian
  // possible at all - an unwelded surface has no neighbours to average - and
  // it roughly halves the vertex count as a side effect. An Int32Array rather
  // than a Map: the corner lattice is exactly `(nx+1)(ny+1)(nz+1)` wide, and
  // the dense array is several times faster to probe than a hash on a grid
  // this size. Allocated only for the styles that weld - Surface Nets does
  // not, and the lattice is the largest allocation in the whole build.
  let cornerIndex: Int32Array | null = null;
  const cornerVert = (cx: number, cy: number, cz: number, sourceVoxel: number) => {
    const lattice = cornerIndex
      ?? (cornerIndex = new Int32Array((nx + 1) * (ny + 1) * (nz + 1)).fill(-1));
    const key = (cz * (ny + 1) + cy) * (nx + 1) + cx;
    const found = lattice[key];
    if (found >= 0) return found;
    const v = verts.length / 3;
    lattice[key] = v;
    verts.push(mnx + cx * voxel, mny + cy * voxel, mnz + cz * voxel);
    pushWeights(sourceVoxel);
    return v;
  };

  // Surface Nets builds its own vertices - they sit anywhere inside a cell,
  // not on grid corners, so the welding above does not apply to them.
  const freeVert = (x: number, y: number, z: number, sourceVoxel: number) => {
    const v = verts.length / 3;
    verts.push(x, y, z);
    pushWeights(sourceVoxel);
    return v;
  };

  const quad = (a: number, b: number, c: number, d: number) => quads.push(a, b, c, d);

  if (s.surface === 'smooth') {
    emitSurfaceNets(nx, ny, nz, mnx, mny, mnz, voxel, solid, idx, freeVert, quad);
  } else if (s.mergeCoplanar) {
    emitMerged(nx, ny, nz, solid, idx, cornerVert, quad);
  } else {
    emitPerVoxel(nx, ny, nz, solid, idx, cornerVert, quad);
  }

  if (quads.length === 0) {
    const empty = emptyResult(voxel, t0);
    empty.dims = { x: nx, y: ny, z: nz };
    empty.origin = { x: mnx, y: mny, z: mnz };
    empty.splatsUsed = splatsUsed;
    empty.occupiedVoxels = occupiedVoxels;
    return empty;
  }

  const vertexCount = verts.length / 3;
  const outPositions = new Float32Array(verts);
  const outQuads = new Uint32Array(quads);
  const outIndices = triangulate(outQuads);

  // ── Laplacian relaxation: melt the cube staircase into a rounded surface.
  //    Plain (shrinking) Laplacian on purpose - the volume was dilated outward
  //    first, so the mild shrink pulls the surface back toward the splats
  //    while it rounds off.
  if (s.smoothIterations > 0) {
    relax(outPositions, vertexCount, outQuads, s.smoothIterations);
  }

  const outNormals = computeNormals(outPositions, outIndices, vertexCount);

  return {
    positions: outPositions,
    normals: outNormals,
    indices: outIndices,
    quads: outQuads,
    boneIndices: vertBoneIndices ? new Float32Array(vertBoneIndices) : null,
    boneWeights: vertBoneWeights ? new Float32Array(vertBoneWeights) : null,
    voxelSize: voxel,
    dims: { x: nx, y: ny, z: nz },
    origin: { x: mnx, y: mny, z: mnz },
    occupiedVoxels,
    splatsUsed,
    vertexCount,
    triangleCount: outIndices.length / 3,
    buildMs: now() - t0,
  };
}

// ── Occupancy ───────────────────────────────────────────────────────────

/** {@link VoxelGrid} plus the per-cell bone accumulation only the mesh needs. */
interface VoxelizeResult extends VoxelGrid {
  /** Cell -> dense accumulator id, or `-1`. `null` on an unskinned run. */
  boneSlot: Int32Array | null;
  /** `[b0..b3] * slotCount`, the four heaviest bones per accumulator. */
  slotIndices: Float32Array | null;
  /** `[w0..w3] * slotCount`, normalized. */
  slotWeights: Float32Array | null;
}

/**
 * The occupancy stage, shared by {@link buildVoxelGrid} and
 * {@link buildProxyMesh}. `label` is the caller's name, so a thrown range
 * error names the function the caller actually called.
 */
function voxelize(
  input: ProxyMeshInput,
  s: Required<ProxySettings>,
  skinned: boolean,
  t0: number,
  label: string,
): VoxelizeResult {
  const positions = input.positions;
  const n = Math.floor(positions.length / 3);
  if (n === 0) return emptyGrid(s.voxelSize, t0);

  const opacities = input.opacities;
  const hasOpacity = !!opacities && opacities.length === n;
  const threshold = s.opacityThreshold;

  const srcBoneIndices = skinned ? input.boneIndices! : null;
  const srcBoneWeights = skinned ? input.boneWeights! : null;
  if (srcBoneIndices && srcBoneWeights) {
    const want = n * INFLUENCES;
    if (srcBoneIndices.length < want || srcBoneWeights.length < want) {
      throw new RangeError(
        `${label} bone arrays must carry ${INFLUENCES} influences per splat: `
        + `expected ${want} entries for ${n} splats, got ${srcBoneIndices.length} indices `
        + `and ${srcBoneWeights.length} weights`,
      );
    }
  }

  // ── Bounds over the splats that count.
  let rawMnx = Infinity, rawMny = Infinity, rawMnz = Infinity;
  let rawMxx = -Infinity, rawMxy = -Infinity, rawMxz = -Infinity;
  let splatsUsed = 0;
  for (let i = 0; i < n; i++) {
    if (hasOpacity && opacities![i] < threshold) continue;
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < rawMnx) rawMnx = x; if (x > rawMxx) rawMxx = x;
    if (y < rawMny) rawMny = y; if (y > rawMxy) rawMxy = y;
    if (z < rawMnz) rawMnz = z; if (z > rawMxz) rawMxz = z;
    splatsUsed++;
  }
  if (splatsUsed === 0) return emptyGrid(s.voxelSize, t0);

  // ── Pad so neither the dilation nor the surface extraction clips at the
  //    border: the dilation loop below deliberately skips the outermost shell
  //    of cells, so without a pad a splat sitting exactly on the bounding box
  //    would not grow.
  //
  //    TWO cells beyond the dilation, not one. Surface Nets reads the 2x2x2
  //    block of lattice points around every dual cell and emits a quad only
  //    where all four cells around a sign-changing edge produced a vertex, so
  //    it needs a clear cell FURTHER out than the per-voxel extractor does. At
  //    `dilate + 1` the two disagree: a ball at voxel 0.08 comes out of
  //    `blocky` closed and out of `smooth` with twelve boundary edges - holes,
  //    which is a light leak, and the one invariant this module actually
  //    promises. It went unseen while the defaults were `blocky` + `dilate: 1`,
  //    where the dilation's own pad happened to cover it. `dilate + 2` closes
  //    `smooth` at every dilation, and makes the two finishes agree on
  //    triangle count again, which is what they are meant to do.
  //
  //    The pad is a number of VOXELS, so it has to move when the coarsen loop
  //    moves the voxel size. Computing it once from the REQUESTED size - what
  //    this did, and what the Unity original it came from does - leaves a grid
  //    coarsened even one step with a pad thinner than the shell the dilation
  //    skips, so a wall on the capture's edge comes out one cell thin or gone.
  //    Invisible on a character, which coarsens never; a scanned scene at a
  //    metric voxel size coarsens every time. The raw bounds are kept and the
  //    pad is re-derived on every sizing.
  let mnx = 0, mny = 0, mnz = 0, mxx = 0, mxy = 0, mxz = 0;
  const requestedVoxelSize = s.voxelSize;
  let voxel = s.voxelSize;
  let nx = 0, ny = 0, nz = 0;
  const sizeGrid = () => {
    const pad = (s.dilate + EXTRACTION_MARGIN) * voxel;
    mnx = rawMnx - pad; mny = rawMny - pad; mnz = rawMnz - pad;
    mxx = rawMxx + pad; mxy = rawMxy + pad; mxz = rawMxz + pad;
    nx = Math.ceil((mxx - mnx) / voxel) + 1;
    ny = Math.ceil((mxy - mny) / voxel) + 1;
    nz = Math.ceil((mxz - mnz) / voxel) + 1;
  };
  sizeGrid();
  // Coarsen rather than allocate a pathological grid: a coarser surface is
  // still a usable surface and an out-of-memory is not.
  //
  // MONOTONICITY IS THE TERMINATION PROOF. A padded axis can never fall below
  // `2 * (dilate + EXTRACTION_MARGIN) + 1` cells however coarse the voxel gets,
  // so an absolute
  // floor like "stop at 2x2x2" is unreachable and would spin forever on an
  // absurdly low `maxVoxels`. Each step multiplies the voxel by 1.5, which
  // strictly shrinks the grid until it reaches that pad floor, and the loop
  // stops the moment a step fails to shrink it.
  let cells = nx * ny * nz;
  while (cells > s.maxVoxels) {
    voxel *= 1.5;
    sizeGrid();
    const next = nx * ny * nz;
    if (next >= cells) break;
    cells = next;
  }

  const nvox = nx * ny * nz;
  const idx = (x: number, y: number, z: number) => (z * ny + y) * nx + x;
  let occ = new Uint8Array(nvox);

  // ── Occupancy, and per-voxel bone accumulation alongside it.
  //
  // `boneSlot` maps a voxel to a dense accumulator id. Only voxels a splat
  // actually landed in get one; dilation hands its id down to the cells it
  // grows, and the floor fill deliberately gets none (it is for static
  // captures, which are never skinned).
  const boneSlot = srcBoneIndices ? new Int32Array(nvox).fill(-1) : null;
  const boneAcc = srcBoneIndices ? new Map<number, number>() : null;
  let slotCount = 0;

  const invVoxel = 1 / voxel;
  for (let i = 0; i < n; i++) {
    if (hasOpacity && opacities![i] < threshold) continue;
    let cx = Math.floor((positions[i * 3] - mnx) * invVoxel);
    let cy = Math.floor((positions[i * 3 + 1] - mny) * invVoxel);
    let cz = Math.floor((positions[i * 3 + 2] - mnz) * invVoxel);
    if (cx < 0) cx = 0; else if (cx >= nx) cx = nx - 1;
    if (cy < 0) cy = 0; else if (cy >= ny) cy = ny - 1;
    if (cz < 0) cz = 0; else if (cz >= nz) cz = nz - 1;
    const vi = idx(cx, cy, cz);
    occ[vi] = 1;

    if (!boneSlot || !boneAcc) continue;
    let slot = boneSlot[vi];
    if (slot < 0) { slot = slotCount++; boneSlot[vi] = slot; }
    const base = i * INFLUENCES;
    for (let j = 0; j < INFLUENCES; j++) {
      const w = srcBoneWeights![base + j];
      if (!(w > 0)) continue;
      const bone = srcBoneIndices![base + j];
      if (bone < 0 || bone >= BONE_KEY_STRIDE) {
        throw new RangeError(
          `${label} bone index ${bone} is out of the packable range `
          + `[0, ${BONE_KEY_STRIDE})`,
        );
      }
      const key = slot * BONE_KEY_STRIDE + bone;
      boneAcc.set(key, (boneAcc.get(key) ?? 0) + w);
    }
  }

  // ── 6-neighbour dilation. Grown voxels inherit the accumulator of the voxel
  //    that grew them, so dilated skin still follows the right limb.
  for (let pass = 0; pass < s.dilate; pass++) {
    const grown = occ.slice();
    for (let z = 1; z < nz - 1; z++) {
      for (let y = 1; y < ny - 1; y++) {
        for (let x = 1; x < nx - 1; x++) {
          const vi = idx(x, y, z);
          if (occ[vi]) continue;
          let src = -1;
          if (occ[idx(x - 1, y, z)]) src = idx(x - 1, y, z);
          else if (occ[idx(x + 1, y, z)]) src = idx(x + 1, y, z);
          else if (occ[idx(x, y - 1, z)]) src = idx(x, y - 1, z);
          else if (occ[idx(x, y + 1, z)]) src = idx(x, y + 1, z);
          else if (occ[idx(x, y, z - 1)]) src = idx(x, y, z - 1);
          else if (occ[idx(x, y, z + 1)]) src = idx(x, y, z + 1);
          if (src < 0) continue;
          grown[vi] = 1;
          if (boneSlot && boneSlot[vi] < 0) boneSlot[vi] = boneSlot[src];
        }
      }
    }
    occ = grown;
  }

  // ── Solid ground under the shell.
  //
  //    Down to the margin, not to row zero. The pad below the lowest splat is
  //    `dilate + EXTRACTION_MARGIN` cells, and filling through it would put
  //    occupied cells against the grid floor, where Surface Nets cannot close
  //    them - a `smooth` proxy with `floorFill` on came out with an open
  //    underside, which is the exact hole the setting exists to shut. The fill
  //    still reaches below every splat in the column, so the ground is solid.
  if (s.floorFill) {
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        let lowest = -1;
        for (let y = 0; y < ny; y++) {
          if (occ[idx(x, y, z)]) { lowest = y; break; }
        }
        for (let y = EXTRACTION_MARGIN; y < lowest; y++) occ[idx(x, y, z)] = 1;
      }
    }
  }

  let occupiedVoxels = 0;
  for (let i = 0; i < nvox; i++) if (occ[i]) occupiedVoxels++;

  // ── Collapse each accumulator down to the four heaviest bones, normalized.
  //    The pass over the completed map is what makes this the EXACT top four
  //    rather than a running approximation: every total is final by the time
  //    it is offered to the selection.
  let slotIndices: Float32Array | null = null;
  let slotWeights: Float32Array | null = null;
  if (boneAcc && occupiedVoxels > 0) {
    slotIndices = new Float32Array(slotCount * INFLUENCES);
    slotWeights = new Float32Array(slotCount * INFLUENCES);
    for (const [key, total] of boneAcc) {
      const slot = Math.floor(key / BONE_KEY_STRIDE);
      const bone = key - slot * BONE_KEY_STRIDE;
      const base = slot * INFLUENCES;
      // Replace the lightest of the four if this one outweighs it. An empty
      // slot reads as weight 0, so the first four always land.
      let worst = 0;
      for (let j = 1; j < INFLUENCES; j++) {
        if (slotWeights[base + j] < slotWeights[base + worst]) worst = j;
      }
      if (total > slotWeights[base + worst]) {
        slotWeights[base + worst] = total;
        slotIndices[base + worst] = bone;
      }
    }
    for (let slot = 0; slot < slotCount; slot++) {
      const base = slot * INFLUENCES;
      let sum = 0;
      for (let j = 0; j < INFLUENCES; j++) sum += slotWeights[base + j];
      if (sum <= 0) continue;
      for (let j = 0; j < INFLUENCES; j++) slotWeights[base + j] /= sum;
    }
  }

  return {
    occupancy: occ,
    dims: { x: nx, y: ny, z: nz },
    origin: { x: mnx, y: mny, z: mnz },
    voxelSize: voxel,
    requestedVoxelSize,
    coarsened: voxel > requestedVoxelSize * 1.001,
    occupiedVoxels,
    splatsUsed,
    buildMs: now() - t0,
    boneSlot,
    slotIndices,
    slotWeights,
  };
}

function emptyGrid(voxelSize: number, t0: number): VoxelizeResult {
  return {
    occupancy: new Uint8Array(0),
    dims: { x: 0, y: 0, z: 0 },
    origin: { x: 0, y: 0, z: 0 },
    voxelSize,
    requestedVoxelSize: voxelSize,
    coarsened: false,
    occupiedVoxels: 0,
    splatsUsed: 0,
    buildMs: now() - t0,
    boneSlot: null,
    slotIndices: null,
    slotWeights: null,
  };
}

// ── Surface extraction ──────────────────────────────────────────────────

type SolidFn = (x: number, y: number, z: number) => boolean;
type IdxFn = (x: number, y: number, z: number) => number;
type CornerVertFn = (cx: number, cy: number, cz: number, sourceVoxel: number) => number;
type QuadFn = (a: number, b: number, c: number, d: number) => void;

/**
 * One quad per voxel face that borders empty space.
 *
 * The corner orders are not free to permute: each one is wound so that
 * `(v1-v0) x (v2-v0)` points OUT of the volume under the right-hand rule,
 * which is what WebGL's default counter-clockwise front face wants and what
 * makes {@link computeNormals} come out pointing outward without a fixup pass.
 * (They are the Unity original's orders unchanged - Unity reads the same
 * ordering as outward under its own left-handed rule.)
 */
function emitPerVoxel(
  nx: number, ny: number, nz: number,
  solid: SolidFn, idx: IdxFn, vert: CornerVertFn, quad: QuadFn,
): void {
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (!solid(x, y, z)) continue;
        const s = idx(x, y, z);
        if (!solid(x - 1, y, z)) {
          quad(vert(x, y, z, s), vert(x, y, z + 1, s), vert(x, y + 1, z + 1, s), vert(x, y + 1, z, s));
        }
        if (!solid(x + 1, y, z)) {
          quad(vert(x + 1, y, z, s), vert(x + 1, y + 1, z, s), vert(x + 1, y + 1, z + 1, s), vert(x + 1, y, z + 1, s));
        }
        if (!solid(x, y - 1, z)) {
          quad(vert(x, y, z, s), vert(x + 1, y, z, s), vert(x + 1, y, z + 1, s), vert(x, y, z + 1, s));
        }
        if (!solid(x, y + 1, z)) {
          quad(vert(x, y + 1, z, s), vert(x, y + 1, z + 1, s), vert(x + 1, y + 1, z + 1, s), vert(x + 1, y + 1, z, s));
        }
        if (!solid(x, y, z - 1)) {
          quad(vert(x, y, z, s), vert(x, y + 1, z, s), vert(x + 1, y + 1, z, s), vert(x + 1, y, z, s));
        }
        if (!solid(x, y, z + 1)) {
          quad(vert(x, y, z + 1, s), vert(x + 1, y, z + 1, s), vert(x + 1, y + 1, z + 1, s), vert(x, y + 1, z + 1, s));
        }
      }
    }
  }
}

/**
 * Greedy meshing. For each of the six face directions, sweep the slices
 * perpendicular to it; in each slice build the 2D mask of faces that border
 * empty space, then repeatedly take the largest axis-aligned rectangle of
 * still-unclaimed mask cells anchored at the first free cell.
 *
 * The emitted surface is geometrically identical to {@link emitPerVoxel}'s -
 * the same planes, the same coverage - with one quad where there were many.
 * Which is also why it cannot be smoothed afterwards: the long thin quads have
 * no interior vertices for the Laplacian to move.
 */
function emitMerged(
  nx: number, ny: number, nz: number,
  solid: SolidFn, idx: IdxFn, vert: CornerVertFn, quad: QuadFn,
): void {
  // axis: 0 = x, 1 = y, 2 = z. For each axis the slice runs over that axis and
  // the mask spans the other two, in (u, v) order as named per axis below.
  for (let axis = 0; axis < 3; axis++) {
    const uN = axis === 0 ? ny : nx;          // x: u=y v=z | y: u=x v=z | z: u=x v=y
    const vN = axis === 2 ? ny : nz;
    const sN = axis === 0 ? nx : (axis === 1 ? ny : nz);
    const mask = new Uint8Array(uN * vN);

    for (let sign = -1; sign <= 1; sign += 2) {
      for (let sl = 0; sl < sN; sl++) {
        let any = false;
        for (let v = 0; v < vN; v++) {
          for (let u = 0; u < uN; u++) {
            let x: number, y: number, z: number;
            if (axis === 0) { x = sl; y = u; z = v; }
            else if (axis === 1) { x = u; y = sl; z = v; }
            else { x = u; y = v; z = sl; }
            const here = solid(x, y, z);
            const nbr = solid(
              x + (axis === 0 ? sign : 0),
              y + (axis === 1 ? sign : 0),
              z + (axis === 2 ? sign : 0),
            );
            const on = here && !nbr;
            mask[v * uN + u] = on ? 1 : 0;
            any = any || on;
          }
        }
        if (!any) continue;

        for (let v = 0; v < vN; v++) {
          for (let u = 0; u < uN; u++) {
            if (!mask[v * uN + u]) continue;
            let w = 1;
            while (u + w < uN && mask[v * uN + u + w]) w++;
            let h = 1;
            let grow = true;
            while (v + h < vN && grow) {
              for (let k = 0; k < w; k++) {
                if (!mask[(v + h) * uN + u + k]) { grow = false; break; }
              }
              if (grow) h++;
            }
            for (let b = 0; b < h; b++) {
              for (let a = 0; a < w; a++) mask[(v + b) * uN + u + a] = 0;
            }

            // Grid-corner extents of the claimed rectangle, and the plane it
            // sits on.
            const u0 = u, u1 = u + w, v0 = v, v1 = v + h;
            const plane = sign > 0 ? sl + 1 : sl;
            // Source voxel for bone weights: the rectangle's anchor cell.
            // Skinned runs never merge in practice (the proxy smooths
            // instead), so this only has to be defined, not representative.
            let sx: number, sy: number, sz: number;
            if (axis === 0) { sx = sl; sy = u0; sz = v0; }
            else if (axis === 1) { sx = u0; sy = sl; sz = v0; }
            else { sx = u0; sy = v0; sz = sl; }
            const src = idx(sx, sy, sz);

            // Winding matches emitPerVoxel's per-direction corner order exactly.
            if (axis === 0) {
              if (sign < 0) {
                quad(vert(plane, u0, v0, src), vert(plane, u0, v1, src),
                  vert(plane, u1, v1, src), vert(plane, u1, v0, src));
              } else {
                quad(vert(plane, u0, v0, src), vert(plane, u1, v0, src),
                  vert(plane, u1, v1, src), vert(plane, u0, v1, src));
              }
            } else if (axis === 1) {
              if (sign < 0) {
                quad(vert(u0, plane, v0, src), vert(u1, plane, v0, src),
                  vert(u1, plane, v1, src), vert(u0, plane, v1, src));
              } else {
                quad(vert(u0, plane, v0, src), vert(u0, plane, v1, src),
                  vert(u1, plane, v1, src), vert(u1, plane, v0, src));
              }
            } else {
              if (sign < 0) {
                quad(vert(u0, v0, plane, src), vert(u0, v1, plane, src),
                  vert(u1, v1, plane, src), vert(u1, v0, plane, src));
              } else {
                quad(vert(u0, v0, plane, src), vert(u1, v0, plane, src),
                  vert(u1, v1, plane, src), vert(u0, v1, plane, src));
              }
            }
          }
        }
      }
    }
  }
}

/** The eight corners of a dual cell, as `(dx, dy, dz)` bit triples. */
const CORNER = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
] as const;

/** The twelve edges joining corners that differ in exactly one axis. */
const EDGE = [
  [0, 1], [2, 3], [4, 5], [6, 7],   // along x
  [0, 2], [1, 3], [4, 6], [5, 7],   // along y
  [0, 4], [1, 5], [2, 6], [3, 7],   // along z
] as const;

/**
 * Surface Nets, the "naive" dual-contouring variant. Occupancy is sampled at
 * CELL CENTRES; every dual cell whose eight surrounding centres are not all-in
 * or all-out straddles the boundary and gets exactly one vertex, placed at the
 * centroid of the cell edges the surface crosses. Faces then join the four
 * dual cells around each sign-changing lattice edge.
 *
 * WHY THIS AND NOT MARCHING CUBES. With binary occupancy every marching-cubes
 * crossing lands at an edge midpoint, so it reproduces the staircase and needs
 * heavy smoothing to hide it - and the smoothing is what then pulls the
 * surface off the geometry. Surface Nets puts one free vertex per boundary
 * cell instead: a wall at 30 degrees comes out at 30 degrees with no smoothing
 * at all. It also produces roughly one vertex per boundary cell rather than
 * four-plus, so it is the cheaper mesh as well as the truer one.
 *
 * The vertex is confined to its own cell, so the reconstruction can never
 * wander further than one voxel from the blocky surface it came from - the
 * error stays bounded by the voxel size, which is the number being tuned.
 */
function emitSurfaceNets(
  nx: number, ny: number, nz: number,
  mnx: number, mny: number, mnz: number, voxel: number,
  solid: SolidFn, idx: IdxFn,
  addVert: (x: number, y: number, z: number, sourceVoxel: number) => number,
  quad: QuadFn,
): void {
  // Dual grid: one cell per (nx-1) x (ny-1) x (nz-1) block of lattice points.
  const dx = nx - 1, dy = ny - 1, dz = nz - 1;
  if (dx <= 0 || dy <= 0 || dz <= 0) return;

  const cellVert = new Int32Array(dx * dy * dz).fill(-1);
  const dIdx = (x: number, y: number, z: number) => (z * dy + y) * dx + x;

  const occ8 = [false, false, false, false, false, false, false, false];
  for (let z = 0; z < dz; z++) {
    for (let y = 0; y < dy; y++) {
      for (let x = 0; x < dx; x++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          const o = solid(x + CORNER[c][0], y + CORNER[c][1], z + CORNER[c][2]);
          occ8[c] = o;
          if (o) inside++;
        }
        // Wholly outside or wholly inside: no surface through this cell.
        if (inside === 0 || inside === 8) continue;

        // Centroid of the crossing edges' midpoints, in the cell's own [0,1]
        // coordinates.
        let ax = 0, ay = 0, az = 0, crossings = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGE[e][0], b = EDGE[e][1];
          if (occ8[a] === occ8[b]) continue;
          ax += (CORNER[a][0] + CORNER[b][0]) * 0.5;
          ay += (CORNER[a][1] + CORNER[b][1]) * 0.5;
          az += (CORNER[a][2] + CORNER[b][2]) * 0.5;
          crossings++;
        }
        if (crossings === 0) continue;
        ax /= crossings; ay /= crossings; az /= crossings;

        // Lattice points are cell CENTRES, hence the half-voxel offset.
        const wx = mnx + (x + 0.5 + ax) * voxel;
        const wy = mny + (y + 0.5 + ay) * voxel;
        const wz = mnz + (z + 0.5 + az) * voxel;

        // Bone weights come from a corner that is actually solid; an empty one
        // carries none.
        let src = idx(x, y, z);
        for (let c = 0; c < 8; c++) {
          if (occ8[c]) { src = idx(x + CORNER[c][0], y + CORNER[c][1], z + CORNER[c][2]); break; }
        }
        cellVert[dIdx(x, y, z)] = addVert(wx, wy, wz, src);
      }
    }
  }

  // One quad per sign-changing lattice edge, joining the four dual cells
  // around it. Each of those four straddles the boundary by construction, so
  // its vertex exists. The corner ORDER matches emitPerVoxel's winding for the
  // same face direction.
  for (let z = 1; z < nz - 1; z++) {
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const a = solid(x, y, z), b = solid(x + 1, y, z);
        if (a === b) continue;
        const v00 = cellVert[dIdx(x, y - 1, z - 1)], v10 = cellVert[dIdx(x, y, z - 1)];
        const v11 = cellVert[dIdx(x, y, z)], v01 = cellVert[dIdx(x, y - 1, z)];
        if (v00 < 0 || v10 < 0 || v11 < 0 || v01 < 0) continue;
        if (a) quad(v00, v10, v11, v01);   // solid at x: face points +x
        else quad(v00, v01, v11, v10);
      }
    }
  }
  for (let z = 1; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const a = solid(x, y, z), b = solid(x, y + 1, z);
        if (a === b) continue;
        const v00 = cellVert[dIdx(x - 1, y, z - 1)], v01 = cellVert[dIdx(x - 1, y, z)];
        const v11 = cellVert[dIdx(x, y, z)], v10 = cellVert[dIdx(x, y, z - 1)];
        if (v00 < 0 || v01 < 0 || v11 < 0 || v10 < 0) continue;
        if (a) quad(v00, v01, v11, v10);   // solid at y: face points +y
        else quad(v00, v10, v11, v01);
      }
    }
  }
  for (let z = 0; z < nz - 1; z++) {
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const a = solid(x, y, z), b = solid(x, y, z + 1);
        if (a === b) continue;
        const v00 = cellVert[dIdx(x - 1, y - 1, z)], v10 = cellVert[dIdx(x, y - 1, z)];
        const v11 = cellVert[dIdx(x, y, z)], v01 = cellVert[dIdx(x - 1, y, z)];
        if (v00 < 0 || v10 < 0 || v11 < 0 || v01 < 0) continue;
        if (a) quad(v00, v10, v11, v01);   // solid at z: face points +z
        else quad(v00, v01, v11, v10);
      }
    }
  }
}

// ── Post-processing ─────────────────────────────────────────────────────

/** `(0,1,2) (0,2,3)` per quad - the same split Unity's `Quad` helper used. */
function triangulate(quads: Uint32Array): Uint32Array {
  const faces = quads.length / 4;
  const out = new Uint32Array(faces * 6);
  for (let f = 0; f < faces; f++) {
    const a = quads[f * 4], b = quads[f * 4 + 1], c = quads[f * 4 + 2], d = quads[f * 4 + 3];
    out[f * 6] = a; out[f * 6 + 1] = b; out[f * 6 + 2] = c;
    out[f * 6 + 3] = a; out[f * 6 + 4] = c; out[f * 6 + 5] = d;
  }
  return out;
}

/**
 * `smoothIterations` passes of `v <- lerp(v, mean(neighbours), 0.5)`.
 *
 * Adjacency comes off the QUAD edges rather than the triangle edges: the
 * triangulation diagonals are an artefact of the index buffer, and feeding
 * them in would weight one corner of every quad twice and shear the surface
 * along the diagonal. The Unity original averaged the triangle list, which
 * carries that bias; it is invisible at three passes on a blocky surface and
 * this is the cheaper thing to get right than to replicate.
 *
 * Built as CSR rather than a set per vertex - a `Set<number>` per vertex is
 * what made the original allocate one object per vertex on every rebuild.
 */
function relax(positions: Float32Array, vertexCount: number, quads: Uint32Array, passes: number): void {
  const faces = quads.length / 4;

  // Pass 1: degree count, both directions of each of the four edges.
  const counts = new Uint32Array(vertexCount + 1);
  for (let f = 0; f < faces; f++) {
    for (let k = 0; k < 4; k++) {
      counts[quads[f * 4 + k]] += 2;
    }
  }
  const starts = new Uint32Array(vertexCount + 1);
  let total = 0;
  for (let i = 0; i < vertexCount; i++) { starts[i] = total; total += counts[i]; }
  starts[vertexCount] = total;

  // Pass 2: fill, then sort and unique each row so a vertex shared by many
  // faces is not counted once per face.
  const cursor = starts.slice();
  const adj = new Uint32Array(total);
  for (let f = 0; f < faces; f++) {
    const q = f * 4;
    for (let k = 0; k < 4; k++) {
      const a = quads[q + k];
      const b = quads[q + ((k + 1) & 3)];
      adj[cursor[a]++] = b;
      adj[cursor[b]++] = a;
    }
  }
  const rowEnd = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const lo = starts[i], hi = starts[i + 1];
    if (hi <= lo) { rowEnd[i] = lo; continue; }
    const row = adj.subarray(lo, hi);
    row.sort();
    let w = lo + 1;
    for (let r = lo + 1; r < hi; r++) {
      if (adj[r] !== adj[w - 1]) adj[w++] = adj[r];
    }
    rowEnd[i] = w;
  }

  const next = new Float32Array(positions.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < vertexCount; i++) {
      const lo = starts[i], hi = rowEnd[i];
      const deg = hi - lo;
      if (deg === 0) {
        next[i * 3] = positions[i * 3];
        next[i * 3 + 1] = positions[i * 3 + 1];
        next[i * 3 + 2] = positions[i * 3 + 2];
        continue;
      }
      let ax = 0, ay = 0, az = 0;
      for (let r = lo; r < hi; r++) {
        const j = adj[r] * 3;
        ax += positions[j]; ay += positions[j + 1]; az += positions[j + 2];
      }
      ax /= deg; ay /= deg; az /= deg;
      next[i * 3] = (positions[i * 3] + ax) * 0.5;
      next[i * 3 + 1] = (positions[i * 3 + 1] + ay) * 0.5;
      next[i * 3 + 2] = (positions[i * 3 + 2] + az) * 0.5;
    }
    positions.set(next);
  }
}

/**
 * Area-weighted vertex normals: accumulate each triangle's UNnormalized cross
 * product onto its three corners, then normalize once. Area weighting falls
 * out of not normalizing the cross product, and is what keeps a smoothed
 * blocky surface from over-weighting the slivers the relaxation leaves behind.
 */
function computeNormals(positions: Float32Array, indices: Uint32Array, vertexCount: number): Float32Array {
  const normals = new Float32Array(vertexCount * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const e1x = positions[b] - positions[a];
    const e1y = positions[b + 1] - positions[a + 1];
    const e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a];
    const e2y = positions[c + 1] - positions[a + 1];
    const e2z = positions[c + 2] - positions[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }
  for (let v = 0; v < vertexCount; v++) {
    const i = v * 3;
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (len > 1e-12) {
      normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len;
    } else {
      // A vertex whose faces cancel out. Up is arbitrary but finite, which is
      // what the vertex buffer needs; NaN here would poison the whole draw.
      normals[i] = 0; normals[i + 1] = 1; normals[i + 2] = 0;
    }
  }
  return normals;
}

// ── Plumbing ────────────────────────────────────────────────────────────

const now = (): number =>
  (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Drop explicitly-`undefined` fields so a caller can spread a partial settings
 * object without its holes punching through the defaults.
 */
function stripUndefined(s: ProxySettings): ProxySettings {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) if (v !== undefined) out[k] = v;
  return out as ProxySettings;
}

function emptyResult(voxelSize: number, t0: number): ProxyMeshResult {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    quads: new Uint32Array(0),
    boneIndices: null,
    boneWeights: null,
    voxelSize,
    dims: { x: 0, y: 0, z: 0 },
    origin: { x: 0, y: 0, z: 0 },
    occupiedVoxels: 0,
    splatsUsed: 0,
    vertexCount: 0,
    triangleCount: 0,
    buildMs: now() - t0,
  };
}
