# 10 · 故障排查与已知问题

## 1. 症状 → 根因速查

| 症状 | 根因 | 修复 |
|---|---|---|
| 状态一直「正在启动内嵌 host…」 | ① `~/.dsh/profiles/node_modules` 里出现「应为软链接却成了(空)目录」的坏条目;② 渲染层 `init()` 未被调用(历史回归) | ① 删除坏条目;② 确认 `App.tsx` 有 `useEffect(() => void init(), [init])` |
| 宿主日志报 `exists and is not a symlink` | 同上 ① | 删除 `~/.dsh/profiles/node_modules/<package>` 对应真实目录 |
| 搜索报 `session search is disabled` | 宿主 `session-query` 的 `openAt: never` | 已通过 `--patch` 覆盖为 `first-search` |
| 搜索报 `corrupt session log: seq gap` | 磁盘存在损坏的会话日志 | 清理损坏会话,或接受搜索不可用 |
| 打包版宿主起不来 | 依赖未解包到磁盘 | `asarUnpack: ["node_modules/**"]` |
| 打包版宿主无输出 | 用了文件描述符 stdio | 改用「打包版 pipe 捕获 + 开发版 inherit」 |
| 双击 exe 没窗口/闪退 | 见 §3 诊断 | 控制台启动看 stderr |

## 2. 诊断手段

### 2.1 宿主日志

宿主 stdout/stderr 在打包版写到 `%TEMP%\dsh-client-host-<pid>.log`。**这是定位宿主启动失败的第一入口**。

### 2.2 主进程控制台

控制台方式启动 exe(`& "dist\win-unpacked\...\DeepSeek Harness Client.exe" 2>&1`)可看到主进程日志(`[main] connection: connected` 等)。

### 2.3 渲染层 CDP 远程调试

```powershell
Start-Process "...\DeepSeek Harness Client.exe" -ArgumentList "--remote-debugging-port=9222"
# 然后(脚本内默认 9222,boot-check 可传端口)
node scripts/cdp-boot-check.mjs 9222   # 等待「已连接」或打印 .status-error
```

保留的 CDP 脚本(均有头部注释说明前提):`cdp-boot-check.mjs`(启动/连接等待)、`cdp-ui-verify.mjs`(目录 modal 全流程)、`cdp-dnd-verify.mjs`(拖拽排序)、`cdp-settings-verify.mjs`(设置/能力面冒烟)、`cdp-shot.mjs`(截图)。这是排查「渲染层不更新」的关键手段(曾据此定位 `init()` 丢失)。

## 3. 已知限制(架构性)

1. **命令枚举**:DSH 无「列出命令」的 RPC(命令注册表在官方 client-runtime 里)。命令面板是**内置已知命令集**,新增命令需手动同步 `src/renderer/src/commands.ts`。
2. **目录选择器**:内嵌宿主只组合 `native` 能力;in-app 目录浏览由主进程本地 fs 兜底(`host.listDirectory` 失败时回退),原生对话框保留为 modal 内备用入口。
3. **设置表单**:「非 const 的 union / intersect」降级为 JSON 编辑(如 `retryPolicy`)。
4. **MCP 验证**:配置注入已验证宿主可启动,但实际连通需真实可达的 MCP server。
5. **打包安装器**:NSIS 封装在本环境工具链不完整;`dist/win-unpacked` 本身可运行。
6. **会话搜索**:依赖宿主 session-query 索引 + 日志干净。

## 4. 历史回归教训

- `App.tsx` 反复编辑中曾误删 `init` 的解构 + effect,导致 store 从不初始化、界面永远「正在启动」。**任何对 App 顶层 store 订阅/初始化的改动都要回归验证状态能到「已连接」**。
- 排查方向别只盯着「宿主有没有起来」——宿主/主进程可能是好的,问题在渲染层初始化或订阅。

## 5. 常见环境坑

- `DSH_HOME` 未设置时宿主回落到 `~/.dsh`(默认一致),一般无需显式设置。
- 多份 `@deepseek-ai/dsh` 安装(npx 缓存 / dev 项目 / 打包版)会争抢 `~/.dsh/profiles/node_modules` 的软链接目标,但每次启动会 heal;只要没有「真实目录挡道」就能自愈。
- Electron 的 GPU/disk_cache 报错(`Gpu Cache Creation failed` 等)是无害的 Chromium 缓存告警,不影响功能。
