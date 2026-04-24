import type { AgentFrame, RunEvent } from '@/api/hermes/chat'
import type { HermesMessage } from '@/api/hermes/sessions'

export type TraceState = {
  frames: AgentFrame[]
  traceUserInputs: Record<string, string>
}

export type ReasoningSessionLike = {
  reasoningFrames: AgentFrame[]
  traceUserInputs: Record<string, string>
}

function ensureFrame(frame: unknown, fallbackTraceId?: string, fallbackSeq?: number): AgentFrame | null {
  if (!frame || typeof frame !== 'object') return null
  const raw = frame as Record<string, unknown>
  const type = typeof raw.type === 'string'
    ? raw.type
    : (typeof raw.frame_type === 'string' ? raw.frame_type : '')
  const traceId = typeof raw.trace_id === 'string' && raw.trace_id.trim()
    ? raw.trace_id
    : (fallbackTraceId || '')
  const seq = typeof raw.seq === 'number'
    ? raw.seq
    : (typeof fallbackSeq === 'number' ? fallbackSeq : NaN)
  const payload = (raw.payload && typeof raw.payload === 'object') ? raw.payload as Record<string, any> : {}
  if (!type || !traceId || Number.isNaN(seq)) return null
  return { type, trace_id: traceId, seq, payload }
}

export function normalizeFramesFromEvent(evt: RunEvent, fallbackTraceId: string, nextSeq: number): AgentFrame[] {
  const eventName = String(evt.event || '').toLowerCase()
  const payloadAny = (evt.payload || {}) as Record<string, any>
  const dataAny = (evt.data || {}) as Record<string, any>
  const candidates: unknown[] = [
    evt.frame,
    payloadAny.frame,
    dataAny.frame,
    evt.payload,
    evt.data,
    evt,
  ]

  const parsed: AgentFrame[] = []
  for (const candidate of candidates) {
    const frame = ensureFrame(candidate, fallbackTraceId, nextSeq + parsed.length)
    if (frame) parsed.push(frame)
  }
  const frameLists: unknown[][] = [
    Array.isArray(payloadAny.frames) ? payloadAny.frames : [],
    Array.isArray(dataAny.frames) ? dataAny.frames : [],
  ]
  for (const list of frameLists) {
    for (const item of list) {
      const frame = ensureFrame(item, fallbackTraceId, nextSeq + parsed.length)
      if (frame) parsed.push(frame)
    }
  }
  if (parsed.length > 0) return parsed

  if (eventName.includes('tool') && (eventName.includes('start') || eventName.includes('begin'))) {
    return [{
      type: 'TOOL_CALL',
      seq: nextSeq,
      trace_id: fallbackTraceId,
      payload: {
        tool_call_id: evt.tool_call_id || evt.payload?.tool_call_id || undefined,
        name: evt.tool || evt.name || evt.payload?.name || 'tool',
        args: evt.args ?? evt.payload?.args ?? {},
        result: null,
      },
    }]
  }

  if (eventName.includes('tool') && (eventName.includes('complete') || eventName.includes('finish') || eventName.includes('done'))) {
    return [{
      type: 'TOOL_CALL',
      seq: nextSeq,
      trace_id: fallbackTraceId,
      payload: {
        tool_call_id: evt.tool_call_id || evt.payload?.tool_call_id || undefined,
        name: evt.tool || evt.name || evt.payload?.name || 'tool',
        args: evt.args ?? evt.payload?.args ?? {},
        result: evt.result ?? evt.payload?.result ?? null,
      },
    }]
  }

  if (eventName.includes('artifact')) {
    return [{
      type: 'ARTIFACT',
      seq: nextSeq,
      trace_id: fallbackTraceId,
      payload: evt.artifact || evt.payload || {},
    }]
  }

  const thoughtDelta = (evt as any).reasoning_delta
    ?? (evt as any).thought_delta
    ?? (evt as any).reasoning
    ?? evt.payload?.reasoning_delta
    ?? evt.payload?.thought_delta
    ?? evt.payload?.reasoning
  if (typeof thoughtDelta === 'string' && thoughtDelta.trim()) {
    return [{
      type: 'THOUGHT',
      seq: nextSeq,
      trace_id: fallbackTraceId,
      payload: { content: thoughtDelta, source: 'reasoning' },
    }]
  }

  if (eventName.includes('thought') || eventName.includes('reason')) {
    const content = String((evt.payload as any)?.content ?? (evt.payload as any)?.delta ?? '')
    if (content.trim()) {
      return [{
        type: 'THOUGHT',
        seq: nextSeq,
        trace_id: fallbackTraceId,
        payload: { content, source: 'reasoning' },
      }]
    }
  }

  return []
}

export function appendReasoningFrame(session: ReasoningSessionLike, frame: AgentFrame, fallbackUserText?: string) {
  const exists = session.reasoningFrames.some(item => item.trace_id === frame.trace_id && item.seq === frame.seq)
  if (exists) return
  session.reasoningFrames.push(frame)
  session.reasoningFrames.sort((a, b) => a.seq - b.seq)
  if (fallbackUserText && !session.traceUserInputs[frame.trace_id]) {
    session.traceUserInputs[frame.trace_id] = fallbackUserText
  }
}

export function nextReasoningSeq(session: ReasoningSessionLike): number {
  const last = session.reasoningFrames[session.reasoningFrames.length - 1]
  return (last?.seq ?? 0) + 1
}

export function deriveTraceState(msgs: HermesMessage[]): TraceState {
  const frames: AgentFrame[] = []
  const traceUserInputs: Record<string, string> = {}
  const toolNameMap = new Map<string, string>()
  const toolArgsMap = new Map<string, string>()
  let seq = 1
  let currentTraceId = 'trace:0'
  let userTurnIndex = 0

  for (const msg of msgs) {
    if (msg.role === 'user') {
      userTurnIndex += 1
      currentTraceId = `turn:${msg.id || userTurnIndex}`
      if (msg.content?.trim()) traceUserInputs[currentTraceId] = msg.content
      continue
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const tcId = String(tc?.id || '')
        const name = String(tc?.function?.name || 'tool')
        const argsRaw = tc?.function?.arguments
        if (tcId) {
          toolNameMap.set(tcId, name)
          if (typeof argsRaw === 'string') toolArgsMap.set(tcId, argsRaw)
        }
        frames.push({
          type: 'TOOL_CALL',
          seq: seq++,
          trace_id: currentTraceId,
          payload: {
            tool_call_id: tcId || undefined,
            name,
            args: typeof argsRaw === 'string' ? argsRaw : argsRaw ?? {},
            result: null,
          },
        })
      }
    }

    if (msg.role === 'assistant' && msg.reasoning?.trim()) {
      frames.push({
        type: 'THOUGHT',
        seq: seq++,
        trace_id: currentTraceId,
        payload: { content: msg.reasoning, source: 'reasoning' },
      })
    }

    if (msg.role === 'tool') {
      const tcId = msg.tool_call_id || ''
      frames.push({
        type: 'TOOL_CALL',
        seq: seq++,
        trace_id: currentTraceId,
        payload: {
          tool_call_id: tcId || undefined,
          name: msg.tool_name || toolNameMap.get(tcId) || 'tool',
          args: toolArgsMap.get(tcId) || {},
          result: msg.content || null,
        },
      })
    }

    if (msg.role === 'assistant' && msg.content?.trim()) {
      frames.push({
        type: 'RESPONSE',
        seq: seq++,
        trace_id: currentTraceId,
        payload: { role: 'assistant', content: msg.content, final: true },
      })
    }
  }

  return { frames, traceUserInputs }
}
