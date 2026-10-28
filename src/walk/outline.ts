/**
 * The edge of where the walker can stand, as lines on the floor: the outline
 * a level designer would draw, instead of every voxel of the collider.
 *
 * A grid of probes round a centre asks "can the body stand here?"; marching
 * squares traces the border between yes and no. A wall, a hole and a ledge too
 * high to step up all come out the same: a line on the floor where walking
 * stops. Pure, so it runs (and is tested) without an engine.
 */

/** The floor height a body can stand on at (x, z), probing down from `fromY`; null where it cannot stand. */
export type StandProbe = (x: number, z: number, fromY: number) => number | null;

export interface OutlineOptions {
  /** Centre of the probed square, world metres (normally the walker). */
  centre: { x: number; y: number; z: number };
  /** Half the side of the probed square, metres. */
  radius: number;
  /** Probe spacing, metres. Finer is smoother and slower: (2 * radius / step)^2 probes. */
  step: number;
  /** How far above `centre.y` each probe starts, metres: a step up the walker could take. */
  stepUp: number;
  /** Two neighbouring floors further apart than this are a ledge, and get a line too. Default `stepUp`. */
  maxRise?: number;
  /** Lines float this far above the floor, metres, so they are not lost in it. Default 0.03. */
  lift?: number;
}

export interface Outline {
  /** Line segments, `[x0, y0, z0, x1, y1, z1] * n`, world metres. */
  segments: Float32Array;
  /** Probes taken. */
  probes: number;
}

/**
 * Marching squares cases: for corners (bit 0 = (i, j), 1 = (i+1, j),
 * 2 = (i+1, j+1), 3 = (i, j+1)) set where the body stands, the cell's edges
 * the border crosses, in pairs. Edges: 0 bottom, 1 right, 2 top, 3 left.
 */
const CASES: readonly (readonly number[])[] = [
  [], [3, 0], [0, 1], [3, 1], [1, 2], [3, 0, 1, 2], [0, 2], [3, 2],
  [2, 3], [0, 2], [0, 1, 2, 3], [1, 2], [1, 3], [0, 1], [3, 0], [],
];

export function walkableOutline(standAt: StandProbe, opts: OutlineOptions): Outline {
  const { centre, radius, step, stepUp } = opts;
  const maxRise = opts.maxRise ?? stepUp;
  const lift = opts.lift ?? 0.03;
  const n = Math.max(2, Math.ceil((2 * radius) / step) + 1);
  const x0 = centre.x - radius;
  const z0 = centre.z - radius;
  const fromY = centre.y + stepUp;

  // The floor at every node, NaN where the body cannot stand.
  const floor = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const g = standAt(x0 + i * step, z0 + j * step, fromY);
      floor[j * n + i] = g ?? Number.NaN;
    }
  }
  // A node a body could reach from a neighbour: standable, and no ledge to a lower neighbour.
  // A cliff top keeps its line even where both sides are floor.
  const ok = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const h = floor[j * n + i]!;
      if (Number.isNaN(h)) continue;
      let ledge = false;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const k = floor[jj * n + ii]!;
        if (!Number.isNaN(k) && h - k > maxRise) { ledge = true; break; }
      }
      ok[j * n + i] = ledge ? 0 : 1;
    }
  }

  const out: number[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const c0 = j * n + i, c1 = c0 + 1, c2 = c0 + n + 1, c3 = c0 + n;
      const index = ok[c0]! | (ok[c1]! << 1) | (ok[c2]! << 2) | (ok[c3]! << 3);
      const edges = CASES[index]!;
      if (!edges.length) continue;
      // The line sits on the walkable side's floor.
      let sum = 0, count = 0;
      for (const c of [c0, c1, c2, c3]) if (ok[c]) { sum += floor[c]!; count++; }
      const y = sum / count + lift;
      const x = x0 + i * step, z = z0 + j * step;
      for (let e = 0; e < edges.length; e += 2) {
        const a = edgeMid(edges[e]!, x, z, step);
        const b = edgeMid(edges[e + 1]!, x, z, step);
        out.push(a[0], y, a[1], b[0], y, b[1]);
      }
    }
  }
  return { segments: Float32Array.from(out), probes: n * n };
}

function edgeMid(edge: number, x: number, z: number, s: number): [number, number] {
  switch (edge) {
    case 0: return [x + s / 2, z];
    case 1: return [x + s, z + s / 2];
    case 2: return [x + s / 2, z + s];
    default: return [x, z + s / 2];
  }
}

/** A flat ring of `segments` lines round (x, y, z), for marking where the walker stands. */
export function ring(x: number, y: number, z: number, radius: number, segments = 32): Float32Array {
  const out = new Float32Array(segments * 6);
  for (let k = 0; k < segments; k++) {
    const a = (k / segments) * Math.PI * 2, b = ((k + 1) / segments) * Math.PI * 2;
    out.set([x + Math.cos(a) * radius, y, z + Math.sin(a) * radius, x + Math.cos(b) * radius, y, z + Math.sin(b) * radius], k * 6);
  }
  return out;
}
