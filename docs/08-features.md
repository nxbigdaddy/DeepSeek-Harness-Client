# 08 · 功能模块

本章逐个说明各功能模块的协议来源、状态、UI 入口与边界。

## 1. 目标(Goals)

- **读**:无 `goal.get` RPC;状态来自 `goal` 投影(`session/projection` 帧 + 历史尾页)。
- **写**:`goals.create/edit/pause/resume/complete/clear`,全部以 `{ sessionId, ref: {id, revision} }` 做 CAS。
- **UI**:`GoalBar`(聊天头部下),展示 objective/phase/rounds/blockedReason,提供全生命周期操作。
- **相位**:`active / paused / blocked / complete`。

## 2. 子代理(Subagents)

- `subagents.list({parentSessionId})` → 直系子代理目录(一次性/可续、running/inactive、诊断项)。
- `subagents.history` 读执行记录(不激活 agent);`subagents.prompt` 仅对 `continuable` 子代理投递后续消息;`subagents.interrupt` 中断。
- **UI**:`SubagentsPanel`(聊天头「子代理」打开):列表 + 时间线 + 后续消息/中断。

## 3. 后台任务(Jobs)

- 来源:`session/jobs` mux 帧(整快照)。
- `JobView { id, kind, label, status, detail?, startedAt, finishedAt? }`;无 jobs RPC,终止走会话 cancel / 命令。
- **UI**:`JobsPanel` 在聊天头下展示运行中/已完成任务。

## 4. 技能(Skills)

- `skills.list({sessionId})` → 用户可调用技能目录(需**已激活**会话;冷会话报 session-not-found)。
- 调用 = 普通 `session.prompt`,首 token 为 `/name`。
- **UI**:「能力」视图技能区,「调用」按钮即发 `/name`。

## 5. Agent 预设(Presets)

- `agentPresets.list()` → 预设目录(`id/trust/isDefault/name/description/broken`)。
- `agentPresets.select({sessionId, agentPreset})`(仅空会话)应用到会话;默认预设是 settings 的 `agent-presets.default`(用 `settingsMutate` 写)。
- **UI**:「能力」视图预设区:设默认 / 应用到会话。

## 6. 凭据(Credentials)

- 无枚举 RPC;引用名从设置 schema 的 `role:'credential-ref'` 字段值发现。
- `credentials.describe({refs})` / `set({ref,value})` / `unset({ref})`;值只写不回传。
- **UI**:「能力」视图凭据区。

## 7. MCP 服务器

- 配置不暴露在 settings;经 `--patch` 把每个服务器注入一个 `@deepseek-ai/dsh-mcp-client` 插件行。
- 服务器配置为 `dsh-mcp-client` 的 `Config`(stdio 或 streamable-http)。
- **UI**:「能力」视图 MCP 区(JSON 编辑 `mcpServers[]`,保存即重连)。

## 8. 命令面板

- DSH 无枚举命令的 RPC;面板内置默认 web 部署的已知斜杠命令(`/compact /goal /plan /feedback /permission /export`),中文描述。
- 触发 = 输入框以 `/` 开头;点选即执行(有 `input` 提示的命令补全参数)。

## 9. 其它会话/工作区能力

- **模型选择**:`session.models`(目录+routable)与 `session.selectModel`。
- **分支 fork**:`session.fork`(最近完成回合)。
- **历史分页**:`session.history` 的 `beforeSeq` 前翻。
- **搜索**:`session.search`(依赖宿主 `session-query` 索引,见 `10-故障` §搜索)。
- **图片附件**:`prompt` 的 image 块 + `session.attachment` 读取渲染。
- **队列**:`session.updateQueue` 的 remove/steer。
- **工作区**:`workspace.*` 全量接入 —— 打开已有项目文件夹(in-app 目录浏览 modal 为主,`host.listDirectory`/`createDirectory` 经主进程本地 fs 兜底,原生对话框保留为 modal 内入口)/ 重命名 / 移除 / 文件管理器打开(`host.openPath`)/ 拖拽排序(`workspace.insertBefore`)/ 工作区内会话拖拽排序(`workspace.insertSessionBefore`)。打开新文件夹后自动新建会话。注意:会话与工作区的从属由会话 cwd 决定,协议不支持跨工作区移动(官方 GUI 同样只支持组内排序);删除工作区后,若仍有会话头记录该 cwd,bootstrap 会自动重建同路径工作区。
- **归档**:`workspace.archiveSession`。
- **错误面**:store 交互操作统一经 `reportStoreError` 上墙(侧栏顶部可关闭错误条),不再静默吞错;被动刷新路径保持 console-only。

## 10. 状态来源汇总

| 模块 | 读 | 写 |
|---|---|---|
| 目标 | `goal` 投影 | `goals.*` |
| 计划 | `plan` 投影 | `/plan` 命令 |
| 标题 | `title` 投影 | `session.rename` |
| 任务 | `session/jobs` 帧 | (取消走会话) |
| 队列 | `session/queue` 帧 | `session.updateQueue` |
| 审批/提问 | `approval|question/requested` 帧 | `respond` |
