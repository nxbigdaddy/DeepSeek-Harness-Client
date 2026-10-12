/**
 * Client-side Chinese localization for host-provided English identifiers.
 * DSH's settings schemas carry English technical keys/descriptions; we map the
 * visible ones here and humanize the rest.
 */

const NAMESPACE_LABELS: Record<string, string> = {
  'ui-onboarding': '界面引导',
  'web-search-deepseek': '网页搜索 (DeepSeek)',
  'llm-deepseek': 'DeepSeek 模型',
  'ui-theme': '界面主题',
  locale: '语言',
  'ui-conversation': '对话',
  'agent-presets': 'Agent 预设',
  'agent-loop': 'Agent 循环',
  shell: 'Shell 命令',
  permission: '权限',
  'llm-pi-ai': 'PI.AI 模型'
}

const FIELD_LABELS: Record<string, string> = {
  apiKey: 'API 密钥',
  apiKeyEnv: 'API 密钥环境变量',
  baseURL: '基础 URL',
  model: '模型',
  apiVersion: 'API 版本',
  maxTokens: '最大输出 token',
  maxUses: '最大使用次数',
  thinking: '思考模式',
  reasoningEffort: '推理强度',
  defaultContextWindow: '默认上下文窗口',
  models: '模型列表',
  streamIdleTimeoutMs: '流空闲超时(毫秒)',
  retryPolicy: '重试策略',
  preference: '偏好',
  busyEnter: '忙碌时回车行为',
  default: '默认',
  maxParallelToolCalls: '最大并行工具调用',
  cwd: '工作目录',
  timeoutMs: '超时(毫秒)',
  maxTimeoutMs: '最大超时(毫秒)',
  maxOutputBytes: '最大输出字节数',
  maxSpillBytes: '最大溢出字节数',
  graceMs: '宽限(毫秒)',
  pwshPath: 'PowerShell 路径',
  defaultPreset: '默认权限预设',
  providers: '服务提供商',
  welcomeNoticeVersion: '欢迎通知版本',
  id: '标识',
  name: '名称',
  description: '描述',
  contextWindow: '上下文窗口',
  maxGoalRounds: '目标最大轮数'
}

const ENUM_LABELS: Record<string, string> = {
  enabled: '启用',
  disabled: '禁用',
  off: '关闭',
  high: '高',
  max: '最高',
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
  zh: '中文',
  en: '英文',
  queue: '排队',
  steer: '插队',
  'read-only': '只读',
  'workspace-write': '工作区写入',
  'danger-full-access': '完全访问',
  startup: '启动时',
  'first-search': '首次搜索时',
  never: '从不'
}

function humanize(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())
}

export function namespaceLabel(ns: string): string {
  return NAMESPACE_LABELS[ns] ?? ns
}

export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? humanize(key)
}

export function enumLabel(value: string): string {
  return ENUM_LABELS[value] ?? value
}
