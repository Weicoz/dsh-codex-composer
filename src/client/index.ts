/**
 * Codex 风格输入框增强：不接管官方 conversation.composer，只在官方输入框上叠加
 * conversation.input.dock 行、历史弹窗、键盘行为与设置开关。
 */
import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import type { ClientContext, ConversationNode, ConversationSnapshot, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

const SETTINGS_NS = 'dsh-codex-composer'
const DOCK_ID = 'codex-enhance'
const HISTORY_LIMIT = 100
const DEFAULT_ARCHIVE_SHORTCUT = 'Ctrl+Shift+K'
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS'])
const RESERVED_KEYS = new Set(['Escape', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

interface ComposerSettings {
  enabled: boolean
  archiveShortcut: string
}
interface InputActions { setDraft(text: string): void }
type DockProps = { session: ConversationSnapshot; input: { draft: string }; inputActions: InputActions; settings: SettingsScope<ComposerSettings> }
type SettingsProps = { settings: SettingsScope<ComposerSettings> }
type HistoryItem = { text: string; time: number; source: 'sent' | 'draft' }
type PopupFrame = { left: number; width: number; surface: string }

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

function normalizeShortcut(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key) || RESERVED_KEYS.has(event.key)) return null
  if (!event.ctrlKey && !event.metaKey) return null
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key
  if (MODIFIER_KEYS.has(key) || RESERVED_KEYS.has(key)) return null
  const parts = [event.metaKey ? 'Cmd' : 'Ctrl']
  if (event.shiftKey) parts.push('Shift')
  if (event.altKey) parts.push('Alt')
  parts.push(key)
  return parts.join('+')
}

function isValidShortcut(shortcut: string): boolean {
  const parts = shortcut.split('+').filter(Boolean)
  if (parts.length < 2) return false
  if (!parts.includes('Ctrl') && !parts.includes('Cmd')) return false
  const key = parts[parts.length - 1]
  return !MODIFIER_KEYS.has(key) && !RESERVED_KEYS.has(key) && key.length > 0
}

function matchesShortcut(event: KeyboardEvent, configured: string): boolean {
  if (!isValidShortcut(configured)) return false
  const parts = configured.split('+')
  const key = parts[parts.length - 1]
  const needsShift = parts.includes('Shift')
  const needsAlt = parts.includes('Alt')
  return (event.ctrlKey || event.metaKey) && event.key.toUpperCase() === key.toUpperCase()
    && event.shiftKey === needsShift && event.altKey === needsAlt
}

function findSurface(element: HTMLElement): string {
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor
    if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color
  }
  return 'color-mix(in srgb, currentColor 12%, transparent)'
}

function useSettings(settings: SettingsScope<ComposerSettings>) {
  const [, rerender] = useState(0)
  useEffect(() => settings.subscribe(() => rerender((value: number) => value + 1)), [settings])
  return settings.getSnapshot()
}

function CodexDock(props: DockProps) {
  const { session, inputActions, settings } = props
  const settingSnapshot = useSettings(settings)
  const enabled = settingSnapshot.status !== 'ready' || settingSnapshot.value?.enabled !== false
  const configuredShortcut = settingSnapshot.status === 'ready' ? settingSnapshot.value?.archiveShortcut : undefined
  const archiveShortcut = configuredShortcut && isValidShortcut(configuredShortcut) ? configuredShortcut : DEFAULT_ARCHIVE_SHORTCUT
  const [draftHistory, setDraftHistory] = useState<HistoryItem[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [popupFrame, setPopupFrame] = useState<PopupFrame | null>(null)
  const dockRef = useRef<HTMLDivElement | null>(null)
  const sentHistory = useMemo(() => historyFromSession(session), [session.nodes])
  const history = useMemo(() => [...sentHistory, ...draftHistory].slice(-HISTORY_LIMIT), [sentHistory, draftHistory])
  const activeItem = historyIndex === null ? undefined : history[historyIndex]

  useEffect(() => {
    if (!open) return
    const updateFrame = (): void => {
      const dock = dockRef.current
      const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="给智能体发消息"]')
      if (dock === null || textarea === null) return
      const dockRect = dock.getBoundingClientRect()
      const inputRect = textarea.getBoundingClientRect()
      setPopupFrame({
        left: Math.max(0, inputRect.left - dockRect.left),
        width: Math.min(inputRect.width, dockRect.width),
        surface: findSurface(textarea),
      })
    }
    updateFrame()
    window.addEventListener('resize', updateFrame)
    return () => window.removeEventListener('resize', updateFrame)
  }, [open])

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isTextareaTarget(event.target)) return
      if (event.key === 'Escape' && open) {
        event.preventDefault()
        setOpen(false)
        return
      }
      if (matchesShortcut(event, archiveShortcut)) {
        event.preventDefault()
        const text = event.target.value.trim()
        if (text) {
          const entry: HistoryItem = { text, time: Date.now(), source: 'draft' }
          setDraftHistory((items: HistoryItem[]) => [...items, entry].slice(-HISTORY_LIMIT))
        }
        inputActions.setDraft('')
        setHistoryIndex(null)
        setOpen(false)
        return
      }
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      const hasModifier = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      if (hasModifier || history.length === 0) return
      event.preventDefault()
      const nextIndex = event.key === 'ArrowUp'
        ? historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
        : historyIndex === null ? 0 : Math.min(history.length - 1, historyIndex + 1)
      setHistoryIndex(nextIndex)
      setOpen(true)
      inputActions.setDraft(history[nextIndex].text)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [enabled, archiveShortcut, history, historyIndex, inputActions, open])

  if (!enabled) return null
  const rows = history.map((item: HistoryItem, index: number) => createElement('button', {
    key: `${item.time}-${index}`, type: 'button',
    onMouseDown: (event: { preventDefault(): void }) => event.preventDefault(),
    onClick: () => { setHistoryIndex(index); setOpen(true); inputActions.setDraft(item.text) },
    style: {
      boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 12, width: '100%', maxWidth: '100%',
      padding: '8px 10px', border: 0, borderRadius: 7,
      background: index === historyIndex ? 'color-mix(in srgb, currentColor 10%, transparent)' : 'transparent',
      color: 'inherit', textAlign: 'left', cursor: 'pointer',
    },
  }, createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.text.replaceAll('\n', ' ↵ ')), createElement('time', { style: { flex: '0 0 auto', opacity: 0.65, fontSize: 12 } }, formatTime(item.time))))

  return createElement('div', { ref: dockRef, style: { position: 'relative', zIndex: 20, boxSizing: 'border-box', width: '100%', maxWidth: '100%', fontFamily: 'inherit', color: 'inherit' } },
    open && activeItem && popupFrame !== null ? createElement('div', {
      style: {
        boxSizing: 'border-box', position: 'absolute', left: popupFrame.left, bottom: 'calc(100% + 8px)',
        width: popupFrame.width, maxWidth: '100%', maxHeight: 220, overflowY: 'auto', padding: 6,
        border: '1px solid color-mix(in srgb, currentColor 24%, transparent)', borderRadius: 10,
        background: popupFrame.surface, color: 'inherit',
        boxShadow: '0 12px 36px color-mix(in srgb, currentColor 24%, transparent)',
      },
    }, rows) : null)
}

function CodexSettingsItem(props: SettingsProps) {
  const { settings } = props
  const snapshot = useSettings(settings)
  const enabled = snapshot.status !== 'ready' || snapshot.value?.enabled !== false
  const shortcut = snapshot.status === 'ready' && isValidShortcut(snapshot.value?.archiveShortcut ?? '')
    ? snapshot.value?.archiveShortcut ?? DEFAULT_ARCHIVE_SHORTCUT : DEFAULT_ARCHIVE_SHORTCUT
  return createElement('div', { style: { display: 'grid', gap: 10, padding: '10px 0' } },
    createElement('label', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, cursor: 'pointer' } },
      createElement('span', null, createElement('strong', { style: { display: 'block' } }, 'Codex 风格输入框增强')),
      createElement('input', { type: 'checkbox', checked: enabled, onChange: (event: { target: { checked: boolean } }) => void settings.set('enabled', event.target.checked) })),
    createElement('label', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 } },
      createElement('span', null, '草稿存档快捷键'),
      createElement('input', {
        type: 'text', value: shortcut, readOnly: true, 'aria-label': '草稿存档快捷键',
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key === 'Escape') return
          const next = normalizeShortcut(event)
          event.preventDefault()
          if (next !== null && isValidShortcut(next)) void settings.set('archiveShortcut', next)
        },
        style: { boxSizing: 'border-box', width: 150, maxWidth: '100%', padding: '5px 8px', border: '1px solid color-mix(in srgb, currentColor 24%, transparent)', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' },
      })))
}
