# DeepSeek Harness Client

一个自研的 **Electron 桌面客户端**,用于驱动 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)。它复用 DSH 官方发布的协议包(`@deepseek-ai/dsh-host-apiproxy` / `@deepseek-ai/dsh-client-connection`),只自写 UI 与平台载体,并与官方 3080 Web GUI 并存。

## 架构

```
┌────────────────────────── Electron ──────────────────────────┐
│  renderer (React + Vite)          main (Node)                │
│  ┌─────────────────────┐  IPC    ┌────────────────────────┐  │
│  │ 自研 UI / zustand   │◄───────►│ Controller             │  │
│  │ timeline 折叠渲染    │         │  ├─ startHost()        │  │
│  └─────────────────────┘         │  │     spawn `dsh web`  │  │
│                                  │  ├─ NodeApiClient      │  │
│                                  │  │   (AbstractApiClient │  │
│                                  │  │    子类: fetch + ws) │  │
│                                  │  └─ ConnectionLoop     │  │
│                                  └───────────┬────────────┘  │
└──────────────────────────────────────────────┼───────────────┘
                                               │ /api HTTP + 2×WebSocket
                                        ┌──────▼──────┐
                                        │ dsh web host│ (127.0.0.1:<port>)
                                        └─────────────┘
```

关键点:DSH 的信任栅栏要求浏览器请求 `Origin === Host` 且拒绝 `sec-fetch-site: cross-site`,所以协议客户端跑在 **Electron 主进程(Node)**——作为回环非浏览器客户端天然通过栅栏,再经 IPC 桥接到渲染层。

## 复用清单

| 能力 | 来源 |
|---|---|
| 类型化 RPC / 信封封装 / zod 校验 | `AbstractApiClient`(`@deepseek-ai/dsh-host-apiproxy/client`) |
| 下行事件流 schema | `@deepseek-ai/dsh-host-apiproxy/api/{rpc,events}.schema` |
| 连接/重连/退避逻辑 | 参考 `dsh-client-connection` 的 `ConnectionController` 移植 |
| WebSocket 下行 | `ws`(Node 侧 `WebApiClient` 的同构移植) |

## 开发

```bash
npm install
npm run dev       # electron-vite 开发(内嵌 host 自动启动)
npm run smoke     # 不依赖 Electron,单独验证「host 启动 + 协议 + 流式」
npm run probe     # 验证 settings/workspace/llm/session.models 等 RPC 面
npm run build     # 构建到 out/
npm run typecheck # tsc --noEmit
```

国内环境安装 Electron 二进制用文档化环境变量(npm 已不再传递 .npmrc 自定义 key):`$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`。

`npm run smoke` 会启动一个 `dsh web`、连接、新建会话、发送一条消息并流式打印事件,用于在无 GUI 环境下验证核心链路。其余探针:

- `npx tsx scripts/ws-open-probe.ts` —— 打开已有文件夹为工作区的 adopt 语义、幂等性、错误路径
- `npx tsx scripts/ws-order-probe.ts` —— 工作区内会话排序 / 工作区排序 / 跨工作区移动拒绝

两个 ws 探针都在临时 `DSH_HOME` 中运行,不会写入真实用户数据。
- `node scripts/cdp-ui-verify.mjs` —— 需应用在 `:9222` 调试端口运行(`npx electron . --remote-debugging-port=9222`):目录 modal 全流程 UI 验证
- `node scripts/cdp-dnd-verify.mjs` —— 拖拽排序 UI 验证(合成 DragEvent,异步分步)
- `node scripts/cdp-settings-verify.mjs` —— 设置/能力面冒烟(命名空间渲染、MCP 非法 JSON 错误样式)
- `node scripts/cdp-boot-check.mjs [port]` —— 等待「已连接」或打印错误(打包冒烟用,默认 9223)
- `node scripts/cdp-shot.mjs [out.png]` —— CDP 截图

## 目录

```
src/
  core/        # 纯 Node:host 启动 + 协议客户端 + 连接循环(不依赖 electron)
  main/        # Electron 主进程
  preload/     # contextBridge 桥
  renderer/    # React UI
  shared/      # 主/渲染共享的 IPC 契约类型
scripts/       # smoke 测试
```

## 功能

- **会话**:列表 / 新建 / 流式对话 / 停止 / 重命名 / 归档 / 分支(fork)/ 历史分页(加载更早)/ 内容搜索 / 图片附件 / 队列(steer/edit 移除)
- **工具轨迹**:富渲染 —— 文件 diff、终端、文件读取(行号)、搜索、网页、通用卡片(消费 host 下发的 `ToolCallView`/`ToolResultView`)
- **审批/提问**:工具审批弹窗、提问(含 plan-review)弹窗,走 `respond` 通道回传
- **计划模式**:chat 头部 plan 状态指示(`plan` 投影)
- **工作区**:侧栏按工作区分组、**打开已有项目文件夹**(in-app 目录浏览:面包屑导航/新建文件夹/系统对话框备用入口;打开即自动建会话;重复打开有提示)/ 重命名 / 移除 / 在文件管理器中打开 / **拖拽排序**(工作区之间与工作区内会话)
- **模型**:会话级模型选择(`session.models` / `session.selectModel`)
- **目标(goal)**:目标条 + 创建/编辑/暂停/继续/完成/清除
- **子代理(subagent)**:子代理面板(列表 / 执行记录 / 后续消息 / 中断)
- **后台任务(jobs)**:会话内 jobs 列表
- **能力面**:技能(skills)列表与调用、Agent 预设(presets)列表/设默认/应用到会话、凭据(credentials)管理、**MCP 服务器**(JSON 编辑,经 `--patch` 注入 `dsh-mcp-client` 插件)
- **命令面板**:输入框输入 `/` 弹出已知斜杠命令(`/compact /goal /plan /feedback /permission /export`,硬编码,因协议无命令枚举 RPC)
- **设置**:`schemastery` schema 驱动的**表单**(复用 `dsh-client-schema-form`),`mutate` 差异保存、保留密钥、重置、打开配置文件
- **连接**:内嵌 host 或远程 host(URL,`--trusted-host` 授权)

## 已知限制

- **命令枚举**:DSH 协议无枚举命令的 RPC;命令面板内置已知命令集,新增命令需手动同步 `src/renderer/src/commands.ts`。
- **MCP 配置**:经 `--patch` 注入 `dsh-mcp-client`(JSON 编辑);实际加载仍需一个可达的 MCP 服务器端。
- **打包**:`npm run dist` 产出 `dist/win-unpacked/`(可运行;host 已 `asarUnpack` 到磁盘,`resolveDshBin` 做了 `app.asar.unpacked` 重写;`files` 白名单只收 `out/**`,源码/脚本不入包)。NSIS 安装器封装依赖 winCodeSign/NSIS 工具链,本环境下载不全会卡在封装步骤(已设 `signAndEditExecutable: false`)。electron-builder 维持 24.x:26.x 的 @electron/rebuild 在本机 node-gyp 检测不到已装的 VS 2022(node-pty 重建失败),有完整工具链的 CI 可升级。
- **跨工作区移动会话**协议不支持:工作区从属由会话 cwd 决定(官方 GUI 也只支持组内排序);同理,移除工作区后若仍有会话记录该 cwd,host bootstrap 会自动重建同路径工作区。
- **内嵌 host 目录选择器**只组合 `native` 能力:`host.listDirectory`/`host.createDirectory` 由主进程本地 fs 兜底(内嵌 host 即本机),in-app 目录浏览因此可用;原生系统对话框保留为备用入口(已观测到 DSH native picker worker 在本机 napi 崩溃一次,host 会正常报错,modal 内显示)。
- **设置表单**对「非 const 的 union/intersect」降级 JSON 编辑(如 `retryPolicy`)。
- **搜索**需 host 启用 session-query 索引(已通过 `--patch` 覆盖 `openAt: first-search`);若磁盘存在损坏的会话日志,索引构建会失败。

---

## 许可证

本项目采用 [MIT 许可证](LICENSE)。

## 第三方与上游声明

本项目包含或依赖第三方组件，其版权与许可证归各自作者所有，
详见仓库内的依赖清单与相关声明文件。若本项目基于其他开源项目二次开发，
已在正文中注明上游项目与所基于的版本，本项目为**非官方**衍生作品。

## 现状与限制

- 本项目为个人开发项目，按“现状”提供，不附带任何明示或暗示的担保。
- README 与代码注释中记录的验证结论仅针对当时的具体环境与版本，不代表在其他环境下同样成立。
- 涉及本地凭据的部分统一使用系统凭据库或环境变量，仓库内不含真实密钥；
  示例配置仅使用占位符。
