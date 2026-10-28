/**
 * Offscreen hole probing: how much of a view is gap rather than scene.
 *
 * WHAT A HOLE IS HERE, AND WHY IT IS NOT A COLOUR. A panorama reconstruction
 * only knows the surfaces one viewpoint could see. Step off that point and
 * everything that was in something's shadow - the floor behind a pillar, the
 * wall behind a sofa - has no splats at all, and renders as nothing. "Nothing"
 * is measured as ACCUMULATED ALPHA: the probe clears its target to
 * (0, 0, 0, 0) and a pixel no splat touched comes back with alpha 0, whatever
 * colour the scene happens to be. An earlier sketch of this counted magenta
 * pixels against a loud clear colour, which is a fine way to SHOW a human
 * where the gaps are and a bad way to measure them - a magenta wall, a neon
 * sign or a sunset all read as holes.
 *
 * ALPHA IS GRADED, AND AN EARLIER VERSION OF THIS FILE SAID IT WAS NOT.
 * PlayCanvas gives gsplat materials BLEND_PREMULTIPLIED, which is
 * `{src: ONE, dst: ONE_MINUS_SRC_ALPHA}` with NO separate alpha factors - so
 * the alpha channel composites the same way the colour does and accumulates
 * to 1 - prod(1 - a_i): real coverage. The note that used to be here claimed
 * an additive, saturating channel and concluded that the only honest test was
 * `alpha === 0`. That was wrong, and it made the probe under-report: a true
 * gap behind the faintest haze of stray splats scored as covered.
 *
 * So the threshold is the same KIND of number the scene-build scorer uses,
 * and set to the same 0.5. The two still are not interchangeable - that one
 * composites isotropic spheres on a CPU, this one real ellipses on a GPU, and
 * spheres close the gaps between discs - but they now measure the same
 * quantity rather than two different ones.
 *
 * ENVIRONMENT ONLY. The probe renders `scene.envLayerId` and nothing else, so
 * a character standing in the place cannot plug a hole and make it disappear
 * from the measurement. What is being judged is the reconstruction.
 *
 * NOTHING HERE IS VISIBLE. It owns its own camera and its own render target,
 * both off the main composition, so probing never disturbs the view the user
 * is looking at. The only thing that moves on screen is a deliberate camera
 * move, which is not this module's job.
 *
 * IT LIVES IN THE ENGINE AND NOT IN THE APP because nothing in PINOC's `src/`
 * imports PlayCanvas directly - the one copy of it is the engine's, and a
 * second import path would be a second copy at runtime. Rendering capabilities
 * belong on this side of that line anyway.
 */

import {
  ADDRESS_CLAMP_TO_EDGE,
  Color,
  Entity,
  FILTER_NEAREST,
  PIXELFORMAT_RGBA8,
  RenderTarget,
  Texture,
} from 'playcanvas';

import type { Scene } from '../scene';

/**
 * Read a render target's colour texture back, top row first, on either backend.
 *
 * THROUGH `Texture.read`, THE PORTABLE CALL, and not the device method this
 * file used to narrow to. `readTextureAsync` exists only on PlayCanvas's WebGL
 * device; the WebGPU device has no such method, so the old guard threw on
 * every WebGPU tab and the agent's `look` and `move_camera` - and, through the
 * same probe, the transcript's Look button - failed there without a word.
 * `Texture.read` hands off to the texture's backend implementation, which both
 * backends have: WebGL routes it to that same `readTextureAsync`, WebGPU does a
 * `copyTextureToBuffer` into a staging buffer.
 *
 * THE TWO HAND BACK ROWS IN OPPOSITE ORDERS, and only WebGL needs flipping.
 * WebGL's is a `readPixels` on the render target's framebuffer, whose origin is
 * the bottom-left corner, so row 0 is the BOTTOM of the picture. WebGPU copies
 * the texture itself, whose origin is the top-left; and since a render target
 * built here leaves `flipY` at its default of false, PlayCanvas does not flip
 * the projection either, so NDC +Y lands on texel row 0 and row 0 is the TOP.
 * Flipping both, as the WebGL-only version effectively did, would turn every
 * WebGPU mask upside down - harmless to `holeFraction`, wrong for the picture
 * sent to the model.
 *
 * THE LAYOUT IS THE SAME RGBA8 ON BOTH. Every target here is PIXELFORMAT_RGBA8
 * (`rgba8unorm` on WebGPU), four bytes a pixel and nothing else - there is no
 * depth or float target to decode, since holes are measured off the colour
 * target's own alpha. WebGPU pads each copied row to 256 bytes, and PlayCanvas
 * strips that padding before writing into `data`, so the buffer arrives
 * tightly packed at `width * 4` bytes a row, as WebGL's does. PlayCanvas
 * creates every non-compressed texture with COPY_SRC usage, which the copy
 * needs.
 *
 * `immediate`, BECAUSE THIS RUNS BETWEEN FRAMES. Without it WebGPU records the
 * copy into the device's open command encoder and maps the staging buffer on a
 * timer, which lands before anything submits that encoder - the map then
 * succeeds on a buffer the copy never reached. Measured on PlayCanvas 2.18 in
 * Chrome: an all-zero buffer, which this probe would score as a 100% hole.
 * `immediate` submits first. On WebGL it is a `gl.flush()`, which costs
 * nothing worth measuring at this size.
 *
 * Throws only for a backend that truly has no readback: `Texture.read` returns
 * undefined when the implementation lacks one (the null device, in tests), and
 * that must fail loudly rather than measure an untouched buffer.
 */
async function readTopDown(
  texture: Texture, target: RenderTarget, width: number, height: number, data: Uint8Array,
): Promise<void> {
  const pending = texture.read(0, 0, width, height, { renderTarget: target, data, immediate: true }) as
    Promise<unknown> | undefined;
  if (!pending) throw new Error('[sceneProbe] this graphics device cannot read a texture back');
  await pending;
  if (!texture.device.isWebGPU) flipRowsInPlace(data, width, height);
}

/** A camera pose to look from, in world space. */
export interface ProbePose {
  position: [number, number, number];
  yawDeg: number;
  pitchDeg: number;
  /** Horizontal field of view. Omitted takes {@link SceneProbeOptions.fovDeg}. */
  fovDeg?: number;
}

/** What one probe measured. */
export interface ProbeResult {
  pose: ProbePose;
  width: number;
  height: number;
  /** Share of pixels with no splat coverage at all. */
  holeFraction: number;
  /**
   * 1 where the pixel is a hole, row-major, top row first.
   *
   * Kept even though the agent only reads `holeFraction`, because the only
   * other consumer there will ever be - particles drawn over the gap while a
   * view generates - needs exactly this buffer and the one below, and getting
   * them out of a second readback later would cost a second render.
   */
  mask: Uint8Array;
  /** The frame itself, RGBA, same order as `mask`. */
  rgba: Uint8Array;
}

export interface SceneProbeOptions {
  /** Probe resolution. Small on purpose: this is a measurement, not a picture. */
  width?: number;
  height?: number;
  /** Horizontal field of view a probe renders at, degrees. */
  fovDeg?: number;
  /**
   * Accumulated alpha below which a pixel counts as a hole.
   *
   * 0.5, the scorer's own figure and the view-generation experiments' TAU_A.
   * It is a real threshold on a real coverage channel - see the module note,
   * and the correction in it. Lower it towards 0 to count only pixels nothing
   * drew at all; raise it to treat thin veils as gaps.
   */
  holeAlpha?: number;
}

const DEFAULTS = { width: 128, height: 72, fovDeg: 100, holeAlpha: 0.5 } as const;

/** A frame encoded for somebody to look at. */
export interface SceneCapture {
  /** `data:image/jpeg;base64,...`, self-contained. */
  dataUrl: string;
  width: number;
  height: number;
  /** The same hole measurement the probe makes, from the same frame. */
  holeFraction: number;
}

export interface SceneProbe {
  /** Measure one pose. */
  probe: (pose: ProbePose) => Promise<ProbeResult>;
  /**
   * Render a pose big enough to be looked at, and encode it.
   *
   * SEPARATE FROM `probe` BECAUSE THE SIZES ARE DIFFERENT QUESTIONS. A
   * measurement wants the smallest frame that still resolves a gap, because
   * the cost is a render and a readback and the answer is one number. A
   * picture for a vision model wants enough pixels to tell a smear from a
   * surface, which is the whole reason to send one. Forcing both through one
   * resolution would make every measurement expensive or every picture
   * useless.
   *
   * The environment only, as the probe is: what is being judged is the
   * reconstruction, and a character standing in front of a gap would hide it.
   */
  capture: (pose: ProbePose, size?: { width: number; height: number; quality?: number }) => Promise<SceneCapture>;
  /** Release the render target, the texture and the camera. */
  destroy: () => void;
}

/**
 * Build a probe for a scene.
 *
 * The camera it creates is disabled except during a single frame of a single
 * probe, so an idle probe costs one texture's worth of memory and no frame
 * time at all.
 */
export function createSceneProbe(scene: Scene, options: SceneProbeOptions = {}): SceneProbe {
  const o = { ...DEFAULTS, ...options };
  const device = scene.app.graphicsDevice;

  const texture = new Texture(device, {
    name: 'scene-probe',
    width: o.width,
    height: o.height,
    format: PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: FILTER_NEAREST,
    magFilter: FILTER_NEAREST,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
  });
  const target = new RenderTarget({ name: 'scene-probe', colorBuffer: texture, depth: true });

  const entity = new Entity('scene-probe-camera');
  entity.addComponent('camera', {
    clearColor: new Color(0, 0, 0, 0),
    clearColorBuffer: true,
    clearDepthBuffer: true,
    renderTarget: target,
    // The environment and nothing else - see the module note.
    layers: [scene.envLayerId],
    fov: o.fovDeg,
    // Horizontal, so the number means the same thing as the scorer's fov and
    // as what `enhance` will send the provider.
    horizontalFov: true,
    nearClip: 0.01,
  });
  entity.enabled = false;
  scene.app.root.addChild(entity);

  const pixels = new Uint8Array(o.width * o.height * 4);
  let destroyed = false;
  /**
   * Whether this camera's splats have ever been sorted.
   *
   * A WOKEN CAMERA HAS NO SORTED SPLATS, AND NO FRAME COUNT FIXES THAT.
   * PlayCanvas sorts a camera's splats on a WORKER, and the order data does
   * not survive the camera being disabled - so every wake re-sorts, and a
   * scene-sized cloud takes around 170 ms to come back, not a frame or two.
   *
   * That took three attempts to pin down because the symptom hides whenever
   * probes run close together. Measured on a real place, from the dev page's
   * own log: a reading taken seconds after the last one came back a perfect
   * 100% hole; three more taken milliseconds apart were all correct. Waiting
   * one extra frame did not help it, and waiting two did not either. What
   * separates the bad reading from the good ones is not how many frames it
   * waited - it is that the camera had gone cold in between.
   *
   * So readiness is TESTED on every wake, not timed and not cached: keep
   * rendering until the target has any coverage at all. That is a real
   * signal, because a frame with literally no splat in it is what an
   * unsorted camera produces and is almost impossible for a real pose - a
   * reconstruction has splats in every direction from its capture point. A
   * pose genuinely looking into the void falls through to the deadline once
   * and is then reported honestly as empty.
   *
   * EVERY PROBE NOW PAYS THIS. A ring sweep used to keep the camera awake for
   * all forty-eight of its poses and warm once for the lot; with the search
   * moved to the scene build there is no longer any caller that takes more
   * than one reading at a time, so the amortisation had nothing left to
   * amortise and the flag that bought it is gone. A `look` or a `move_camera`
   * costs one extra frame.
   */
  let warm = false;

  /**
   * How long to keep asking before accepting that a frame really is empty.
   *
   * Generous because it happens at most once per probe and the alternative
   * is a silently wrong first measurement, which is what shipped. On a cloud
   * small enough to sort in one frame this costs one frame.
   */
  const WARM_DEADLINE_MS = 2000;

  /**
   * THE FIRST FRAME AFTER THE CAMERA WAKES, OR AFTER ITS TARGET CHANGES, IS
   * THROWN AWAY.
   *
   * Two separate things had to be measured before this was clear, and both
   * are in the dev page's log. The cold start - the very first sort of a
   * scene-sized cloud - takes about 200 ms and is handled by `ensureWarm`
   * below. But a camera that is merely woken after sitting idle ALSO loses
   * its first frame, which is why a probe run seconds after a warm one read
   * a perfect 100% hole while the three that followed it milliseconds later
   * were all correct. Switching render target does the same, which is why a
   * capture was black even on a probe that had already warmed.
   *
   * One discarded frame costs about sixteen milliseconds and removes both.
   * A pose change on a live camera does NOT need it, which the old ring
   * sweep's own ranks 2-8 showed by being correct all along - but nothing
   * keeps the camera live across two readings any more, so every probe
   * discards one frame.
   */
  let settled = false;

  /**
   * Put the camera back to sleep, and forget everything a wake invalidates.
   *
   * `warm` goes with it: the order data does not survive this, so the next
   * wake has to prove itself again rather than trusting a flag set before
   * the camera went cold.
   */
  function sleepCamera(): void {
    entity.enabled = false;
    settled = false;
    warm = false;
  }

  /** Draw a frame, discarding the one after a wake or a target change. */
  async function drawFrame(): Promise<void> {
    if (!settled) {
      await nextFrame(scene);
      settled = true;
    }
    await nextFrame(scene);
  }

  /**
   * Render one frame with the camera live and read the small target back.
   *
   * `pixels` comes back top row first on either backend - see `readTopDown`.
   */
  async function renderSmall(): Promise<void> {
    await drawFrame();
    await readTopDown(texture, target, o.width, o.height, pixels);
  }

  /** Whether anything at all drew: the readiness test, not a coverage score. */
  function anyCoverage(buf: Uint8Array, stride = 4): boolean {
    for (let i = 3; i < buf.length; i += stride) if (buf[i]! > 0) return true;
    return false;
  }

  /**
   * Block until this camera's splats have been sorted at least once.
   *
   * The camera must already be enabled and posed. Reads the small target
   * rather than whichever one the caller wants, so a capture pays the same
   * cheap warm-up a probe does.
   */
  async function ensureWarm(): Promise<void> {
    if (warm) return;
    const deadline = Date.now() + WARM_DEADLINE_MS;
    for (;;) {
      await renderSmall();
      if (anyCoverage(pixels) || Date.now() >= deadline) break;
    }
    warm = true;
  }

  /** One rendered frame with the probe camera live, then the pixels back. */
  async function shoot(pose: ProbePose): Promise<ProbeResult> {
    if (destroyed) throw new Error('[sceneProbe] used after destroy()');
    entity.setPosition(pose.position[0], pose.position[1], pose.position[2]);
    // PlayCanvas Euler order is ZYX and its camera looks down -Z, so a yaw of
    // 0 looks along -Z. Callers speak compass yaw about +Y, which is the same
    // convention `cameraGlide` and the walk controller use.
    entity.setEulerAngles(pose.pitchDeg, pose.yawDeg, 0);
    const cam = entity.camera;
    if (cam) cam.fov = pose.fovDeg ?? o.fovDeg;

    entity.enabled = true;
    try {
      await ensureWarm();
      await renderSmall();
    } finally {
      sleepCamera();
    }

    // Already top row first - `readTopDown` flips where the backend reads
    // bottom-up - which is what every consumer of `mask` and `rgba` assumes.
    // Copied, because `pixels` is reused by the next probe.
    const rgba = pixels.slice();
    const n = o.width * o.height;
    const mask = new Uint8Array(n);
    let holes = 0;
    for (let i = 0; i < n; i++) {
      if (rgba[i * 4 + 3]! / 255 < o.holeAlpha) { mask[i] = 1; holes++; }
    }
    return { pose, width: o.width, height: o.height, holeFraction: holes / n, mask, rgba };
  }

  /** A second, larger target, built on first use and reused after. */
  let shot: { texture: Texture; target: RenderTarget; w: number; h: number } | null = null;

  return {
    probe: shoot,
    async capture(pose, size) {
      if (destroyed) throw new Error('[sceneProbe] used after destroy()');
      const w = size?.width ?? 512;
      const h = size?.height ?? Math.round((w * o.height) / o.width);
      if (!shot || shot.w !== w || shot.h !== h) {
        shot?.target.destroy();
        shot?.texture.destroy();
        const tex = new Texture(device, {
          name: 'scene-capture',
          width: w, height: h, format: PIXELFORMAT_RGBA8, mipmaps: false,
          minFilter: FILTER_NEAREST, magFilter: FILTER_NEAREST,
          addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE,
        });
        shot = { texture: tex, target: new RenderTarget({ name: 'scene-capture', colorBuffer: tex, depth: true }), w, h };
      }
      const cam = entity.camera;
      if (!cam) throw new Error('[sceneProbe] the probe camera went away');
      entity.setPosition(pose.position[0], pose.position[1], pose.position[2]);
      entity.setEulerAngles(pose.pitchDeg, pose.yawDeg, 0);
      cam.fov = pose.fovDeg ?? o.fovDeg;
      cam.renderTarget = shot.target;
      const buf = new Uint8Array(w * h * 4);
      entity.enabled = true;
      try {
        // Warm against the SMALL target first: the capture's own target is
        // new on its first use, and a warm-up that read it would be timing
        // the sort and the new attachment at once.
        cam.renderTarget = target;
        await ensureWarm();
        // The target changes under the camera here, so the next frame is
        // the one that gets thrown away - exactly as a wake's is.
        cam.renderTarget = shot.target;
        settled = false;
        await drawFrame();
        await readTopDown(shot.texture, shot.target, w, h, buf);
      } finally {
        cam.renderTarget = target;
        sleepCamera();
      }
      const rgba = buf;
      let holes = 0;
      for (let i = 0; i < w * h; i++) if (rgba[i * 4 + 3]! / 255 < o.holeAlpha) holes++;
      return {
        dataUrl: await encodeJpeg(rgba, w, h, size?.quality ?? 0.7),
        width: w, height: h, holeFraction: holes / (w * h),
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      entity.destroy();
      target.destroy();
      texture.destroy();
      shot?.target.destroy();
      shot?.texture.destroy();
    },
  };
}

/** Resolve once the app has drawn a frame with the probe camera enabled. */
function nextFrame(scene: Scene): Promise<void> {
  return new Promise((resolve) => {
    const app = scene.app as unknown as {
      once?: (name: string, cb: () => void) => void;
    };
    if (typeof app.once === 'function') {
      app.once('frameend', () => resolve());
      return;
    }
    // No event bus on this app build: a double rAF is the next best thing,
    // because one rAF can land before the frame the camera was enabled for.
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** Bottom-up framebuffer rows into top-down image rows, in place. */
function flipRowsInPlace(buf: Uint8Array, width: number, height: number): void {
  const stride = width * 4;
  const row = new Uint8Array(stride);
  for (let top = 0, bottom = height - 1; top < bottom; top++, bottom--) {
    const a = top * stride;
    const b = bottom * stride;
    row.set(buf.subarray(a, a + stride));
    buf.copyWithin(a, b, b + stride);
    buf.set(row, b);
  }
}

/**
 * RGBA bytes to a JPEG data URL.
 *
 * JPEG AND NOT PNG. The frame is a photograph of a rendered scene - gradients,
 * noise, no flat colour to speak of - so PNG would be four or five times the
 * bytes for detail a vision model does not use. A HOLE IS PAINTED FLAT BLACK
 * rather than left transparent: JPEG has no alpha, and an un-composited
 * transparent pixel encodes as whatever happened to be in the colour channels,
 * which for an untouched render target is black anyway - painting it says so
 * instead of relying on it.
 *
 * OffscreenCanvas rather than a DOM canvas, so this never touches the document
 * and can run while the tab is doing something else.
 */
async function encodeJpeg(rgba: Uint8Array, width: number, height: number, quality: number): Promise<string> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[sceneProbe] no 2d context to encode with');
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3]!;
    const opaque = a > 0;
    image.data[i * 4] = opaque ? rgba[i * 4]! : 0;
    image.data[i * 4 + 1] = opaque ? rgba[i * 4 + 1]! : 0;
    image.data[i * 4 + 2] = opaque ? rgba[i * 4 + 2]! : 0;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}
