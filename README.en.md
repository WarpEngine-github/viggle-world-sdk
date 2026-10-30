# @viggle/scene-sdk

[中文](README.md) | English

A TypeScript SDK for the Viggle Scene API (`https://apis.viggle.ai`). It covers:

- **Initial scene generation**: create a Gaussian Splat 3D scene from a description (optionally with reference images) or from a panorama
- **Expansion**: fly to a spot you want filled in, generate a new view from the current camera, and rebuild the scene with it
- **Rebuild**: drop the views a given expansion added and rebuild the scene
- **Character walking**: put a splat character into a scene and walk, run and jump in third person, with a follow camera that doesn't clip through walls, plus optional sunlight and shadows (the same implementation as the PINOC gallery page)

## Six entry points, import what you need

| Entry point | Contents | Size (gzip) | Runs in |
|---|---|---|---|
| `@viggle/scene-sdk` | API client, types, error classes, pose helpers | ~4 KB | Browsers, Node 18+, Deno, Bun, Edge; ships both ESM and CJS |
| `@viggle/scene-sdk/react` | Provider, hooks, `<SceneViewer>`, `<SceneStudio>`, `<SceneExplorerView>` | ~6 KB | React 18 / 19; SSR-safe; marked `"use client"` |
| `@viggle/scene-sdk/viewer` | `SceneRenderer` (free-flying WebGL viewer) | engine | Browser |
| `@viggle/scene-sdk/explorer` | `SceneExplorer` (character walking: character, locomotion, collision, follow camera) | engine + ~9 KB | Browser |
| `@viggle/scene-sdk/lighting` | `SceneLighting` (sunlight, character shadows, scene lamps) | engine + ~1.5 KB | Browser |
| `@viggle/scene-sdk/walk` | Pure walking logic: physics step, action state machine, ground probing, camera boom, scene placement | ~6 KB | Anywhere (no engine, no DOM) |

- **The 3D engine loads on demand**: the engine (splat engine + PlayCanvas, about 635 KB gzip) is one chunk shared by `/viewer`, `/explorer` and `/lighting`. `<SceneViewer>` and `<SceneExplorerView>` load it with a dynamic `import()` only when they mount. Apps that use only the client or the hooks never bundle PlayCanvas, and server rendering never touches WebGL.
- **Zero runtime dependencies**: the splat engine and (patched) PlayCanvas are bundled in; React is an optional peer dependency.

## Compatibility

Each of these was verified in a fresh project against the packed tarball:

| | |
|---|---|
| Node | `require('@viggle/scene-sdk')` (CJS), `import` (ESM) |
| TypeScript `moduleResolution` | `bundler`, `node16`, `nodenext`, `node10`; works in both ESM and CJS projects (CJS gets its own `.d.cts`) |
| React | 18.3 (bundled output run and verified), 19 |
| Bundlers | Vite. webpack 5, Next.js and Rspack also handle workers written as `new URL('…', import.meta.url)` |

## Install

```bash
npm install ./viggle-scene-sdk-0.4.0.tgz
```

React is optional (18 or 19); you can skip it if you only use the client or `/viewer`. The 3D engine is bundled in and there are no other runtime dependencies.

**With Vite**, add the following to `vite.config`. The SDK ships its own worker files, which must be served as is and not pre-bundled by Vite; but the React it imports is CommonJS and must be pre-bundled. Without this, the page is blank in dev mode with an error saying `react/jsx-runtime` does not export `jsxs`:

```ts
optimizeDeps: {
  exclude: ['@viggle/scene-sdk'],
  include: ['react', 'react/jsx-runtime', 'react-dom/client'],
},
```

## Quick start

```tsx
import { SceneStudio, ViggleSceneProvider } from '@viggle/scene-sdk/react';

export function App() {
  return (
    <ViggleSceneProvider baseUrl="/viggle-api">  {/* your proxy; see the note on API keys below */}
      <div style={{ height: 600 }}>
        <SceneStudio defaultScene={saved} onSceneChange={save} generateInput={{ quality: 'low' }} />
      </div>
    </ViggleSceneProvider>
  );
}
```

`<SceneStudio>` is an all-in-one component with:

- A floating composer at the bottom centre: type a description and click Generate (create a scene); Images picks reference images (up to 8, shown as removable thumbnails, sent with the description); Panorama creates a scene from a panorama. On narrow screens the input gets a row of its own
- A free-flying scene canvas: drag to look around, WASD/QE to move, scroll to dolly
- Fill view at the top right (generate a scene view from the current camera)
- Find gaps and Auto fill at the top right: find holes in the scene and fill them automatically; see "Finding and filling gaps" below
- A version timeline on the left: one row per step, click to switch to that version; when an expansion step is selected, its row shows Remove (rebuild the scene without that step)

The default look is dark frosted glass with a purple accent (`#7c5cff`). You can restyle it as described below.

### Toolbar slot

`toolbar` puts your own buttons next to Fill view at the top right. It receives the current scene and the version being viewed:

```tsx
<SceneStudio
  toolbar={({ scene, versionIndex }) => (
    <button onClick={async () => save(await client.fetchSplat(scene, versionIndex))}>Download</button>
  )}
/>
```

### Finding and filling gaps

A panorama reconstruction contains only what the capture point could see. Step a few paces away and anything that was hidden behind something (the floor behind a pillar, the wall behind a sofa) has no splats and shows up as a hole. Generating views from those spots fills in exactly what's missing.

- **Find gaps** (free, no credits): places a ring of candidate cameras round the capture point, inside the room, looking towards the middle of the scene. Each camera is rendered once offscreen to measure the share of the frame no splat covers (accumulated alpha < 0.5 counts as empty). The candidates are ranked from emptiest down, and the camera glides to the worst one. The top right shows "Gap 1/3 · 11% empty"; use ‹ › to move to the next gap, and Fill view fills from that view.
- **Auto fill** (costs one expansion's credits): finds the worst gap, flies the camera there, and generates a fill from that view straight away. If you have already clicked Find gaps, it fills the gap currently selected.

Both buttons act on the latest version only. A fill creates a new version and clears the gaps found earlier; click Find gaps again to see what is left. Pass `hideGaps` if you don't want these buttons.

Without `<SceneStudio>`, `SceneViewerHandle` and `SceneRenderer` offer the same:

```ts
const gaps = await viewer.findGaps({ onProgress: ({ measured, total }) => {} });  // free, emptiest first
if (gaps[0]) {
  await viewer.flyTo(gaps[0].pose);                        // glide the camera there
  await expand.expand(gaps[0].pose, { fov: viewer.fov });  // fill from that view (costs credits)
}
const empty = await viewer.measureView();                  // share of the current view that is empty, 0..1
```

`findGaps` options: `directions` (directions round the ring, default 12), `radii` (distance from the capture point in capture heights, default `[0.75, 1.5]`), `minHoleFraction` (less empty than this doesn't count, default 0.01), `maxGaps` (at most this many, default 5), `previews: true` (attach a JPEG preview to each gap, with the hole in black), `signal` (cancel mid-search). The returned `pose` is in the same frame as `getPose()`: pass it straight to `expand` or `client.expandScene`, or serialise it for an MCP tool or backend.

Note: this measure finds "empty", not "blurry". For example, standing too close to a distant surface, a few huge splats can cover the whole frame: the hole fraction is 0 but the view looks smeared.

### Reference images

- **Picked by the user**: the Images button in the composer picks reference images; they are cleared after a successful generation. Pass `hideReferences` to hide the button if users shouldn't pick their own.
- **Attached in code**: pass `generateInput={{ referenceImages: [...] }}` and they go with every generation. URLs, data URLs, `{ base64, mimeType }` and `File`s all work, up to 8 together with the user's picks.
- **Without `<SceneStudio>`**: call `gen.generate({ prompt, referenceImages })` or `client.generateScene({ prompt, referenceImages })` directly.
- **Either text or images is enough**: send only a prompt, only reference images, or both. In the Studio, Generate is clickable with images picked and nothing typed.

`<SceneStudio>` works controlled (`scene` plus `onSceneChange`) or uncontrolled (`defaultScene`).

### Theming

Three ways, from least to most change:

1. **CSS variables**, set on any ancestor: `--viggle-scene-bg`, `-surface`, `-text`, `-border`, `-accent`, `-danger`, `-radius`, `-font`
2. **`classNames`**: a class per part (suits Tailwind or CSS Modules). Parts include `root`, `versions`, `versionButton`, `expand`, `gapsButton`, `autoFillButton`, `gaps`, `status`, `error`, `promptBar`, `input`, `referencesButton`, `references`, `referenceThumb`, `referenceRemove`, `panoramaButton`, `generateButton`
3. **`unstyled`**: drops the built-in look and keeps only positioning. Every part carries a `data-viggle-part="…"` attribute you can select in CSS

Override any text with `labels`, in any language.

## Build your own

```tsx
import { SceneViewer, useSceneExpand, useSceneGeneration, type SceneViewerHandle } from '@viggle/scene-sdk/react';

function MyScene() {
  const viewer = useRef<SceneViewerHandle>(null);
  const [scene, setScene] = useState<ViggleScene | null>(null);
  const gen = useSceneGeneration({ onGenerated: setScene });
  const expand = useSceneExpand(scene, { onExpanded: setScene });

  return (
    <>
      <button onClick={() => gen.generate({ prompt: 'a sunlit open-plan office' })} disabled={gen.busy}>Generate</button>
      <SceneViewer ref={viewer} scene={scene} style={{ height: 500 }} />
      <button onClick={() => expand.expand(viewer.current!.getPose()!, { fov: viewer.current!.fov })} disabled={!scene || expand.busy}>
        Expand this view
      </button>
    </>
  );
}
```

| Hook | Methods | Callback when done |
|---|---|---|
| `useSceneGeneration(opts)` | `generate(input)`, `generateFromPanorama({ panorama, pose? })` | `onGenerated` |
| `useSceneExpand(scene, opts)` | `expand(pose, { fov, projection, seed })` | `onExpanded` |
| `useSceneRebuild(scene, opts)` | `rebuild(batchIds?)`, often with `withoutBatch(scene, id)` | `onRebuilt` |

Every hook returns `phase` (`idle → submitting → processing → ready | failed`), `busy`, `taskId`, `startedAt`, `result`, `error`, `cancel` and `reset`.

## Without React

```ts
import { createViggleSceneClient } from '@viggle/scene-sdk';       // Node / server / any framework
import { SceneRenderer } from '@viggle/scene-sdk/viewer';           // Browser, Vue, Svelte, plain JS

const client = createViggleSceneClient({ apiKey: process.env.VIGGLE_API_KEY });
let scene = await client.generateScene({ prompt: 'a cozy cabin', quality: 'low' });

const renderer = await SceneRenderer.create(canvas);
await renderer.load([scene.versions.at(-1)!.splatUrl]);
scene = await client.expandScene(scene, renderer.getPose()!, { fov: renderer.fov });

// Find a gap, fly there, and fill from that view
const [gap] = await renderer.findGaps();
if (gap) {
  await renderer.flyTo(gap.pose);
  scene = await client.expandScene(scene, gap.pose, { fov: renderer.fov });
}
```

## Character walking

The same implementation as the walking page of the [PINOC gallery](https://viggle.ai/pinoc/app/gallery#atticCabin): WASD / arrow keys to walk, Shift to run, Space to jump, drag to look around, scroll or pinch to zoom; touch screens get a joystick and a jump button automatically.

```tsx
import { SceneExplorerView } from '@viggle/scene-sdk/react';

<SceneExplorerView
  style={{ height: 600 }}
  scene={{ url: 'https://…/attic.sog', placement: { scale: 3.8, floor: 0.402, start: [0, 0.2] } }}
  character={{ url: 'https://…/girl.vsplat' }}          // 1.7 m tall by default
  light={{ azimuth: 216, elevation: 45, color: '#fff0d8' }} // optional: sun and shadows
  onReady={() => console.log('ready to walk')}
/>
```

- **`placement` (scene placement)**: `scale` is metres per file unit (tune it until doors and chairs look human-sized), `floor` is the height of the ground under the start point on the file's Y axis, and `start` is the start point's file (x, z). Files are taken as Y-down by default; pass `upright: true` for Y-up files, and `face` to set the starting heading. From then on the whole world is in metres, with the start point at the origin and the ground at y = 0.
- **Automatic placement, `placement: { auto: true }`**: for freshly generated or user-uploaded scenes of unknown scale. The SDK probes down from the capture point to find the ground, takes the capture height as 1.5 m (change it with `captureHeight`) to work out metres per unit, and stands the character on the capture point.
  - Orientation follows the file format: `.spz` is Y-up (as scenes from the API are), `.ply` is Y-down; override with `upright`.
  - After loading, `explorer.getPlacement()` returns the measured values; save them and pass them in next time.
  - `getPlacementSource()` returns `'measured'` or `'fallback'`. `'fallback'` means no ground was found and the common value of 10 metres per unit was used.
- **Actions**: by default, Viggle's public idle / walk / run / jump clips (`VIGGLE_LOCOMOTION_CLIPS`), which suit every Viggle splat character; swap in your own `.glb` or `.anim` with `clips`.
- **Collision**: on by default (`collision`). Voxel collision is built from the scene's own splats in a worker; the character slides along walls, and the camera pulls in along its boom when a wall is in the way. Ground height is probed from rendered opacity, so the character stands on the ground you can see.
- **Lighting**: `light` is optional; pass `null` or leave it out to use only the scene's own light.
  - Directions and positions (`azimuth`, `region`, `lamps`) are in the scene file's own coordinates; the SDK turns them into world coordinates through the placement.
  - Changing only `azimuth`, `elevation` or `intensity` adjusts the existing lights without a rebuild, so you can wire them to sliders; changing any other field (colour, shadows, …) rebuilds the lighting.
  - Without React, call `lighting.setSun({ azimuth, elevation, intensity })`.
  - On phones, pass `lightQuality="low"`.
- **Showing collision**: `showCollision` is for tuning scenes, not for players. You can also call `explorer.showCollision(view)`. Values:
  - `'outline'` (recommended): draws only the boundary of the walkable area on the ground (walls, pits and steps too high to climb all count), plus a ring under the character that is green normally and turns red when a wall blocks it.
  - `'cells'`: a wireframe of every collision voxel, for close inspection.
  - `'floor'`: only the tops you can stand on.
  - `'surface'`: the opaque solid surface, i.e. the collision mesh exported to game engines.
  - `'off'`: nothing.

  `cells`, `floor` and `surface` also draw the character's capsule. Collision is built in a worker, so the lines appear a moment after the scene does.
  - The `outline` boundary is worked out only within about 3.5 character heights of the character, and is recomputed as you walk away.
  - It comes from the pure function `walkableOutline` (in `@viggle/scene-sdk/walk`), which you can also feed to your own renderer.
- **Back to start**: call `ref.current.respawn()` (without React, `explorer.respawn()`). The character goes back to the spawn point; heading, camera distance and pitch reset, and any action playing stops. It also happens automatically when the character falls out of the scene (12 character heights below the ground).
- **ref**: `SceneExplorerHandle` offers `getWalker()`, `teleport()`, `respawn()`, `playAction()` and the underlying `explorer`.

### Switching scene, character and action

The example's Edit page (`#edit`) shows all three; its built-in assets come from Viggle's public CDN:

- **Switch scene**: change the `scene` prop; the whole scene reloads.
- **Switch character**: changing only `character.url` swaps the character in place. The scene, collision and camera stay and nothing is downloaded again; the new character is as tall as the old one, and lights and shadows follow it. Without React, call `explorer.setCharacter({ url })`.
- **Play an action**: call `ref.current.playAction(glbUrl, { loop })`; pass `null` to stop.
  - Takes `.glb` files for the Viggle splat skeleton, and baked `.anim` files.
  - Plays once by default and returns to standing; `loop: true` repeats it.
  - Walking or jumping interrupts an action.
  - Within one scene, each action is downloaded once.
  - `onActionChange` tells you which action is playing, and is called with `null` when it ends or is interrupted.

```tsx
const view = useRef<SceneExplorerHandle>(null);
<SceneExplorerView ref={view} scene={scene} character={{ url: characterUrl }} onActionChange={setPlaying} />
<button onClick={() => view.current?.playAction('https://…/wave.glb')}>Wave</button>
```

Without React:

```ts
import { SceneExplorer } from '@viggle/scene-sdk/explorer';
import { SceneLighting } from '@viggle/scene-sdk/lighting';

const explorer = await SceneExplorer.create(canvas);
await explorer.load({ scene: { url, placement }, character: { url: characterUrl } });
const light = SceneLighting.create(explorer, { azimuth: 216, elevation: 45 }); // destroyed when the scene changes
explorer.setMove({ x: 0, z: 1 });  // wire up your own virtual joystick; the keyboard is listened to automatically
await explorer.setCharacter({ url: otherCharacterUrl });  // swap the character in place
await explorer.playAction('https://…/wave.glb', { loop: false });
```

To use your own renderer or game loop, use the pure functions in `@viggle/scene-sdk/walk` directly: `stepWalker` (movement, gravity, steps, wall hits), `stepLocomotion` (idle / walk / run / jump transitions and jump timing), `buildFloorIndex` (ground probing from a point cloud), `boomLimit` / `followYaw` (camera boom and swinging round behind), and `placeWalkScene`. They depend on neither the engine nor the DOM, so they run and test in Node.

## API reference

| API docs | Endpoint | Low-level call | Wrapped method (submit and wait) |
|---|---|---|---|
| Create scene | `POST /v1/scenes/pano` | `createSceneTask` | `generateScene` |
| Create scene from a custom panorama | `POST /v1/scenes/custom-pano` | `createSceneFromPanoramaTask` | `generateSceneFromPanorama` |
| Generate scene view | `POST /v1/scenes/generate` | `generateViewTask` | `expandScene` |
| Rebuild scene | `POST /v1/scenes/reconstruct` | `reconstructTask` | `rebuildScene` |
| Get scene task | `GET /v1/scenes/{task_id}` | `getTask` / `waitForTask` | `refreshScene` (re-signs URLs) |

- **Polling**: `waitForTask` polls every 2 seconds at first, backing off to 5 seconds. Network errors, 429s and 5xxs are retried automatically, giving up only after more than `maxPollErrors` (default 3) in a row; 4xx errors are thrown at once.
- **Cancelling**: pass a `signal` to stop waiting; the task keeps running on the server.
- **Image inputs**: four forms, up to 8 reference images:
  - An http(s) URL: the API downloads it itself, and the request goes as JSON.
  - A data URL such as `data:image/png;base64,...`.
  - `{ base64, mimeType, name? }`: for text-only callers such as MCP tools and JSON APIs.
  - A `Blob` / `File`.

  The last three are treated as files and uploaded as multipart automatically; JPEG / PNG / WebP only. The reference images in one request must be all URLs or all files, not a mix.
- **Session busy (409)**: a `sessionId` runs one task at a time. Pass `waitIfBusy: true` to a wrapped method and the SDK waits for the running task to finish, then resubmits; the hooks take this option too.
- **Task status**: `queued` → `processing` → `ready` / `failed` / `cancelled`. `credits` on the task object is what it cost (6 for a `low`-quality panorama generation).

### Checked locally, by the server's rules

These rules were collected from the actual 400s `apis.viggle.ai` returns. The SDK stops such requests before sending them, and throws with the same error `code` and wording as the server (`SceneApiError`, `status` 400, `code` `INVALID_REQUEST`):

| Field | Rule |
|---|---|
| `sessionId` | 1–128 characters, letters, digits, `_` and `-` only |
| `prompt` / `referenceImages` | At least one of them. `prompt` is at most 1000 characters; without reference images it can't be all whitespace, and beside reference images whitespace counts as no prompt |
| `quality` | `low` / `medium` / `high`. The server doesn't accept `fast` |
| `referenceImages` | At most 8; URLs must be http(s) without a username or password |
| `panorama` | Can't be sent with `prompt` / `quality` / `referenceImages` |
| `referenceBatchIds` | 1–35, lowercase canonical UUIDs, no repeats |
| `pose` / C2W | A 4×4 numeric matrix whose last row is `[0,0,0,1]` |
| `fov` | 20–140; not sent when `projection: 'pano'` |
| `seed` | An integer from 0 to 4294967295 |
| `spzOutputUrl` | http(s) without a username or password |

One limit the server does not check at submit time: a scene is rebuilt from at most 40 images. Past that, the server runs the generation first and only then fails, wasting the credits. The SDK records `viewCount` on every version, and `expandScene` refuses up front when the limit would be exceeded. The limit is exported in `LIMITS`.

## The caller keeps the scene state

**The API does not store scenes.** A scene is a `sessionId` plus an ordered list of batch ids. The SDK represents it as `ViggleScene`, a plain JSON object: `{ sessionId, versions: [{ taskId, operation, batchIds, splatUrl, pose, batch, viewCount, … }] }`, where the last version is the current one.

`batch` is the set of images that version added, with each image's link and camera parameters (`c2w`, `intrinsic`); `viewCount` is the total number of images the rebuild used. Store it in your own database to reopen or keep expanding the scene later. `splatUrl` is a signed link that expires after about 3 hours; re-sign it with `client.refreshScene(scene)`. To keep the file long-term or hand it to another viewer, `client.fetchSplat(scene, versionIndex?)` gets the file itself (a `Blob`, `.spz`), re-signing once if the link has expired.

## Keep the API key out of the frontend

An `sk-` key written into browser code is public. Have the browser call your own server instead, which adds `Authorization: Bearer $VIGGLE_API_KEY` and forwards to `https://apis.viggle.ai`; the frontend sets only `baseUrl`. Pass `apiKey` directly only on a server, in scripts, or in local development.

## Poses

A camera can be written three ways, and every place that takes a pose (`expandScene`, `generateViewTask`, `createSceneFromPanoramaTask`, `useSceneExpand`) accepts all three:

```ts
client.expandScene(scene, { yaw: 90, pitch: -10 });                    // angles: easiest to write by hand, suits agents
client.expandScene(scene, renderer.getPose()!);                        // { position, forward }: from a preview
client.expandScene(scene, [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]);  // a 4×4 matrix, sent as is
```

- **`yaw`**: degrees turned right from the panorama's front: 0 is front, 90 right, 180 back, -90 left. This mapping was checked against the cube faces the API actually returns.
- **`pitch`**: positive looks up, negative looks down, from -90 to 90.
- **`position`**: defaults to the capture point `[0,0,0]`.
- **Converting**: `anglesToPose` / `poseToAngles` convert between the two forms; `toC2W` turns any of them into a matrix.

`ScenePose { position, forward }` uses the provider's camera frame: the OpenCV convention, Y down, origin at the panorama's capture point. SPZ files themselves are stored Y-up; the SDK handles the difference, so what `getPose()` returns can go straight to the API. `poseToC2W` turns a pose into the 4×4 matrix the API wants (keeping the horizon level, the same way the Viggle backend does); you can also pass a matrix directly.

## Errors

| Error class | Meaning |
|---|---|
| `SceneApiError` | The request was refused or the task failed. `status` is the HTTP status, or 0 for a failed task; also `code`, `requestId` (from the `X-Request-Id` header when the body has none), `retryable`, `remediation` and `details`. Helpers: `isAuthError` (key missing or invalid), `isSessionBusy` (409; `runningTaskId` gives the running task), `shouldRetry` (a failed task follows the server's `retryable`; a refused request goes by status: 409/429/5xx are retryable) |
| `SceneTimeoutError` | `timeoutMs` passed (the task is still running) |
| `SceneNetworkError` | The network is unreachable |

Every error can be passed straight to `JSON.stringify`, giving `name`, `message`, `status`, `code`, `requestId`, `retryable`, `shouldRetry`, `taskId` and so on, without leaking signed links. For any thrown value, `serializeError(err)` turns it into the same shape, for logs, API responses or MCP tool results.

When a task fails because the server doesn't have a batch (it came from another service or account, or is past retention), the server says only "Cache rejected scene request". The SDK rewrites it into an error message that explains why.

## Example

`example/` is a small project you can run as is, showing everything the SDK does:

```bash
cd example
npm install
cp .env.example .env.local   # fill in VIGGLE_API_KEY; leave it empty to use the built-in mock API
npm run dev                  # http://localhost:5191
```

The key stays on the local dev server: the page calls `/viggle-api`, and the dev server forwards to `https://apis.viggle.ai` with the `Authorization` header added, so the key never reaches the page. In a real product your own server should do this; see "Keep the API key out of the frontend" above.

The example is one complete flow across three pages:

1. **Studio** (`#`): generate and expand scenes. **Download** at the top right saves the current version as a `.spz` file; **Use in Edit →** saves it to the local scene library and goes to Edit.
2. **Edit** (`#edit`): pick a scene (the 4 from the gallery, plus My scenes: those sent from Studio or added with **Upload** as `.spz/.ply/.sog`). Your own scenes get their ground measured automatically; use Size to scale them and flip their orientation.
   - **Light**: pick a lighting preset (Off / Scene / Daylight / Golden hour / Overcast / Blue hour), adjust direction, height and intensity with sliders, and toggle shadows.
   - **Collision**: show the collision wireframe (Lines / Floor / Surface); for debugging only, never published.
   - Then pick a character and an action, enter a title, and click **Publish to Showcase →**. The lighting is published with it.
3. **Showcase** (`#showcase`): shows what was published, plays the chosen action on open, and lets you walk around.

Edit and Showcase both have two buttons at the top left: **▦ Collision** toggles the collision wireframe, and **⟲ Back to start** sends the character back to the spawn point.

Scene files are kept in the browser's IndexedDB (no reliance on expiring signed links), and published configs in localStorage. In a real product both belong on your own server; see `example/library.ts`.
