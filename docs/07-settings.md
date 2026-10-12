# 07 · 设置系统

## 1. 数据来源

`settings.describe()` 返回每个命名空间:

```ts
interface SettingsNamespace {
  ns: string                       // 命名空间键(llm-deepseek 等)
  schema: unknown                  // schemastery 序列化信封 { uid, refs }
  value: unknown                   // 红action 后的解析值(默认→base→user)
  user?: unknown                   // 用户层(红action)
  applies: 'live' | 'restart'
  secrets: { path: string[]; set: boolean }[]
  revision: number                 // CAS 版本
}
```

## 2. Schema 还原

`schema` 是 `{ uid, refs }` 的引用封装(去重/递归引用),用官方 `rehydrateSchema` 还原为活的 schemastery 校验器节点树:

```ts
import { rehydrateSchema } from '@deepseek-ai/dsh-client-schema-form'
const root = rehydrateSchema(ns.schema)  // 可执行内容,只信任本机宿主
```

## 3. 通用表单渲染器(`SchemaForm.tsx`)

按 schema 节点 `type` + `meta` 递归渲染:

| 类型 | 控件 |
|---|---|
| `object` | 字段分组 |
| `string` | 文本框;`role: 'secret'` → 密码框(只写);`role: 'credential-ref'` → 文本 |
| `number` / `natural` / `percent` | 数字框(min/max/step) |
| `boolean` | 复选框 |
| `union`(全 const) | 下拉枚举 |
| `array` / `dict` | 可增删的条目/键值编辑器 |
| `transform` | 透传渲染 `inner` |
| `const` | 静态展示 |
| 其它(`any` / 非 const union / intersect) | JSON 降级编辑 |

## 4. 编辑模型(路径操作,非整体覆盖)

渲染层的「草稿」不直接改对象,而是维护**待提交路径操作列表**,叠加显示:

```
生效值(path) = 待提交 set op 的值
            ?? (user 里有该 path ? user 的值 : resolved 的值)
已覆盖(path) = 存在 set op,或 user 里存在该 path
```

- 编辑字段 → `upsert { op:'set', path, value }`
- 重置字段 → `upsert { op:'unset', path }`
- 保存 → `settings.mutate(ns, ops, revision)`,由宿主侧正确物化中间容器。

**为什么不用整体 replace / 客户端 copy-on-write**:路径操作天然**保留未触碰的密钥**(密钥从不回传,不在 ops 里),且数组/字典的中间物化由宿主做,客户端无需处理。

## 5. 密钥与凭据

- `role: 'secret'` 字段只写:显示「已配置 · 留空保持不变」占位,非空才 set。
- `role: 'credential-ref'` 字段值是指向凭据引用的名字(如 `DEEPSEEK_API_KEY`);「能力」视图的凭据区通过扫描 schema 中的 `credential-ref` 字段发现引用,再走 `credentials.describe/set/unset`。

## 6. 保存/重置/打开

- 保存:`settingsMutate`(差异)。
- 全部重置:`settingsReplace(ns, {}, revision)`(回退默认)。
- 打开文件:`settingsOpenDocument()`(交给系统编辑器)。
- `applies: 'restart'` 的命名空间在 UI 标注「重启生效」。

## 7. 本地化

字段标签/枚举值经 `locale.ts` 的中文词典;命名空间列表用 `namespaceLabel`。见 `06-UI` §4。

## 8. 命名空间清单(默认 web 部署)

`ui-onboarding`(界面引导)、`web-search-deepseek`(网页搜索)、`llm-deepseek`(DeepSeek 模型)、`ui-theme`(主题)、`locale`(语言)、`ui-conversation`(对话)、`agent-presets`(预设)、`agent-loop`(循环)、`shell`(命令)、`permission`(权限)、`llm-pi-ai`(PI.AI 模型)。
