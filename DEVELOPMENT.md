# 开发说明（内部）

不随 npm 包发布，也不交给客户。

这个包放在 `pinoc/viggle-scene-sdk`，通过 `link:` 使用旁边 `P.I.N.O.C./engine` 里的 splat 引擎（只此一份源码）。打包时用的是 P.I.N.O.C. 安装好的、打过补丁的 PlayCanvas，所以 **P.I.N.O.C. 需要先安装过依赖**。

```bash
pnpm --dir ../P.I.N.O.C. install   # 第一次，或引擎依赖变化时
pnpm install
pnpm test
pnpm typecheck                     # 示例代码也一起检查
pnpm build                         # ESM + CJS + .d.ts / .d.cts → dist/
pnpm example                       # http://localhost:5191
```

走路相关的纯逻辑（`src/walk/`）和碰撞（`src/explorer/collider.ts`）移植自 P.I.N.O.C. 的 `viewer3d`，测试一起带了过来。修改时可以对照那边的版本。

类型声明构建（`tsconfig.build.json`）只生成不检查（`noCheck`），因为引擎是外部源码；类型检查由 `pnpm typecheck` 对照真实引擎完成。`build/prune-types.mjs` 会删掉内部声明，并在任何公开声明引用到引擎时让构建失败。

源码里的相对 import 都带 `.js` 扩展名，这样生成的类型声明在 `node16` / `nodenext` 下也能解析。新增文件时请保持这个写法。

在 `example/.env.local` 里设置 `VIGGLE_API_KEY` 后，示例会连接真实 API：由 dev server 代理请求并在服务端加上 key，key 不会进入页面。没有设置时使用 mock，设置 `VIGGLE_MOCK=1` 可以强制使用 mock。`*.local` 已被 gitignore。

发给客户的版本用 `pnpm build:release` 构建：压缩，不带 source map（map 里会带上包括引擎在内的全部源码和注释）。然后 `npm pack`，再和 `example/` 一起打成 zip。客户版 `example/` 的项目文件（`package.json`、`vite.config.ts`、`tsconfig.json`、`.env.example`、`.gitignore`）在 `build/client-example/`：把 `example/` 的源码和 `public/` 复制过去，再放上它们。这些文件让示例依赖 tgz，不再 alias 到 `../src` 和引擎。
