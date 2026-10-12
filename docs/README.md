# DeepSeek Harness Client — 设计文档

本目录是 **DeepSeek Harness 桌面客户端**(`deepseek-harness-client`)的整套设计文档。该客户端是一个 **Electron 桌面应用**,内嵌自启动 DeepSeek Harness(`dsh web`)宿主,并通过复用 DSH 官方协议包驱动它,目标是对齐 Codex / Cursor 一类的 **Agentic 编码客户端**体验。

## 文档索引

| 编号 | 文档 | 内容 |
|---|---|---|
| 01 | [架构设计](./01-architecture.md) | 系统定位、进程模型、分层、整体数据流 |
| 02 | [DSH 协议与复用](./02-protocol-reuse.md) | 复用的官方包、RPC 模型、事件帧、工具视图 |
| 03 | [连接与宿主管理](./03-connection-host.md) | 内嵌宿主启动、信任栅栏、远程连接、重连、补丁 |
| 04 | [IPC 契约](./04-ipc-contract.md) | 主进程↔渲染层通道、preload 桥、共享类型 |
| 05 | [数据模型与状态管理](./05-data-model.md) | 会话事件、时间线派生、zustand store、投影 |
| 06 | [UI 设计](./06-ui-design.md) | 视图结构、组件、交互、样式 |
| 07 | [设置系统](./07-settings.md) | schema 表单、编辑模型、密钥、本地化 |
| 08 | [功能模块](./08-features.md) | goals / subagents / jobs / skills / presets / credentials / MCP / 命令 |
| 09 | [打包与分发](./09-packaging.md) | electron-builder、asar、宿主解包、产物 |
| 10 | [故障排查与已知问题](./10-troubleshooting.md) | 常见故障、诊断手段、已知限制 |
| 11 | [开发与测试](./11-development.md) | 目录结构、脚本、探针、调试、本地化 |

## 快速上手

```bash
npm install
npm run dev       # 开发模式(内嵌宿主自动启动)
npm run build     # 构建到 out/
npm run dist      # 打包(dist/win-unpacked/)
npm run smoke     # 无 GUI 端到端验证
```

## 术语

- **DSH / Harness**:DeepSeek Harness,官方 npm 包 `@deepseek-ai/dsh`。
- **宿主(host)**:一个 `dsh web` 进程,提供 `/api` 协议面与 WebSocket 下行。
- **客户端(client)**:本桌面应用,通过协议面驱动宿主。
- **投影(projection)**:由会话事件折叠出的、可订阅的派生值(标题、计划、目标等)。
- **时间线(timeline)**:渲染层从会话事件日志派生的对话展示序列。
