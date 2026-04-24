<script setup lang="ts">
import type { AgentFrame } from '@/api/hermes/chat'
import type { Message } from '@/stores/hermes/chat'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  frames: AgentFrame[]
  traceUserInputs: Record<string, string>
  toolMessages: Message[]
  active: boolean
  sessionId?: string
}>()

const { t } = useI18n()
const listRef = ref<HTMLElement | null>(null)
const isAtBottom = ref(true)
const scrollTop = ref(0)
const viewMode = ref<'reasoning' | 'tools'>('reasoning')
const collapsed = ref(false)
const hasAutoScrolledForSession = ref(false)
const cachedScrollTop = ref(0)
const cachedWasAtBottom = ref(true)

const STICKY_BOTTOM_THRESHOLD_PX = 48
const VIRTUALIZE_THRESHOLD_FRAMES = 180
const OVERSCAN_PX = 480
const CARD_BASE_HEIGHT = 46
const CARD_VERTICAL_GAP = 8

type TraceGroup = { traceId: string, frames: AgentFrame[] }

function shortTraceId(traceId: string): string {
  return traceId.length > 28 ? `${traceId.slice(0, 14)}…${traceId.slice(-10)}` : traceId
}

function frameTypeLabel(type: string): string {
  if (type === 'TOOL_CALL') return 'TOOL_CALL'
  if (type === 'THOUGHT') return 'THOUGHT'
  if (type === 'ARTIFACT') return 'ARTIFACT'
  return type
}

function mergeStreamingFrames(frames: AgentFrame[]): AgentFrame[] {
  const merged: AgentFrame[] = []
  for (const frame of frames) {
    const prev = merged[merged.length - 1]
    const canMergeThought =
      frame.type === 'THOUGHT'
      && prev?.type === 'THOUGHT'
      && frame.trace_id === prev.trace_id
      && (frame.payload?.source ?? 'reasoning') === (prev.payload?.source ?? 'reasoning')
    const canMergeResponseDelta =
      frame.type === 'RESPONSE'
      && prev?.type === 'RESPONSE'
      && frame.trace_id === prev.trace_id
      && !Boolean(frame.payload?.final)
      && !Boolean(prev.payload?.final)
      && frame.payload?.role === prev.payload?.role

    if (canMergeThought || canMergeResponseDelta) {
      merged[merged.length - 1] = {
        ...prev,
        payload: {
          ...prev.payload,
          content: `${String(prev.payload?.content ?? '')}${String(frame.payload?.content ?? '')}`,
        },
      }
      continue
    }
    merged.push(frame)
  }
  return merged
}

function groupDisplayFramesByTraceId(frames: AgentFrame[]): TraceGroup[] {
  const map = new Map<string, AgentFrame[]>()
  const order: string[] = []
  for (const frame of frames) {
    if (!map.has(frame.trace_id)) {
      map.set(frame.trace_id, [])
      order.push(frame.trace_id)
    }
    map.get(frame.trace_id)!.push(frame)
  }
  return order.map(traceId => ({ traceId, frames: map.get(traceId)! }))
}

function estimateCardHeight(frame: AgentFrame): number {
  const payloadStr = JSON.stringify(frame.payload, null, 2)
  const lineCount = payloadStr.split('\n').length
  return CARD_BASE_HEIGHT + lineCount * 18 + CARD_VERTICAL_GAP
}

function toPrettyJson(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2)
      } catch {
        return value
      }
    }
    return value
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const displayFrames = computed(() =>
  mergeStreamingFrames(
    props.frames.filter(frame =>
      frame.type === 'THOUGHT' || frame.type === 'TOOL_CALL' || frame.type === 'ARTIFACT',
    ),
  ),
)

const dedupedDisplayFrames = computed(() => {
  const frames = displayFrames.value
  // If a TOOL_CALL with same trace_id + tool_call_id later has non-null result,
  // hide the earlier placeholder card whose result is null.
  return frames.filter((frame, index) => {
    if (frame.type !== 'TOOL_CALL') return true
    const toolCallId = String(frame.payload?.tool_call_id || '')
    if (!toolCallId) return true
    const result = frame.payload?.result
    if (result != null) return true
    const hasLaterCompleted = frames.slice(index + 1).some(next =>
      next.type === 'TOOL_CALL'
      && next.trace_id === frame.trace_id
      && String(next.payload?.tool_call_id || '') === toolCallId
      && next.payload?.result != null,
    )
    return !hasLaterCompleted
  })
})

const groupedFrames = computed(() => groupDisplayFramesByTraceId(dedupedDisplayFrames.value))
const shouldVirtualize = computed(() => dedupedDisplayFrames.value.length >= VIRTUALIZE_THRESHOLD_FRAMES)
const toolLogs = computed(() => [...props.toolMessages].reverse())

const estimatedHeights = computed(() => dedupedDisplayFrames.value.map(frame => estimateCardHeight(frame)))
const offsets = computed(() => {
  const list: number[] = new Array(dedupedDisplayFrames.value.length)
  let acc = 0
  for (let i = 0; i < dedupedDisplayFrames.value.length; i += 1) {
    list[i] = acc
    acc += estimatedHeights.value[i] ?? 0
  }
  return { list, total: acc }
})

const visibleRange = computed(() => {
  if (!shouldVirtualize.value) return { start: 0, end: dedupedDisplayFrames.value.length }
  const viewportHeight = listRef.value?.clientHeight ?? 0
  const top = Math.max(0, scrollTop.value - OVERSCAN_PX)
  const bottom = scrollTop.value + viewportHeight + OVERSCAN_PX
  let start = 0
  let end = dedupedDisplayFrames.value.length

  for (let i = 0; i < offsets.value.list.length; i += 1) {
    const itemTop = offsets.value.list[i]
    const itemBottom = itemTop + (estimatedHeights.value[i] ?? 0)
    if (itemBottom >= top) {
      start = i
      break
    }
  }
  for (let i = start; i < offsets.value.list.length; i += 1) {
    const itemTop = offsets.value.list[i]
    if (itemTop > bottom) {
      end = i
      break
    }
  }
  return { start, end }
})

function onScroll() {
  const el = listRef.value
  if (!el) return
  scrollTop.value = el.scrollTop
  const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight)
  isAtBottom.value = remaining <= STICKY_BOTTOM_THRESHOLD_PX
}

function scrollToBottom(behavior: ScrollBehavior = 'auto') {
  nextTick(() => {
    const el = listRef.value
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
  })
}

function handleToggleCollapsed() {
  const el = listRef.value
  if (!collapsed.value) {
    cachedScrollTop.value = el?.scrollTop ?? scrollTop.value
    cachedWasAtBottom.value = isAtBottom.value
    collapsed.value = true
    return
  }

  collapsed.value = false
  nextTick(() => {
    const nextEl = listRef.value
    if (!nextEl) return
    if (cachedWasAtBottom.value) {
      nextEl.scrollTo({ top: nextEl.scrollHeight, behavior: 'auto' })
      scrollTop.value = nextEl.scrollTop
      isAtBottom.value = true
      return
    }
    nextEl.scrollTo({ top: Math.max(0, cachedScrollTop.value), behavior: 'auto' })
    onScroll()
  })
}

watch(() => props.frames.length, () => {
  if (props.active && isAtBottom.value) scrollToBottom()
})

watch(
  () => props.sessionId,
  () => {
    hasAutoScrolledForSession.value = false
    isAtBottom.value = true
    scrollTop.value = 0
    scrollToBottom()
  },
  { immediate: true },
)

watch(
  () => dedupedDisplayFrames.value.length,
  (len) => {
    if (len <= 0) return
    if (hasAutoScrolledForSession.value) return
    hasAutoScrolledForSession.value = true
    isAtBottom.value = true
    scrollToBottom()
  },
  { immediate: true },
)
</script>

<template>
  <aside class="reasoning-trace" :class="{ collapsed }">
    <button
      type="button"
      class="reasoning-trace__toggle-handle"
      :title="collapsed ? t('chat.reasoningTitle') : t('common.collapse')"
      :data-tip="collapsed ? `展开${t('chat.reasoningTitle')}` : t('common.collapse')"
      :aria-label="collapsed ? t('common.expand') : t('common.collapse')"
      @click="handleToggleCollapsed"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <path v-if="collapsed" d="M15 6l-6 6 6 6" />
        <path v-else d="M9 6l6 6-6 6" />
      </svg>
    </button>

    <header v-if="!collapsed" class="reasoning-trace__header">
      <span v-if="!collapsed">{{ t('chat.reasoningTitle') }}</span>
      <div class="reasoning-trace__tabs">
        <template v-if="!collapsed">
          <button
          type="button"
          class="reasoning-trace__tab"
          :class="{ active: viewMode === 'reasoning' }"
          @click="viewMode = 'reasoning'"
        >
          {{ t('chat.reasoningTitle') }}
          </button>
          <button
          type="button"
          class="reasoning-trace__tab"
          :class="{ active: viewMode === 'tools' }"
          @click="viewMode = 'tools'"
        >
          {{ t('chat.tool') }}
          </button>
        </template>
      </div>
    </header>
    <div v-if="!collapsed" ref="listRef" class="reasoning-trace__body" @scroll="onScroll">
      <div v-if="viewMode === 'reasoning' && groupedFrames.length === 0" class="reasoning-trace__empty">
        {{ t('chat.reasoningTraceEmpty') }}
      </div>

      <template v-else-if="viewMode === 'reasoning' && !shouldVirtualize">
        <section
          v-for="(group, index) in groupedFrames"
          :key="group.traceId"
          class="reasoning-turn"
        >
          <div class="reasoning-turn__meta">
            <span class="reasoning-turn__badge">{{ t('chat.reasoningTraceRound', { n: index + 1 }) }}</span>
            <span v-if="index === groupedFrames.length - 1" class="reasoning-turn__latest">{{ t('chat.reasoningTraceLatest') }}</span>
            <span class="reasoning-turn__trace-id" :title="group.traceId">{{ shortTraceId(group.traceId) }}</span>
          </div>
          <p class="reasoning-turn__label">{{ t('chat.reasoningTraceTriggeredBy') }}</p>
          <div class="reasoning-turn__user-shell">
            <svg class="reasoning-turn__user-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <div class="reasoning-turn__user">
              {{ traceUserInputs[group.traceId] || t('chat.reasoningTraceNoUserMatch') }}
            </div>
          </div>

          <article
            v-for="frame in group.frames"
            :key="`${frame.trace_id}-${frame.seq}`"
            class="trace-card"
            :class="`trace-card--${frame.type.toLowerCase()}`"
          >
            <div class="trace-card__header">
              <svg v-if="frame.type === 'TOOL_CALL'" class="trace-card__tool-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
              </svg>
              <span class="trace-card__type">{{ frameTypeLabel(frame.type) }}</span>
              <span class="trace-card__seq">#{{ frame.seq }}</span>
            </div>
            <template v-if="frame.type === 'THOUGHT'">
              <div class="trace-card__source">
                source: {{ String(frame.payload?.source ?? 'reasoning') }}
              </div>
              <div class="trace-card__content">{{ String(frame.payload?.content ?? '') }}</div>
            </template>
            <template v-else-if="frame.type === 'TOOL_CALL'">
              <div class="trace-card__tool">
                <span class="trace-card__tool-name">{{ String(frame.payload?.name ?? 'tool') }}</span>
                <span class="trace-card__tool-id">{{ String(frame.payload?.tool_call_id ?? '—') }}</span>
              </div>
              <div class="trace-card__section">{{ t('chat.arguments') }}</div>
              <pre class="trace-card__code">{{ toPrettyJson(frame.payload?.args ?? {}) }}</pre>
              <div class="trace-card__section">{{ t('chat.result') }}</div>
              <pre class="trace-card__code">{{ toPrettyJson(frame.payload?.result ?? null) }}</pre>
            </template>
            <template v-else-if="frame.type === 'ARTIFACT'">
              <div class="trace-card__artifact-grid">
                <span>artifact_id</span><span>{{ String(frame.payload?.artifact_id ?? '—') }}</span>
                <span>source_tool</span><span>{{ String(frame.payload?.source_tool ?? '—') }}</span>
                <span>artifact_type</span><span>{{ String(frame.payload?.artifact_type ?? '—') }}</span>
                <span>mime</span><span>{{ String(frame.payload?.mime ?? '—') }}</span>
              </div>
              <pre class="trace-card__code">{{ toPrettyJson(frame.payload ?? {}) }}</pre>
            </template>
          </article>
        </section>
      </template>

      <template v-else-if="viewMode === 'reasoning'">
        <div :style="{ height: `${offsets.list[visibleRange.start] ?? 0}px` }"></div>
        <article
          v-for="frame in dedupedDisplayFrames.slice(visibleRange.start, visibleRange.end)"
          :key="`${frame.trace_id}-${frame.seq}`"
          class="trace-card"
          :class="`trace-card--${frame.type.toLowerCase()}`"
        >
          <div class="trace-card__header">
            <svg v-if="frame.type === 'TOOL_CALL'" class="trace-card__tool-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            <span class="trace-card__type">{{ frameTypeLabel(frame.type) }}</span>
            <span class="trace-card__seq">#{{ frame.seq }}</span>
          </div>
          <template v-if="frame.type === 'THOUGHT'">
            <div class="trace-card__source">
              source: {{ String(frame.payload?.source ?? 'reasoning') }}
            </div>
            <div class="trace-card__content">{{ String(frame.payload?.content ?? '') }}</div>
          </template>
          <template v-else-if="frame.type === 'TOOL_CALL'">
            <div class="trace-card__tool">
              <span class="trace-card__tool-name">{{ String(frame.payload?.name ?? 'tool') }}</span>
              <span class="trace-card__tool-id">{{ String(frame.payload?.tool_call_id ?? '—') }}</span>
            </div>
            <div class="trace-card__section">{{ t('chat.arguments') }}</div>
            <pre class="trace-card__code">{{ toPrettyJson(frame.payload?.args ?? {}) }}</pre>
            <div class="trace-card__section">{{ t('chat.result') }}</div>
            <pre class="trace-card__code">{{ toPrettyJson(frame.payload?.result ?? null) }}</pre>
          </template>
          <template v-else-if="frame.type === 'ARTIFACT'">
            <div class="trace-card__artifact-grid">
              <span>artifact_id</span><span>{{ String(frame.payload?.artifact_id ?? '—') }}</span>
              <span>source_tool</span><span>{{ String(frame.payload?.source_tool ?? '—') }}</span>
              <span>artifact_type</span><span>{{ String(frame.payload?.artifact_type ?? '—') }}</span>
              <span>mime</span><span>{{ String(frame.payload?.mime ?? '—') }}</span>
            </div>
            <pre class="trace-card__code">{{ toPrettyJson(frame.payload ?? {}) }}</pre>
          </template>
        </article>
        <div
          :style="{
            height: `${Math.max(0, offsets.total - (offsets.list[visibleRange.end] ?? offsets.total))}px`,
          }"
        ></div>
      </template>

      <template v-else>
        <div v-if="toolLogs.length === 0" class="reasoning-trace__empty">
          {{ t('chat.noData') }}
        </div>
        <section v-for="tool in toolLogs" :key="tool.id" class="tool-log-card">
          <div class="tool-log-card__head">
            <span class="tool-log-card__name">{{ tool.toolName || 'tool' }}</span>
            <span class="tool-log-card__status" :class="`status-${tool.toolStatus || 'done'}`">
              {{ tool.toolStatus || 'done' }}
            </span>
          </div>
          <div v-if="tool.toolPreview" class="tool-log-card__preview">{{ tool.toolPreview }}</div>
          <div class="trace-card__section">{{ t('chat.arguments') }}</div>
          <pre class="trace-card__code">{{ toPrettyJson(tool.toolArgs || '{}') }}</pre>
          <div class="trace-card__section">{{ t('chat.result') }}</div>
          <pre class="trace-card__code">{{ toPrettyJson(tool.toolResult || 'null') }}</pre>
        </section>
      </template>
    </div>

    <button
      v-if="!collapsed && !isAtBottom"
      class="reasoning-trace__to-bottom"
      type="button"
      title="Scroll to bottom"
      aria-label="Scroll to bottom"
      @click="scrollToBottom('smooth')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  </aside>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.reasoning-trace {
  width: 340px;
  min-width: 280px;
  border-left: 1px solid $border-color;
  display: flex;
  flex-direction: column;
  position: relative;
  transition: width $transition-fast, min-width $transition-fast;
}

.reasoning-trace.collapsed {
  width: 0;
  min-width: 0;
  border-left: 0;
  overflow: visible;
}

.reasoning-trace__toggle-handle {
  position: absolute;
  left: -13px;
  top: 50%;
  transform: translateY(-50%);
  width: 26px;
  height: 44px;
  border: 1px solid rgba(var(--text-primary-rgb), 0.18);
  border-radius: 999px;
  background: $bg-card;
  color: $text-muted;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 20;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
  transition: all $transition-fast;
}

.reasoning-trace.collapsed .reasoning-trace__toggle-handle {
  left: -18px;
}

.reasoning-trace.collapsed .reasoning-trace__toggle-handle::after {
  content: attr(data-tip);
  position: absolute;
  left: -8px;
  top: 50%;
  transform: translate(-100%, -50%);
  white-space: nowrap;
  font-size: 11px;
  line-height: 1;
  color: $text-primary;
  background: $bg-card;
  border: 1px solid rgba(var(--text-primary-rgb), 0.18);
  border-radius: 999px;
  padding: 6px 10px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  opacity: 0;
  pointer-events: none;
  transition: opacity $transition-fast, transform $transition-fast;
}

.reasoning-trace.collapsed .reasoning-trace__toggle-handle:hover::after {
  opacity: 1;
  transform: translate(calc(-100% - 6px), -50%);
}

.reasoning-trace__toggle-handle:hover {
  color: $text-primary;
  border-color: rgba(var(--text-primary-rgb), 0.3);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
}

.reasoning-trace__header {
  padding: 10px 10px 9px;
  border-bottom: 1px solid $border-color;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: $text-primary;
  background: rgba(var(--text-primary-rgb), 0.02);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 40px;
}

.reasoning-trace__tabs {
  display: inline-flex;
  gap: 6px;
}

.reasoning-trace__tab {
  border: 1px solid rgba(var(--text-primary-rgb), 0.18);
  background: transparent;
  color: $text-muted;
  border-radius: 999px;
  font-size: 10px;
  padding: 2px 8px;
  cursor: pointer;
}

.reasoning-trace__tab.active {
  color: $text-primary;
  background: rgba(var(--text-primary-rgb), 0.12);
}

.reasoning-trace__body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px;
}

.reasoning-trace__empty {
  font-size: 12px;
  color: $text-muted;
  text-align: center;
  padding: 24px 8px;
}

.reasoning-turn {
  margin-bottom: 12px;
  border: 1px solid rgba(var(--text-primary-rgb), 0.12);
  border-radius: 16px;
  padding: 12px;
  // background:
  //   linear-gradient(145deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.01) 45%, transparent 100%),
  //   linear-gradient(180deg, rgba(var(--text-primary-rgb), 0.04), transparent);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

.reasoning-turn__meta {
  display: flex;
  align-items: center;
  gap: 6px;
}

.reasoning-turn__badge,
.reasoning-turn__latest {
  font-size: 10px;
  padding: 2px 8px 1px;
  border-radius: 999px;
  font-weight: 600;
  border: 1px solid rgba(var(--text-primary-rgb), 0.25);
  background: rgba(var(--text-primary-rgb), 0.1);
  color: $text-primary;
}

.reasoning-turn__badge::before {
  content: '✦';
  margin-right: 4px;
  opacity: 0.8;
}

.reasoning-turn__trace-id {
  margin-left: auto;
  max-width: 120px;
  font-size: 10px;
  color: $text-muted;
  font-family: $font-code;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.reasoning-turn__label {
  font-size: 10px;
  color: $text-muted;
  margin: 10px 0 6px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.reasoning-turn__user-shell {
  position: relative;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid rgba(var(--text-primary-rgb), 0.1);
  background: rgba(var(--text-primary-rgb), 0.04);
  padding: 10px 10px 10px 12px;
  margin-bottom: 12px;
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.reasoning-turn__user {
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  color: $text-primary;
}

.reasoning-turn__user-icon {
  margin-top: 2px;
  flex-shrink: 0;
  color: $text-muted;
}

.trace-card {
  background: rgba(var(--text-primary-rgb), 0.03);
  border: 1px solid rgba(var(--text-primary-rgb), 0.12);
  border-radius: 12px;
  padding: 9px 11px 10px;
  margin-top: 10px;
  opacity: 0;
  transform: translateY(4px);
  animation: trace-fade-in 0.16s ease-out forwards;
}

.trace-card__header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.trace-card__tool-icon {
  color: $text-muted;
  flex-shrink: 0;
}

.trace-card__type {
  font-size: 12px;
  font-weight: 600;
  color: $text-primary;
  letter-spacing: 0.02em;
}

.trace-card__seq {
  margin-left: auto;
  font-size: 10px;
  color: $text-muted;
  font-family: $font-code;
}

.trace-card__source {
  width: fit-content;
  font-size: 10px;
  color: $text-muted;
  border: 1px solid rgba(var(--text-primary-rgb), 0.16);
  border-radius: 999px;
  padding: 1px 6px;
  margin-bottom: 8px;
  font-family: $font-code;
}

.trace-card__content {
  font-size: 12px;
  white-space: pre-wrap;
  line-height: 1.6;
  color: $text-secondary;
}

.trace-card__tool {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-bottom: 10px;
}

.trace-card__tool-name {
  font-size: 12px;
  font-weight: 600;
  color: $text-primary;
}

.trace-card__tool-id {
  font-size: 10px;
  color: $text-muted;
  font-family: $font-code;
}

.trace-card__section {
  font-size: 10px;
  text-transform: uppercase;
  color: $text-muted;
  margin-top: 10px;
  margin-bottom: 6px;
}

.trace-card__code {
  margin: 0;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  background: rgba(var(--text-primary-rgb), 0.07);
  border: 1px solid rgba(var(--text-primary-rgb), 0.12);
  border-radius: 8px;
  padding: 9px;
  line-height: 1.5;
  color: $text-primary;
}

.trace-card__artifact-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px 8px;
  font-size: 10px;
  color: $text-muted;
  margin-bottom: 8px;
}

.trace-card__artifact-grid span:nth-child(2n) {
  text-align: right;
  color: $text-secondary;
  font-family: $font-code;
}

.trace-card--thought,
.trace-card--tool_call,
.trace-card--artifact {
  border-left: 1px solid rgba(var(--text-primary-rgb), 0.12);
}

.reasoning-trace__to-bottom {
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: 34px;
  height: 34px;
  border: 1px solid rgba(var(--text-primary-rgb), 0.18);
  border-radius: 50%;
  background: rgba(var(--bg-secondary-rgb, 26, 26, 26), 0.88);
  cursor: pointer;
  color: $text-primary;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(6px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16);
  transition: all $transition-fast;
}

.reasoning-trace__to-bottom:hover {
  background: rgba(var(--text-primary-rgb), 0.18);
  transform: translateY(-1px);
  border-color: rgba(var(--text-primary-rgb), 0.28);
}

.tool-log-card {
  margin-bottom: 10px;
  border: 1px solid rgba(var(--text-primary-rgb), 0.12);
  border-radius: 12px;
  padding: 10px;
  background: rgba(var(--text-primary-rgb), 0.03);
}

.tool-log-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.tool-log-card__name {
  font-size: 12px;
  font-weight: 600;
  color: $text-primary;
  font-family: $font-code;
}

.tool-log-card__status {
  font-size: 10px;
  border-radius: 999px;
  padding: 1px 7px;
  border: 1px solid rgba(var(--text-primary-rgb), 0.18);
}

.tool-log-card__status.status-running {
  color: $text-primary;
}

.tool-log-card__status.status-error {
  color: $error;
  border-color: rgba(var(--error-rgb), 0.35);
  background: rgba(var(--error-rgb), 0.08);
}

.tool-log-card__preview {
  font-size: 11px;
  color: $text-secondary;
  margin-bottom: 8px;
}

@keyframes trace-fade-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 1200px) {
  .reasoning-trace {
    width: 300px;
    min-width: 240px;
  }
}

@media (max-width: $breakpoint-mobile) {
  .reasoning-trace {
    width: 100%;
    min-width: 0;
    border-left: 0;
    border-top: 1px solid $border-color;
    max-height: 45%;
  }
}
</style>
