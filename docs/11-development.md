# 11 · 开发与测试

## 1. 目录结构

```
deepseek-h/
├─ src/
│  ├─ core/                 # 纯 Node,不依赖 electron
│  │  ├─ client.ts          # NodeApiClient + ConnectionLoop
│  │  └─ host.ts            # resolveDshBin / findFreePort / startHost / --patch
│  ├─ main/
│  │  ├─ controller.ts      # Controller(宿主/连接/RPC)
│  │  └─ index.ts           # app 生命周期 + IPC 注册
│  ├─ preload/index.ts      # contextBridge → window.dsh
│  ├─ renderer/
│  │  ├─ index.html
│  │  └─ src/               # React 视图 + store + 工具
│  └─ shared/ipc.ts         # 主/渲染共享契约
├─ scripts/                 # 探针与诊断脚本
├─ docs/                    # 本文档
├─ electron.vite.config.ts
├─ tsconfig.json
└─ package.json
```

## 2. 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | electron-vite 开发(内嵌宿主自动启动,HMR) |
| `npm run build` | 构建 `out/`(main/preload/renderer) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke` | 无 GUI 端到端:启动宿主→连接→建会话→发消息→流式 |
| `npm run probe` | 验证 settings/workspace/llm/session.models 等 RPC 面 |
| `npm run dist` | 构建 + electron-builder 打包 |

## 3. 探针脚本(`scripts/`)

| 脚本 | 验证点 |
|---|---|
| `smoke.ts` | 完整链路(宿主+协议+流式+模型回答) |
| `probe.ts` | settings/workspace/llm/session.models RPC |
| `m2-probe.ts` | 工具 `view`(ToolCallView/ToolResultView)下传 |
| `m3-probe.ts` | fork + search |
| `m45-probe.ts` | skills/presets/credentials/goals/subagents RPC |
| `mcp-probe.ts` | MCP 补丁注入下宿主可启动 |
| `schema-dump.ts` | 打印各命名空间 schema 结构(表单渲染参考) |
| `cdp-*.mjs` | 打包版渲染层诊断(CDP 远程调试) |

探针通过 `npx tsx scripts/<name>.ts` 运行,复用 `src/core`(不依赖 Electron),是改动核心层后的快速回归手段。

## 4. 调试

- **宿主问题**:读 `%TEMP%\dsh-client-host-<pid>.log`。
- **主进程**:控制台启动 exe / dev 看 `[main]` 日志。
- **渲染层**:dev 下开 DevTools;打包版用 CDP(见 `10-故障` §2.3)。
- **类型**:`npm run typecheck`;构建由 electron-vite(esbuild/rollup)完成,不跑 tsc,故 typecheck 需显式执行。

## 5. 本地化扩展

新增漏翻字段时,编辑 `src/renderer/src/locale.ts`:

- `NAMESPACE_LABELS` → 命名空间中文名
- `FIELD_LABELS` → 字段键中文名
- `ENUM_LABELS` → 枚举值中文名

未命中项自动 camelCase 人性化兜底。

## 6. 改动检查清单

涉及以下改动时,跑对应验证:

- **核心层(`src/core`)**:`npm run smoke`(或对应 probe)+ `typecheck`。
- **主进程/契约**:`typecheck` + `dev` 启动看 `[main] connection: connected`。
- **渲染层**:`typecheck` + dev 打开确认状态到「已连接」、会话/工作区列表出现。
- **打包**:`npm run build && npx electron-builder --dir`,确认 `app.asar.unpacked/node_modules` 完整 + 双击启动宿主。
