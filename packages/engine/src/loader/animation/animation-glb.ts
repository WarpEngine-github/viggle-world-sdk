import type { SkeletalKeyframeEntry } from '../../animation';
import { BONE_NAMES, SKELETON_1185_NAMES } from '../skeleton/skeleton-data';
import { BONE_NAMES_441 } from '../skeleton/skeleton-data-441';

/**
 * Decoded contents of an *armature GLB* - a glTF 2.0 binary carrying a bone
 * hierarchy, a skin, and one animation clip. Produced by the offline MetaHuman
 * GLB exporter, and readable back after a Blender round-trip.
 *
 * @internal
 */
export interface ArmatureGlbAnimation {
  /** Per-bone keys, every bone keyed on every frame. The frames array is shared. */
  keyframes: Map<number, SkeletalKeyframeEntry>;
  numFrames: number;
  numBones: number;
  /** Bone names in bone-index order (canonical rig order when recognised). */
  boneNames: string[];
  /**
   * Per bone: `1` if the clip drives that bone's translation, `0` if the bone
   * must inherit the armature's rest translation. `undefined` when every bone
   * is driven - which is what a `.anim` file means, since that format cannot
   * say anything else.
   *
   * Derived from the DATA, not from which channels exist: a translation
   * channel whose keys are all equal declares a rest pose, and a channel that
   * varies is motion. See {@link parseArmatureGlbAnimation}.
   */
  translationMask?: Uint8Array;
  /** Source frame rate derived from the main timestamp accessor. */
  frameRate: number;
  /** Clip name as stored in the GLB. */
  animationName: string;
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942;  // 'BIN\0'
const COMPONENT_FLOAT = 5126;
const COMPONENT_SHORT = 5122;
const COMPONENTS_PER_TYPE: Record<string, number> = { SCALAR: 1, VEC3: 3, VEC4: 4 };
/** glTF 2.0 dequantization divisor for `normalized: true` SHORT. */
const SHORT_SCALE = 32767;

/** Minimal shape of the glTF JSON fields this reader consumes. */
interface Gltf {
  asset?: { version?: string };
  nodes?: Array<{ name?: string; translation?: number[] }>;
  skins?: Array<{ joints?: number[] }>;
  accessors?: Array<{
    bufferView?: number;
    byteOffset?: number;
    componentType?: number;
    normalized?: boolean;
    count?: number;
    type?: string;
  }>;
  bufferViews?: Array<{ byteOffset?: number; byteLength?: number; byteStride?: number }>;
  animations?: Array<{
    name?: string;
    samplers: Array<{ input: number; output: number; interpolation?: string }>;
    channels: Array<{ sampler: number; target: { node?: number; path: string } }>;
  }>;
}

/**
 * Split a `.glb` container into its JSON chunk and its binary chunk.
 *
 * @throws If the magic, version or chunk layout is not glTF 2.0 binary.
 */
function splitGlb(buffer: ArrayBuffer): { json: Gltf; binOffset: number; binLength: number } {
  if (buffer.byteLength < 20) throw new Error('Not a GLB: file is too short');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('Not a GLB: bad magic');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`Unsupported GLB version ${version} (expected 2)`);

  let json: Gltf | null = null;
  let binOffset = -1;
  let binLength = 0;

  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (dataStart + chunkLength > buffer.byteLength) throw new Error('Corrupt GLB: chunk overruns file');

    if (chunkType === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, dataStart, chunkLength))) as Gltf;
    } else if (chunkType === CHUNK_BIN) {
      binOffset = dataStart;
      binLength = chunkLength;
    }
    offset = dataStart + chunkLength;
  }

  if (!json) throw new Error('Corrupt GLB: no JSON chunk');
  if (binOffset < 0) throw new Error('GLB has no BIN chunk - external buffers are not supported');
  return { json, binOffset, binLength };
}

/**
 * Read accessor `index` as a flat `Float32Array` of `count * components`.
 *
 * Two encodings are accepted, matching what the MetaHuman GLB exporter
 * emits: plain FLOAT, and `normalized: true` SHORT, dequantized per the glTF
 * rule `f = max(c / 32767, -1)`. Anything else throws by name rather than
 * being reinterpreted as float garbage.
 *
 * Accessors may share a bufferView and address their slice with `byteOffset`.
 * FLOAT takes a zero-copy view when 4-byte aligned (the writer guarantees it);
 * the unaligned path and every SHORT path copy.
 */
function readFloatAccessor(
  json: Gltf,
  buffer: ArrayBuffer,
  binOffset: number,
  index: number,
  expectedType: string,
): Float32Array {
  const accessor = json.accessors?.[index];
  if (!accessor) throw new Error(`GLB accessor ${index} is missing`);
  if (accessor.type !== expectedType) {
    throw new Error(`GLB accessor ${index} must be ${expectedType} (got ${accessor.type})`);
  }
  if (accessor.bufferView === undefined) {
    throw new Error(`GLB accessor ${index} has no bufferView - sparse accessors are not supported`);
  }
  const bufferView = json.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new Error(`GLB bufferView ${accessor.bufferView} is missing`);
  if (bufferView.byteStride !== undefined && bufferView.byteStride !== 0) {
    throw new Error('Interleaved (byteStride) animation accessors are not supported');
  }

  const components = COMPONENTS_PER_TYPE[expectedType];
  const count = accessor.count ?? 0;
  const length = count * components;
  const start = binOffset + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);

  if (accessor.componentType === COMPONENT_SHORT) {
    if (!accessor.normalized) {
      throw new Error(`GLB accessor ${index} is SHORT but not normalized - refusing to guess a scale`);
    }
    if (start + length * 2 > buffer.byteLength) {
      throw new Error(`GLB accessor ${index} overruns the BIN chunk`);
    }
    const raw = (start & 1) === 0
      ? new Int16Array(buffer, start, length)
      : new Int16Array(buffer.slice(start, start + length * 2));
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = Math.max(raw[i] / SHORT_SCALE, -1);
    return out;
  }

  if (accessor.componentType !== COMPONENT_FLOAT) {
    throw new Error(
      `GLB accessor ${index} must be FLOAT or normalized SHORT (got componentType ${accessor.componentType})`,
    );
  }
  if (start + length * 4 > buffer.byteLength) {
    throw new Error(`GLB accessor ${index} overruns the BIN chunk`);
  }
  if ((start & 3) === 0) return new Float32Array(buffer, start, length);
  // Unaligned: copy into a fresh buffer so the typed-array view is legal.
  return new Float32Array(buffer.slice(start, start + length * 4));
}

/** Rigs the engine knows by name. Order inside each table IS the bone order. */
const KNOWN_RIGS: readonly (readonly string[])[] = [BONE_NAMES, BONE_NAMES_441, SKELETON_1185_NAMES];

/**
 * If `jointNames` is one of the engine's known rigs, return the permutation
 * that puts it in that rig's canonical order (`order[bone]` indexes
 * `jointNames`). Returns `null` when no rig matches, in which case the file's
 * own joint order stands.
 *
 * This matters because downstream `filterAnimationForArmature` resolves rigs by
 * NAME but assumes source bone index order matches the engine's table. A
 * Blender round-trip is free to reorder joints, so index order cannot be
 * trusted - the name set can.
 */
function canonicalBoneOrder(jointNames: string[]): number[] | null {
  const indexByName = new Map<string, number>();
  for (let i = 0; i < jointNames.length; i++) indexByName.set(jointNames[i], i);
  if (indexByName.size !== jointNames.length) return null; // duplicate names

  for (const table of KNOWN_RIGS) {
    if (table.length !== jointNames.length) continue;
    const order: number[] = [];
    for (const name of table) {
      const i = indexByName.get(name);
      if (i === undefined) break;
      order.push(i);
    }
    if (order.length === table.length) return order;
  }
  return null;
}

/**
 * How a sampler's output is laid out, per its interpolation mode.
 *
 * CUBICSPLINE stores `[inTangent, value, outTangent]` per keyframe. The Hermite
 * spline passes exactly through `value` at the key's own time, and this reader
 * samples only at key times, so taking the middle element is exact rather than
 * an approximation. Reading it as LINEAR would consume tangents as poses and
 * produce a plausible-but-wrong result, which is why the mode is resolved
 * explicitly and anything unrecognised throws.
 */
function samplerLayout(
  interpolation: string | undefined,
  label: string,
): { stride: number; offset: number; step: boolean } {
  switch (interpolation ?? 'LINEAR') {
    case 'LINEAR':
      return { stride: 1, offset: 0, step: false };
    case 'STEP':
      return { stride: 1, offset: 0, step: true };
    case 'CUBICSPLINE':
      return { stride: 3, offset: 1, step: false };
    default:
      throw new Error(`${label} uses unsupported interpolation "${interpolation}"`);
  }
}

/** One decoded animation channel, with its own timeline. */
interface DecodedChannel {
  values: Float32Array;
  times: Float32Array;
  keys: number;
  stride: number;
  offset: number;
  comps: number;
  step: boolean;
  /** True when key `i` is exactly frame `i` of the main timeline. */
  aligned: boolean;
}

/** Component `c` of keyframe `k`. */
function keyValue(ch: DecodedChannel, k: number, c: number): number {
  return ch.values[(k * ch.stride + ch.offset) * ch.comps + c];
}

/**
 * How far a translation channel may wander and still count as a declaration of
 * rest rather than motion: 10 µm.
 *
 * The distinction cannot be drawn from channel *presence*, because a
 * conformant writer emits a channel for every bone and Blender re-exports
 * dense channels for everything it imports. It is drawn from the values, which
 * survive that round trip: a constant track stays constant however densely it
 * is written.
 *
 * The bound is empirical and has room on both sides. Below it: a Blender
 * 4.2.18 import→export of our own files re-derives every bone through its own
 * matrix pipeline and perturbs a constant translation by at most 7.96e-7 m,
 * 12x under this. Above it: the smallest genuinely moving channel in the same
 * files drifts 3.06e-4 m, 30x over. The writer's own collapse threshold
 * (the exporter's own `TRANSLATION_EPS`, 1e-6 m) sits inside
 * that gap too, so everything it calls constant still reads as constant here,
 * before and after a round trip.
 *
 * Shared with the `.anim` reader ({@link Animation.parse}), which asks the same
 * question of the same quantity, so one number keeps the two formats from ever
 * disagreeing about what "constant" means. It has even more room there: a v3
 * `.anim` stores float16, whose decode is deterministic, so a constant track
 * comes back bit-identical (deviation exactly 0) while the smallest moving bone
 * across `test_full` / `test_stripped` / `test_blend_*` drifts 2.69e-4 m. Motion
 * finer than this bound is not representable at bone-offset magnitudes in
 * float16 anyway (one ulp at 0.4 m is 2.4e-4 m), so it has already been
 * quantized flat before the test sees it.
 *
 * @internal
 */
export const CONSTANT_TRANSLATION_EPS = 1e-5;

/**
 * The same test for scale, which is dimensionless, so the tolerance stands
 * against the identity it is being compared with. 1e-4 is far above float32
 * noise - Blender writes a scale channel for every bone it exports and ours
 * come back within 3.6e-7 of `1,1,1` - and far below any scale a rig author
 * would notice.
 */
const CONSTANT_SCALE_EPS = 1e-4;

/**
 * True when every key of `ch` sits within `eps` of the first - i.e. the channel
 * holds one value for the whole clip.
 *
 * For CUBICSPLINE the tangents are checked too: equal values with a non-zero
 * tangent still bulge between keys, so that is motion, not a constant.
 */
function isConstantChannel(ch: DecodedChannel, eps: number): boolean {
  for (let c = 0; c < ch.comps; c++) {
    const first = keyValue(ch, 0, c);
    for (let k = 1; k < ch.keys; k++) {
      if (Math.abs(keyValue(ch, k, c) - first) > eps) return false;
    }
  }
  if (ch.stride === 3) {
    for (let k = 0; k < ch.keys; k++) {
      for (let c = 0; c < ch.comps; c++) {
        if (Math.abs(ch.values[(k * 3) * ch.comps + c]) > eps) return false;      // inTangent
        if (Math.abs(ch.values[(k * 3 + 2) * ch.comps + c]) > eps) return false;  // outTangent
      }
    }
  }
  return true;
}

/**
 * Evaluate a channel at time `t` into `out`.
 *
 * Needed because a channel is not obliged to share the main timeline: Blender
 * collapses a constant track to two STEP keys on a two-entry timeline of its
 * own, and hand-authored files may key anything anywhere. Resampling here is
 * what lets frame `f` mean one instant across every bone downstream.
 */
function evalChannel(ch: DecodedChannel, t: number, out: Float32Array): void {
  const n = ch.keys;
  if (n === 1 || t <= ch.times[0]) {
    for (let c = 0; c < ch.comps; c++) out[c] = keyValue(ch, 0, c);
    return;
  }
  if (t >= ch.times[n - 1]) {
    for (let c = 0; c < ch.comps; c++) out[c] = keyValue(ch, n - 1, c);
    return;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ch.times[mid] <= t) lo = mid; else hi = mid;
  }
  const t0 = ch.times[lo];
  const t1 = ch.times[lo + 1];
  const dt = t1 - t0;
  const u = dt > 0 ? (t - t0) / dt : 0;

  if (ch.stride === 3) {
    // CUBICSPLINE: Hermite between the two keys, using key `lo`'s outTangent
    // and key `lo+1`'s inTangent. Tangents are stored scaled by 1/dt.
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    for (let c = 0; c < ch.comps; c++) {
      const p0 = ch.values[(lo * 3 + 1) * ch.comps + c];
      const m0 = ch.values[(lo * 3 + 2) * ch.comps + c] * dt;
      const p1 = ch.values[((lo + 1) * 3 + 1) * ch.comps + c];
      const m1 = ch.values[((lo + 1) * 3) * ch.comps + c] * dt;
      out[c] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
    }
    return;
  }
  if (ch.step) {
    for (let c = 0; c < ch.comps; c++) out[c] = keyValue(ch, lo, c);
    return;
  }
  // LINEAR. Quaternions get a sign fix so the short way round is taken; the
  // caller renormalizes, which turns this into an nlerp.
  let sign = 1;
  if (ch.comps === 4) {
    let dot = 0;
    for (let c = 0; c < 4; c++) dot += keyValue(ch, lo, c) * keyValue(ch, lo + 1, c);
    if (dot < 0) sign = -1;
  }
  for (let c = 0; c < ch.comps; c++) {
    const a = keyValue(ch, lo, c);
    const b = keyValue(ch, lo + 1, c) * sign;
    out[c] = a + (b - a) * u;
  }
}

function decodeChannel(
  json: Gltf,
  buffer: ArrayBuffer,
  binOffset: number,
  sampler: { input: number; output: number; interpolation?: string },
  type: 'VEC3' | 'VEC4',
  label: string,
  mainInput: number,
  numFrames: number,
): DecodedChannel {
  const { stride, offset, step } = samplerLayout(sampler.interpolation, label);
  const comps = COMPONENTS_PER_TYPE[type];
  const values = readFloatAccessor(json, buffer, binOffset, sampler.output, type);
  const times = readFloatAccessor(json, buffer, binOffset, sampler.input, 'SCALAR');
  const keys = values.length / comps / stride;
  if (!Number.isInteger(keys) || keys !== times.length) {
    throw new Error(
      `${label} has ${values.length / comps} output elements for ${times.length} timestamps `
      + `(interpolation ${sampler.interpolation ?? 'LINEAR'})`,
    );
  }
  if (keys === 0) throw new Error(`${label} has no keyframes`);
  const aligned = sampler.input === mainInput && keys === numFrames;
  return { values, times, keys, stride, offset, comps, step, aligned };
}

/**
 * Parse an armature GLB into the per-bone keys {@link Animation} plays from.
 *
 * **Bones are resolved by NAME, never by node index.** The joint set comes from
 * `skins[0].joints` when a skin is present (files we write, and anything
 * Blender exports), falling back to "every node is a bone" for older files
 * that carried no skin. If the joint names match one of the engine's known rigs the bones are
 * re-ordered into that rig's canonical order; otherwise the file's joint order
 * stands. Nodes that are not joints - the armature parent, mesh nodes, cameras,
 * anything a DCC tool adds - are ignored, and so are channels targeting them.
 *
 * What it accepts:
 *
 *  - `translation`, `rotation` and `scale` channels; `weights` is ignored,
 *    there being no morph targets on an armature.
 *  - Rotations as FLOAT or `normalized: true` SHORT (dequantized + renormalized).
 *  - `LINEAR`, `STEP` and `CUBICSPLINE` samplers. Other modes throw by name.
 *  - Per-channel timelines: each sampler rides either the main timeline - the
 *    longest, so frame `f` is the same instant for every bone - or a one-key
 *    timeline of its own, meaning a constant channel held for the whole clip.
 *  - Accessors sharing one bufferView via `byteOffset`, and absent `min`/`max`.
 *
 * What it requires: exactly one rotation channel per bone, timestamps on a
 * uniform grid (the engine indexes animations by frame, so key `i` must be
 * frame `i`), and no duplicate channels.
 *
 * **Constant translation is a rest declaration, not motion.** A translation
 * channel whose keys are all equal (within {@link CONSTANT_TRANSLATION_EPS})
 * states the rig's own bone length; a channel that varies is real motion -
 * root motion at the pelvis, and the face, which is translation-driven. The
 * former is reported through {@link ArmatureGlbAnimation.translationMask} as a
 * `0`, so playback keeps the TARGET character's rest translation and its limbs
 * do not resize mid-clip. On our own clips that lands on 85 of 441 bones
 * without a single bone name being mentioned anywhere.
 *
 * The test reads the data rather than the channel list on purpose. Absence
 * could carry the same message, but only in a file nobody has touched: a
 * conformant reader is entitled to use `nodes[b].translation` when a channel
 * is missing, and Blender re-exports dense channels for every bone, which
 * erases the distinction. Constancy survives both. Files that genuinely omit
 * the channel - everything written before 2026-08 - are still read the old
 * way, as `0`.
 *
 * Scale gets the same treatment, and resolves at parse time: a constant scale
 * is a rest declaration, and every rig this engine builds rests at scale
 * `1,1,1`, so a constant channel simply resolves to identity here and needs no
 * mask of its own. A varying scale is honoured. Our writers emit no scale
 * channels at all, so this only ever fires for a bone somebody scaled by hand
 * in a DCC tool.
 *
 * @throws If the container, the layout, or an accessor is invalid.
 * @internal
 */
export function parseArmatureGlbAnimation(
  buffer: ArrayBuffer,
  animationName?: string,
): ArmatureGlbAnimation {
  const { json, binOffset } = splitGlb(buffer);

  const declaredVersion = json.asset?.version;
  if (declaredVersion !== undefined && !declaredVersion.startsWith('2')) {
    throw new Error(`Unsupported glTF asset version "${declaredVersion}"`);
  }

  const nodes = json.nodes ?? [];
  if (nodes.length === 0) throw new Error('Armature GLB has no nodes');

  // Joint set: the skin when there is one, otherwise every node (the skinless
  // layout this loader shipped with, before the skin was added for Blender).
  const skin = json.skins?.[0];
  let jointNodes = skin?.joints;
  if (jointNodes === undefined) {
    jointNodes = Array.from({ length: nodes.length }, (_, i) => i);
  }
  if (jointNodes.length === 0) throw new Error('Armature GLB skin has no joints');
  for (const node of jointNodes) {
    if (node < 0 || node >= nodes.length) throw new Error(`Skin references node ${node}, out of range`);
  }

  const jointNames = jointNodes.map((node, i) => nodes[node].name ?? `#${i}`);
  const order = canonicalBoneOrder(jointNames);
  const boneToNode = order
    ? order.map((jointIdx) => jointNodes[jointIdx])
    : jointNodes.slice();
  const numBones = boneToNode.length;
  // Bone order, which is canonical order when the rig was recognised.
  const boneNames = boneToNode.map((node, i) => nodes[node].name ?? `#${i}`);
  const nodeToBone = new Map<number, number>();
  boneToNode.forEach((node, bone) => nodeToBone.set(node, bone));

  const animations = json.animations ?? [];
  if (animations.length === 0) throw new Error('Armature GLB has no animations');
  const animation = animationName === undefined
    ? animations[0]
    : animations.find((a) => a.name === animationName);
  if (!animation) {
    const available = animations.map((a) => a.name ?? '<unnamed>').join(', ');
    throw new Error(`Animation "${animationName}" not found in GLB (have: ${available})`);
  }

  // Resolve channels by target. Channels aimed at non-joint nodes are skipped,
  // not fatal - a DCC tool may animate the armature object or a camera.
  const translationOf = new Int32Array(numBones).fill(-1);
  const rotationOf = new Int32Array(numBones).fill(-1);
  const scaleOf = new Int32Array(numBones).fill(-1);
  for (const channel of animation.channels) {
    const node = channel.target.node;
    if (node === undefined) continue;
    const bone = nodeToBone.get(node);
    if (bone === undefined) continue;
    const sampler = animation.samplers[channel.sampler];
    if (!sampler) throw new Error(`Animation channel references missing sampler ${channel.sampler}`);
    const slot = channel.target.path === 'translation' ? translationOf
      : channel.target.path === 'rotation' ? rotationOf
        : channel.target.path === 'scale' ? scaleOf
          : null;                                 // 'weights' ignored - no morph targets here
    if (slot === null) continue;
    if (slot[bone] >= 0) {
      throw new Error(`Bone ${bone} ("${boneNames[bone]}") has two ${channel.target.path} channels`);
    }
    slot[bone] = channel.sampler;
  }

  // A rotation channel is mandatory; translation and scale are not. The mask is
  // filled in below, once each channel has been decoded and can be asked
  // whether it varies - absence is only one of the two ways a bone ends up
  // inheriting its rest translation.
  const translationMask = new Uint8Array(numBones);
  let restBones = 0;
  for (let bone = 0; bone < numBones; bone++) {
    if (rotationOf[bone] < 0) {
      throw new Error(`Bone ${bone} ("${boneNames[bone]}") is missing a rotation channel`);
    }
  }

  // The main timeline is the longest sampler input. Constant channels ride a
  // one-key timeline of their own; anything else would make frame `f` mean
  // different instants for different bones.
  let timeAccessor = -1;
  let numFrames = 0;
  for (const sampler of animation.samplers) {
    const count = json.accessors?.[sampler.input]?.count ?? 0;
    if (count > numFrames) {
      numFrames = count;
      timeAccessor = sampler.input;
    }
  }
  if (timeAccessor < 0 || numFrames === 0) throw new Error('Animation has no keyframes');

  const times = readFloatAccessor(json, buffer, binOffset, timeAccessor, 'SCALAR');
  const span = numFrames > 1 ? times[numFrames - 1] - times[0] : 0;
  const frameRate = span > 0 ? (numFrames - 1) / span : 30;

  // Playback is frame-indexed: key `i` must BE frame `i`. A non-uniform grid
  // would still load, but every frame after the first irregular key would sit
  // at the wrong instant, so refuse it instead.
  if (numFrames > 2 && span > 0) {
    const step = span / (numFrames - 1);
    let worst = 0;
    for (let i = 0; i < numFrames; i++) {
      worst = Math.max(worst, Math.abs(times[i] - (times[0] + i * step)));
    }
    if (worst > step * 0.5) {
      throw new Error(
        `Animation timestamps are not on a uniform grid (off by up to ${worst.toFixed(4)}s `
        + `against a ${step.toFixed(4)}s step); resampling is not supported`,
      );
    }
  }

  // Parent-local TRS per bone; every bone shares one frames array.
  const frames = new Float32Array(numFrames);
  for (let frame = 0; frame < numFrames; frame++) frames[frame] = frame;
  const keyframes = new Map<number, SkeletalKeyframeEntry>();
  const scratch = new Float32Array(4);

  for (let bone = 0; bone < numBones; bone++) {
    const name = boneNames[bone];
    const rot = decodeChannel(
      json, buffer, binOffset, animation.samplers[rotationOf[bone]], 'VEC4',
      `Bone ${bone} ("${name}") rotation`, timeAccessor, numFrames,
    );
    const trans = translationOf[bone] >= 0
      ? decodeChannel(
        json, buffer, binOffset, animation.samplers[translationOf[bone]], 'VEC3',
        `Bone ${bone} ("${name}") translation`, timeAccessor, numFrames,
      )
      : null;
    let scaleCh = scaleOf[bone] >= 0
      ? decodeChannel(
        json, buffer, binOffset, animation.samplers[scaleOf[bone]], 'VEC3',
        `Bone ${bone} ("${name}") scale`, timeAccessor, numFrames,
      )
      : null;

    // Here is the whole decision. A channel that varies drives the bone; a
    // channel that holds still is stating the source rig's rest, which the
    // target character's own rest must override.
    if (trans !== null && !isConstantChannel(trans, CONSTANT_TRANSLATION_EPS)) {
      translationMask[bone] = 1;
    } else {
      restBones++;
    }
    // A constant scale resolves to identity right here rather than to a mask:
    // every rig the engine builds rests at scale 1,1,1 (see `Skeleton.restPose`),
    // so there is no per-character value to defer to and nothing to carry.
    if (scaleCh !== null && isConstantChannel(scaleCh, CONSTANT_SCALE_EPS)) scaleCh = null;

    // Every key needs a translation. A present channel is used verbatim, as a
    // conformant glTF reader would, and `translationMask` overrides it at
    // playback. Without one (files written before 2026-08) the node's rest
    // translation stands in.
    const rest = nodes[boneToNode[bone]].translation;
    const restX = rest?.[0] ?? 0;
    const restY = rest?.[1] ?? 0;
    const restZ = rest?.[2] ?? 0;

    const positions = new Float32Array(numFrames * 3);
    const rotations = new Float32Array(numFrames * 4);
    const scales = new Float32Array(numFrames * 3).fill(1);
    for (let frame = 0; frame < numFrames; frame++) {
      const t = times[frame];
      const o3 = frame * 3;
      if (!trans) {
        positions[o3] = restX; positions[o3 + 1] = restY; positions[o3 + 2] = restZ;
      } else if (trans.aligned) {
        const i = (frame * trans.stride + trans.offset) * trans.comps;
        positions[o3] = trans.values[i]; positions[o3 + 1] = trans.values[i + 1]; positions[o3 + 2] = trans.values[i + 2];
      } else {
        evalChannel(trans, t, scratch);
        positions[o3] = scratch[0]; positions[o3 + 1] = scratch[1]; positions[o3 + 2] = scratch[2];
      }

      if (scaleCh?.aligned) {
        const i = (frame * scaleCh.stride + scaleCh.offset) * scaleCh.comps;
        scales[o3] = scaleCh.values[i]; scales[o3 + 1] = scaleCh.values[i + 1]; scales[o3 + 2] = scaleCh.values[i + 2];
      } else if (scaleCh) {
        evalChannel(scaleCh, t, scratch);
        scales[o3] = scratch[0]; scales[o3 + 1] = scratch[1]; scales[o3 + 2] = scratch[2];
      }

      // glTF stores quaternions xyzw, the same order as playcanvas Quat.
      // Dequantized int16 and interpolated values sit slightly off the unit
      // sphere - renormalize. A no-op for an already-unit FLOAT quaternion.
      let x: number, y: number, z: number, w: number;
      if (rot.aligned) {
        const j = (frame * rot.stride + rot.offset) * rot.comps;
        x = rot.values[j]; y = rot.values[j + 1]; z = rot.values[j + 2]; w = rot.values[j + 3];
      } else {
        evalChannel(rot, t, scratch);
        x = scratch[0]; y = scratch[1]; z = scratch[2]; w = scratch[3];
      }
      const len = Math.sqrt(x * x + y * y + z * z + w * w);
      const o4 = frame * 4;
      if (len === 0) {
        rotations[o4 + 3] = 1;
      } else {
        rotations[o4] = x / len; rotations[o4 + 1] = y / len; rotations[o4 + 2] = z / len; rotations[o4 + 3] = w / len;
      }
    }
    keyframes.set(bone, { frames, positions, rotations, scales });
  }

  return {
    keyframes,
    numFrames,
    numBones,
    boneNames,
    // Every bone genuinely translates: say nothing, which is what `.anim` means
    // and what every consumer already treats as "drive them all".
    translationMask: restBones === 0 ? undefined : translationMask,
    frameRate,
    animationName: animation.name ?? '<unnamed>',
  };
}
