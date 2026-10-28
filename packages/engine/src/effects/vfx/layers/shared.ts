/**
 * Shared helpers used by layer renderers - curve evaluation, PlayCanvas curve
 * construction, vec utilities. Both engine-internal renderers (particle/mesh/
 * sprite) and consumer renderers (GameEditor's stylized layers, accessed via
 * the public `VfxLayerRenderer` surface) can use these.
 */

import { Curve, CurveSet, Mat4, Quat, Vec3 } from 'playcanvas';
import type { Color } from 'playcanvas';
import type { CurvePoint, ColorCurvePoint } from '../data-types';

export function lerpCurve(keys: CurvePoint[] | undefined, t: number): number {
  if (!keys || keys.length === 0) return 1;
  if (keys.length === 1) return keys[0][1];
  if (t <= keys[0][0]) return keys[0][1];
  if (t >= keys[keys.length - 1][0]) return keys[keys.length - 1][1];

  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i];
    const [t1, v1] = keys[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return v0 + (v1 - v0) * f;
    }
  }
  return keys[keys.length - 1][1];
}

export function lerpColorCurve(keys: ColorCurvePoint[] | undefined, t: number, out: Color): void {
  if (!keys || keys.length === 0) return;
  if (keys.length === 1) { out.set(keys[0][1], keys[0][2], keys[0][3]); return; }
  if (t <= keys[0][0]) { out.set(keys[0][1], keys[0][2], keys[0][3]); return; }
  const last = keys[keys.length - 1];
  if (t >= last[0]) { out.set(last[1], last[2], last[3]); return; }

  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const f = (t - a[0]) / (b[0] - a[0]);
      out.set(
        a[1] + (b[1] - a[1]) * f,
        a[2] + (b[2] - a[2]) * f,
        a[3] + (b[3] - a[3]) * f,
      );
      return;
    }
  }
}

export function curveToPc(keys: CurvePoint[] | undefined): Curve | undefined {
  if (!keys || keys.length === 0) return undefined;
  const c = new Curve();
  for (const [t, v] of keys) c.add(t, v);
  return c;
}

export function colorCurveToPcSet(keys: ColorCurvePoint[] | undefined): CurveSet | undefined {
  if (!keys || keys.length === 0) return undefined;
  const cs = new CurveSet([[], [], []]);
  for (const [t, r, g, b] of keys) {
    cs.get(0).add(t, r);
    cs.get(1).add(t, g);
    cs.get(2).add(t, b);
  }
  return cs;
}

export function vec3OrUndefined(v: [number, number, number] | undefined): Vec3 | undefined {
  return v ? new Vec3(v[0], v[1], v[2]) : undefined;
}

export function vec3CurveSet(v: [number, number, number] | undefined): CurveSet | undefined {
  if (!v) return undefined;
  return new CurveSet([
    [0, v[0]],
    [0, v[1]],
    [0, v[2]],
  ]);
}

export function quatFromForward(dir: Vec3): Quat {
  const d = dir.clone().normalize();
  const worldUp = Math.abs(d.y) < 0.99 ? new Vec3(0, 1, 0) : new Vec3(1, 0, 0);
  const right = new Vec3().cross(worldUp, d).normalize();
  const correctedUp = new Vec3().cross(d, right).normalize();
  const m = new Mat4();
  const md = m.data;
  md[0] = right.x;       md[1] = right.y;       md[2] = right.z;       md[3] = 0;
  md[4] = correctedUp.x; md[5] = correctedUp.y; md[6] = correctedUp.z; md[7] = 0;
  md[8] = d.x;           md[9] = d.y;           md[10] = d.z;          md[11] = 0;
  md[12] = 0;            md[13] = 0;            md[14] = 0;            md[15] = 1;
  return new Quat().setFromMat4(m);
}
