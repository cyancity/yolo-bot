/**
 * 数字员工 UI 显示偏好 V2（持久化到浏览器 localStorage，键不变）。
 * style（discord/wechat）与 scheme（system/light/dark）是两个独立维度，
 * 各自运行时切换；不写 document 级主题属性（由 token 根的 data-wb-*
 * 属性承接）。头像统一使用 Morph Bot，旧头像与终端特效偏好在读取时移除。
 *
 * 历史迁移：
 * - style / chatLayout 历史值映射到 discord 或 wechat
 * - theme 具名深色（catppuccin-mocha/dracula/rose-pine-main）→ scheme 'dark'
 *   具名浅色（catppuccin-latte/rose-pine-dawn）→ scheme 'light'
 *   'host'/缺失 → scheme 'system'
 */
import { useSyncExternalStore } from 'react'

export type WorkforceStyle = 'discord' | 'wechat'
export type WorkforceScheme = 'system' | 'light' | 'dark'
export type ResolvedScheme = 'light' | 'dark'
/** 同一句人类消息的多条员工回复如何呈现。 */
export type ReplyGrouping = 'summary' | 'expanded' | 'collapsed'

export interface WorkforcePrefs {
  readonly style: WorkforceStyle
  readonly scheme: WorkforceScheme
  readonly showSteps: boolean
  readonly showTokenStats: boolean
  readonly replyGrouping: ReplyGrouping
}

/** 回复卡片圆角取值范围（历史滑块常量，仅保留迁移期工具函数）。 */
export const BUBBLE_RADIUS_MIN = 0
export const BUBBLE_RADIUS_MAX = 20
export const BUBBLE_RADIUS_DEFAULT = 12

/** 夹取并取整圆角值，非法输入回落到默认值。 */
export function normalizeBubbleRadius(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return BUBBLE_RADIUS_DEFAULT
  return Math.min(BUBBLE_RADIUS_MAX, Math.max(BUBBLE_RADIUS_MIN, Math.round(value)))
}

const DARK_THEMES = new Set(['catppuccin-mocha', 'dracula', 'rose-pine-main'])
const LIGHT_THEMES = new Set(['catppuccin-latte', 'rose-pine-dawn'])

const STORAGE_KEY = 'workforce.preferences'
const DEFAULT_PREFS: WorkforcePrefs = {
  style: 'discord',
  scheme: 'system',
  showSteps: false,
  showTokenStats: false,
  replyGrouping: 'summary',
}

function migrateThemeToScheme(theme: unknown): WorkforceScheme {
  if (typeof theme === 'string') {
    if (DARK_THEMES.has(theme)) return 'dark'
    if (LIGHT_THEMES.has(theme)) return 'light'
  }
  return 'system'
}

export function migrateWorkforcePrefs(parsed: unknown): WorkforcePrefs {
  if (parsed === null || typeof parsed !== 'object') return DEFAULT_PREFS
  const raw = parsed as Record<string, unknown>
  if ('style' in raw || 'scheme' in raw) {
    return {
      style: raw.style === 'wechat' ? 'wechat' : 'discord',
      scheme: raw.scheme === 'light' || raw.scheme === 'dark' ? raw.scheme : 'system',
      showSteps: typeof raw.showSteps === 'boolean' ? raw.showSteps : false,
      showTokenStats: typeof raw.showTokenStats === 'boolean' ? raw.showTokenStats : false,
      replyGrouping: migrateReplyGrouping(raw.replyGrouping),
    }
  }
  // V1 迁移：chatLayout 保留导航偏好；具名主题进 scheme；sidebarMode 不再使用。
  // bubbleRadius 不再使用。
  return {
    style: raw.chatLayout === 'wechat' || raw.style === 'wechat' ? 'wechat' : 'discord',
    scheme: migrateThemeToScheme(raw.theme),
    showSteps: typeof raw.showSteps === 'boolean' ? raw.showSteps : false,
    showTokenStats: typeof raw.showTokenStats === 'boolean' ? raw.showTokenStats : false,
    replyGrouping: migrateReplyGrouping(raw.replyGrouping),
  }
}

/** 老数据没有 replyGrouping：落到默认摘要卡片，不因新增字段改写既有偏好。 */
function migrateReplyGrouping(value: unknown): ReplyGrouping {
  return value === 'expanded' || value === 'collapsed' ? value : 'summary'
}

let cachedPrefs: WorkforcePrefs = readInitial()

function readInitial(): WorkforcePrefs {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return DEFAULT_PREFS
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      const migrated = migrateWorkforcePrefs(parsed)
      if (parsed && typeof parsed === 'object' && ('avatarStyle' in parsed || 'typingEffect' in parsed)) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated)) } catch {}
      }
      return migrated
    }
  } catch {}
  return DEFAULT_PREFS
}

const listeners = new Set<() => void>()

export function getWorkforcePrefs(): WorkforcePrefs {
  return cachedPrefs
}

export function setWorkforcePrefs(patch: Partial<WorkforcePrefs>): void {
  const next: WorkforcePrefs = {
    style: patch.style === 'discord' || patch.style === 'wechat' ? patch.style : cachedPrefs.style,
    scheme: patch.scheme === 'light' || patch.scheme === 'dark' || patch.scheme === 'system' ? patch.scheme : cachedPrefs.scheme,
    showSteps: patch.showSteps ?? cachedPrefs.showSteps,
    showTokenStats: patch.showTokenStats ?? cachedPrefs.showTokenStats,
    replyGrouping: patch.replyGrouping === 'expanded' || patch.replyGrouping === 'collapsed' || patch.replyGrouping === 'summary'
      ? patch.replyGrouping
      : cachedPrefs.replyGrouping,
  }
  if (
    next.style === cachedPrefs.style &&
    next.scheme === cachedPrefs.scheme &&
    next.showSteps === cachedPrefs.showSteps &&
    next.showTokenStats === cachedPrefs.showTokenStats &&
    next.replyGrouping === cachedPrefs.replyGrouping
  ) {
    return
  }
  cachedPrefs = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {}
  for (const listener of listeners) listener()
}

export function subscribeWorkforcePrefs(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 把全局 style/scheme 快照镜像到 <html>：portal 到 body 的浮层（宿主 Menu/
 *  Lightbox 等不经过插件根）经继承拿到同一套 token。组件行为仍以各根的
 *  data-wb-* 为准；html 级只是兜底的继承源。scheme 需先解析 system。 */
function syncHtmlScope(): void {
  if (typeof document === 'undefined' || !document.documentElement) return
  const { style, scheme } = cachedPrefs
  const resolved = scheme === 'system'
    ? (schemeMedia()?.matches ? 'dark' : 'light')
    : scheme
  document.documentElement.setAttribute('data-wb-style', style)
  document.documentElement.setAttribute('data-wb-scheme', resolved)
}

export function useWorkforcePrefs(): [WorkforcePrefs, (patch: Partial<WorkforcePrefs>) => void] {
  const prefs = useSyncExternalStore(subscribeWorkforcePrefs, getWorkforcePrefs, getWorkforcePrefs)
  return [prefs, setWorkforcePrefs]
}

const schemeMedia = (): MediaQueryList | undefined =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : undefined

function subscribeSystemScheme(fn: () => void): () => void {
  const mq = schemeMedia()
  if (!mq) return () => {}
  mq.addEventListener('change', fn)
  return () => mq.removeEventListener('change', fn)
}

function getSystemScheme(): ResolvedScheme {
  return schemeMedia()?.matches ? 'dark' : 'light'
}

/** scheme 'system' 跟随 prefers-color-scheme，切换经订阅即刻生效。 */
export function useResolvedScheme(scheme: WorkforceScheme): ResolvedScheme {
  const system = useSyncExternalStore(subscribeSystemScheme, getSystemScheme, () => 'light' as const)
  return scheme === 'system' ? system : scheme
}

if (typeof document !== 'undefined') {
  syncHtmlScope()
  subscribeWorkforcePrefs(syncHtmlScope)
  const mq = schemeMedia()
  mq?.addEventListener('change', syncHtmlScope)
}
