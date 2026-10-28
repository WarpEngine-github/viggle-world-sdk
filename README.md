# @viggle/scene-sdk

Viggle Scene API（`https://apis.viggle.ai`）的 TypeScript SDK，支持以下操作：

- **初始场景生成**：用一句描述（可附参考图）或一张全景图生成 Gaussian Splat 3D 场景
- **扩展生成**：飞到想补全的位置，按当前相机生成一个新视角，并重建场景
- **重建**：去掉某一步扩展加入的视角，重新构建场景
- **角色漫游**：把一个 splat 角色放进场景，第三人称走、跑、跳，相机跟随且不穿墙，可加太阳光和影子（和 PINOC gallery 页面同一套实现）

## 六个入口，按需引入

| 入口 | 内容 | 体积 (gzip) | 运行环境 |
|---|---|---|---|
| `@viggle/scene-sdk` | API 客户端、类型、错误类、位姿工具 | ~4 KB | 浏览器、Node 18+、Deno、Bun、Edge；同时提供 ESM 和 CJS |
| `@viggle/scene-sdk/react` | Provider、hooks、`<SceneViewer>`、`<SceneStudio>`、`<SceneExplorerView>` | ~6 KB | React 18 / 19；支持 SSR；带 `"use client"` |
| `@viggle/scene-sdk/viewer` | `SceneRenderer`（自由飞行的 WebGL 查看器） | 引擎 | 浏览器 |
| `@viggle/scene-sdk/explorer` | `SceneExplorer`（角色漫游：角色、走路、碰撞、跟随相机） | 引擎 + ~9 KB | 浏览器 |
| `@viggle/scene-sdk/lighting` | `SceneLighting`（太阳光、角色投影、场景灯） | 引擎 + ~1.5 KB | 浏览器 |
| `@viggle/scene-sdk/walk` | 走路的纯逻辑：物理步进、动作状态机、地面探测、相机吊臂、场景摆放 | ~6 KB | 任意（不依赖引擎和 DOM） |

- **3D 引擎按需加载**：引擎（splat 引擎 + PlayCanvas，约 635 KB gzip）是 `/viewer`、`/explorer`、`/lighting` 共用的一个 chunk。`<SceneViewer>` 和 `<SceneExplorerView>` 挂载时才通过动态 `import()` 加载它。只用客户端或 hooks 的应用不会打包进 PlayCanvas，服务端渲染时也不会碰到 WebGL。
- **零运行时依赖**：splat 引擎和（打过补丁的）PlayCanvas 都打包在内，React 是可选的 peer 依赖。

## 兼容性

以下组合都用打包后的 tarball 在一个全新项目里验证过：

| | |
|---|---|
| Node | `require('@viggle/scene-sdk')`（CJS）、`import`（ESM） |
| TypeScript `moduleResolution` | `bundler`、`node16`、`nodenext`、`node10`；ESM 和 CJS 项目都能用（CJS 有单独的 `.d.cts`） |
| React | 18.3（打包产物实际运行验证）、19 |
| 打包器 | Vite。webpack 5、Next.js、Rspack 也能处理 `new URL('…', import.meta.url)` 形式的 worker |

## 安装

```bash
npm install ./viggle-scene-sdk-0.4.0.tgz
```

React 是可选依赖（18 或 19），只用客户端或 `/viewer` 时可以不装。3D 引擎已经打包在内，没有其他运行时依赖。

**用 Vite 时**需要在 `vite.config` 里加下面这段。SDK 自带 worker 文件，要按原样提供，不能让 Vite 预构建；但 SDK 引用的 React 是 CommonJS，必须预构建。漏掉这段的话，开发模式下页面会白屏，报错 `react/jsx-runtime` 没有导出 `jsxs`：

```ts
optimizeDeps: {
  exclude: ['@viggle/scene-sdk'],
  include: ['react', 'react/jsx-runtime', 'react-dom/client'],
},
```

## 快速开始

```tsx
import { SceneStudio, ViggleSceneProvider } from '@viggle/scene-sdk/react';

export function App() {
  return (
    <ViggleSceneProvider baseUrl="/viggle-api">  {/* 你的代理地址，见下面关于 key 的说明 */}
      <div style={{ height: 600 }}>
        <SceneStudio defaultScene={saved} onSceneChange={save} generateInput={{ quality: 'low' }} />
      </div>
    </ViggleSceneProvider>
  );
}
```

`<SceneStudio>` 是一体化组件，包含：

- 底部居中的悬浮输入栏：写描述后点 Generate（创建场景）；Images 选参考图（最多 8 张，有缩略图可删除，跟描述一起提交）；Panorama 用全景图创建场景。窄屏时输入框单独占一行
- 自由飞行的场景画布：拖动转视角，WASD/QE 移动，滚轮推近
- 右上角 Fill view（生成场景视图，按当前视角补全）
- 右上角 Find gaps 和 Auto fill：自动找出场景里的漏洞并补图，见下面的「自动找漏洞、补图」
- 左侧的版本时间线：每一步一行，点一下切到那个版本；选中某一步扩展时，行内出现 Remove（重建场景时去掉这一步）

默认配色是深色毛玻璃加紫色强调色（`#7c5cff`），可以用下面的方式改成你自己的风格。

### 工具栏插槽

`toolbar` 可以在右上角 Fill view 旁边放你自己的按钮，参数里有当前场景和正在看的版本：

```tsx
<SceneStudio
  toolbar={({ scene, versionIndex }) => (
    <button onClick={async () => save(await client.fetchSplat(scene, versionIndex))}>下载</button>
  )}
/>
```

### 自动找漏洞、补图

全景重建只有拍摄点能看到的内容。离开拍摄点走几步，被东西挡住的地方（柱子后面的地面、沙发后面的墙）就没有 splat，会显示成空洞。从那些位置生成视图，补的正好是缺的内容。

- **Find gaps**（免费，不扣额度）：在拍摄点四周、房间以内摆一圈候选相机，看向场景中间。每个相机都在屏幕外渲染一次，算出画面里没被任何 splat 覆盖的比例（累积 alpha < 0.5 算空）。然后按空洞从多到少排序，相机平滑飞到最严重的那个视角。右上角会显示「Gap 1/3 · 11% empty」，用 ‹ › 切换下一个漏洞，这时点 Fill view 就按这个视角补图。
- **Auto fill**（扣一次扩展的额度）：找到最严重的漏洞，相机飞过去，然后直接从这个视角生成补图。如果已经点过 Find gaps，就补当前选中的那个漏洞。

两个按钮都只对最新版本生效。补完会产生新版本，之前找到的漏洞会自动清空，可以再点 Find gaps 看还剩哪些。不想要这两个按钮时传 `hideGaps`。

不用 `<SceneStudio>` 时，`SceneViewerHandle` 和 `SceneRenderer` 上有同样的能力：

```ts
const gaps = await viewer.findGaps({ onProgress: ({ measured, total }) => {} });  // 免费，按空洞从多到少
if (gaps[0]) {
  await viewer.flyTo(gaps[0].pose);                        // 相机平滑飞过去
  await expand.expand(gaps[0].pose, { fov: viewer.fov });  // 从这个视角补图（扣额度）
}
const empty = await viewer.measureView();                  // 当前视角有多少比例是空的，0..1
```

`findGaps` 的选项：`directions`（一圈几个方向，默认 12）、`radii`（离拍摄点几倍拍摄高度，默认 `[0.75, 1.5]`）、`minHoleFraction`（空洞少于多少不算，默认 0.01）、`maxGaps`（最多几个，默认 5）、`previews: true`（每个漏洞附带一张 JPEG 预览图，漏洞部分是黑色）、`signal`（中途取消）。返回的 `pose` 和 `getPose()` 是同一个坐标系，可以直接传给 `expand` 或 `client.expandScene`，也可以序列化后交给 MCP / 后端。

说明：这个指标只能发现「空」，发现不了「糊」。比如离远处的表面太近时，几个很大的 splat 把画面盖满了，空洞比例是 0，但看起来是糊的。

### 参考图

- **用户自己选**：点输入栏的 Images 按钮选参考图，生成成功后会自动清空。如果不想让用户选，传 `hideReferences` 隐藏这个按钮。
- **代码里固定附带**：通过 `generateInput={{ referenceImages: [...] }}` 传入，每次生成都会带上。可以是 URL、data URL、`{ base64, mimeType }` 或 `File`，和用户选的图合在一起最多 8 张。
- **不用 `<SceneStudio>`**：直接调用 `gen.generate({ prompt, referenceImages })` 或 `client.generateScene({ prompt, referenceImages })`。
- **文字和图片有一个就行**：可以只写 prompt，可以只传参考图，也可以两个都传。Studio 里只选了图、没打字时，Generate 按钮也能点。

`<SceneStudio>` 既可以受控使用（`scene` 加 `onSceneChange`），也可以非受控使用（`defaultScene`）。

### 主题定制

从改动最小到最大有三种方式：

1. **CSS 变量**：设置在任意祖先元素上：`--viggle-scene-bg`、`-surface`、`-text`、`-border`、`-accent`、`-danger`、`-radius`、`-font`
2. **`classNames`**：按部件传 class（适合 Tailwind 或 CSS Modules），部件有 `root`、`versions`、`versionButton`、`expand`、`gapsButton`、`autoFillButton`、`gaps`、`status`、`error`、`promptBar`、`input`、`referencesButton`、`references`、`referenceThumb`、`referenceRemove`、`panoramaButton`、`generateButton` 等
3. **`unstyled`**：去掉内置外观，只保留定位。每个部件都带有 `data-viggle-part="…"` 属性，可以直接用 CSS 选择

文案通过 `labels` 覆盖，包括中文在内都可以。

## 自己组合

```tsx
import { SceneViewer, useSceneExpand, useSceneGeneration, type SceneViewerHandle } from '@viggle/scene-sdk/react';

function MyScene() {
  const viewer = useRef<SceneViewerHandle>(null);
  const [scene, setScene] = useState<ViggleScene | null>(null);
  const gen = useSceneGeneration({ onGenerated: setScene });
  const expand = useSceneExpand(scene, { onExpanded: setScene });

  return (
    <>
      <button onClick={() => gen.generate({ prompt: '一间阳光充足的开放式办公室' })} disabled={gen.busy}>生成</button>
      <SceneViewer ref={viewer} scene={scene} style={{ height: 500 }} />
      <button onClick={() => expand.expand(viewer.current!.getPose()!, { fov: viewer.current!.fov })} disabled={!scene || expand.busy}>
        扩展当前视角
      </button>
    </>
  );
}
```

| Hook | 提供的方法 | 完成时的回调 |
|---|---|---|
| `useSceneGeneration(opts)` | `generate(input)`、`generateFromPanorama({ panorama, pose? })` | `onGenerated` |
| `useSceneExpand(scene, opts)` | `expand(pose, { fov, projection, seed })` | `onExpanded` |
| `useSceneRebuild(scene, opts)` | `rebuild(batchIds?)`，常配合 `withoutBatch(scene, id)` 使用 | `onRebuilt` |

所有 hook 都返回 `phase`（`idle → submitting → processing → ready | failed`）、`busy`、`taskId`、`startedAt`、`result`、`error`、`cancel`、`reset`。

## 不用 React

```ts
import { createViggleSceneClient } from '@viggle/scene-sdk';       // Node / 服务端 / 任意框架
import { SceneRenderer } from '@viggle/scene-sdk/viewer';           // 浏览器、Vue、Svelte、原生 JS

const client = createViggleSceneClient({ apiKey: process.env.VIGGLE_API_KEY });
let scene = await client.generateScene({ prompt: 'a cozy cabin', quality: 'low' });

const renderer = await SceneRenderer.create(canvas);
await renderer.load([scene.versions.at(-1)!.splatUrl]);
scene = await client.expandScene(scene, renderer.getPose()!, { fov: renderer.fov });

// 自动找漏洞，飞过去，从那里补图
const [gap] = await renderer.findGaps();
if (gap) {
  await renderer.flyTo(gap.pose);
  scene = await client.expandScene(scene, gap.pose, { fov: renderer.fov });
}
```

## 角色漫游

和 [PINOC gallery](https://viggle.ai/pinoc/app/gallery#atticCabin) 的走路页同一套实现：WASD / 方向键走，Shift 跑，空格跳，拖动转视角，滚轮或双指缩放；触屏上自动出现摇杆和跳跃按钮。

```tsx
import { SceneExplorerView } from '@viggle/scene-sdk/react';

<SceneExplorerView
  style={{ height: 600 }}
  scene={{ url: 'https://…/attic.sog', placement: { scale: 3.8, floor: 0.402, start: [0, 0.2] } }}
  character={{ url: 'https://…/girl.vsplat' }}          // 默认身高 1.7 m
  light={{ azimuth: 216, elevation: 45, color: '#fff0d8' }} // 可选：太阳和影子
  onReady={() => console.log('可以走了')}
/>
```

- **`placement`（场景摆放）**：`scale` 是每个文件单位多少米（调到门、椅子看起来是人的尺度），`floor` 是起点脚下地面在文件 Y 轴上的高度，`start` 是起点的文件 (x, z)。默认按 Y 朝下处理，Y 朝上的文件传 `upright: true`，还可以用 `face` 指定起始朝向。之后整个世界以米为单位，起点在原点、地面在 y = 0。
- **自动摆放 `placement: { auto: true }`**：适用于刚生成或用户上传、不知道比例的场景。SDK 会从拍摄点往下找地面，按拍摄高度 1.5 米（可用 `captureHeight` 改）算出每单位多少米，角色站在拍摄点。
  - 朝向按文件格式判断：`.spz` 是 Y 朝上（API 生成的场景就是这种），`.ply` 是 Y 朝下，可以用 `upright` 覆盖。
  - 加载完后，`explorer.getPlacement()` 拿到测出的数值，存下来下次直接传。
  - `getPlacementSource()` 返回 `'measured'` 或 `'fallback'`。`'fallback'` 表示没找到地面，用的是 10 米/单位的常见值。
- **动作**：默认用 Viggle 公开的 idle / walk / run / jump 四段动作（`VIGGLE_LOCOMOTION_CLIPS`），适用于所有 Viggle splat 角色；可以用 `clips` 换成自己的 `.glb` 或 `.anim`。
- **碰撞**：默认开启（`collision`）。在 Worker 里用场景自己的 splat 构建体素碰撞，角色贴墙滑动，相机被墙挡住时沿吊臂收近。地面高度按渲染出来的不透明度探测，所以角色站在看得到的地面上。
- **打光**：`light` 是可选的，传 `null` 或不传就只用场景自带的光。
  - 方向和位置（`azimuth`、`region`、`lamps`）都用场景文件自己的坐标，SDK 会按 placement 转到世界坐标。
  - 只改 `azimuth`、`elevation`、`intensity` 时直接调整现有灯光，不重建，可以接滑块；改其它字段（颜色、阴影等）会重建灯光。
  - 不用 React 时调用 `lighting.setSun({ azimuth, elevation, intensity })`。
  - 手机上传 `lightQuality="low"`。
- **显示碰撞**：`showCollision` 用来调场景，不给玩家看。也可以调用 `explorer.showCollision(view)`。可选值：
  - `'outline'`（推荐）：只在地面上画出可行走范围的边界线（墙、坑、走不上去的台阶都算），加上角色脚下的一个圆环，正常是绿色，被墙挡住时变红。
  - `'cells'`：每个碰撞体素的线框，用来细查。
  - `'floor'`：只画能站立的顶面。
  - `'surface'`：不透明的实体表面，也就是导出给游戏引擎的碰撞面。
  - `'off'`：不显示。

  `cells`、`floor`、`surface` 还会画出角色的胶囊体。碰撞体是在 Worker 里构建的，场景显示后稍等片刻线条才会出现。
  - `outline` 的边界线只计算角色周围约 3.5 个身高的范围，走远后会重新计算。
  - 计算用的是纯函数 `walkableOutline`（在 `@viggle/scene-sdk/walk` 里），也可以拿去接自己的渲染器。
- **回到出生点**：调用 `ref.current.respawn()`（不用 React 时调用 `explorer.respawn()`）。角色回到出生点，朝向、相机距离和俯仰角都复位，正在播的动作会停止。角色掉出场景（低于地面 12 个身高）时也会自动执行一次。
- **ref**：`SceneExplorerHandle` 提供 `getWalker()`、`teleport()`、`respawn()`、`playAction()` 和底层的 `explorer`。

### 切换场景、角色、动作

示例的 Edit 页（`#edit`）演示了这三种切换，内置资源都来自 Viggle 公开 CDN：

- **换场景**：改 `scene` prop，会重新加载整个场景。
- **换角色**：只改 `character.url` 时，角色会在原地替换。场景、碰撞和相机都保留，不重新下载；新角色和原来的一样高，灯光和影子也会跟到新角色上。不用 React 时调用 `explorer.setCharacter({ url })`。
- **播放动作**：调用 `ref.current.playAction(glbUrl, { loop })`，传 `null` 停止。
  - 支持 Viggle splat 骨骼的 `.glb`，以及烘焙好的 `.anim`。
  - 默认只播一次，播完回到站立；`loop: true` 时一直重复。
  - 动作播放时一走动或跳跃就会中断。
  - 同一个场景里，动作只下载一次。
  - 用 `onActionChange` 可以知道当前正在播哪个动作，播完或被打断时回调 `null`。

```tsx
const view = useRef<SceneExplorerHandle>(null);
<SceneExplorerView ref={view} scene={scene} character={{ url: characterUrl }} onActionChange={setPlaying} />
<button onClick={() => view.current?.playAction('https://…/wave.glb')}>挥手</button>
```

不用 React：

```ts
import { SceneExplorer } from '@viggle/scene-sdk/explorer';
import { SceneLighting } from '@viggle/scene-sdk/lighting';

const explorer = await SceneExplorer.create(canvas);
await explorer.load({ scene: { url, placement }, character: { url: characterUrl } });
const light = SceneLighting.create(explorer, { azimuth: 216, elevation: 45 }); // 场景换掉时自动销毁
explorer.setMove({ x: 0, z: 1 });  // 接自己的虚拟摇杆；键盘自动监听
await explorer.setCharacter({ url: otherCharacterUrl });  // 原地换角色
await explorer.playAction('https://…/wave.glb', { loop: false });
```

想用自己的渲染器或游戏循环，可以直接用 `@viggle/scene-sdk/walk` 里的纯函数：`stepWalker`（移动、重力、台阶、撞墙）、`stepLocomotion`（idle / walk / run / jump 切换和跳跃时序）、`buildFloorIndex`（从点云探测地面）、`boomLimit` / `followYaw`（相机吊臂和自动转到身后）、`placeWalkScene`。它们不依赖引擎和 DOM，可以在 Node 里跑和测试。

## 接口对照

| API 文档 | 接口 | 底层调用 | 封装好的方法（提交并等待） |
|---|---|---|---|
| 创建场景 | `POST /v1/scenes/pano` | `createSceneTask` | `generateScene` |
| 从自定义全景图创建场景 | `POST /v1/scenes/custom-pano` | `createSceneFromPanoramaTask` | `generateSceneFromPanorama` |
| 生成场景视图 | `POST /v1/scenes/generate` | `generateViewTask` | `expandScene` |
| 重建场景 | `POST /v1/scenes/reconstruct` | `reconstructTask` | `rebuildScene` |
| 查询场景任务 | `GET /v1/scenes/{task_id}` | `getTask` / `waitForTask` | `refreshScene`（重新签名 URL） |

- **轮询**：`waitForTask` 会以 2 秒起步、逐步退避到 5 秒的间隔轮询。遇到网络错误、429 或 5xx 时会自动重试，连续失败超过 `maxPollErrors`（默认 3 次）才放弃；4xx 错误立即抛出。
- **取消**：传入 `signal` 可以中止等待，但服务端的任务会继续运行。
- **图片输入**：有四种写法，参考图最多 8 张：
  - http(s) URL：API 自己去下载，请求以 JSON 发送。
  - `data:image/png;base64,...` 这样的 data URL。
  - `{ base64, mimeType, name? }`：适合 MCP 工具、JSON 接口这类只能传文本的调用方。
  - `Blob` / `File`。

  后三种都会被当作文件，自动改用 multipart 上传，只支持 JPEG / PNG / WebP。一次请求里的参考图要么全是 URL，要么全是文件，不能混用。
- **会话忙（409）**：同一个 `sessionId` 同时只能跑一个任务。给封装方法传 `waitIfBusy: true`，SDK 会先等正在跑的任务结束，再自动重新提交；hooks 也支持这个选项。
- **任务状态**：`queued` → `processing` → `ready` / `failed` / `cancelled`。任务对象上的 `credits` 是这次扣的额度（`low` 质量的全景生成是 6）。

### 本地校验，和服务端规则一致

下面这些规则都是对照 `apis.viggle.ai` 实际返回的 400 整理出来的。SDK 在发请求前就会拦下，抛出的错误 `code` 和文案都和服务端一致（`SceneApiError`，`status` 400，`code` 为 `INVALID_REQUEST`）：

| 字段 | 规则 |
|---|---|
| `sessionId` | 1–128 位，只能用字母、数字、`_`、`-` |
| `prompt` / `referenceImages` | 至少传一个。`prompt` 最多 1000 字；没有参考图时不能全是空白，有参考图时空白等于没传 |
| `quality` | `low` / `medium` / `high`。服务端不接受 `fast` |
| `referenceImages` | 最多 8 张，URL 必须是 http(s) 且不带账号密码 |
| `panorama` | 不能和 `prompt` / `quality` / `referenceImages` 同时传 |
| `referenceBatchIds` | 1–35 个，必须是小写标准 UUID，不能重复 |
| `pose` / C2W | 4×4 数字矩阵，最后一行是 `[0,0,0,1]` |
| `fov` | 20–140；`projection: 'pano'` 时不发送 |
| `seed` | 0–4294967295 的整数 |
| `spzOutputUrl` | http(s) 且不带账号密码 |

有一条服务端不会在提交时拦截：一个场景最多由 40 张图重建。超过时服务端会先跑完生成再报失败，白花一次额度。SDK 会在每个版本上记下 `viewCount`，`expandScene` 发现超限时直接拒绝。上限值在 `LIMITS` 里导出。

## 场景状态由调用方保存

**API 不保存场景**。一个场景就是一个 `sessionId` 加一个有序的 batch id 列表。SDK 用 `ViggleScene` 表示它，这是一个纯 JSON 对象：`{ sessionId, versions: [{ taskId, operation, batchIds, splatUrl, pose, batch, viewCount, … }] }`，最后一个版本就是当前版本。

`batch` 是这个版本新增的那批图，包含每张图的链接和相机参数（`c2w`、`intrinsic`）；`viewCount` 是重建用到的图片总数。把它存进你自己的数据库，以后就能重新打开或继续扩展。`splatUrl` 是签名链接，约 3 小时后过期，过期后用 `client.refreshScene(scene)` 重新签名。想长期保存或交给别的查看器，用 `client.fetchSplat(scene, versionIndex?)` 直接拿到文件（`Blob`，`.spz`），链接过期时会自动重新签名一次。

## API Key 不要放进前端

写进浏览器代码的 `sk-` key 等于公开了。正确做法是让浏览器请求你自己的服务端，由服务端加上 `Authorization: Bearer $VIGGLE_API_KEY` 后转发到 `https://apis.viggle.ai`，前端只配置 `baseUrl`。只有在服务端、脚本或本地开发时，才直接传 `apiKey`。

## 位姿

相机有三种写法，凡是需要位姿的地方（`expandScene`、`generateViewTask`、`createSceneFromPanoramaTask`、`useSceneExpand`）都能用：

```ts
client.expandScene(scene, { yaw: 90, pitch: -10 });                    // 角度：最好手写，适合智能体
client.expandScene(scene, renderer.getPose()!);                        // { position, forward }：从预览界面拿
client.expandScene(scene, [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]);  // 4×4 矩阵原样发送
```

- **`yaw`**：从全景图正前方往右转的角度，0 是前，90 是右，180 是后，-90 是左。这个对应关系对照过 API 实际返回的立方体各面。
- **`pitch`**：正数抬头、负数低头，范围 -90 到 90。
- **`position`**：默认是拍摄点 `[0,0,0]`。
- **相互转换**：`anglesToPose` / `poseToAngles` 在两种写法之间转换，`toC2W` 把任意一种转成矩阵。

`ScenePose { position, forward }` 使用 provider 的相机坐标系：OpenCV 约定，Y 轴朝下，原点在全景图拍摄点。SPZ 文件本身是 Y 轴朝上存储的，SDK 已经处理了这个差异，所以 `getPose()` 的返回值可以直接发给 API。`poseToC2W` 把位姿转成 API 需要的 4×4 矩阵（保持地平线水平，算法和 Viggle 后端一致）；也可以直接传矩阵。

## 错误

| 错误类 | 含义 |
|---|---|
| `SceneApiError` | 请求被拒或任务失败。`status` 是 HTTP 状态码，任务失败时为 0；还有 `code`、`requestId`（响应体里没有时取 `X-Request-Id` 头）、`retryable`、`remediation`、`details`。辅助判断：`isAuthError`（key 缺失或无效）、`isSessionBusy`（409，用 `runningTaskId` 拿到正在跑的任务）、`shouldRetry`（任务失败看服务端的 `retryable`，请求被拒看状态码：409/429/5xx 可重试） |
| `SceneTimeoutError` | 超过 `timeoutMs`（任务仍在运行） |
| `SceneNetworkError` | 网络不可达 |

所有错误都可以直接 `JSON.stringify`，结果包含 `name`、`message`、`status`、`code`、`requestId`、`retryable`、`shouldRetry`、`taskId` 等字段，不会带出签名链接。对于任意抛出的值，可以用 `serializeError(err)` 统一转成同样的结构，方便写日志、作为接口响应或 MCP 工具结果返回。

如果任务失败的原因是服务端没有某个 batch（来自别的服务或账号，或已过保留期），服务端只会返回 "Cache rejected scene request"。SDK 会把它改写成说明原因的错误信息。

## 示例

`example/` 是一个可以直接运行的小项目，用它可以看到 SDK 的所有能力：

```bash
cd example
npm install
cp .env.example .env.local   # 填入 VIGGLE_API_KEY；不填就用内置的模拟接口
npm run dev                  # http://localhost:5191
```

key 只留在本地开发服务器上：页面请求 `/viggle-api`，由 dev server 代理转发到 `https://apis.viggle.ai` 并加上 `Authorization` 头，key 不会进入页面。正式产品里应该由你自己的服务端来做这件事，见上面「API Key 不要放进前端」一节。

示例是一条完整流程，分三个页面：

1. **Studio**（`#`）：生成、扩展场景。右上角 **Download** 把当前版本存成 `.spz` 文件；**Use in Edit →** 把它存进本地场景库，然后跳到 Edit。
2. **Edit**（`#edit`）：选场景（gallery 的 4 个，加上 My scenes 里从 Studio 送来的或 **Upload** 上传的 `.spz/.ply/.sog`）。自己的场景会自动测地面，可以用 Size 调大小、翻转朝向。
   - **Light**：选灯光方案（Off / Scene / Daylight / Golden hour / Overcast / Blue hour），用滑块调方向、高度、强度，可以开关阴影。
   - **Collision**：可以把碰撞线框显示出来（Lines / Floor / Surface），只用于调试，不会发布。
   - 再选角色和动作，填标题，点 **Publish to Showcase →**。灯光会一起发布。
3. **Showcase**（`#showcase`）：展示已发布的内容，打开时自动播放发布时选的动作，可以走动。

Edit 和 Showcase 的画面左上角都有两个按钮：**▦ Collision** 用来开关碰撞线框，**⟲ Back to start** 让角色回到出生点。

场景文件存在浏览器的 IndexedDB 里（不依赖会过期的签名链接），发布的配置存在 localStorage。正式产品里这两样应该存在你自己的服务端，见 `example/library.ts`。
