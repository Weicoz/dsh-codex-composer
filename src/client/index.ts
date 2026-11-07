/**
 * Codex 风格输入框增强：不接管官方 conversation.composer，只在官方输入框上叠加
 * conversation.input.dock 行、历史弹窗、$ skill 选择菜单、键盘行为与设置开关。
 */
import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import type { ClientContext, ConversationNode, ConversationSnapshot, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

const SETTINGS_NS = 'dsh-codex-composer'
const DOCK_ID = 'codex-enhance'
const HISTORY_LIMIT = 100
const DEFAULT_ARCHIVE_SHORTCUT = 'Ctrl+Shift+K'
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS'])
const RESERVED_KEYS = new Set(['Escape', 'Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
/** $ 触发词：草稿开头或空白之后的 `$name`（到光标为止不含空白），与官方 /、@ 的 word boundary 一致。 */
const DOLLAR_TOKEN = /(?:^|\s)\$([^\s]*)$/

interface ComposerSettings {
  enabled: boolean
  archiveShortcut: string
  skillPicker: boolean
}
interface InputActions { setDraft(text: string): void }
type UseSession = <T>(selector: (snapshot: ConversationSnapshot) => T) => T
type DockProps = { session: { sessionId: string }; input: { draft: string }; inputActions: InputActions; settings: SettingsScope<ComposerSettings>; useSession: UseSession }
type SettingsProps = { settings: SettingsScope<ComposerSettings> }
type HistoryItem = { text: string; time: number; source: 'sent' | 'draft' }
type PopupFrame = { left: number; width: number; surface: string }
type SkillEntry = { name: string; description: string; whenToUse?: string; modelInvocable: boolean }
type SkillsRemote = { list(payload: { sessionId: string }, signal?: AbortSignal): Promise<{ ok: boolean; value?: { skills: SkillEntry[] }; error?: { code: string; message: string } }> }
type SkillMenuState = { query: string; tokenStart: number; caret: number }

export const inject = ['slots', 'settingsScope', 'remote', 'remote.skills']

export function apply(ctx: ClientContext): void {
  const skillsApi = (ctx as ClientContext & { remote?: { skills?: SkillsRemote } }).remote?.skills
  const settings = ctx.settingsScope.bind<ComposerSettings>({ namespace: SETTINGS_NS })
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: DOCK_ID, order: 30, inject: () => ({ settings, skillsApi }),
  }, CodexDock))
  // 设置项挂在「设置 → 插件 → 插件配置」里：keyed 插槽按 settings namespace 配对。
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item', id: DOCK_ID, key: SETTINGS_NS, order: 30,
    inject: () => ({ settings }),
  }, CodexSettingsItem))
}

function readText(content: readonly unknown[]): string {
  if (!Array.isArray(content)) return ''
  return content.filter((block): block is { type: 'text'; text: string } => {
    if (typeof block !== 'object' || block === null) return false
    const candidate = block as { type?: unknown; text?: unknown }
    return candidate.type === 'text' && typeof candidate.text === 'string'
  }).map((block) => block.text).join('').trim()
}

function historyFromSession(session: ConversationSnapshot): HistoryItem[] {
  const nodes = Array.isArray((session as ConversationSnapshot & { nodes?: readonly ConversationNode[] }).nodes)
    ? (session as ConversationSnapshot & { nodes: readonly ConversationNode[] }).nodes : []
  return nodes.filter((node): node is Extract<ConversationNode, { kind: 'user' }> => node.kind === 'user')
    .map((node) => ({ text: readText(node.content), time: node.time, source: 'sent' as const }))
    .filter((item) => item.text.length > 0).slice(-HISTORY_LIMIT)
}

function formatTime(epochMs: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(epochMs))
}

/** 扫描草稿中命中的 `$skill名` token（词首/空白后，名在 skill 目录内）。 */
function scanSkillTokens(draft: string, names: ReadonlySet<string>): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  const re = /(?:^|\s)\$([^\s]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(draft)) !== null) {
    const name = match[1]
    if (!names.has(name.toLowerCase())) continue
    const start = match.index + match[0].length - name.length - 1
    out.push({ start, end: start + name.length + 1 })
  }
  return out
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function buildHighlightedHtml(draft: string, ranges: Array<{ start: number; end: number }>): string {
  let html = ''
  let pos = 0
  for (const range of ranges) {
    html += escapeHtml(draft.slice(pos, range.start))
    html += `<span style="background:rgba(245,158,11,0.22);border-radius:4px;-webkit-box-decoration-break:clone;box-decoration-break:clone">${escapeHtml(draft.slice(range.start, range.end))}</span>`
    pos = range.end
  }
  html += escapeHtml(draft.slice(pos))
  return `${html}\n`
}

const MIRROR_PROPS = ['boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const

type EditableTarget = HTMLTextAreaElement | HTMLElement

function isEditableTarget(target: EventTarget | null): target is EditableTarget {
  if (target instanceof HTMLTextAreaElement) return true
  return target instanceof HTMLElement && (target.isContentEditable || target.getAttribute('contenteditable') === 'true')
}

function activeEditable(): EditableTarget | null {
  const element = document.activeElement
  return isEditableTarget(element) ? element : null
}

function visibleTextarea(): HTMLTextAreaElement | null {
  const list = document.querySelectorAll('textarea')
  for (let index = 0; index < list.length; index++) {
    const item = list[index]
    if (item.offsetWidth > 0 && item.offsetHeight > 0) return item
  }
  return null
}

/** 当前可见的会话编辑器；新版 DSH 使用 Lexical contenteditable。 */
function visibleEditable(): EditableTarget | null {
  return activeEditable()
    ?? visibleTextarea()
    ?? Array.from(document.querySelectorAll<HTMLElement>('[contenteditable="true"]'))
      .find((item) => item.offsetWidth > 0 && item.offsetHeight > 0)
    ?? null
}

function editableText(element: EditableTarget, fallback: string): string {
  return element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? fallback
}

function editableOffset(element: EditableTarget): number {
  if (element instanceof HTMLTextAreaElement) return element.selectionStart ?? 0
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0 || selection.anchorNode === null || !element.contains(selection.anchorNode)) return element.textContent?.length ?? 0
  const range = selection.getRangeAt(0).cloneRange()
  range.selectNodeContents(element)
  range.setEnd(selection.anchorNode, selection.anchorOffset)
  return range.toString().length
}

function setEditableOffset(element: EditableTarget, offset: number): void {
  if (element instanceof HTMLTextAreaElement) {
    element.setSelectionRange(offset, offset)
    return
  }
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let node: Node | null = null
  let remaining = offset
  while ((node = walker.nextNode()) !== null) {
    const length = node.textContent?.length ?? 0
    if (remaining <= length) break
    remaining -= length
  }
  if (node === null) {
    node = element
    remaining = element.childNodes.length
  }
  const range = document.createRange()
  range.setStart(node, Math.min(remaining, node.textContent?.length ?? node.childNodes.length))
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

async function fetchSkills(skillsApi: SkillsRemote | undefined, sessionId: string, signal: AbortSignal): Promise<SkillEntry[]> {
  if (skillsApi === undefined) return []
  const result = await skillsApi.list({ sessionId }, signal)
  if (!result.ok || result.value === undefined || !Array.isArray(result.value.skills)) return []
  return result.value.skills
}

/** 用镜像 div 测量 textarea 中指定偏移的光标纵向位置（相对文本首行的 top 偏移）。 */
function caretTopIn(textarea: HTMLTextAreaElement, pos: number): number {
  const style = getComputedStyle(textarea)
  const mirror = document.createElement('div')
  for (const prop of ['boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'paddingTop', 'paddingLeft', 'paddingRight', 'borderTopWidth'] as const) {
    mirror.style[prop] = style[prop]
  }
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordWrap = 'break-word'
  mirror.style.left = '-9999px'
  mirror.style.top = '0'
  mirror.style.height = 'auto'
  const before = document.createElement('span')
  before.textContent = textarea.value.slice(0, pos)
  const marker = document.createElement('span')
  marker.textContent = '\u200b'
  mirror.appendChild(before)
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const top = marker.offsetTop
  document.body.removeChild(mirror)
  return top
}

function caretTopInEditable(element: EditableTarget, pos: number, text: string): number {
  if (element instanceof HTMLTextAreaElement) return caretTopIn(element, pos)
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let node: Node | null = null
  let remaining = pos
  while ((node = walker.nextNode()) !== null) {
    const length = node.textContent?.length ?? 0
    if (remaining <= length) break
    remaining -= length
  }
  const range = document.createRange()
  if (node === null) {
    range.selectNodeContents(element)
    range.collapse(false)
  } else {
    range.setStart(node, Math.min(remaining, node.textContent?.length ?? 0))
    range.collapse(true)
  }
  return range.getBoundingClientRect().top || (text.length === 0 ? 0 : Number.POSITIVE_INFINITY)
}

/** 光标是否位于文本第一行（上方再无可移动的行）。 */
function caretOnFirstLine(element: EditableTarget, text: string): boolean {
  const pos = editableOffset(element)
  return caretTopInEditable(element, pos, text) <= caretTopInEditable(element, 0, text)
}

/** 光标是否位于文本最后一行（下方再无可移动的行）。 */
function caretOnLastLine(element: EditableTarget, text: string): boolean {
  const pos = editableOffset(element)
  return caretTopInEditable(element, pos, text) >= caretTopInEditable(element, text.length, text)
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

function popupStyleFor(frame: PopupFrame, maxHeight: number) {
  return {
    boxSizing: 'border-box' as const, position: 'absolute' as const, left: frame.left, bottom: 'calc(100% + 8px)',
    width: frame.width, maxWidth: '100%', maxHeight, overflowY: 'auto' as const, padding: 6,
    border: '1px solid rgba(148, 163, 184, 0.24)', borderRadius: 8,
    background: frame.surface, color: 'inherit',
    boxShadow: '0 12px 32px rgba(2, 6, 23, 0.28)',
    backdropFilter: 'blur(14px)',
  }
}

function measurePopupFrame(dock: HTMLDivElement, textarea: HTMLElement): PopupFrame {
  const dockRect = dock.getBoundingClientRect()
  const inputRect = textarea.getBoundingClientRect()
  return {
    left: Math.max(0, inputRect.left - dockRect.left),
    width: Math.min(inputRect.width, dockRect.width),
    surface: findSurface(textarea),
  }
}

function CodexDock(props: DockProps) {
  const { session, input, inputActions, settings, useSession, skillsApi } = props as DockProps & { skillsApi?: SkillsRemote }
  const settingSnapshot = useSettings(settings)
  const enabled = settingSnapshot.status !== 'ready' || settingSnapshot.value?.enabled !== false
  const skillPickerEnabled = settingSnapshot.status !== 'ready' || settingSnapshot.value?.skillPicker !== false
  const configuredShortcut = settingSnapshot.status === 'ready' ? settingSnapshot.value?.archiveShortcut : undefined
  const archiveShortcut = configuredShortcut && isValidShortcut(configuredShortcut) ? configuredShortcut : DEFAULT_ARCHIVE_SHORTCUT
  const [draftHistory, setDraftHistory] = useState<HistoryItem[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [popupFrame, setPopupFrame] = useState<PopupFrame | null>(null)
  const [skillMenu, setSkillMenu] = useState<SkillMenuState | null>(null)
  const [skillHighlight, setSkillHighlight] = useState(0)
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const dockRef = useRef<HTMLDivElement | null>(null)
  const lastSkillQuery = useRef<string | null>(null)
  const conversation = useSession((snapshot) => snapshot)
  const sentHistory = useMemo(() => historyFromSession(conversation), [conversation])
  const history = useMemo(() => [...sentHistory, ...draftHistory].slice(-HISTORY_LIMIT), [sentHistory, draftHistory])
  const activeItem = historyIndex === null ? undefined : history[historyIndex]
  const skillMatches = useMemo(() => {
    if (skillMenu === null) return []
    const query = skillMenu.query.toLowerCase()
    return skills.filter((skill) => skill.name.toLowerCase().startsWith(query))
  }, [skillMenu, skills])

  // 预热：挂载后拉一次当前会话可用的 skill 目录（官方 skills.list 同源）。
  useEffect(() => {
    if (!enabled || !skillPickerEnabled) return
    const controller = new AbortController()
    fetchSkills(skillsApi, session.sessionId, controller.signal).then((rows) => {
      if (!controller.signal.aborted) setSkills(rows)
    }, () => {})
    return () => controller.abort()
  }, [enabled, skillPickerEnabled, session.sessionId, skillsApi])

  useEffect(() => {
    if ((!open || activeItem === undefined) && skillMenu === null) return
    const updateFrame = (): void => {
      const dock = dockRef.current
      const textarea = visibleEditable()
      if (dock === null || textarea === null) return
      setPopupFrame(measurePopupFrame(dock, textarea))
    }
    updateFrame()
    window.addEventListener('resize', updateFrame)
    return () => window.removeEventListener('resize', updateFrame)
  }, [open, activeItem, skillMenu])

  // 输入监听：光标前的 token 命中 `$name` 时打开 skill 菜单，否则关闭。
  useEffect(() => {
    if (!enabled || !skillPickerEnabled) return
    const update = (): void => {
      const textarea = activeEditable()
      if (textarea === null) {
        lastSkillQuery.current = null
        setSkillMenu(null)
        return
      }
      const caret = editableOffset(textarea)
      const match = DOLLAR_TOKEN.exec(editableText(textarea, input.draft).slice(0, caret))
      if (match === null || match[1] === undefined) {
        lastSkillQuery.current = null
        setSkillMenu(null)
        return
      }
      const query = match[1]
      // 只在查询词变化（新开菜单 / 改过滤词）时重置高亮；
      // 否则导航键 keydown 设好的高亮会被随后的 keyup 打回 0。
      if (lastSkillQuery.current !== query) {
        lastSkillQuery.current = query
        setSkillHighlight(0)
      }
      setSkillMenu({ query, tokenStart: caret - query.length - 1, caret })
    }
    const onDoc = (event: Event): void => {
      // 控制键（Esc/Enter/Tab/箭头）不改文本，跳过 keyup 重算，
      // 否则 Esc 关闭的菜单会被紧随的 keyup 立即重开。
      if (event.type === 'keyup' && RESERVED_KEYS.has((event as KeyboardEvent).key)) return
      if (isEditableTarget(event.target)) update()
    }
    document.addEventListener('input', onDoc, true)
    document.addEventListener('keyup', onDoc, true)
    document.addEventListener('mouseup', onDoc, true)
    return () => {
      document.removeEventListener('input', onDoc, true)
      document.removeEventListener('keyup', onDoc, true)
      document.removeEventListener('mouseup', onDoc, true)
    }
  }, [enabled, skillPickerEnabled, input.draft])

  const pickSkill = (skillName: string): void => {
    if (skillMenu === null) return
    const { tokenStart, caret } = skillMenu
    const value = input.draft
    const next = `${value.slice(0, tokenStart)}$${skillName} ${value.slice(caret)}`
    const caretAfter = tokenStart + skillName.length + 2
    inputActions.setDraft(next)
    setSkillMenu(null)
    requestAnimationFrame(() => {
      const element = activeEditable()
      if (element !== null) setEditableOffset(element, caretAfter)
    })
  }

  // $skill名 高亮层：镜像 div 叠在官方 textarea 上（pointer-events:none、文字透明），
  // 命中 skill 目录的 `$name` 绘制浅橙背景块，观感对齐官方 / 的行内标记。
  useEffect(() => {
    if (!enabled || !skillPickerEnabled) return
    const overlay = document.createElement('div')
    overlay.style.position = 'absolute'
    overlay.style.boxSizing = 'border-box'
    overlay.style.whiteSpace = 'pre-wrap'
    overlay.style.wordBreak = 'break-word'
    overlay.style.overflowWrap = 'anywhere'
    overlay.style.overflow = 'hidden'
    overlay.style.pointerEvents = 'none'
    overlay.style.color = 'transparent'
    overlay.style.margin = '0'
    overlay.style.zIndex = '1'
    let attachedTa: HTMLTextAreaElement | null = null
    let observer: ResizeObserver | null = null
    const sync = (): void => {
      const textarea = visibleTextarea()
      if (textarea === null || textarea.parentElement === null) return
      if (overlay.parentElement !== textarea.parentElement) {
        textarea.parentElement.appendChild(overlay)
        attachedTa?.removeEventListener('scroll', sync)
        textarea.addEventListener('scroll', sync)
        observer?.disconnect()
        observer?.observe(textarea)
        attachedTa = textarea
      }
      for (const prop of MIRROR_PROPS) {
        overlay.style[prop] = getComputedStyle(textarea)[prop]
      }
      overlay.style.left = `${textarea.offsetLeft}px`
      overlay.style.top = `${textarea.offsetTop}px`
      overlay.style.height = `${textarea.offsetHeight}px`
      const names = new Set(skills.map((skill: SkillEntry) => skill.name.toLowerCase()))
      overlay.innerHTML = buildHighlightedHtml(props.input.draft, scanSkillTokens(props.input.draft, names))
      overlay.scrollTop = textarea.scrollTop
      overlay.scrollLeft = textarea.scrollLeft
    }
    sync()
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(sync)
      const textarea = visibleTextarea()
      if (textarea !== null) {
        observer.observe(textarea)
        textarea.addEventListener('scroll', sync)
        attachedTa = textarea
      }
    }
    window.addEventListener('resize', sync)
    return () => {
      window.removeEventListener('resize', sync)
      observer?.disconnect()
      attachedTa?.removeEventListener('scroll', sync)
      overlay.remove()
      attachedTa = null
    }
  }, [enabled, skillPickerEnabled, skills, input.draft])

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event as KeyboardEvent & { isComposing?: boolean }).isComposing === true || (event as KeyboardEvent & { keyCode?: number }).keyCode === 229) return
      if (!isEditableTarget(event.target)) return
      // 拦截即吞掉事件：preventDefault 之外还要 stopImmediatePropagation，
      // 否则同阶段更早注册的官方 composer 监听（如 Enter→发送）照样执行。
      const swallow = (): void => {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      const menuOpen = skillMenu !== null
      if (menuOpen) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          swallow()
          setSkillHighlight((index: number) => {
            const count = skillMatches.length
            if (count === 0) return 0
            return event.key === 'ArrowDown' ? (index + 1) % count : (index - 1 + count) % count
          })
          return
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && skillMatches.length > 0) {
          swallow()
          pickSkill(skillMatches[Math.min(skillHighlight, skillMatches.length - 1)].name)
          return
        }
        if (event.key === 'Escape') {
          swallow()
          setSkillMenu(null)
          return
        }
        return
      }
      if (event.key === 'Escape' && open) {
        swallow()
        setOpen(false)
        return
      }
      if (event.key === 'Tab' && open && historyIndex !== null) {
        // Tab 确认当前选中的历史项（草稿已在翻页时同步），仅关闭弹窗。
        swallow()
        setOpen(false)
        setHistoryIndex(null)
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j' && !event.shiftKey && !event.altKey) {
        swallow()
        const caret = editableOffset(event.target)
        inputActions.setDraft(`${input.draft.slice(0, caret)}\n${input.draft.slice(caret)}`)
        requestAnimationFrame(() => {
          const element = activeEditable()
          if (element !== null) setEditableOffset(element, caret + 1)
        })
        return
      }
      if (matchesShortcut(event, archiveShortcut)) {
        swallow()
        const text = input.draft.trim()
        if (text) {
          const entry: HistoryItem = { text, time: Date.now(), source: 'draft' }
          setDraftHistory((items: HistoryItem[]) => [...items, entry].slice(-HISTORY_LIMIT))
        }
        inputActions.setDraft('')
        setHistoryIndex(null)
        setOpen(false)
        setSkillMenu(null)
        return
      }
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      const hasModifier = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      if (hasModifier || history.length === 0) return
      const browsing = open && historyIndex !== null
      if (!browsing) {
        // 只有空输入框，或光标已抵达对应方向的行边界时，↑↓ 才转为历史浏览。
        const atEdge = input.draft.length === 0
          || (event.key === 'ArrowUp' ? caretOnFirstLine(event.target, input.draft) : caretOnLastLine(event.target, input.draft))
        if (!atEdge) return
      }
      swallow()
      const nextIndex = event.key === 'ArrowUp'
        ? historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
        : historyIndex === null ? 0 : Math.min(history.length - 1, historyIndex + 1)
      setHistoryIndex(nextIndex)
      setOpen(true)
      inputActions.setDraft(history[nextIndex].text)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [enabled, archiveShortcut, history, historyIndex, input.draft, inputActions, open, skillMenu, skillMatches, skillHighlight])

  if (!enabled) return null

  const frameReady = (open && activeItem !== undefined || skillMenu !== null) && popupFrame !== null
  const historyRows = history.map((item: HistoryItem, index: number) => createElement('button', {
    key: `${item.time}-${index}`, type: 'button',
    onMouseDown: (event: { preventDefault(): void }) => event.preventDefault(),
    onClick: () => { setHistoryIndex(index); setOpen(true); inputActions.setDraft(item.text) },
    style: {
      boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 12, width: '100%', maxWidth: '100%',
      minHeight: 36, padding: '8px 10px', border: 0, borderRadius: 6,
      borderLeft: index === historyIndex ? '2px solid #f59e0b' : '2px solid transparent',
      background: index === historyIndex ? 'rgba(245, 158, 11, 0.13)' : 'transparent',
      color: 'inherit', textAlign: 'left', cursor: 'pointer', transition: 'background 120ms ease, border-color 120ms ease',
    },
  }, createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.text.replaceAll('\n', ' ↵ ')), createElement('time', { style: { flex: '0 0 auto', opacity: 0.52, fontSize: 12 } }, formatTime(item.time))))

  const skillRows = skillMatches.map((skill: SkillEntry, index: number) => createElement('button', {
    key: skill.name, type: 'button',
    onMouseDown: (event: { preventDefault(): void }) => event.preventDefault(),
    onClick: () => pickSkill(skill.name),
    onMouseEnter: () => setSkillHighlight(index),
    style: {
      boxSizing: 'border-box', display: 'grid', gap: 2, width: '100%', maxWidth: '100%',
      padding: '6px 10px', border: 0, borderRadius: 6, textAlign: 'left', cursor: 'pointer',
      borderLeft: index === skillHighlight ? '2px solid #f59e0b' : '2px solid transparent',
      background: index === skillHighlight ? 'rgba(245, 158, 11, 0.13)' : 'transparent',
      color: 'inherit', transition: 'background 120ms ease, border-color 120ms ease',
    },
  },
    createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 } },
      createElement('code', { style: { fontFamily: 'inherit' } }, `$${skill.name}`),
      skill.modelInvocable ? null : createElement('span', { style: { fontSize: 11, fontWeight: 400, opacity: 0.55 } }, '仅用户可用')),
    createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, opacity: 0.62 } },
      skill.description)))

  return createElement('div', { ref: dockRef, style: { position: 'relative', zIndex: 20, boxSizing: 'border-box', width: '100%', maxWidth: '100%', fontFamily: 'inherit', color: 'inherit' } },
    frameReady && skillMenu !== null ? createElement('div', { style: popupStyleFor(popupFrame!, 260) },
      skillRows.length > 0 ? skillRows : createElement('div', { style: { padding: '8px 10px', fontSize: 12, opacity: 0.55 } }, '没有匹配的 skill')) : null,
    frameReady && skillMenu === null && open && activeItem ? createElement('div', { style: popupStyleFor(popupFrame!, 220) }, historyRows) : null)
}

function CodexSettingsItem(props: SettingsProps) {
  const { settings } = props
  const snapshot = useSettings(settings)
  const enabled = snapshot.status !== 'ready' || snapshot.value?.enabled !== false
  const skillPicker = snapshot.status !== 'ready' || snapshot.value?.skillPicker !== false
  const shortcut = snapshot.status === 'ready' && isValidShortcut(snapshot.value?.archiveShortcut ?? '')
    ? snapshot.value?.archiveShortcut ?? DEFAULT_ARCHIVE_SHORTCUT : DEFAULT_ARCHIVE_SHORTCUT
  return createElement('div', { style: { display: 'grid', gap: 10, padding: '10px 0', color: 'inherit' } },
    createElement('label', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, cursor: 'pointer' } },
      createElement('span', null, createElement('strong', { style: { display: 'block', fontSize: 13 } }, 'Codex 风格输入框增强')),
      createElement('input', { type: 'checkbox', checked: enabled, onChange: (event: { target: { checked: boolean } }) => void settings.set('enabled', event.target.checked) })),
    createElement('label', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 32 } },
      createElement('span', { style: { fontSize: 13, opacity: 0.72 } }, '$ 选 skill'),
      createElement('input', { type: 'checkbox', checked: skillPicker, disabled: !enabled, onChange: (event: { target: { checked: boolean } }) => void settings.set('skillPicker', event.target.checked) })),
    createElement('label', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 32 } },
      createElement('span', { style: { fontSize: 13, opacity: 0.72 } }, '草稿存档快捷键'),
      createElement('input', {
        type: 'text', value: shortcut, readOnly: true, 'aria-label': '草稿存档快捷键',
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key === 'Escape') return
          const next = normalizeShortcut(event)
          event.preventDefault()
          if (next !== null && isValidShortcut(next)) void settings.set('archiveShortcut', next)
        },
        style: { boxSizing: 'border-box', width: 150, maxWidth: '100%', minHeight: 30, padding: '5px 9px', border: '1px solid rgba(148, 163, 184, 0.26)', borderRadius: 6, background: 'rgba(15, 23, 42, 0.32)', color: 'inherit', font: 'inherit', fontSize: 13, outline: 'none', boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.035)' },
      })))
}
