/**
 * The CPU half of a decompressed `.sog` load, with no PlayCanvas in it so it
 * can run in `sog-worker.ts`: SOG pixels to the 14 (or 59) splat properties,
 * and the resource's texture data, centres and bounds, in one pass. Same arithmetic as
 * PlayCanvas's `GSplatSogData.decompress` and `GSplatResource`, so the output
 * is bit-identical (fast-sog-decompress.test.ts).
 */

import type { DecodedSpz, SplatProperty } from '../environment/spz-decode';
import { float2Half } from './float-half';

export type SogMeta = {
  version?: number;
  means: { mins: number[]; maxs: number[] };
  scales: { codebook: number[]; mins: number[]; maxs: number[] };
  sh0: { codebook: number[]; mins: number[]; maxs: number[] };
  shN?: { codebook: number[]; mins: number; maxs: number };
};

/** RGBA8 pixels of each SOG texture, read back from the GPU. */
export interface SogPixels {
  /** With `_patchCodebooks` already applied. */
  meta: SogMeta;
  count: number;
  shBands: number;
  means_l: Uint8Array; means_u: Uint8Array; quats: Uint8Array; scales: Uint8Array; sh0: Uint8Array;
  sh_labels?: Uint8Array; sh_centroids?: Uint8Array;
  centroidsWidth: number;
}

const SH_C0 = 0.28209479177387814;

const lerp = (a: number, b: number, t: number) => a * (1 - t) + b * t;

/**
 * Scale, colour and opacity each come from one byte (per channel), so their
 * float32 property values and packed halves are tables of 256: the same
 * arithmetic as per splat, done once per byte value.
 */
function byteTables(meta: SogMeta) {
  const v2 = meta.version === 2;
  const { scales: sm, sh0: cm } = meta;
  const scaleF = new Float32Array(768), scaleH = new Uint16Array(768);
  const colorF = new Float32Array(768), colorH = new Uint16Array(768);
  const opacityF = new Float32Array(256), alphaH = new Uint16Array(256);
  for (let c = 0; c < 3; c++) {
    for (let b = 0; b < 256; b++) {
      const k = c * 256 + b;
      scaleF[k] = v2 ? sm.codebook[b] : lerp(sm.mins[c], sm.maxs[c], b / 255);
      scaleH[k] = float2Half(Math.exp(scaleF[k]));
      const v = 0.5 + (v2 ? cm.codebook[b] : lerp(cm.mins[c], cm.maxs[c], b / 255)) * SH_C0;
      colorF[k] = (v - 0.5) / SH_C0;
      colorH[k] = float2Half(colorF[k] * SH_C0 + 0.5);
    }
  }
  for (let b = 0; b < 256; b++) {
    const ca = v2 ? b / 255 : 1 / (1 + Math.exp(-lerp(cm.mins[3], cm.maxs[3], b / 255)));
    opacityF[b] = ca <= 0 ? -40 : ca >= 1 ? 40 : -Math.log(1 / ca - 1);
    alphaH[b] = float2Half(1 / (1 + Math.exp(-opacityF[b])));
  }
  return { scaleF, scaleH, colorF, colorH, opacityF, alphaH };
}

/** A position axis is 16 bits, so its float32 values are a table of 65536. */
function positionTable(min: number, max: number): Float32Array {
  const out = new Float32Array(65536);
  for (let v = 0; v < 65536; v++) {
    const t = lerp(min, max, v / 65535);
    out[v] = Math.sign(t) * (Math.exp(Math.abs(t)) - 1);
  }
  return out;
}

export function decodeSog(input: SogPixels): DecodedSpz {
  const members = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const { shBands, meta, count: n } = input;
  if (shBands > 0) {
    members.splice(members.indexOf('f_dc_0') + 1, 0, ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`));
  }
  const data: Record<string, Float32Array> = {};
  for (const name of members) data[name] = new Float32Array(n);
  const { x, y, z, f_dc_0: r0, f_dc_1: g0, f_dc_2: b0, opacity, scale_0: sx, scale_1: sy, scale_2: sz, rot_0, rot_1, rot_2, rot_3 } = data;

  const [posX, posY, posZ] = [0, 1, 2].map((axis) => positionTable(meta.means.mins[axis], meta.means.maxs[axis]));
  const { means_l: ml, means_u: mu, quats: qd, scales: sd, sh0: cd } = input;
  const { scaleF, scaleH, colorF, colorH, opacityF, alphaH } = byteTables(meta);
  const color = new Uint16Array(n * 4);
  const transformA = new Uint32Array(n * 4);
  const transformAFloat = new Float32Array(transformA.buffer);
  const transformB = new Uint16Array(n * 4);
  const centers = new Float32Array(n * 3);
  let first = true;
  let mx = 0, my = 0, mz = 0, Mx = 0, My = 0, Mz = 0;
  // PlayCanvas's iterator Quat persists: a mode byte outside 252-255 keeps the last rotation.
  let qx = 0, qy = 0, qz = 0, qw = 1;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // Packing reads back the stored float32s, as GSplatResource reads the props.
    const px = (x[i] = posX[(mu[o] << 8) + ml[o]]);
    const py = (y[i] = posY[(mu[o + 1] << 8) + ml[o + 1]]);
    const pz = (z[i] = posZ[(mu[o + 2] << 8) + ml[o + 2]]);
    transformAFloat[o] = px;
    transformAFloat[o + 1] = py;
    transformAFloat[o + 2] = pz;
    centers[i * 3] = px;
    centers[i * 3 + 1] = py;
    centers[i * 3 + 2] = pz;

    const a = (qd[o] / 255 - 0.5) * Math.SQRT2;
    const b = (qd[o + 1] / 255 - 0.5) * Math.SQRT2;
    const c = (qd[o + 2] / 255 - 0.5) * Math.SQRT2;
    const d = Math.sqrt(Math.max(0, 1 - (a * a + b * b + c * c)));
    switch (qd[o + 3] - 252) {
      case 0: qx = a; qy = b; qz = c; qw = d; break;
      case 1: qx = d; qy = b; qz = c; qw = a; break;
      case 2: qx = b; qy = d; qz = c; qw = a; break;
      case 3: qx = b; qy = c; qz = d; qw = a; break;
    }
    rot_1[i] = qx; rot_2[i] = qy; rot_3[i] = qz; rot_0[i] = qw;
    // `packQuat`, inlined by hand: this loop is past V8's inlining budget.
    let rx = rot_1[i], ry = rot_2[i], rz = rot_3[i], rw = rot_0[i];
    let len = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
    if (len === 0) {
      rx = ry = rz = 0;
      rw = 1;
    } else {
      len = 1 / len;
      rx *= len; ry *= len; rz *= len; rw *= len;
    }
    if (rw < 0) {
      rx *= -1; ry *= -1; rz *= -1;
    }
    transformA[o + 3] = float2Half(rx) | (float2Half(ry) << 16);
    transformB[o + 3] = float2Half(rz);

    const s0 = sd[o], s1 = 256 + sd[o + 1], s2 = 512 + sd[o + 2];
    sx[i] = scaleF[s0]; sy[i] = scaleF[s1]; sz[i] = scaleF[s2];
    transformB[o] = scaleH[s0]; transformB[o + 1] = scaleH[s1]; transformB[o + 2] = scaleH[s2];
    const c0 = cd[o], c1 = 256 + cd[o + 1], c2 = 512 + cd[o + 2];
    r0[i] = colorF[c0]; g0[i] = colorF[c1]; b0[i] = colorF[c2]; opacity[i] = opacityF[cd[o + 3]];
    color[o] = colorH[c0]; color[o + 1] = colorH[c1]; color[o + 2] = colorH[c2]; color[o + 3] = alphaH[cd[o + 3]];

    const scale = Math.max(scaleF[s0], scaleF[s1], scaleF[s2]);
    if (!isFinite(px) || !isFinite(py) || !isFinite(pz) || !isFinite(scale)) continue;
    const e = 2.0 * Math.exp(scale);
    if (first) {
      first = false;
      mx = px - e; my = py - e; mz = pz - e;
      Mx = px + e; My = py + e; Mz = pz + e;
    } else {
      mx = Math.min(mx, px - e); my = Math.min(my, py - e); mz = Math.min(mz, pz - e);
      Mx = Math.max(Mx, px + e); My = Math.max(My, py + e); Mz = Math.max(Mz, pz + e);
    }
  }
  const aabb = first ? null : [(mx + Mx) * 0.5, (my + My) * 0.5, (mz + Mz) * 0.5, (Mx - mx) * 0.5, (My - my) * 0.5, (Mz - mz) * 0.5];

  if (shBands > 0) {
    const labels = input.sh_labels!, centroids = input.sh_centroids!, shN = meta.shN!;
    const v2 = meta.version === 2;
    const coeffs = [0, 3, 8, 15][shBands];
    const rowStride = input.centroidsWidth * 4;
    const rest = Array.from({ length: 45 }, (_, c) => data[`f_rest_${c}`]);
    for (let i = 0; i < n; i++) {
      const label = labels[i * 4] + (labels[i * 4 + 1] << 8);
      const u = (label % 64) * coeffs;
      const row = Math.floor(label / 64) * rowStride;
      for (let j = 0; j < 3; ++j) {
        for (let k = 0; k < coeffs; ++k) {
          const byte = centroids[(u + k) * 4 + j + row];
          rest[j * 15 + k][i] = v2 ? shN.codebook[byte] : lerp(shN.mins, shN.maxs, byte / 255);
        }
      }
    }
  }

  const properties: SplatProperty[] = members.map((name) => ({ type: 'float', name, storage: data[name], byteSize: 4 }));
  return { count: n, properties, packed: { color, transformA, transformB, centers, aabb } };
}
