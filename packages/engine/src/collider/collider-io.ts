/**
 * Getting a built collider out of the browser, in the two shapes a consumer
 * actually has a use for.
 *
 * They are not alternatives, they answer different questions:
 *
 * - **`.obj`** ({@link colliderSurfaceToObj}) - the triangulated Surface Nets
 *   surface, in world metres. This is what a game engine's collider component
 *   eats: a Unity `MeshCollider`, a Godot `ConcavePolygonShape3D`, an Unreal
 *   static mesh's complex collision, a Rapier or Ammo trimesh. It is the
 *   "export it with the environment and use it in a game" file.
 * - **`.collider.json`** ({@link encodeSceneColliderData}) - the grid itself,
 *   occupancy and all. This is what {@link SceneCollider.fromData} reloads, and
 *   it is the ONE thing the mesh cannot do: answer `groundAt` and `blocked`
 *   without a physics engine. A web app that ships a prebuilt collider loads
 *   this and skips the voxelization entirely.
 *
 * WHY OBJ AND NOT GLTF. The mesh is positions, normals and triangles - there is
 * no material, no rig, no animation and no texture for a richer container to
 * carry. OBJ is text, needs no writer library, and every tool named above
 * imports it. A `.glb` would be a binary writer and a JSON chunk for the same
 * triangles.
 *
 * WHY THE MESH IS IN WORLD METRES. So it lines up with what was on screen when
 * it was written, which is the only claim about it a reader can actually check -
 * open the `.obj` next to the capture in any DCC tool and they coincide. The
 * frame it was written at is recorded in the header comment, and
 * {@link SceneColliderData.builtFrame} carries it in the JSON, so nothing is
 * lost by not exporting in the capture's own units.
 *
 * Pure: no DOM, no fetch, no PlayCanvas. A caller turns the string into a
 * download, a file write or a fixture as it likes.
 *
 * @module
 */

import type { ProxyMeshResult } from '../proxy/voxelizer';

import type { SceneColliderData, SceneColliderStats } from './collider-grid';
import type { ColliderFrame } from './collider-grid';

/**
 * Format version of the `.collider.json` envelope.
 *
 * Separate from {@link SceneColliderData.version}, which is the in-memory
 * record's version: this one is about the FILE, and the two can move
 * independently (a base64 change is not a grid change).
 */
export const SCENE_COLLIDER_FILE_VERSION = 1;

/** The `.collider.json` envelope. Every length inside is in LOCAL units. */
export interface SceneColliderFile {
  format: 'viggle-scene-collider';
  fileVersion: number;
  /** {@link SceneColliderData.version}. */
  version: number;
  /**
   * How {@link occupancy} is packed. `rle` is what the encoder writes; `raw` is
   * read as well so a file hand-assembled from plain bytes is still valid.
   */
  occupancyEncoding: 'rle' | 'raw';
  /** The occupancy, base64 of {@link occupancyEncoding}'s bytes. */
  occupancy: string;
  dims: { x: number; y: number; z: number };
  gridOrigin: { x: number; y: number; z: number };
  voxelSize: number;
  floorRefY: number;
  bandMinY: number;
  bandMaxY: number;
  tuning: SceneColliderData['tuning'];
  builtFrame: ColliderFrame;
  stats: SceneColliderStats;
}

/**
 * A built grid as `.collider.json` text.
 *
 * Base64 rather than an array of numbers: a grid is BYTES, and JSON digits would
 * be about twice their size before whitespace. It also survives a round trip
 * through any JSON parser unchanged, which a typed-array-shaped object does not.
 *
 * Run-length encoded before that, because a walkable grid is overwhelmingly
 * empty and it is not close: a band-cropped city comes out around 2 million
 * cells with 32 thousand of them solid, so raw base64 is megabytes of zeros.
 * The runs are the whole of it - see {@link rleEncode}.
 */
export function encodeSceneColliderData(data: SceneColliderData): string {
  const file: SceneColliderFile = {
    format: 'viggle-scene-collider',
    fileVersion: SCENE_COLLIDER_FILE_VERSION,
    version: data.version,
    occupancyEncoding: 'rle',
    occupancy: toBase64(rleEncode(data.occupancy)),
    dims: data.dims,
    gridOrigin: data.gridOrigin,
    voxelSize: data.voxelSize,
    floorRefY: data.floorRefY,
    bandMinY: data.bandMinY,
    bandMaxY: data.bandMaxY,
    tuning: data.tuning,
    builtFrame: data.builtFrame,
    stats: data.stats,
  };
  return JSON.stringify(file);
}

/**
 * `.collider.json` text back into a record {@link SceneCollider.fromData} takes.
 *
 * Validated rather than trusted: a file is an input, and a grid whose occupancy
 * does not match its dims would index out of bounds on the first query with no
 * error anywhere near the cause.
 *
 * @throws when the text is not this format, is a version this build does not
 *   read, or is internally inconsistent.
 */
export function decodeSceneColliderData(text: string): SceneColliderData {
  let file: Partial<SceneColliderFile>;
  try {
    file = JSON.parse(text) as Partial<SceneColliderFile>;
  } catch (err) {
    throw new Error(`[decodeSceneColliderData] not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (file?.format !== 'viggle-scene-collider') {
    throw new Error('[decodeSceneColliderData] not a viggle-scene-collider file');
  }
  if (file.fileVersion !== SCENE_COLLIDER_FILE_VERSION) {
    throw new Error(
      `[decodeSceneColliderData] file version ${String(file.fileVersion)}, this build reads `
      + `${SCENE_COLLIDER_FILE_VERSION}`,
    );
  }
  const dims = file.dims;
  if (!dims || !file.occupancy || !file.gridOrigin || !file.builtFrame || !file.tuning || !file.stats) {
    throw new Error('[decodeSceneColliderData] the file is missing required fields');
  }
  const packed = fromBase64(file.occupancy);
  const cells = dims.x * dims.y * dims.z;
  const occupancy = file.occupancyEncoding === 'raw' ? packed : rleDecode(packed, cells);
  if (occupancy.length !== cells) {
    throw new Error(
      `[decodeSceneColliderData] occupancy is ${occupancy.length} bytes for a `
      + `${dims.x}x${dims.y}x${dims.z} grid (${cells} cells)`,
    );
  }
  return {
    version: 1,
    occupancy,
    dims,
    gridOrigin: file.gridOrigin,
    voxelSize: file.voxelSize!,
    floorRefY: file.floorRefY!,
    bandMinY: file.bandMinY!,
    bandMaxY: file.bandMaxY!,
    tuning: file.tuning,
    builtFrame: file.builtFrame,
    stats: file.stats,
  };
}

/** Options for {@link colliderSurfaceToObj}. */
export interface ColliderObjOptions {
  /** Object name written as `o <name>`. Default `scene-collider`. */
  name?: string;
  /**
   * Write vertex normals. Default `true`. A collider does not need them and they
   * roughly double the file; they are on because the same file is the one a
   * reader opens in a DCC tool to check it, and a normal-less OBJ shades flat
   * grey there.
   */
  normals?: boolean;
  /**
   * Decimal places on every coordinate. Default `4`, i.e. 0.1 mm - two orders
   * finer than the voxel size that produced the surface, so it is exact for
   * every purpose and a third shorter than the default float printing.
   */
  precision?: number;
  /** Lines written above the geometry as `# ...`, for provenance. */
  header?: string[];
}

/**
 * A surface as Wavefront OBJ text, transformed by `frame` into world metres.
 *
 * `surface` must be the result of `SceneCollider.surface()` - the SAME call the
 * on-screen view draws - which is what makes the file and the picture the same
 * geometry rather than two things built the same way.
 */
export function colliderSurfaceToObj(
  surface: ProxyMeshResult,
  frame: ColliderFrame,
  options: ColliderObjOptions = {},
): string {
  const name = options.name ?? 'scene-collider';
  const withNormals = options.normals ?? true;
  const p = Math.max(0, Math.min(8, Math.round(options.precision ?? 4)));
  const s = frame.scale;
  const ox = frame.origin.x, oy = frame.origin.y, oz = frame.origin.z;

  const out: string[] = [];
  for (const line of options.header ?? []) out.push(`# ${line}`);
  out.push(`# ${surface.vertexCount} vertices, ${surface.triangleCount} triangles`);
  out.push(`o ${name}`);

  const pos = surface.positions;
  for (let v = 0; v < surface.vertexCount; v++) {
    out.push(
      `v ${(ox + pos[v * 3] * s).toFixed(p)} `
      + `${(oy + pos[v * 3 + 1] * s).toFixed(p)} `
      + `${(oz + pos[v * 3 + 2] * s).toFixed(p)}`,
    );
  }
  if (withNormals) {
    const n = surface.normals;
    // Normals are direction, so the frame's translation does not apply and its
    // UNIFORM scale cancels on renormalization - they go out unchanged.
    for (let v = 0; v < surface.vertexCount; v++) {
      out.push(`vn ${n[v * 3].toFixed(4)} ${n[v * 3 + 1].toFixed(4)} ${n[v * 3 + 2].toFixed(4)}`);
    }
  }

  const idx = surface.indices;
  for (let t = 0; t < idx.length; t += 3) {
    // OBJ indices are 1-based.
    const a = idx[t] + 1, b = idx[t + 1] + 1, c = idx[t + 2] + 1;
    out.push(withNormals ? `f ${a}//${a} ${b}//${b} ${c}//${c}` : `f ${a} ${b} ${c}`);
  }
  out.push('');
  return out.join('\n');
}

/**
 * Alternating run lengths as LEB128 varints, starting with a run of EMPTY cells.
 *
 * A cell is solid or it is not, so the array is a bit field stored a byte at a
 * time and the runs are all there is to say about it. A zero-length first run
 * covers a grid that starts solid, so no flag is needed anywhere and the decoder
 * never has to ask which phase it is in.
 *
 * On the shipped captures this is a 40x to 60x reduction, and it degrades
 * gracefully: the worst case - alternating single cells - is one byte per cell,
 * the same as raw.
 */
function rleEncode(occ: Uint8Array): Uint8Array {
  const out: number[] = [];
  const pushVarint = (v: number) => {
    let n = v;
    while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
    out.push(n);
  };
  let i = 0;
  let want = 0;
  while (i < occ.length) {
    let run = 0;
    while (i + run < occ.length && (occ[i + run] !== 0 ? 1 : 0) === want) run++;
    pushVarint(run);
    i += run;
    want = want === 0 ? 1 : 0;
  }
  return new Uint8Array(out);
}

/** The inverse of {@link rleEncode}. `cells` is what the runs must add up to. */
function rleDecode(packed: Uint8Array, cells: number): Uint8Array {
  const out = new Uint8Array(cells);
  let at = 0;
  let value = 0;
  let i = 0;
  while (i < packed.length) {
    let run = 0;
    let shift = 0;
    for (;;) {
      if (i >= packed.length) throw new Error('[decodeSceneColliderData] truncated run length');
      const b = packed[i++];
      run |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new Error('[decodeSceneColliderData] run length out of range');
    }
    if (at + run > cells) {
      throw new Error(`[decodeSceneColliderData] runs overrun the grid at cell ${at + run} of ${cells}`);
    }
    if (value) out.fill(1, at, at + run);
    at += run;
    value = value === 0 ? 1 : 0;
  }
  if (at !== cells) {
    throw new Error(`[decodeSceneColliderData] runs cover ${at} cells, the grid has ${cells}`);
  }
  return out;
}

/** Standard base64 of a byte array, without depending on Node's Buffer. */
function toBase64(bytes: Uint8Array): string {
  // Chunked: `String.fromCharCode(...bytes)` on a 300k-byte grid blows the
  // argument limit and throws, which is the kind of failure that only shows up
  // on the big capture someone actually wanted to export.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** The inverse of {@link toBase64}. */
function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
