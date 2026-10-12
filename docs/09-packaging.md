# 09 · 打包与分发

## 1. 工具与配置

- 打包器:**electron-builder**(配置在 `package.json` 的 `"build"` 字段)。
- 构建:`electron-vite build`(产出 `out/`)→ `electron-builder`(产出 `dist/`)。
- 脚本:`npm run dist` = `electron-vite build && electron-builder`。

```jsonc
"build": {
  "appId": "com.deepseek.harness.client",
  "productName": "DeepSeek Harness Client",
  "directories": { "output": "dist" },
  "asarUnpack": ["node_modules/**"],
  "win": { "target": ["nsis"], "signAndEditExecutable": false },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true }
}
```

## 2. 内嵌宿主与 asar 的冲突(核心难点)

宿主 `dsh web` 由主进程 spawn,跑在 `ELECTRON_RUN_AS_NODE` 下,它**只能读磁盘上的真实文件,读不了 asar**。因此:

1. `asarUnpack: ["node_modules/**"]` —— 把**全部** node_modules 解包到 `app.asar.unpacked/`(曾只解包 `@deepseek-ai/**`,导致宿主找不到 `zod`/`commander` 等普通 JS 依赖而启动失败)。
2. `resolveDshBin()` 把 `require.resolve('@deepseek-ai/dsh/package.json')` 得到的 `app.asar\node_modules\...` 重写为 `app.asar.unpacked\node_modules\...`,再拼 `lib/bin.js`。

```ts
let pkgJson = require.resolve('@deepseek-ai/dsh/package.json')
pkgJson = pkgJson.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
```

## 3. 宿主启动(打包版)

`process.execPath` = 打包后的 exe;`spawn(exe, [bin.js, 'web', ...], { env: { ELECTRON_RUN_AS_NODE: '1' } })` 以 Node 模式运行 `bin.js`。宿主所需的 Node ≥22.6 由 **Electron 37 内置 Node 22.21** 提供。

## 4. 产物

- `dist/win-unpacked/` —— 可运行目录(交付物):`DeepSeek Harness Client.exe` + `resources/app.asar` + `resources/app.asar.unpacked/node_modules/**`。
- 安装器(NSIS):`npm run dist` 的目标之一,但本环境的 winCodeSign/NSIS 工具链下载不全会卡在封装步骤;已设 `signAndEditExecutable: false` 跳过 exe 资源编辑。可用 `npx electron-builder --dir` 只产出 `win-unpacked`。

## 5. 验证要点

打包后必须确认:

- `app.asar.unpacked/node_modules` 下 `@deepseek-ai/dsh/lib/bin.js`、`zod`、`commander`、`ws` 等都在。
- 双击/无控制台场景下宿主能起(参考 `10-故障` 的诊断法)。

## 6. 未做 / 待办

- 应用图标、自动更新、代码签名。
- 安装器在本环境未完整验证;跨机分发建议先验证目标机的 NSIS 工具链或改用 `dir` 目标分发。
