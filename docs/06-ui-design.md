# 06 · UI 设计

## 1. 视图结构

`App.tsx` 采用「左侧边栏 + 主区」布局,主区按 `view` 切三种视图:

```
┌──────────┬───────────────────────────────┐
│ 侧栏      │ 主区                           │
│ 状态/连接  │  view: chat | settings | capabilities│
│ 新建会话/区 │  └─ ChatView / SettingsView / CapabilitiesView │
│ 搜索框    │                                │
│ 工作区/会话│                                │
│ 已归档    │                                │
│ [对话][设置][能力]                          │
└──────────┴───────────────────────────────┘
```

- **`chat`**(`ChatView.tsx`):会话头 + 目标条 + 任务条 + 消息流 + 队列 + 输入框。
- **`settings`**(`SettingsView.tsx`):配置项列表 + schema 表单。
- **`capabilities`**(`CapabilitiesView.tsx`):连接 / MCP / 技能 / 预设 / 凭据。
- **全局覆盖层**:`PromptLayer`(审批/提问弹窗)、`SubagentsPanel`(子代理抽屉)。

## 2. 组件清单

| 组件 | 职责 |
|---|---|
| `ChatView` | 会话主界面:标题(可重命名)、模型选择、分支/归档、目标条、任务条、消息流、命令面板、图片附件、子代理入口 |
| `SettingsView` | 命名空间列表 + 表单编辑 + 保存/重置/打开文件 |
| `CapabilitiesView` | 连接配置、MCP 服务器(JSON)、技能、预设、凭据 |
| `SchemaForm` | 通用 schemastery schema 表单渲染器(递归) |
| `ToolCard` | 工具富卡片:diff / terminal / read / search / web / generic |
| `Prompts` | 审批卡片 + 提问卡片(含 plan-review) |
| `GoalBar` | 目标展示与生命周期操作 |
| `JobsPanel` | 后台任务列表 |
| `SubagentsPanel` | 子代理列表 + 执行记录 + 后续消息/中断 |
| `timeline` / `diff` | 事件→时间线派生、LCS 行 diff |

## 3. 关键交互

### 3.1 输入框与命令面板

- `Enter` 发送、`Shift+Enter` 换行。
- 输入以 `/` 开头且无空格时弹出**命令面板**(`commands.ts` 的已知斜杠命令),点选即执行或补全参数。
- 支持图片附件(转 base64 作为 `PromptContentPart` 的 `image` 块)。

### 3.2 工具轨迹

`ToolCard` 按 `view.card` 分支:

- `diff`:LCS 行 diff,增/删着色(新文件全绿)。
- `terminal`:cwd 头 + 命令 + 输出 + 退出码。
- `read`:行号代码视图。
- `search`:按文件分组匹配或路径列表。
- `web`:来源列表。
- `generic`:标题 + rawInput + 结果文本(兜底)。

### 3.3 模型选择 / 目标 / 分支 / 归档

- 模型下拉按 provider 分组(`session.models`),切换走 `session.selectModel`。
- 目标条支持创建/编辑/暂停/继续/完成/清除(`goals.*`)。
- 分支(fork)从最近完成回合复制会话;归档走 `workspace.archiveSession`。

### 3.4 审批 / 提问

`PromptLayer` 叠加层:审批给「允许/拒绝」,提问按选项(单选/多选)提交,plan-review 把 `detail` 以大块展示。

## 4. 本地化(`locale.ts`)

- `namespaceLabel(ns)`、`fieldLabel(key)`、`enumLabel(value)` 三张中文词典,兜底做 camelCase 人性化。
- 设置表单与命名空间列表统一走词典;命令面板描述直接中文;模型名/预设 id 等专有名词保留原文。

## 5. 样式

`styles.css` 单一暗色主题(CSS 变量),类名按组件域前缀(如 `.tool-*`、`.form-*`、`.prompt-*`、`.goal-*`),无第三方 UI 库。

## 6. 状态订阅

`useAppStore()` 无选择器订阅整个 store;流式文本更新触发 `timeline` 重算(`useMemo`),滚动到底部用 `scrollIntoView`。
