export interface SlashCommand {
  name: string
  description: string
  /** Optional free-form input hint (the command takes an argument). */
  input?: string
}

/**
 * Host-side slash commands composed in the default `dsh web` deployment.
 * DSH exposes no RPC to enumerate them (they live in the host's cordis command
 * registry), so this is the known set for the shipped bundle; each command is
 * invoked as a plain `session.prompt` whose first token is `/name`.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: '压缩较早的对话历史' },
  { name: 'goal', description: '设置或查看长任务的目标' },
  { name: 'plan', description: '进入或退出计划模式' },
  { name: 'feedback', description: '记录对本会话的反馈' },
  { name: 'permission', description: '切换权限预设(沙盒模式 + 审批策略)', input: '<preset>' },
  { name: 'export', description: '将会话日志下载为 ZIP 压缩包' }
]
