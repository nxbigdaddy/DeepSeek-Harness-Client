# 04 · IPC 契约

## 1. 概览

- 契约类型集中在 `src/shared/ipc.ts`,主/渲染共享,且**零 DSH 依赖**(避免渲染层拉入重型类型图)。
- preload(`src/preload/index.ts`)用 `contextBridge.exposeInMainWorld('dsh', api)` 暴露 `DsApi`。
- 主进程(`src/main/index.ts`)用 `ipcMain.handle` 注册下行 RPC,用 `webContents.send` 做上行推送。

## 2. 通道清单

### 2.1 invoke(渲染层 → 主进程)

| 通道 | 控制器方法 |
|---|---|
| `dsh:getHostInfo` | `getHostInfo` |
| `dsh:listSessions` / `dsh:createSession` / `dsh:prompt` / `dsh:cancel` / `dsh:history` | 对应 `sessions.*` |
| `dsh:searchSessions` / `dsh:forkSession` / `dsh:attachment` / `dsh:updateQueue` | 会话扩展 |
| `dsh:sessionRename` / `dsh:sessionModels` / `dsh:sessionSelectModel` / `dsh:archiveSession` | 会话管理 |
| `dsh:respond` | 答复审批/提问 |
| `dsh:listWorkspaces` / `dsh:createWorkspace` / `dsh:renameWorkspace` / `dsh:deleteWorkspace` | `workspace.*` |
| `dsh:pickDirectory` / `dsh:listDirectory` / `dsh:openPath` | `host.*`(目录/路径) |
| `dsh:settingsDescribe` / `dsh:settingsMutate` / `dsh:settingsReplace` / `dsh:settingsOpenDocument` | `settings.*` |
| `dsh:llmModels` | `llm.models` |
| `dsh:goalCreate` / `goalEdit` / `goalPause` / `goalResume` / `goalComplete` / `goalClear` | `goals.*` |
| `dsh:subagentList` / `subagentHistory` / `subagentPrompt` / `subagentInterrupt` | `subagents.*` |
| `dsh:skillsList` | `skills.list` |
| `dsh:agentPresetList` / `dsh:agentPresetSelect` | `agentPresets.*` |
| `dsh:credentialsDescribe` / `dsh:credentialsSet` / `dsh:credentialsUnset` | `credentials.*` |
| `dsh:getConnectionConfig` / `dsh:setConnectionConfig` | 连接配置 |

### 2.2 send(主进程 → 渲染层)

| 通道 | 载荷 |
|---|---|
| `dsh:hostInfo` | `HostInfo` |
| `dsh:frame` | `DownlinkFrame { stream, rpcId, payload }` |

## 3. preload 桥

```ts
const api: DsApi = {
  getHostInfo: () => ipcRenderer.invoke('dsh:getHostInfo'),
  ...
  onFrame: (cb) => {
    const l = (_e, frame) => cb(frame)
    ipcRenderer.on('dsh:frame', l)
    return () => ipcRenderer.removeListener('dsh:frame', l)
  },
  onHostInfo: (cb) => { /* 同上 */ }
}
contextBridge.exposeInMainWorld('dsh', api)
```

- 渲染层 `window.dsh` 是 `DsApi` 类型(`src/renderer/src/env.d.ts` 声明全局)。
- 订阅类方法返回**取消函数**,`store.init()` 幂等(靠 `initialized` 标志),避免重复订阅。

## 4. 关键共享类型(节选)

```ts
type ConnectionState = 'connecting' | 'connected' | 'reconnecting'
interface HostInfo { baseUrl; port; state; description?; error? }
interface SessionSummary { sessionId; updatedAt; running; blank; title?; ... }
interface HistoryResult { events: SessionEventView[]; hasMore; title?; plan?; goal? }
interface DownlinkFrame { stream: 'mux'|'host'; rpcId; payload: { type; [k]: unknown } }
interface SettingsNamespace { ns; applies; revision; secrets; schema; value; user }
type SettingsPathOp = { op:'set'; path; value } | { op:'unset'; path }
interface Workspace { workspaceId; path; title; sessionIds; ... }
interface GoalView { goal: GoalSnapshot; roundsStarted; createdAt; updatedAt }
interface PendingApproval / PendingQuestion / JobView / SkillEntry / AgentPresetEntry / CredentialView ...
```

> `DownlinkFrame.payload` 刻意保持 `{ type; [k]: unknown }` 的宽松形态:渲染层按 `type` 防御式收窄,不引入 DSH 的完整帧类型。

## 5. 约定

- 所有 RPC 结果经控制器 `unwrap(resp, label)` 解包:`ok` 取 `value`,`!ok` 抛 `Error(含 code + message)`;`ipcRenderer.invoke` 会把拒绝回传成渲染层 `Promise` 拒绝。
- 品牌类型(`SessionId` / `WorkspaceId` / `GoalId` / `RpcId` / `MessageId` / `AttachmentId`)在控制器入口用 `sid()/wid()/as never` 做编译期品牌化;它们运行时仍是字符串。
- IPC 参数在 `index.ts` 侧普遍以 `unknown` 接、`as never` 传,避免手写桥的层层类型噪音。
