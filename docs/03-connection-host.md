# 03 · 连接与宿主管理

本章覆盖 `src/core/host.ts` 与 `src/core/client.ts`:如何内嵌启动宿主、如何建立协议连接、以及信任栅栏 / 远程连接 / 补丁等关键点。

## 1. 内嵌宿主启动

`startHost(opts)` 的流程:

1. `resolveDshBin()`:定位 `@deepseek-ai/dsh/lib/bin.js`(打包版做 `app.asar` → `app.asar.unpacked` 重写)。
2. `findFreePort(preferred=3210)`:从首选端口起探测空闲端口。
3. 生成 `--patch` 覆盖文件(见 §5)。
4. `spawn(process.execPath, [bin, 'web', '--patch', <patch>, '--host', '127.0.0.1', '--port', <port>])`。
5. `waitForApi(baseUrl)`:轮询 `POST /api/host.describe` 直到 2xx 或超时。

### 1.1 为什么用 `ELECTRON_RUN_AS_NODE`

在 Electron 主进程里,`process.execPath` 是 Electron 可执行文件而非 `node`。设置环境变量 `ELECTRON_RUN_AS_NODE=1` 让该可执行文件以纯 Node 方式执行 `bin.js`。

### 1.2 Node 版本要求

DSH 需要 **Node ≥ 22.6**(`node:zlib` 的 zstd、`node:module.stripTypeScriptTypes`)。Electron 31 内置 Node 20.18 会崩溃,因此锁定 **Electron 37(内置 Node 22.21)**。这是自包含的关键——宿主运行在应用自带的 Node 上,不依赖系统 Node。

### 1.3 宿主输出与失败检测

- 打包版:`captureLog: true` → 宿主 stdout/stderr 走 `pipe` 写入 `%TEMP%/dsh-client-host-<pid>.log`;开发版走 `inherit` 流到终端。
- 宿主在就绪前退出(或 spawn 失败)时,`waitForApi` 立刻以「退出码 + 日志尾」报错,渲染层把该错误显示在状态栏。

> 曾用 `stdio: 'inherit'`,在 GUI(无控制台)下宿主崩溃时错误被丢弃;也曾用文件描述符 `fd`,在打包版 Electron 下宿主无输出。最终采用「打包版 pipe 捕获 + 开发版 inherit」。

## 2. 协议客户端 `NodeApiClient`

`NodeApiClient extends AbstractApiClient`,只补三个平台点:

```ts
resolveBase(): string              // 返回宿主 baseUrl(替代默认的 fake authority)
doFetch(input, init): Response     // Node 全局 fetch
openMux / openHost                 // 用 ws 连 /api/events.mux、/api/events.host
```

`readWebSocket` 把每条 WS 文本帧按 `serverRequestSchema` + 帧 schema 解析为 `{ rpcId, payload }`。注意宿主下行实际发的是 **二进制帧(Buffer)**,解析前要 `Buffer → string`(浏览器 `WebApiClient` 是文本,Node 侧做了兼容)。

## 3. 信任栅栏(为什么客户端在主进程)

DSH 的 `/api` 栅栏规则:浏览器请求若带 `Origin` 则必须与 Host 权威一致,`sec-fetch-site: cross-site` 一律拒绝。Electron 渲染进程从 `file://` / 自定义协议加载后去 fetch 宿主,必为跨源 → 403。

因此协议客户端跑在 **主进程(Node)**:作为「非浏览器客户端」,以 loopback 地址通过栅栏;渲染层再经 IPC 访问。

## 4. `ConnectionLoop`(连接/重连/退避)

移植自官方 `ConnectionController`,核心循环:

1. 开两条 WS 流 + `host.describe` 握手。
2. 成功 → `emitState('connected')` + `onConnected(description)`。
3. 流结束/失败 → `emitState('reconnecting')` → 指数退避(500ms 起,×2,上限 10s + 抖动)后重试。
4. sink 异常被隔离(不会拖垮泵取循环)。

## 5. `--patch` 覆盖层

宿主每次启动都带一个临时补丁文件,做两件事:

1. **启用全文搜索**:`session-query-sqlite` 的 `openAt` 从默认 `never` 改为 `first-search`。
2. **注入 MCP 服务器**(若有):为每个配置追加 `insert` 一个 `@deepseek-ai/dsh-mcp-client` 行。

> 补丁格式:YAML 列表,`{id, config}` 按 id 整体替换该行 config,`{insert: [...]}` 追加新行。**launcher 旗标(`--patch`)必须放在内层旗标(`--host/--port`)之前**,否则被 pass-through 吞掉报 `unknown option --patch`。

## 6. 远程连接

连接配置(`client-config.json`,存于 Electron `userData`):

```json
{ "mode": "embedded" | "remote", "remoteUrl": "http://192.168.1.10:3080", "mcpServers": [] }
```

- `mode: remote` 时跳过 `startHost`,直接以 `remoteUrl` 建 `NodeApiClient`。
- 远程宿主需在对方 `--host <LAN IP>` 或 `--trusted-host` 授权;客户端主进程作为非浏览器客户端经 LAN IP 字面量通过栅栏。
- 「能力」视图的「连接」区可切换内嵌/远程并保存重连(`setConnectionConfig` → `reconnect`)。

## 7. 错误与状态

- `Controller` 持有 `HostInfo { baseUrl, port, state, description?, error? }`,经 `dsh:hostInfo` 推给渲染层。
- 启动失败(`start()` 拒绝)由 `index.ts` 捕获,把错误写入 `HostInfo.error` 并置 `reconnecting`。
