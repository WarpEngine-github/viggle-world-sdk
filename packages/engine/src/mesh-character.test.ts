import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { GraphNode, Quat } from 'playcanvas';

import { Animation } from './animation.ts';
import type { SkeletalKeyframeEntry } from './animation.ts';
import type { Armature } from './armature.ts';
import { loadSkeletonLibrary } from './loader/skeleton/index.ts';
import { bakeRetarget, buildRig, SkeletonSource } from './mesh-character.ts';
import type { Scene } from './scene.ts';
import { Skeleton } from './skeletal/skeleton.ts';

function fakeScene() {
  return {
    contentRoot: new GraphNode('root'),
    skeletalAnimationLibrary: new Map<string, Animation>(),
    skeletonLibrary: loadSkeletonLibrary(),
    app: { frame: 0 },
    cameraEntity: null,
  } as unknown as Scene;
}

/** A travelling 441-bone clip: half its bones dense, half sparse (splined), half its translations masked. */
function registerClip(scene: Scene, name: string, numFrames = 90) {
  const lib = scene.skeletonLibrary;
  const restT = lib.restTranslations441!;
  const restR = lib.restRotations441!;
  const n = lib.parents441!.length;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const keyframes = new Map<number, SkeletalKeyframeEntry>();
  const q = new Quat();
  const r = new Quat();
  for (let b = 0; b < n; b++) {
    const step = b % 2 ? 3 : 1;
    const keys = Math.ceil(numFrames / step);
    const frames = Float32Array.from({ length: keys }, (_, k) => Math.min(k * step, numFrames - 1));
    const positions = new Float32Array(keys * 3);
    const rotations = new Float32Array(keys * 4);
    const [ax, ay, az] = [rnd(), rnd(), rnd()];
    for (let k = 0; k < keys; k++) {
      const t = frames[k] / 10;
      const travel = b === 1 ? t * 0.1 : 0;
      positions.set([restT[b * 3] + travel, restT[b * 3 + 1] + 0.01 * Math.sin(t), restT[b * 3 + 2]], k * 3);
      q.setFromEulerAngles(25 * ax * Math.sin(t), 25 * ay * Math.cos(t), 25 * az * Math.sin(0.7 * t));
      r.set(restR[b * 4], restR[b * 4 + 1], restR[b * 4 + 2], restR[b * 4 + 3]).mul(q);
      rotations.set([r.x, r.y, r.z, r.w], k * 4);
    }
    keyframes.set(b, { frames, positions, rotations, scales: new Float32Array(keys * 3).fill(1) });
  }
  const clip = new Animation(new Float32Array(0), numFrames, n);
  clip.translationMask = Uint8Array.from({ length: n }, (_, b) => (b < 2 || b % 3 ? 1 : 0));
  clip.skeletalStore = { keyframes, manualBones: new Set(), source: 'imported' };
  clip.skeletalConverted = true;
  clip.register(scene, name);
}

/** The skinned bones of the bundled Mixamo dummy, parents first, as the loader lists them. */
function dummyBones(): GraphNode[] {
  const glb = readFileSync(new URL('../test-fixtures/dummy.glb', import.meta.url));
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
  const joints = new Set<number>(json.skins[0].joints);
  const nodes: GraphNode[] = json.nodes.map((nd: { name: string; translation?: number[]; rotation?: number[] }) => {
    const g = new GraphNode(nd.name);
    if (nd.translation) g.setLocalPosition(nd.translation[0], nd.translation[1], nd.translation[2]);
    if (nd.rotation) g.setLocalRotation(nd.rotation[0], nd.rotation[1], nd.rotation[2], nd.rotation[3]);
    return g;
  });
  json.nodes.forEach((nd: { children?: number[] }, i: number) => nd.children?.forEach((c) => nodes[i].addChild(nodes[c])));
  const out: GraphNode[] = [];
  const walk = (g: GraphNode) => {
    if (joints.has(nodes.indexOf(g))) out.push(g);
    for (const c of g.children) walk(c as GraphNode);
  };
  nodes.filter((g) => !g.parent).forEach(walk);
  return out;
}

describe('mesh character retarget bake', () => {
  it('poses only the bones it reads, with output identical to a full-rig pose', () => {
    const scene = fakeScene();
    registerClip(scene, 'walk');
    const bones = dummyBones();
    const pivot = bones[0].parent!;
    const rig = buildRig(bones, pivot.getRotation().clone(), pivot.getScale().x);

    // A rig's first bake reads its rest at full precision, later ones at the
    // Float32 it is reset to; warm it so both bakes below start alike.
    const warm = SkeletonSource.create(scene, 'walk');
    bakeRetarget(rig, warm, 30);
    warm.destroy();

    const subset = SkeletonSource.create(scene, 'walk');
    const fast = bakeRetarget(rig, subset, 30);
    subset.destroy();

    const full = SkeletonSource.create(scene, 'walk');
    (full as unknown as { _arm: Armature })._arm.evaluateOnly(null);
    const slow = bakeRetarget(rig, full, 30);
    full.destroy();

    assert.equal(fast.numFrames, slow.numFrames);
    assert.equal(fast.keyframes.size, rig.nodes.length);
    for (const [i, k] of slow.keyframes) {
      const f = fast.keyframes.get(i)!;
      assert.deepEqual(f.positions, k.positions, `bone ${i} positions`);
      assert.deepEqual(f.rotations, k.rotations, `bone ${i} rotations`);
    }
  });

  it('closes a bone subset over its ancestors, parents first', () => {
    const lib = loadSkeletonLibrary();
    const skeleton = new Skeleton({
      numBones: lib.parents441!.length,
      stdMaleParents: lib.parents441!,
      stdMaleRestTranslations: lib.restTranslations441!,
      stdMaleRestRotations: lib.restRotations441!,
    });
    const head = lib.boneNames441!.indexOf('head');
    const ball = lib.boneNames441!.indexOf('ball_l');
    const order = Array.from(skeleton.subsetOrder([head, ball]));
    const chain = (b: number) => { const out = []; for (let p = b; p >= 0; p = skeleton.parents[p]) out.push(p); return out; };
    assert.deepEqual(new Set(order), new Set([...chain(head), ...chain(ball)]));
    order.forEach((b, k) => {
      const p = skeleton.parents[b];
      if (p >= 0) assert.ok(order.indexOf(p) < k, `${b} after its parent`);
    });
  });
});
