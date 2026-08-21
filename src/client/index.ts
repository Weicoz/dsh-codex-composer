/**
 * Codex 风格输入框增强：不接管官方 conversation.composer，只在官方输入框上叠加
 * conversation.input.dock 行、历史弹窗、键盘行为与设置开关。
 */
import { createElement, useEffect, useMemo, useState } from 'react'
import type { ClientContext, ConversationNode, ConversationSnapshot, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

const SETTINGS_NS = 'dsh-codex-composer'
const DOCK_ID = 'codex-enhance'
const HISTORY_LIMIT = 100

interface ComposerSettings { enabled: boolean }
interface InputActions { setDraft(text: string): void }
type DockProps = { session: ConversationSnapshot; input: { draft: string }; inputActions: InputActions; settings: SettingsScope<ComposerSettings> }
type SettingsProps = { settings: SettingsScope<ComposerSettings> }
type HistoryItem = { text: string; time: number; source: 'sent' | 'draft' }

export const inject = ['slots', 'settingsScope']

export function apply(ctx: ClientContext): void {
  const settings = ctx.settingsScope.bind<ComposerSettings>({ namespace: SETTINGS_NS })
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: DOCK_ID, order: 30, inject: () => ({ settings }),
  }, CodexDock))
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: DOCK_ID, order: 30, inject: () => ({ settings }),
  }, CodexSettingsItem))
}

function readText(content: readonly unknown[]): string {
  return content.filter((block): block is { type: 'text'; text: string } => {
    if (typeof block !== 'object' || block === null) return false
    const candidate = block as { type?: unknown; text?: unknown }
    return candidate.type === 'text' && typeof candidate.text === 'string'
  }).map((block) => block.text).join('').trim()
}

function historyFromSession(session: ConversationSnapshot): HistoryItem[] {
  return session.nodes.filter((node): node is Extract<ConversationNode, { kind: 'user' }> => node.kind === 'user')
    .map((node) => ({ text: readText(node.content), time: node.time, source: 'sent' as const }))
    .filter((item) => item.text.length > 0).slice(-HISTORY_LIMIT)
}

function formatTime(epochMs: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(epochMs))
}

function isTextareaTarget(target: EventTarget | null): target is HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement
}

function useSettings(settings: SettingsScope<ComposerSettings>) {
  const [, rerender] = useState(0)
  useEffect(() => settings.subscribe(() => rerender((value: number) => value + 1)), [settings])
  return settings.getSnapshot()
}

function CodexDock(props: DockProps) {
  const { session, input, inputActions, settings } = props
  const settingSnapshot = useSettings(settings)
  const enabled = settingSnapshot.status !== 'ready' || settingSnapshot.value?.enabled !== false
  const [draftHistory, setDraftHistory] = useState<HistoryItem[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const sentHistory = useMemo(() => historyFromSession(session), [session.nodes])
  const history = useMemo(() => [...sentHistory, ...draftHistory].slice(-HISTORY_LIMIT), [sentHistory, draftHistory])
  const activeItem = historyIndex === null ? undefined : history[historyIndex]

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isTextareaTarget(event.target)) return
      if (event.ctrlKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        const textarea = event.target
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const draft = textarea.value
        inputActions.setDraft(draft.slice(0, start) + '\n' + draft.slice(end))
        queueMicrotask(() => textarea.setSelectionRange(start + 1, start + 1))
        setHistoryIndex(null); setOpen(false); return
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        const text = event.target.value.trim()
        if (text) {
          const entry: HistoryItem = { text, time: Date.now(), source: 'draft' }
          setDraftHistory((items: HistoryItem[]) => [...items, entry].slice(-HISTORY_LIMIT))
        }
        inputActions.setDraft(''); setHistoryIndex(null); setOpen(false); return
      }
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      const hasModifier = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      if (hasModifier || history.length === 0) return
      event.preventDefault()
      const nextIndex = event.key === 'ArrowUp'
        ? historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
        : historyIndex === null ? 0 : Math.min(history.length - 1, historyIndex + 1)
      setHistoryIndex(nextIndex); setOpen(true); inputActions.setDraft(history[nextIndex].text)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [enabled, history, historyIndex, input.draft, inputActions])

  if (!enabled) return null
  const rows = history.map((item: HistoryItem, index: number) => createElement('button', {
    key: `${item.time}-${index}`, type: 'button',
    onMouseDown: (event: { preventDefault(): void }) => event.preventDefault(),
    onClick: () => { setHistoryIndex(index); setOpen(true); inputActions.setDraft(item.text) },
    style: { display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '8px 10px', border: 0, borderRadius: 7, background: index === historyIndex ? 'var(--accent-color, rgba(127,127,127,.18))' : 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer' },
  }, createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.text.replaceAll('\n', ' ↵ ')), createElement('time', { style: { flex: '0 0 auto', opacity: 0.65, fontSize: 12 } }, formatTime(item.time))))
  return createElement('div', { style: { position: 'relative', zIndex: 20, width: '100%', fontFamily: 'inherit' } },
    open && activeItem ? createElement('div', { style: { position: 'absolute', left: 0, right: 0, bottom: 'calc(100% + 8px)', maxHeight: 220, overflowY: 'auto', padding: 6, border: '1px solid var(--border-color, rgba(127,127,127,.35))', borderRadius: 10, background: 'var(--surface-color, Canvas)', boxShadow: '0 12px 36px rgba(0,0,0,.22)' } }, rows) : null)
}

function CodexSettingsItem(props: SettingsProps) {
  const { settings } = props
  const snapshot = useSettings(settings)
  const enabled = snapshot.status !== 'ready' || snapshot.value?.enabled !== false
  return createElement('label', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '10px 0', cursor: 'pointer' } }, createElement('span', null, createElement('strong', { style: { display: 'block' } }, 'Codex 风格输入框增强'), createElement('small', { style: { opacity: 0.65 } }, '启用历史导航、Ctrl+J 换行和 Ctrl+C 草稿存档')), createElement('input', { type: 'checkbox', checked: enabled, onChange: (event: { target: { checked: boolean } }) => void settings.set('enabled', event.target.checked) }))
}
