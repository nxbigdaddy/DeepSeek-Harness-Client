import type { SessionEventView } from '@shared/ipc'

/** One rendered line in the conversation timeline. */
export type TimelineItem =
  | {
      kind: 'user'
      text: string
      images: { attachmentId: string; mediaType: string; name?: string }[]
      seq: number
    }
  | { kind: 'assistant'; text: string; reasoning: string; seq: number; finalized: boolean }
  | {
      kind: 'tool'
      callId: string
      name: string
      arguments: string
      status: 'running' | 'done'
      resultText?: string
      isError?: boolean
      /** host-computed ToolCallView (from the `tool/call` event's `view`). */
      callView?: unknown
      /** host-computed ToolResultView (from the `tool/result` event's `view`). */
      resultView?: unknown
      seq: number
    }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(content: any): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' || block?.type === 'reasoning')
    .map((block) => block.text)
    .join('')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function viewOf(ev: SessionEventView, forKind: 'call' | 'result'): unknown {
  const v = ev.view as any
  return v?.for === forKind ? v.view : undefined
}

export function deriveTimeline(events: SessionEventView[]): TimelineItem[] {
  const toolResults = new Map<string, { text: string; isError: boolean; view?: unknown }>()
  for (const ev of events) {
    if (ev.type !== 'tool/result') continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = ev.data as any
    const block = d?.message?.content?.[0]
    if (block?.toolCallId) {
      toolResults.set(block.toolCallId, {
        text: extractText(block.content),
        isError: Boolean(block.isError),
        view: viewOf(ev, 'result')
      })
    }
  }

  const items: TimelineItem[] = []
  let currentAssistant: Extract<TimelineItem, { kind: 'assistant' }> | null = null
  const finalizeAssistant = (): void => {
    if (currentAssistant) {
      currentAssistant.finalized = true
      currentAssistant = null
    }
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'user/message': {
        finalizeAssistant()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const content = (ev.data as any)?.content ?? []
        const text = extractText(content)
        const images = content
          .filter((b: any) => b?.type === 'image' && b?.attachment?.attachmentId)
          .map((b: any) => ({
            attachmentId: b.attachment.attachmentId,
            mediaType: b.attachment.mediaType,
            name: b.attachment.name
          }))
        if (text || images.length > 0) items.push({ kind: 'user', text, images, seq: ev.seq })
        break
      }
      case 'assistant/chunk': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = ev.data as any
        const chunk = d?.chunk
        if (chunk?.type === 'text-delta' && chunk.text) {
          if (!currentAssistant) {
            currentAssistant = { kind: 'assistant', text: '', reasoning: '', seq: ev.seq, finalized: false }
            items.push(currentAssistant)
          }
          currentAssistant.text += chunk.text
        } else if (chunk?.type === 'reasoning-delta' && chunk.text) {
          if (!currentAssistant) {
            currentAssistant = { kind: 'assistant', text: '', reasoning: '', seq: ev.seq, finalized: false }
            items.push(currentAssistant)
          }
          currentAssistant.reasoning += chunk.text
        }
        break
      }
      case 'assistant/message': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const content = ((ev.data as any)?.message?.content ?? []) as any[]
        const text = content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
        const reasoning = content.filter((b) => b?.type === 'reasoning').map((b) => b.text).join('')
        if (currentAssistant) {
          currentAssistant.text = text
          currentAssistant.reasoning = reasoning
          finalizeAssistant()
        } else if (text || reasoning) {
          items.push({ kind: 'assistant', text, reasoning, seq: ev.seq, finalized: true })
        }
        break
      }
      case 'tool/call': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = ev.data as any
        const callId = d?.callId ?? `call-${ev.seq}`
        const result = toolResults.get(callId)
        items.push({
          kind: 'tool',
          callId,
          name: d?.name ?? 'tool',
          arguments: d?.arguments ?? '',
          status: result ? 'done' : 'running',
          resultText: result?.text,
          isError: result?.isError,
          callView: viewOf(ev, 'call'),
          resultView: result?.view,
          seq: ev.seq
        })
        break
      }
      default:
        break
    }
  }
  finalizeAssistant()
  return items
}
