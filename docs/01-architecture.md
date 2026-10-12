# 01 · 架构设计

## 1. 系统定位

**DeepSeek Harness Client** 是一个独立的 Electron 桌面客户端,面向 DeepSeek Harness(`@deepseek-ai/dsh`)这一 agent 运行时。它要解决的核心问题:

> 把 DSH 的能力(会话、工具执行、目标、子代理、计划、审批……)包装成 Codex / Cursor 一类的 **Agentic 编码客户端** 交互体验,并且**开箱即用**(双击运行,自带宿主,无需用户自己起服务)。

关键取舍(贯穿整个设计):

1. **复用协议、自写 UI** —— 复用 DSH 官方发布的协议包(`dsh-host-apiproxy` 等)拿到类型化 RPC、信封封装、zod 校验;UI 完全自研。
2. **主进程做协议客户端** —— 因 DSH 信任栅栏,协议客户端必须跑在 Electron 主进程(Node),渲染层经 IPC 访问。
3. **内嵌宿主** —— 应用自己 spawn 一个 `dsh web`,而不是要求用户预先启动。

## 2. 进程模型

```
┌──────────────────────────────── Electron 应用 ────────────────────────────────┐
│                                                                                │
│  渲染进程 (renderer / Chromium)            主进程 (main / Node)                 │
│  ┌────────────────────────────┐            ┌─────────────────────────────┐    │
│  │ React + zustand            │   IPC      │ Controller                  │    │
│  │  ├─ App / ChatView         │◄──────────►│  ├─ startHost()  spawn dsh  │    │
│  │  ├─ SettingsView(表单)     │  contextBridge │    web (ELECTRON_RUN_   │    │
│  │  ├─ CapabilitiesView       │            │    AS_NODE=1)               │    │
│  │  ├─ SchemaForm / ToolCard  │            │  ├─ NodeApiClient           │    │
│  │  └─ store.ts(状态)        │            │  │   (AbstractApiClient 子类) │    │
│  └────────────────────────────┘            │  └─ ConnectionLoop          │    │
│                                            └──────────────┬──────────────┘    │
│  preload (contextBridge)                       /api HTTP + 2×WebSocket        │
└───────────────────────────────────────────────────────────┼───────────────────┘
                                                            ▼
                                              ┌──────────────────────────┐
                                              │ dsh web 宿主 (子进程)     │
                                              │  127.0.0.1:<port>        │
                                              │  (agent 运行时 / 会话 / 工具)│
                                              └──────────────────────────┘
```

- **渲染进程**:纯 UI,无 Node 能力(`nodeIntegration: false`、`contextIsolation: true`),只通过 `window.dsh`(preload 暴露)访问主进程。
- **主进程**:Node 侧,持有 `Controller`,负责宿主生命周期 + 协议连接 + 事件转发。
- **宿主进程**:由主进程 spawn 的 `dsh web`,是真正的 agent 运行时。

## 3. 分层职责

| 层 | 文件 | 职责 |
|---|---|---|
| 协议/宿主核心(纯 Node,无 electron 依赖) | `src/core/client.ts`、`src/core/host.ts` | `NodeApiClient`(fetch+ws)、`ConnectionLoop`(重连)、`startHost`(spawn 宿主) |
| 主进程控制 | `src/main/controller.ts`、`src/main/index.ts` | 宿主/连接编排、RPC 方法、IPC 注册、窗口生命周期 |
| 桥接 | `src/preload/index.ts` | `contextBridge` 暴露 `window.dsh` |
| 渲染层 | `src/renderer/src/*` | React 视图、zustand store、时间线派生、表单 |
| 契约 | `src/shared/ipc.ts` | 主/渲染共享的 IPC 类型(依赖无关) |

## 4. 整体数据流

### 4.1 启动流程

1. `app.whenReady` → 注册 IPC → 创建窗口 → `Controller.start(win)`。
2. `Controller.boot()`:读连接配置 →(内嵌模式)`startHost()` spawn 宿主并轮询就绪 → 创建 `NodeApiClient` → `ConnectionLoop.start()`。
3. 渲染层 `App` 挂载后调用 `init()`:拉取 `getHostInfo`、订阅 `onHostInfo`/`onFrame`、刷新会话与工作区。

### 4.2 上行(请求)

渲染层动作 → `window.dsh.<method>()` → `ipcRenderer.invoke` → `ipcMain.handle` → `Controller.<method>()` → `NodeApiClient` 的 unary RPC → 宿主 `/api/<method>`。

### 4.3 下行(事件)

宿主事件 → `ConnectionLoop` 泵取 `events.mux` / `events.host` 两条 WS 流 → `Controller.sendFrame()` → `webContents.send('dsh:frame')` → 渲染层 `store.handleFrame()` → 更新 zustand 状态 → React 重渲染。

### 4.4 宿主连接状态

`ConnectionLoop` 维护粗粒度状态(`connected` / `reconnecting`),`onConnected` 携带 `host.describe` 快照;`Controller` 把状态经 `dsh:hostInfo` 推给渲染层,侧栏据此显示「已连接 / 正在启动 / 重连中」。

## 5. 关键设计原则

1. **宿主自包含**:宿主所需依赖全部解包到磁盘(见 `09-打包`),不依赖系统 Node 版本。
2. **容错**:连接断开自动指数退避重连;宿主提前退出立刻以日志尾报错;渲染层 `init` 幂等。
3. **契约先行**:所有跨进程结构集中在 `src/shared/ipc.ts`,避免主/渲染类型漂移。
4. **展示与模型分离**:时间线派生(`timeline.ts`)、工具富渲染(`ToolCard.tsx`)、表单渲染(`SchemaForm.tsx`)各自独立,消费同一份事件/视图数据。
