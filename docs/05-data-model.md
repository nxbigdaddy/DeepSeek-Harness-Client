# 05 · 数据模型与状态管理

## 1. 会话事件日志

会话以**追加式事件日志**为唯一事实源(`SessionEvent`)。客户端拿到的是两种来源的统一视图:

- **历史**(`session.history` / `subagent.history`):按消息边界分页的事件页。
- **实时**(`session/event` mux 帧):订阅后新追加的事件。

两者都附带 `seq`(单调递增)与 `view`(工具视图,`HistoryEntry.view` / 帧的 `view`)。

## 2. 时间线派生(`timeline.ts`)

`deriveTimeline(events)` 把事件日志折叠成可渲染的 `TimelineItem[]`:

| 事件 | 派生结果 |
|---|---|
| `user/message` | `user` 项(text + 图片附件引用) |
| `assistant/chunk` | 累积到当前 `assistant` 项(text/reasoning 增量) |
| `assistant/message` | 终结 `assistant` 项(以最终 content 覆盖流式文本) |
| `tool/call` + `tool/result` | `tool` 项(按 `callId` 配对;携带 `callView`/`resultView`) |

要点:
- 流式文本来自 `chunk` 增量,`assistant/message` 到来时定稿。
- 工具卡片不渲染 `assistant/message` 里的 tool-call block(避免与 `tool/call` 事件重复),而是消费事件自带的 `view`。
- 未知事件类型安全忽略(插件可扩展事件词表)。

## 3. zustand store(`store.ts`)

单例 store,状态分三类:

```ts
interface AppState {
  // 连接
  host: HostInfo
  // 会话
  sessions: SessionSummary[]
  selectedId: string | null
  eventsBySession: Record<SessionId, SessionEventView[]>
  hasMoreBySession / runningBySession / loadedSessions
  titles / plans / goals: Record<SessionId, ...>
  // 编排 / 能力
  workspaces / archivedSessionIds
  modelsBySession
  approvals / questions
  jobsBySession / queueBySession
  searchResults / searching / searchError
  view: 'chat' | 'settings' | 'capabilities'
  initialized
}
```

### 3.1 帧处理 `handleFrame(set, get, frame)`

- `session/event`:去重(按 `last.seq < event.seq`)追加;`turn/start|end` 翻转运行态;合并帧的 `view`。
- `session/projection`:按 `key` 写入 `titles`(`title`)、`plans`(`plan`)、`goals`(`goal`)。
- `session/queue` / `session/jobs`:整体快照写入对应表。
- `approval|question/requested|resolved`:维护待答复集合(按 `approvalId` / `rpcId`)。
- `host/session-*` / `host/workspace-*`:触发刷新会话/工作区。

### 3.2 关键动作

- `init`(幂等)、`selectSession`(载历史+模型)、`loadOlder`(分页前翻)、`send(content)`、`cancel`。
- `respondApproval` / `respondQuestion`(乐观移除 + `respond` 回传)。
- `refreshSessions` / `refreshWorkspaces`(重连基线)。
- `goalCreate/Edit/Pause/Resume/Complete/Clear`(以当前 goal 的 `{id,revision}` 做 CAS 引用)。
- `search`(节流 300ms,错误入 `searchError`)。

## 4. 投影(projection)

宿主把某些派生值作为「投影单元」随 `session/projection` 帧与历史尾页的 `projections.values` 下发,last-wins:

| key | 值 | 用途 |
|---|---|---|
| `title` | `string \| null` | 会话标题 |
| `plan` | `{ active, pending }` | 计划模式状态 |
| `goal` | `GoalProjection \| null` | 当前目标(含 CAS ref) |
| `sessionListMetadata` | `{ blank, lastPromptAt }` | 列表提示 |
| `imageLimits` | 图片摄入限制 | 附件预检 |

## 5. 队列与任务

- `session/queue`:待处理收件箱(`queued`/`steering`/`context`),UI 提供 steer(插队)与 remove。
- `session/jobs`:后台任务(`JobView { id, kind, label, status, detail?, startedAt, finishedAt? }`),纯展示(无 jobs RPC,终止走会话 cancel / 命令)。

## 6. 审批 / 提问

- `approval/requested` → 弹窗 → `respond(rpcId, { sessionId, approvalId, outcome: 'allowed-once'|'rejected' })`。
- `question/requested` → 弹窗 → `respond(rpcId, { sessionId, answer: { answers } })`。
- `resolved` 帧关闭弹窗;`question/requested` 带 `intent.kind === 'plan-review'` 时按计划评审渲染。

## 7. 一致性说明

- 事件按 `seq` 去重追加,重连后靠 `session/subscribed.lastSeq` + 重新拉历史做基线,天然收敛。
- 投影帧「高 seq 覆盖」,历史尾页只作种子,不会覆盖更新的推送。
- 所有跨会话 id 在共享层是普通 `string`,品牌只在主进程控制器入口做编译期标注。
