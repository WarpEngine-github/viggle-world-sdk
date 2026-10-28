import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildProxyMesh, defaultProxySettings } from './voxelizer.ts';
import type { ProxyMeshInput, ProxyMeshResult, ProxySettings } from './voxelizer.ts';

/**
 * The voxelizer is a pure function with a small number of invariants that are
 * cheap to assert and expensive to get wrong: the surface has to be CLOSED (a
 * lighting proxy with a hole in it leaks light through the hole), the vertex
 * count has to scale with the voxel size the way the knob promises, dilate has
 * to grow the volume, floor fill has to fill underneath, and skinned weights
 * have to sum to 1 or the mesh collapses toward the origin as the rig moves.
 *
 * None of that needs a GPU, a scene or a real capture, which is the whole
 * reason the module is pure. The blobs below are generated point clouds.
 */

// ── Fixtures ────────────────────────────────────────────────────────────

/** A filled ball of splats, dense enough that no voxel inside it is missed. */
function ball(radius: number, step: number, centre = [0, 0, 0]): Float32Array {
  const pts: number[] = [];
  for (let x = -radius; x <= radius; x += step) {
    for (let y = -radius; y <= radius; y += step) {
      for (let z = -radius; z <= radius; z += step) {
        if (x * x + y * y + z * z <= radius * radius) {
          pts.push(centre[0] + x, centre[1] + y, centre[2] + z);
        }
      }
    }
  }
  return new Float32Array(pts);
}

/** A solid axis-aligned box of splats, one per `step` in each axis. */
function box(min: number[], max: number[], step: number): Float32Array {
  const pts: number[] = [];
  for (let x = min[0]; x <= max[0] + 1e-9; x += step) {
    for (let y = min[1]; y <= max[1] + 1e-9; y += step) {
      for (let z = min[2]; z <= max[2] + 1e-9; z += step) pts.push(x, y, z);
    }
  }
  return new Float32Array(pts);
}

function build(positions: Float32Array, settings: ProxySettings = {}): ProxyMeshResult {
  return buildProxyMesh({ positions }, settings);
}

// ── Helpers the assertions are phrased in ───────────────────────────────

/**
 * Count how many triangles each undirected edge belongs to.
 *
 * A closed, manifold surface has every edge in exactly two. One is a boundary
 * edge (a hole); three or more is a non-manifold pinch. Both are ways a
 * voxelizer breaks that no eyeball catches on a 6000-triangle mesh.
 */
function edgeUseCounts(indices: Uint32Array): Map<string, number> {
  const uses = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    for (let k = 0; k < 3; k++) {
      const a = tri[k], b = tri[(k + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  return uses;
}

function assertClosed(result: ProxyMeshResult, what: string): void {
  assert.ok(result.triangleCount > 0, `${what}: expected some triangles`);
  const uses = edgeUseCounts(result.indices);
  let boundary = 0;
  let nonManifold = 0;
  for (const count of uses.values()) {
    if (count === 1) boundary++;
    else if (count > 2) nonManifold++;
  }
  assert.equal(boundary, 0, `${what}: ${boundary} boundary edges - the surface has holes`);
  assert.equal(nonManifold, 0, `${what}: ${nonManifold} edges shared by more than two triangles`);
}

/**
 * Six times the enclosed volume, by the divergence theorem over the triangles.
 *
 * Positive means every face is wound so that `(v1-v0) x (v2-v0)` points OUT
 * under the right-hand rule, which is what WebGL's counter-clockwise front
 * face wants. This is the assertion that would have caught a winding flip in
 * the Unity port, where the source convention is left-handed.
 */
function signedVolume6(positions: Float32Array, indices: Uint32Array): number {
  let acc = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    acc += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return acc;
}

function minY(positions: Float32Array): number {
  let lo = Infinity;
  for (let i = 1; i < positions.length; i += 3) if (positions[i] < lo) lo = positions[i];
  return lo;
}

// ── The defaults themselves ─────────────────────────────────────────────

describe('proxy voxelizer defaults', () => {
  it('defaults to the RELIGHT finish, tuned on screen', () => {
    // These are not arbitrary: they are what the relight reads best at on the
    // bundled character and capture, and `defaultProxySettings`' own doc
    // carries the measurements each one was chosen over. The voxel size and
    // the finish now agree with the Unity component, which they did not while
    // this said blocky / 0.03. Change them there, with a reason, not here.
    assert.equal(defaultProxySettings.surface, 'smooth');
    assert.equal(defaultProxySettings.voxelSize, 0.025);
    assert.equal(defaultProxySettings.opacityThreshold, 0.04);
    assert.equal(defaultProxySettings.dilate, 0);
    assert.equal(defaultProxySettings.smoothIterations, 3);
    assert.equal(defaultProxySettings.mergeCoplanar, false);
    assert.equal(defaultProxySettings.floorFill, false);
  });
});

// ── Closure, the invariant that matters most ────────────────────────────

describe('proxy voxelizer surface closure', () => {
  const blob = ball(0.5, 0.05);

  for (const surface of ['blocky', 'smooth'] as const) {
    for (const smoothIterations of [0, 3]) {
      it(`${surface} + ${smoothIterations} relaxation passes closes`, () => {
        const r = build(blob, { surface, smoothIterations, voxelSize: 0.08 });
        assertClosed(r, `${surface}/${smoothIterations}`);
      });
    }
  }

  it('merging keeps the shape and drops the triangles - but breaks the edge manifold', () => {
    // `blocky` explicitly: the greedy sweep merges coplanar voxel FACES, so it
    // has nothing to do on a Surface Nets mesh - and `smooth` is the default.
    const merged = build(blob, { surface: 'blocky', mergeCoplanar: true, smoothIterations: 0, voxelSize: 0.08 });
    const plain = build(blob, { surface: 'blocky', mergeCoplanar: false, smoothIterations: 0, voxelSize: 0.08 });

    // Lossless in shape and only in shape: the same planes, the same coverage,
    // one quad where there were many. Equal enclosed volume is the strongest
    // cheap statement of that. If the triangle count ever comes out EQUAL, the
    // greedy sweep silently did nothing and the setting is a no-op.
    assert.ok(
      merged.triangleCount < plain.triangleCount * 0.6,
      `merged ${merged.triangleCount} tris should be well under unmerged ${plain.triangleCount}`,
    );
    const a = signedVolume6(merged.positions, merged.indices);
    const b = signedVolume6(plain.positions, plain.indices);
    assert.ok(Math.abs(a - b) < 1e-4 * Math.abs(b), `volume moved: ${a / 6} vs ${b / 6}`);

    // And it is NOT edge-manifold, which is a property of greedy meshing and
    // not a bug: a large merged quad's edge is crossed by the corners of the
    // smaller quads beside it, leaving T-junctions. Watertight by AREA, open
    // by TOPOLOGY. A third independent reason merging stays off here - the
    // Laplacian needs the manifold as much as it needs the uniform grid.
    let boundary = 0;
    for (const count of edgeUseCounts(merged.indices).values()) if (count === 1) boundary++;
    assert.ok(boundary > 0, 'expected T-junctions; if this is 0 the greedy sweep merged nothing');
  });

  it('winds every face outward', () => {
    for (const surface of ['blocky', 'smooth'] as const) {
      const r = build(blob, { surface, smoothIterations: 0, voxelSize: 0.08 });
      assert.ok(
        signedVolume6(r.positions, r.indices) > 0,
        `${surface}: enclosed volume came out negative - the winding is inside out`,
      );
    }
  });

  it('a diagonal touch stays CLOSED but pinches the edge manifold', () => {
    // Two cells that share only a grid EDGE. The boundary of that set is still
    // closed - no holes, so no light leaks - but the shared edge belongs to
    // four faces instead of two, which is non-manifold.
    //
    // This is a property of extracting the boundary of a voxel SET, not a bug,
    // and the Unity original has it too. Pinned here because it is the one
    // invariant the closure tests above would otherwise imply and not deliver:
    // a real character at voxel 0.05 comes out with ~2 such edges out of ~7000.
    // Harmless for lighting; a collision cook or a mesh-processing step that
    // assumes a manifold is where it would bite.
    const positions = new Float32Array([0, 0, 0, 0.1, 0.1, 0]);
    for (const surface of ['blocky', 'smooth'] as const) {
      const r = buildProxyMesh({ positions }, {
        surface, voxelSize: 0.1, dilate: 0, smoothIterations: 0,
      });
      let boundary = 0, nonManifold = 0;
      for (const count of edgeUseCounts(r.indices).values()) {
        if (count === 1) boundary++;
        else if (count > 2) nonManifold++;
      }
      assert.equal(boundary, 0, `${surface}: a pinch must not open a hole`);
      assert.ok(nonManifold > 0, `${surface}: expected the pinch to be non-manifold`);
    }

    // Dilation does NOT fix it, which is worth stating because it is the
    // obvious guess: growing both cells fills the gap between them and opens
    // fresh pinches at the new outer corners. Nothing in the pipeline removes
    // these; they are rare and harmless, and that is the whole answer.
    const dilated = buildProxyMesh({ positions }, { voxelSize: 0.1, dilate: 1, smoothIterations: 0 });
    let boundary = 0, nonManifold = 0;
    for (const count of edgeUseCounts(dilated.indices).values()) {
      if (count === 1) boundary++;
      else if (count > 2) nonManifold++;
    }
    assert.equal(boundary, 0, 'still no holes after dilation');
    assert.ok(nonManifold > 0, 'dilation moves the pinches rather than removing them');
  });

  it('two disjoint blobs come out as two closed shells', () => {
    // Nothing in the algorithm treats components separately, which is exactly
    // why this is worth pinning: a bug in the boundary test shows up as the
    // two shells being stitched to each other.
    const a = ball(0.3, 0.05, [0, 0, 0]);
    const b = ball(0.3, 0.05, [3, 0, 0]);
    const both = new Float32Array(a.length + b.length);
    both.set(a); both.set(b, a.length);
    assertClosed(build(both, { voxelSize: 0.1 }), 'two blobs');
  });
});

// ── The knobs ───────────────────────────────────────────────────────────

describe('proxy voxelizer parameters', () => {
  const blob = ball(0.5, 0.04);

  it('vertex count scales with voxel size', () => {
    // Surface cells go as 1/voxel^2, so halving the voxel size should roughly
    // quadruple the vertex count. Asserted as a loose band rather than a
    // number: the point is the SCALING LAW, and pinning an exact count would
    // break on any harmless change to the boundary test.
    const coarse = build(blob, { voxelSize: 0.16, smoothIterations: 0 });
    const fine = build(blob, { voxelSize: 0.08, smoothIterations: 0 });
    const ratio = fine.vertexCount / coarse.vertexCount;
    assert.ok(ratio > 2.5 && ratio < 6, `expected ~4x more vertices, got ${ratio.toFixed(2)}x`);
    assert.equal(fine.voxelSize, 0.08, 'a grid this small should not have been coarsened');
  });

  it('blocky and smooth cost exactly the same, and differ only in where the vertices sit', () => {
    // The Unity header sells Surface Nets as "roughly one vertex per boundary
    // cell instead of four or more, so it is also the lighter mesh". That is
    // true against an UNWELDED blocky surface and false against this one. The
    // two are combinatorially dual: a blocky welded vertex is a grid corner
    // with solid and empty among its eight cells, and a Surface Nets vertex is
    // a dual cell with solid and empty among its eight centres - the same set,
    // counted from opposite ends. Same vertices, same quads, different
    // positions.
    //
    // Pinned as equality rather than left implicit because it is the answer to
    // "which finish is cheaper": neither. Pick on shape alone.
    for (const voxelSize of [0.05, 0.08, 0.13]) {
      const blocky = build(blob, { surface: 'blocky', voxelSize, smoothIterations: 0 });
      const smooth = build(blob, { surface: 'smooth', voxelSize, smoothIterations: 0 });
      assert.equal(smooth.vertexCount, blocky.vertexCount, `vertex count at ${voxelSize}`);
      assert.equal(smooth.triangleCount, blocky.triangleCount, `triangle count at ${voxelSize}`);
    }

    // Where they differ: blocky vertices land exactly on grid corners, Surface
    // Nets vertices slide inside their cell - which is the whole reason a
    // sloped surface comes out sloped instead of as steps.
    const onGrid = (r: ProxyMeshResult) => {
      let off = 0;
      for (let v = 0; v < r.vertexCount; v++) {
        for (let k = 0; k < 3; k++) {
          const axis = k === 0 ? r.origin.x : k === 1 ? r.origin.y : r.origin.z;
          const cells = (r.positions[v * 3 + k] - axis) / r.voxelSize;
          if (Math.abs(cells - Math.round(cells)) > 1e-4) { off++; break; }
        }
      }
      return r.vertexCount - off;
    };
    const blocky = build(blob, { surface: 'blocky', voxelSize: 0.08, smoothIterations: 0 });
    const smooth = build(blob, { surface: 'smooth', voxelSize: 0.08, smoothIterations: 0 });
    assert.equal(onGrid(blocky), blocky.vertexCount, 'every blocky vertex should be a grid corner');
    // Not zero, and deliberately not asserted as zero: a cell whose crossings
    // are symmetric puts its centroid at the cell centre, which IS a grid
    // corner. The flat patches of a voxelized ball are full of those. The
    // claim is that most vertices have moved, not that all have.
    assert.ok(
      onGrid(smooth) < smooth.vertexCount * 0.5,
      `${onGrid(smooth)} of ${smooth.vertexCount} Surface Nets vertices stayed on grid corners`,
    );

    // And the shape that buys: cutting the corners off the staircase encloses
    // strictly less volume than the staircase did.
    assert.ok(
      signedVolume6(smooth.positions, smooth.indices) < signedVolume6(blocky.positions, blocky.indices),
      'Surface Nets should undercut the blocky staircase, not match it',
    );
  });

  it('dilate grows the volume', () => {
    const none = build(blob, { dilate: 0, voxelSize: 0.08, smoothIterations: 0 });
    const one = build(blob, { dilate: 1, voxelSize: 0.08, smoothIterations: 0 });
    const two = build(blob, { dilate: 2, voxelSize: 0.08, smoothIterations: 0 });
    assert.ok(none.occupiedVoxels < one.occupiedVoxels, 'one dilation pass should add voxels');
    assert.ok(one.occupiedVoxels < two.occupiedVoxels, 'a second pass should add more');
    assertClosed(two, 'dilate 2');
  });

  it('the opacity threshold drops the faint splats', () => {
    // A solid core at alpha 1 with a halo of alpha 0.1 floaters around it -
    // the wispy shell the knob exists to discard.
    const core = ball(0.3, 0.05);
    const halo = ball(0.9, 0.09);
    const positions = new Float32Array(core.length + halo.length);
    positions.set(core); positions.set(halo, core.length);
    const opacities = new Float32Array(positions.length / 3);
    opacities.fill(1, 0, core.length / 3);
    opacities.fill(0.1, core.length / 3);

    const settings: ProxySettings = { voxelSize: 0.1, smoothIterations: 0 };
    const kept = buildProxyMesh({ positions, opacities }, { ...settings, opacityThreshold: 0.05 });
    const dropped = buildProxyMesh({ positions, opacities }, { ...settings, opacityThreshold: 0.2 });
    assert.equal(dropped.splatsUsed, core.length / 3, 'only the core should have passed');
    assert.ok(dropped.occupiedVoxels < kept.occupiedVoxels / 2, 'the halo should have gone');
  });

  it('floorFill fills underneath', () => {
    // A thin ledge a metre up, plus a post standing on the ground beside it -
    // the post is what pushes the grid floor down to y=0, so the ledge has an
    // "underneath" to fill at all. Without the fill the ledge is a
    // one-voxel-thick shell a fast rigidbody tunnels through; with it, its
    // column becomes solid all the way down.
    const ledge = box([-0.4, 1.0, -0.4], [0.4, 1.05, 0.4], 0.05);
    const post = box([1.0, 0.0, -0.05], [1.1, 1.05, 0.05], 0.05);
    const positions = new Float32Array(ledge.length + post.length);
    positions.set(ledge); positions.set(post, ledge.length);

    const shell = build(positions, { voxelSize: 0.05, smoothIterations: 0 });
    const filled = build(positions, { voxelSize: 0.05, smoothIterations: 0, floorFill: true });
    assert.ok(
      filled.occupiedVoxels > shell.occupiedVoxels * 3,
      `column not filled: ${shell.occupiedVoxels} -> ${filled.occupiedVoxels} voxels`,
    );
    // The ledge's own underside has to have travelled down to the grid floor.
    // `minY` alone would pass on the post, which already reaches it.
    const lowestUnderLedge = (r: ProxyMeshResult) => {
      let lo = Infinity;
      for (let v = 0; v < r.vertexCount; v++) {
        if (Math.abs(r.positions[v * 3]) > 0.5) continue;   // skip the post
        if (r.positions[v * 3 + 1] < lo) lo = r.positions[v * 3 + 1];
      }
      return lo;
    };
    assert.ok(
      lowestUnderLedge(filled) < lowestUnderLedge(shell) - 0.8,
      `ledge underside only reached ${lowestUnderLedge(filled)}`,
    );
    assert.ok(minY(filled.positions) <= minY(shell.positions) + 1e-6);
    assertClosed(filled, 'floorFill');
  });

  it('coarsens rather than allocating a pathological grid', () => {
    // The guard that keeps a bad voxel size on a large capture from being an
    // out-of-memory instead of a coarse mesh.
    const r = build(ball(0.5, 0.05), { voxelSize: 0.01, maxVoxels: 5000 });
    assert.ok(r.voxelSize > 0.01, 'the voxel size should have been raised');
    assert.ok(r.dims.x * r.dims.y * r.dims.z <= 5000, `grid is ${JSON.stringify(r.dims)}`);
    assertClosed(r, 'coarsened');
  });

  it('keeps the dilation border a whole voxel wide after coarsening', () => {
    // The pad exists because the dilation pass skips the outermost shell of
    // cells: without it, a splat on the bounding box does not grow. Sizing the
    // pad from the REQUESTED voxel and then coarsening leaves it a fraction of a
    // delivered voxel wide, and the wall on a capture's edge comes out one cell
    // thin or gone - invisible on a character, which never coarsens, and the
    // normal case for a scanned scene at a metric voxel size.
    //
    // The claim is geometric, so it is asserted geometrically: every axis has to
    // carry `dilate + 1` clear cells of pad on each side of the splats.
    const r = build(box([-1, -1, -1], [1, 1, 1], 0.05), {
      voxelSize: 0.02, dilate: 1, maxVoxels: 60_000,
    });
    assert.ok(r.voxelSize > 0.02, 'this case is only interesting once it coarsens');
    const pad = (defaultProxySettings.dilate + 1) * r.voxelSize;
    for (const [axis, lo, n] of [
      ['x', r.origin.x, r.dims.x], ['y', r.origin.y, r.dims.y], ['z', r.origin.z, r.dims.z],
    ] as const) {
      // The splats span [-1, 1] on every axis, so the padded grid must start at
      // or below -1 - pad and end at or above 1 + pad.
      assert.ok(lo <= -1 - pad + 1e-9, `${axis} low pad is ${(-1 - lo).toFixed(4)}, want >= ${pad.toFixed(4)}`);
      const hi = lo + (n - 1) * r.voxelSize;
      assert.ok(hi >= 1 + pad - 1e-9, `${axis} high pad is ${(hi - 1).toFixed(4)}, want >= ${pad.toFixed(4)}`);
    }
  });

  it('stops coarsening when a step no longer shrinks the grid', () => {
    // The pad is re-derived per step, so a padded axis can never fall below
    // `2 * (dilate + 1) + 1` cells however coarse the voxel gets. An absolute
    // floor would therefore be unreachable; monotonicity is the termination
    // proof, and a `maxVoxels` under that floor has to return rather than spin.
    const r = build(ball(0.5, 0.05), { voxelSize: 0.05, dilate: 1, maxVoxels: 1 });
    assert.ok(r.dims.x >= 5 && r.dims.y >= 5 && r.dims.z >= 5, `grid is ${JSON.stringify(r.dims)}`);
    assert.ok(Number.isFinite(r.voxelSize) && r.voxelSize > 0.05);
  });
});

// ── Rejections ──────────────────────────────────────────────────────────

describe('proxy voxelizer rejections', () => {
  const blob = ball(0.3, 0.05);

  it('refuses mergeCoplanar together with smoothing', () => {
    // Mutually exclusive by construction: merging destroys the uniform grid
    // the Laplacian averages over. Refused rather than quietly producing a
    // surface that is neither merged well nor smoothed well.
    assert.throws(
      () => build(blob, { surface: 'blocky', mergeCoplanar: true, smoothIterations: 1 }),
      /mutually exclusive/,
    );
    // Either one alone is fine, and Surface Nets never consults the flag at
    // all - so the combination is legal there and simply ignores the merge.
    assert.doesNotThrow(() => build(blob, { mergeCoplanar: true, smoothIterations: 0 }));
    assert.doesNotThrow(() => build(blob, { mergeCoplanar: false, smoothIterations: 3 }));
    assert.doesNotThrow(() => build(blob, { surface: 'smooth', mergeCoplanar: true, smoothIterations: 2 }));
  });

  it('refuses a non-positive voxel size', () => {
    assert.throws(() => build(blob, { voxelSize: 0 }), /voxelSize/);
    assert.throws(() => build(blob, { voxelSize: -0.05 }), /voxelSize/);
  });

  it('refuses bone arrays that are the wrong length', () => {
    const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
    assert.throws(
      () => buildProxyMesh({
        positions,
        boneIndices: new Uint32Array(4),      // 4 influences, 2 splats' worth wanted
        boneWeights: new Float32Array(8),
      }),
      /influences per splat/,
    );
  });

  it('returns an empty result rather than throwing on empty input', () => {
    const r = buildProxyMesh({ positions: new Float32Array(0) });
    assert.equal(r.vertexCount, 0);
    assert.equal(r.triangleCount, 0);
    assert.equal(r.boneIndices, null);

    // Every splat below the threshold is the same situation arrived at from
    // the other side, and is what a capture of pure haze produces.
    const faint = buildProxyMesh(
      { positions: ball(0.3, 0.1), opacities: new Float32Array(ball(0.3, 0.1).length / 3).fill(0.05) },
      { opacityThreshold: 0.2 },
    );
    assert.equal(faint.vertexCount, 0);
    assert.equal(faint.splatsUsed, 0);
  });
});

// ── Skinning ────────────────────────────────────────────────────────────

describe('proxy voxelizer bone weights', () => {
  /**
   * Two overlapping arms of splats, each rigidly weighted to its own bone,
   * with a blend zone in the middle where both bones contribute. The proxy
   * built over it has to come out weighted to bone 2 at one end, bone 7 at the
   * other, and to both in between.
   */
  function twoBoneBlob(): ProxyMeshInput {
    const positions: number[] = [];
    const boneIndices: number[] = [];
    const boneWeights: number[] = [];
    const push = (x: number, y: number, z: number, wa: number, wb: number) => {
      positions.push(x, y, z);
      boneIndices.push(2, 7, 0, 0);
      boneWeights.push(wa, wb, 0, 0);
    };
    for (let x = -0.5; x <= 0.5 + 1e-9; x += 0.03) {
      // Linear blend along x, so the middle band genuinely carries both.
      const t = Math.min(Math.max((x + 0.15) / 0.3, 0), 1);
      for (let y = -0.15; y <= 0.15 + 1e-9; y += 0.03) {
        for (let z = -0.15; z <= 0.15 + 1e-9; z += 0.03) push(x, y, z, 1 - t, t);
      }
    }
    return {
      positions: new Float32Array(positions),
      boneIndices: new Uint32Array(boneIndices),
      boneWeights: new Float32Array(boneWeights),
    };
  }

  it('emits four influences a vertex that sum to 1', () => {
    for (const surface of ['blocky', 'smooth'] as const) {
      const r = buildProxyMesh(twoBoneBlob(), { surface, voxelSize: 0.06 });
      assert.ok(r.boneIndices && r.boneWeights, `${surface}: expected skinned output`);
      assert.equal(r.boneIndices!.length, r.vertexCount * 4);
      assert.equal(r.boneWeights!.length, r.vertexCount * 4);
      for (let v = 0; v < r.vertexCount; v++) {
        let sum = 0;
        for (let j = 0; j < 4; j++) sum += r.boneWeights![v * 4 + j];
        // Weight 0 on every influence is the legal "no bone reached this
        // vertex" answer - it leaves the vertex at bind rather than pinning it
        // to the root. Anything in between is a normalization bug.
        assert.ok(
          Math.abs(sum - 1) < 1e-5 || sum === 0,
          `${surface}: vertex ${v} weights sum to ${sum}`,
        );
      }
    }
  });

  it('keeps each end on its own bone and blends the middle', () => {
    const r = buildProxyMesh(twoBoneBlob(), { voxelSize: 0.06, dilate: 0, smoothIterations: 0 });
    const weightOf = (v: number, bone: number) => {
      let w = 0;
      for (let j = 0; j < 4; j++) if (r.boneIndices![v * 4 + j] === bone) w += r.boneWeights![v * 4 + j];
      return w;
    };
    let leftOnA = 0, rightOnB = 0, blended = 0;
    for (let v = 0; v < r.vertexCount; v++) {
      const x = r.positions[v * 3];
      const a = weightOf(v, 2), b = weightOf(v, 7);
      if (x < -0.3 && a > 0.99) leftOnA++;
      if (x > 0.3 && b > 0.99) rightOnB++;
      if (a > 0.05 && b > 0.05) blended++;
    }
    assert.ok(leftOnA > 0, 'the far -x end should be rigid on bone 2');
    assert.ok(rightOnB > 0, 'the far +x end should be rigid on bone 7');
    assert.ok(blended > 0, 'the middle band should carry both bones');
  });

  it('dilated voxels inherit the weights of the voxel that grew them', () => {
    // The reason dilate is safe on a character: the shell it adds follows the
    // same limb, rather than falling back to an unweighted (and therefore
    // stationary) ring around the silhouette.
    const r = buildProxyMesh(twoBoneBlob(), { voxelSize: 0.06, dilate: 2 });
    let unweighted = 0;
    for (let v = 0; v < r.vertexCount; v++) {
      let sum = 0;
      for (let j = 0; j < 4; j++) sum += r.boneWeights![v * 4 + j];
      if (sum === 0) unweighted++;
    }
    assert.equal(unweighted, 0, `${unweighted} vertices came out with no bone at all`);
  });

  it('leaves the bone arrays null when the input is unskinned', () => {
    const r = build(ball(0.3, 0.05));
    assert.equal(r.boneIndices, null);
    assert.equal(r.boneWeights, null);
  });
});

// ── The quad list ───────────────────────────────────────────────────────

describe('proxy voxelizer quad list', () => {
  it('carries the same surface as the triangle list', () => {
    const r = build(ball(0.4, 0.05), { voxelSize: 0.1, smoothIterations: 0 });
    assert.equal(r.indices.length, (r.quads.length / 4) * 6, 'two triangles a quad');
    // The quads are what a wireframe should walk: the triangulation diagonals
    // are an artefact of the index buffer, not edges of the surface.
    for (let i = 0; i < r.quads.length; i++) {
      assert.ok(r.quads[i] < r.vertexCount, `quad index ${r.quads[i]} out of range`);
    }
  });
});
