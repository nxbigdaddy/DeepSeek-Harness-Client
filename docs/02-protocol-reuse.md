# 02 · DSH 协议与复用

本客户端复用的核心是 DSH 官方发布的协议包。本章说明复用了什么、协议长什么样。

## 1. 复用的官方包

| 包 | 用途 | 说明 |
|---|---|---|
| `@deepseek-ai/dsh-host-apiproxy/client` | `AbstractApiClient` | 类型化 RPC、信封封装/解封、zod 二次校验、超时、错误折叠 |
| `@deepseek-ai/dsh-host-apiproxy/api/rpc.schema` | `serverRequestSchema` | 下行帧信封校验 |
| `@deepseek-ai/dsh-host-apiproxy/api/events.schema` | `muxFrameSchema` / `hostFrameSchema` | 下行帧体校验 |
| `@deepseek-ai/dsh-client-connection` | 类型 + `ConnectionController` 参考 | 连接/重连/退避逻辑的移植蓝本 |
| `@deepseek-ai/dsh-client-schema-form` | `rehydrateSchema` / `setPath` / `deletePath` / `hasPath` / `validateDraft` | 设置 schema 模型层(无 React) |
| `@deepseek-ai/schemastery` | `Schema` | 序列化 schema 信封的运行时校验器 |
| `ws` | WebSocket | 下行事件流载体 |

> `AbstractApiClient` 是子类化复用的关键:实现 `doFetch` + 覆盖 `openMux`/`openHost`,即可获得整套类型化 API,无需自写 RPC 细节。

## 2. 传输模型

- **上行(unary / respond)**:HTTP `POST /api/<method>` 与 `POST /api/respond`,JSON 体。
- **下行(事件)**:两条 **WebSocket** —— `/api/events.mux`(会话聚合流)与 `/api/events.host`(宿主级流)。

> 注意:网络场景必须用 WebSocket;`AbstractApiClient` 默认的 SSE-over-fetch 仅服务「进程内同构载体」,网络 GET 会返回 426。

## 3. 四象限 RPC 模型

| 消息 | 方向 | 载体 | 说明 |
|---|---|---|---|
| `client-request` | 客户端→宿主 | POST `/api/<method>` body | 发起 unary 调用 |
| `server-response` | 宿主→客户端 | 对应 HTTP 响应 body | unary 结果 |
| `server-request` | 宿主→客户端 | 下行流帧 | 事件推送 / 可答复交互(审批、提问) |
| `client-response` | 客户端→宿主 | POST `/api/respond` body | 答复 `server-request` |

每个消息都有 `rpcId`(发起方铸造,响应回显);`client-response` 的 `result` 是业务结果,答复成功后返回 `{accepted: true}` 的 carrier receipt。

## 4. `IApiClient` 域方法

`AbstractApiClient` 提供以下域(每个 unary 方法形如 `domain.method(payload, signal?) → RpcResponse<T>`):

- `sessions`:list / search / create / history / models / selectModel / rename / fork / prompt / attachment / updateQueue / cancel
- `subagents`:list / history / prompt / interrupt
- `host`:describe / pickDirectory / listDirectory / createDirectory / openPath
- `workspace`:list / create / rename / delete / insertBefore / insertSessionBefore / archiveSession
- `skills`:list
- `agentPresets`:list / select / read / copy / openDocument / remove
- `goals`:create / edit / pause / resume / complete / clear
- `settings`:describe / openDocument / update / replace / mutate
- `credentials`:describe / set / unset
- `llm`:providers / models / discoverModels
- `events`:mux / host(异步可迭代流)
- `respond`(答复 server-request)

返回值统一为 `RpcResponse<T> = { rpcId, result: { ok: true, value } | { ok: false, error } }`;业务错误不抛异常,而是 `result.ok === false`。

## 5. 下行帧

### 5.1 Mux 帧(`MuxFrame`)

| type | 说明 |
|---|---|
| `session/event` | 原始会话事件 + 可选 `view`(工具视图) |
| `session/subscribed` | 流就绪订阅基线(`lastSeq`) |
| `session/projection` | 投影单元值变化(`key`/`value`/`seq`) |
| `session/queue` | 待处理收件箱快照(steer/edit) |
| `session/jobs` | 后台任务快照 |
| `approval/requested` / `approval/resolved` | 工具审批请求/结果 |
| `question/requested` / `question/resolved` | 提问请求/结果(含 plan-review) |
| `stream/error` | 流级错误 |

### 5.2 Host 帧(`HostFrame`)

| type | 说明 |
|---|---|
| `host/session-added` / `host/session-removed` | 会话新增/移除 |
| `host/session-status` | 会话运行状态翻转 |
| `host/agent-error` | 无回合位置的实时失败 |
| `host/workspace-changed` / `-removed` / `-order-changed` | 工作区变化 |
| `host/archived-sessions-changed` | 归档集合变化 |
| `host/remote-event` | 白名单 cordis 事件透传 |

### 5.3 会话事件(`SessionEvent`)

核心类型:`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`todo/write`、`request/header`、`request/context`、`session/end-seed`;插件会扩展(`command/run`/`command/done`、`session/title`、`plan/mode`、`permission/preset`、`goal/change` 等)。

只有 `user/message` / `assistant/message` / `tool/result` 进入「模型可见 surface」,其余是日志级事件。

## 6. 工具视图(`ToolCallView` / `ToolResultView`)

`session/event` 帧携带的 `view` 字段是宿主在发射时计算的渲染意图(`ToolEventView`):

- **调用视图**:`card: 'generic' | 'terminal' | 'diff'`。
- **结果视图**:`card: 'generic' | 'terminal' | 'diff' | 'search' | 'read' | 'web'`。

客户端据此渲染富卡片(见 `06-UI` / `ToolCard.tsx`),而不是回退到裸 JSON。

## 7. 自写 vs 复用边界

- **复用**:协议传输、信封/校验、schema 模型、连接退避逻辑(移植)。
- **自写**:UI 组件、zustand store、时间线派生、diff 渲染、IPC 桥、宿主 spawn/打包。

> 未复用的原因:`dsh-client-ui-*` 等官方 UI 组件绑定在 DSH 的 client-runtime / slot 系统里,不是可独立 import 的 React 组件;作为「独立客户端」,选择自写 UI + 复用协议层。
