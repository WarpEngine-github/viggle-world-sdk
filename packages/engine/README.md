# @viggle/splat-engine

Minimal Gaussian Splat character engine. Load `.bin` characters, play `.anim` skeletal animations with crossfade blending, load `.ply`/`.spz` environment splats, render with PlayCanvas.

Skeleton data is bundled in the engine — no external asset files needed.

## Install

```bash
npm install @viggle/splat-engine
```

Requires `playcanvas@2.17.2` (installed as dependency).

## Quick Start

```typescript
import {
  Scene,
  Character,
  Animation,
  Environment,
  OrbitControls,
  Grid,
  SkyDome,
} from '@viggle/splat-engine';

// 1. Create scene
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const scene = await Scene.create(canvas, { fov: 45 });
scene.start();

// 2. Orbit camera + sky + grid + environment splat (optional)
const controls = new OrbitControls({
  distance: 4,
  pitch: 15,
  target: { x: 0, y: 0.8, z: 0 },
});
controls.attach({ canvas, cameraEntity: scene.cameraEntity });
scene.app.on('update', () => controls.update());
SkyDome.create(scene, { topColor: '#c2f0ff', bottomColor: '#ffffff' });
Grid.create(scene);
await Environment.load(scene, '/assets/room.spz');

// 3. Load character
const character = await Character.load(scene, '/assets/character.bin');

// 4. Load animations (fetch + parse + register in one call)
await Promise.all([
  Animation.load(scene, '/assets/idle.anim', 'idle'),
  Animation.load(scene, '/assets/run.anim', 'run'),
]);

// 5. Play / crossfade
character.playAnimation('idle', { loop: true });
character.crossfadeTo('run', { duration: 0.3, loop: true });
```

## API Reference

### Scene

#### `Scene.create(canvas, options?): Promise<Scene>`

Initialize the rendering engine on a canvas element.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `bgColor` | `{r,g,b,a}` | `{0.08, 0.08, 0.12, 1}` | Background clear color (0-1 floats) |
| `fov` | `number` | `60` | Camera field of view in degrees |
| `near` | `number` | `0.1` | Camera near clip plane. Lower it for a panorama reconstruction, whose nearest surface can sit ~0.2 units from the capture point |
| `far` | `number` | `100` | Camera far clip plane |
| `cameraPosition` | `{x,y,z}` | `{0, 1, 5}` | Initial camera position |
| `cameraTarget` | `{x,y,z}` | `{0, 0.5, 0}` | Initial camera look-at target |
| `ambientLight` | `number` | `0.55` | Ambient light intensity (0-1) |
| `exposure` | `number` | `1` | Tone mapping exposure |
| `loadSkeleton` | `boolean` | `true` | Load skeleton library on creation |
| `antialias` | `boolean` | `false` | WebGL antialiasing |
| `backend` | `'webgl' \| 'webgpu'` | auto | Preferred graphics backend. Omit to auto-detect (prefers WebGPU, falls back to WebGL2). |
| `depth` | `boolean` | `false` | Request a depth buffer on the graphics device. Turn on when mixing PC standard render meshes / lines / immediate-mode geometry — without it, opaque meshes paint in submission order. Splat-only scenes can leave it off. |
| `physics` | `boolean \| { loadAmmo }` | `false` | Register PC's Ammo-backed physics systems. See [Physics (opt-in)](#physics-opt-in). |
| `extraComponentSystems` | `unknown[]` | `[]` | Additional PC component systems to register beyond the engine's defaults. |
| `extraResourceHandlers` | `unknown[]` | `[]` | Additional PC resource handlers to register beyond the engine's defaults. |
| `logDeviceCaps` | `boolean` | `false` | Log graphics device capabilities at creation for backend-diagnostic triage. |

Returns a `Scene` instance:

```typescript
class Scene {
  app: AppBase;                                    // PlayCanvas app instance
  contentRoot: Entity;                             // Parent entity for all content
  cameraEntity: Entity;                            // Camera entity
  graphicsDevice: GraphicsDevice;
  skeletonLibrary: SkeletonLibrary;
  skeletalAnimationLibrary: Map<string, Animation>;
  outlines: OutlineRegistry;                       // Per-entity outline registry
                                                   //   (see "Outlines" below)

  start(): void;                                   // Start render loop
  destroy(): void;                                 // Clean up all resources

  static getDeviceCapabilities(device): Record<string, unknown>;
}
```

`Scene.getDeviceCapabilities` collects common WebGL/WebGPU capability fields from a PlayCanvas graphics device. Useful for debug overlays and backend diagnostics.

---

### Character

#### `Character.load(scene, url, options?): Promise<Character>`

Load a `.bin` character bundle and add it to the scene.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | filename | Character name |
| `position` | `{x,y,z}` | origin | Initial world position |

Returns a `Character` instance:

```typescript
class Character {
  armature: Armature;   // Skeleton + animation controller
  splat: Splat;         // Gaussian splat renderer

  // Transform (all trigger sort refresh automatically)
  setPosition(x: number, y: number, z: number): void;
  setRotation(xDeg: number, yDeg: number, zDeg: number): void;  // Euler degrees
  setScale(x: number, y: number, z: number): void;

  // Playback
  playAnimation(name: string, opts?: { loop?: boolean; rootMotion?: boolean }): boolean;
  crossfadeTo(name: string, opts?: { duration?: number /* default 0.08 */; loop?: boolean; rootMotion?: boolean }): boolean;
  stop(fadeDuration?: number): void;

  destroy(): void;
}
```

`playAnimation()` starts a registered animation immediately (hard switch, no crossfade). Returns `false` if the animation isn't registered. Defaults: `loop: true`, `rootMotion: false`.

`crossfadeTo()` snapshots current bone poses and smoothly blends toward the new animation over `duration` seconds (default `0.08`). Safe to call mid-crossfade — always starts from wherever bones actually are.

`stop()` with no argument snaps to rest pose; pass a `fadeDuration` to crossfade back to rest instead.

---

### Animation

#### `Animation.load(scene, url, name): Promise<Animation>`

Fetch, parse, and register a `.anim` file on the scene under `name`, in one call. Supports v2 (float32) and v3 (float16) formats. After this resolves, `character.playAnimation(name)` / `character.crossfadeTo(name)` can reference it.

```typescript
await Animation.load(scene, '/assets/idle.anim', 'idle');
character.playAnimation('idle', { loop: true });
```

#### `Animation.parse(buffer): Animation` (advanced)

Parse an already-fetched `ArrayBuffer` into an `Animation` for custom fetch pipelines. Pair with `animation.register(scene, name)` to make it playable. Most callers should use `Animation.load` instead.

---

### Environment Splats

#### `Environment.load(scene, url, options?): Promise<Environment>`

Load a Gaussian-splat file as an environment and attach it to the scene. Supports `.ply` (and the PlayCanvas-native `.compressed.ply`, `.sog`, `.sogs` variants) natively, plus `.spz` via on-the-fly conversion through [`spz-js`](https://www.npmjs.com/package/spz-js).

Installs the engine's environment work-buffer modifier so the splat responds to the lighting registry (sun + sky + point lights). Mounts the asset with `unified: true` so the environment sorts together with characters loaded via `Character.load`.

```typescript
import { Environment } from '@viggle/splat-engine';

const env = await Environment.load(scene, '/assets/room.spz', {
  position: { x: 0, y: 0, z: 0 },
  scale: 1,
});
// later:
env.destroy();
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | URL basename | Entity name |
| `position` | `{x,y,z}` | origin | World position |
| `rotation` | `{x,y,z}` | none | Euler angles in degrees |
| `scale` | `number` | `1` | Uniform scale |
| `filename` | `string` | inferred | Explicit filename for extension detection on URLs without one (e.g. signed CDN URLs) |

#### Clip bounds

`Environment` exposes an axis-aligned world-space render clip box. Splats whose center falls outside the box on any axis are collapsed to zero scale by the env work-buffer modifier and contribute no pixels. Useful for hiding sky / ceiling / off-stage geometry from a scanned environment without re-baking the file.

```typescript
import { Vec3 } from 'playcanvas';

// Hide everything above world-Y = 3.
env.setClipMaxY(3);

// Or set a full 6-DOF box (any component may be ±Infinity → "unbounded on that axis").
env.setClipBounds(
  new Vec3(-10, -Infinity, -10),
  new Vec3( 10,  3,         10),
);

env.clipBoundsMin;  // readonly Vec3 — current lower corner
env.clipBoundsMax;  // readonly Vec3 — current upper corner
```

Default: ±Infinity on every axis (no clipping). Infinity is normalised to a finite sentinel (≈1e9) internally so the shader math stays well-defined.

#### Clip distance

The radial sibling of the clip box, for the shells an axis-aligned box cannot describe. `setClipDistance(min, max)` keeps only the splats whose center lies in the half-open spherical shell `[min, max)` around a chosen origin; the rest are collapsed to zero scale the same way. Peeling a capture into depth layers around a viewpoint, a dome of sky past some radius, a bubble of interior around the player.

```typescript
import { Vec3 } from 'playcanvas';

// Measure from the viewer rather than the world origin.
env.setClipDistanceOrigin(scene.cameraEntity.getPosition());

// One depth layer: 2 units out to 4 units.
env.setClipDistance(2, 4);

// No far bound, and then back to no clipping at all.
env.setClipDistance(2);
env.setClipDistance(0);

env.clipDistanceMin;     // number
env.clipDistanceMax;     // number, `Infinity` when unbounded
env.clipDistanceOrigin;  // readonly Vec3
```

The band is half-open so that successive bands (`[0, 1)`, `[1, 2)`, ...) tile the scene with every splat in exactly one of them: a closed upper bound would draw the splats on a seam into two layers. It composes with the clip box rather than replacing it, so a splat has to survive both. `max <= min` is an empty band and renders nothing.

Changing the band per frame needs a `Splat.markEnvWorkBuffersDirty()` after the call, the same caveat `setCameraCull` carries: env splats update their work buffer automatically, so pushing uniforms alone does not re-render one.

#### `loadSplatAsset(app, url, filename?): Promise<Asset>` (advanced)

Low-level loader that returns a raw PlayCanvas `gsplat` `Asset` without scene wiring or the environment work-buffer modifier. Use when you need to manage the entity mount yourself; otherwise prefer `Environment.load`.

---

### Outlines

`scene.outlines` is an opt-in, per-entity outline registry with automatic ancestry-based merging.

- **Opt-in per entity** — an outline only appears when code explicitly calls `tag(entity, cfg)`. Untagged children of a tagged parent stay invisible to the registry; nothing recursive happens automatically.
- **Structural merge** — two tagged entities merge into one silhouette iff one is an ancestor of the other in the scene graph. Each connected component of tagged entities gets its own mask render target. The group root (topmost tagged ancestor) sets the colour + thickness.

```typescript
import { Color } from 'playcanvas';

scene.outlines.tag(character.armature.entity, {
  color: new Color(1, 0.4, 0.8, 1),
  thicknessPx: 3,
});
// Parenting an item under the character entity collapses it into the
// same silhouette — no second tag, no second pass.
scene.outlines.tag(swordEntity, {
  color: new Color(0.2, 0.9, 1.0, 1),
});

// Reparenting a tagged entity? Force a re-solve:
scene.outlines.rebuild();

scene.outlines.untag(swordEntity);
```

The group solver runs only on `tag` / `untag` / `rebuild` — never per frame.

For lower-level control, `OutlineEffect` is also exported and can be constructed directly. The registry layers ancestry-merge logic on top of one or more `OutlineEffect`s; standalone usage is documented in the source.

---

### GLB / GLTF Models

PlayCanvas's `ContainerHandler` is registered by default — call PC's asset API directly to load any GLB/GLTF (game props, weapons, stage geometry, prop interactables, etc.). No engine wrapper exists for this because there's nothing engine-specific to wrap.

```typescript
import { Asset } from 'playcanvas';

async function loadGlb(scene: Scene, url: string): Promise<Entity> {
  const asset = new Asset(url.split('/').pop()!, 'container', { url });
  scene.app.assets.add(asset);
  scene.app.assets.load(asset);
  await new Promise<void>((resolve, reject) => {
    asset.once('load', () => resolve());
    asset.once('error', (err) => reject(new Error(String(err))));
  });
  const root = (asset.resource as any).instantiateRenderEntity();
  scene.contentRoot.addChild(root);
  return root;
}

const prop = await loadGlb(scene, '/assets/sword.glb');
prop.setPosition(0, 1, 0);
```

If you want depth-correct mixing of GLB models with splats, set `depth: true` on `Scene.create` — otherwise PC standard meshes paint in submission order.

**Out of scope:** Draco-compressed GLB, KTX2 textures, and separated `.gltf` + `.bin` + textures all work through the same `ContainerHandler` but need extra global config (`pc.WasmModule.setConfig(...)`, basis transcoder setup). That's a PC-level concern — follow PC's docs. The engine doesn't bundle the decoders.

**FBX / OBJ / other formats**: not supported by PC natively. If your asset pipeline produces these, convert at build time (FBX → glTF via [FBX2glTF](https://github.com/facebookincubator/FBX2glTF), OBJ → glTF via [obj2gltf](https://github.com/CesiumGS/obj2gltf)) or use a runtime loader like three.js in your application layer — but keep that out of the engine.

---

### Physics (opt-in)

The engine does not include physics, does not ship Ammo, and has no opinion about gravity or simulation step. It can register PlayCanvas's Ammo-backed `RigidBodyComponentSystem` + `CollisionComponentSystem` if you ask for them. Setup is your responsibility for three reasons: Ammo's npm packaging is fragmented, the wasm sidecar is bundler-specific, and pinning an Ammo build to your PC version is a contract the engine shouldn't make for you.

#### Consumer checklist

1. **Vendor Ammo.** Grab `ammo.wasm.js` + `ammo.wasm.wasm` from the `playcanvas/engine` repo at the tag matching your PlayCanvas version (`examples/src/lib/ammo/`). Check both files into your app's `public/lib/ammo/` (or equivalent static-asset folder). Pinning is "whatever's in the repo."
2. **Write a loader.** 3 lines. The shim assigns a Promise-returning factory to `globalThis.Ammo`; you call it once and overwrite the global with the resolved namespace:

   ```typescript
   async function loadAmmo() {
     if ((globalThis as any).Ammo) return;
     await new Promise<void>((resolve, reject) => {
       const s = document.createElement('script');
       s.src = '/lib/ammo/ammo.wasm.js';
       s.onload = () => resolve();
       s.onerror = reject;
       document.head.appendChild(s);
     });
     (globalThis as any).Ammo = await (globalThis as any).Ammo();
   }
   ```

3. **Pass it to `Scene.create`** so the engine awaits Ammo before registering the physics systems:

   ```typescript
   const scene = await Scene.create(canvas, {
     physics: { loadAmmo },
     depth: true,            // see below
   });
   scene.app.systems.rigidbody!.gravity.set(0, -9.81, 0);
   ```

   Pass `physics: true` instead if Ammo is already on `globalThis` (e.g. loaded via a synchronous script tag in `index.html`). The engine throws a clear error if `physics: true` but the global is absent.

4. **Turn on `depth: true`.** Physics scenes almost always mix PC standard render meshes (colliders' visible representations) with splat content. Without a depth buffer, opaque meshes paint in submission order and farther geometry covers closer geometry. The engine's default is `depth: false` because gsplat sorts itself; flip the flag when you add render meshes.

5. **Configure gravity / simulation knobs on `scene.app.systems.rigidbody`** — the engine deliberately doesn't proxy these. The bypass is the API for everything physics-specific past "is it registered?"

#### What the engine guarantees

- If you pass `{ loadAmmo }`, the engine awaits your loader before constructing the rigidbody/collision systems.
- If you pass `true` without `globalThis.Ammo` set, you get an actionable error, not a silent NaN-explosion later.
- The engine does not import Ammo, does not bundle Ammo, and does not pin an Ammo version. Splat-only consumers pay zero bytes for the physics path.

#### Custom component systems / resource handlers

For PC subsystems beyond physics (audio, particles, custom file formats), pass them through `extraComponentSystems` / `extraResourceHandlers`:

```typescript
import { SoundComponentSystem } from 'playcanvas';

const scene = await Scene.create(canvas, {
  extraComponentSystems: [SoundComponentSystem],
});
```

This is the generic escape hatch — anything PC supports as a component system or resource handler plugs in here without a dedicated engine option.

---

### Utilities

#### `OrbitControls`

Mouse-driven orbit camera controller.

```typescript
const controls = new OrbitControls({
  yaw: 0,              // Initial horizontal angle (degrees)
  pitch: 15,           // Initial vertical angle (degrees)
  distance: 5,         // Distance from target
  target: {x:0, y:0.5, z:0},
  distanceRange: [0.5, 50],   // Zoom min/max
  orbitSensitivity: 0.3,      // Degrees per pixel drag
  panSensitivity: 0.002,      // Pan speed multiplier
  zoomSensitivity: 0.001,     // Scroll zoom multiplier
});
controls.attach({ canvas, cameraEntity: scene.cameraEntity });

scene.app.on('update', () => controls.update());

controls.destroy();
```

**Controls:** Left-drag = orbit, Right/Middle-drag = pan, Scroll = zoom.
**Properties:** `yaw`, `pitch`, `distance` (read/write), `target` (Vec3, read).

#### `Grid.create(scene, options?): Grid`

Ground grid rendered via ray-plane intersection in a fullscreen shader. Proper depth sorting with GSplat content.

```typescript
const grid = Grid.create(scene, {
  size: 50,            // Half-extent
  divisions: 100,      // Number of grid lines
  color: '#b5b5b5',    // Line color (CSS hex string)
  fadeStart: 3,        // Fade start distance from camera
  fadeEnd: 18,         // Fade end distance from camera
  y: 0,                // Vertical position
  showAxes: true,      // Red X-axis / blue Z-axis lines
});

grid.enabled = false;  // Toggle visibility
```

#### `SkyDome.create(scene, options?): SkyDome`

Gradient sky background. Renders a view-direction-aware gradient that adapts to camera angle.

```typescript
const sky = SkyDome.create(scene, {
  topColor: '#c2f0ff',
  bottomColor: '#ffffff',
});

sky.enabled = false;  // Toggle visibility
sky.entity;           // Underlying PlayCanvas Entity
```

---

### Advanced: Direct Class Access

For custom pipelines, the `Armature` and `Splat` classes are exported directly:

```typescript
import { Armature, Splat } from '@viggle/splat-engine';
```

- **`Armature`** — Bone hierarchy, rest pose, keyframe evaluation, crossfade blending, per-frame `update(dt)`.
  Methods: `playAnimation()`, `crossfadeTo()`, `stop()`, `move(position?, rotation?, scale?)`, `endCrossfade()`, `destroy()`.
  Getters/setters: `rootMotion`, `isPlaying`, `isFinished`, `paused` (pause/resume), `animationTime` (writable, in frames — use for scrubbing), `animationDuration` (read-only frame count), `crossfadeProgress` (`[0, 1]` — blend factor of the active crossfade; `0` when none is active), `boneNames` (read-only `readonly string[]` from the attached scene's skeleton library), `currentAnimationName`, `frameRate`.
  `destroy()` detaches the armature from its scene, disposes linked splats, and frees the pivot entity — call when removing a character outside the `Character.destroy()` flow.

- **`Splat`** — PlayCanvas GSplat entity wrapper, GPU textures (bone indices/weights), transform palette, work buffer shader override for bone blending. Methods: `updatePositions(boneTransforms)`, `requestSort()`, `destroy()`.

---

## Asset Formats

The only files users need to provide:

- **Character** (`.bin`) — `VFCHARB1` binary bundle containing Gaussian splat data, bone weights, and optionally embedded animation. Rig is picked from the bundle's bone count: 441 bones = full body + facial rig, otherwise the 86-bone std-male body rig.
- **Animation** (`.anim`) — Skeletal animation file with per-bone 4x4 matrices per frame. Supports float32 (v2) and float16 (v3) encoding.
- **Environment splat** (`.ply`, `.compressed.ply`, `.sog`, `.sogs`, `.spz`) — Gaussian splat scene/background, loaded via `Environment.load` (or `loadSplatAsset` for the low-level path). SPZ files are converted to PLY in-memory before hand-off to PlayCanvas.

Skeleton data (bone hierarchy, rest pose, bone names) is bundled inside the engine package — no external skeleton files to serve.
