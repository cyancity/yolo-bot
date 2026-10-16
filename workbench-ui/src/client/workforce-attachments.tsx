import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FileTypeIcon, IconCloseOutlineRegular, ImageLightbox, Modal, ReadBlock, fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReadBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { WorkforceMessageText } from './workforce-message-text.tsx'
import { Menu, Tooltip, tokenScopeClass } from './ui/index.tsx'
import css from './workforce-attachments.module.css'

/** Narrow desktop carrier, bound once by the apply-side face; no model tool receives paths. */
interface WorkforceFileSession {
  canOpenWorkspacePath(): Promise<{ readonly ok: boolean; readonly value?: boolean }>
  openWorkspacePath(request: { readonly path: string; readonly action?: 'reveal' }): Promise<{ readonly ok: boolean }>
}
let fileSession: WorkforceFileSession | undefined
let desktopAvailable: Promise<boolean> | undefined
/** 桌面能力的一次性结论（缓存同步可读）：web 版为 false，native open 不必每次试不支持的服务。 */
let desktopSupported: boolean | undefined
export function bindWorkforceFileSession(session: WorkforceFileSession | undefined): void {
  fileSession = session
  desktopAvailable = undefined
  desktopSupported = undefined
}

/** 同步读取桌面能力结论；未探测过返回 undefined（调用方需先探测）。 */
function nativeOpenSupported(): boolean | undefined {
  if (!fileSession) return false
  if (desktopSupported !== undefined) return desktopSupported
  desktopAvailable ??= fileSession.canOpenWorkspacePath().then(result => result.ok && result.value === true).catch(() => false)
  void desktopAvailable.then(value => { desktopSupported = value })
  return undefined
}

/** Shared desktop capability; both fixed-version file actions and Host-created backups use this carrier. */
export function useWorkforceFileSession(): WorkforceFileSession | undefined {
  const session = fileSession
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (!session) { setAvailable(false); return }
    desktopAvailable ??= session.canOpenWorkspacePath().then(result => result.ok && result.value === true).catch(() => false)
    let mounted = true
    void desktopAvailable.then(value => { if (mounted) setAvailable(value) })
    return () => { mounted = false }
  }, [session])
  return available ? session : undefined
}

/** Native actions resolve a fixed business file version, never a model-authored local path. */
export function WorkforceNativeFileMenu({
  url,
  locationUrl,
  name,
  downloadUrl,
  downloadName,
  showFolderButton = false,
  mime,
}: {
  readonly url?: string | undefined
  readonly locationUrl?: string | undefined
  readonly name: string
  readonly downloadUrl?: string | undefined
  readonly downloadName?: string | undefined
  readonly showFolderButton?: boolean | undefined
  readonly mime?: string | undefined
}) {
  const session = useWorkforceFileSession()
  const gate = gateAttachment(name, mime)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const locUrl = safeLocationUrl(locationUrl) ?? resolveLocationUrl(url)
  const canReveal = Boolean(session && locUrl)
  const canOpen = Boolean(session && url && gate.canNativeOpen)
  // 安装包明确拒 byte，绝不提供下载项（避免 404）；普通未知格式仍可下载
  const dlUrl = gate.isInstaller ? undefined : (downloadUrl ?? (url ? downloadHref(url) : undefined))

  const invoke = async (action: 'open' | 'reveal'): Promise<void> => {
    if (!session || busy) return
    setOpen(false); setBusy(true); setError(undefined)
    try {
      const result = action === 'reveal'
        ? await revealNativeFile({ locationUrl, url })
        : await openNativeDeliverable(url ?? '', { action: 'open' })
      if (!result.ok) throw new Error(result.message ?? (action === 'open' ? '系统应用打开失败，请检查文件关联或重试' : '资源管理器定位失败，请重试'))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败，请重试')
    } finally { setBusy(false) }
  }

  const triggerDownload = () => {
    if (!dlUrl) return
    setOpen(false)
    const a = document.createElement('a')
    a.href = dlUrl
    a.download = downloadName ?? name
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const items: Array<{ id: string; label: string }> = []
  if (dlUrl !== undefined) {
    items.push({ id: 'download', label: '下载' })
  }
  if (canOpen) {
    items.push({ id: 'open', label: '在系统应用打开' })
  }
  if (canReveal) {
    items.push({ id: 'reveal', label: '在资源管理器中显示' })
  }

  if (items.length === 0 && !showFolderButton) return null

  const onSelect = (id: string) => {
    if (id === 'download') triggerDownload()
    else if (id === 'open' || id === 'reveal') void invoke(id)
  }

  return <>
    <span className={showFolderButton ? css.nativeActionGroup : css.nativeActions}>
      {showFolderButton && (
        <button
          type="button"
          className={css.nativeFolderBtn}
          aria-label={`在资源管理器中显示 ${name}`}
          title={canReveal ? '在资源管理器中显示' : session ? '无法获取本地文件路径' : '在资源管理器中显示（需桌面版支持）'}
          disabled={busy || !canReveal}
          onClick={() => void invoke('reveal')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
      )}
      <Menu
        label={`更多操作 ${name}`}
        open={open}
        onOpenChange={setOpen}
        align="end"
        trigger={
          <button
            type="button"
            className={css.nativeTrigger}
            aria-label={`更多操作 ${name}`}
            disabled={busy || items.length === 0}
          >
            {busy ? '…' : '⋯'}
          </button>
        }
        items={items.map(item => ({ ...item, onSelect: () => onSelect(item.id) }))}
      />
    </span>
    {error && <span className={css.nativeError} role="alert">{error}</span>}
  </>
}
export type AttachmentKind = 'image' | 'video' | 'audio' | 'pdf' | 'file'

/**
 * 成果卡标题/版本行的「打开」直接触发系统应用打开，与 WorkforceNativeFileMenu 同一条链路：
 * 站内成果 URL → /location 解析宿主真实路径 → openWorkspacePath。
 * 桌面会话不可用（web 版）时抛错，由调用方退回下载。
 */
export async function openNativeDeliverable(
  url: string,
  options?: { readonly action?: 'open' | 'reveal' }
): Promise<{ readonly ok: boolean; readonly message?: string }> {
  if (options?.action === 'reveal') {
    return revealNativeFile(url)
  }
  if (!fileSession) return { ok: false, message: '当前环境不支持系统应用打开，可改用下载' }
  let supported = nativeOpenSupported()
  if (supported === undefined) {
    supported = await (desktopAvailable ?? Promise.resolve(false))
    desktopSupported = supported
  }
  if (!supported) return { ok: false, message: '当前环境不支持系统应用打开，可改用下载' }

  const locUrl = resolveLocationUrl(url)
  if (!locUrl) return { ok: false, message: '无法定位成果文件，可改用下载' }

  try {
    const file = new URL(locUrl, window.location.href)
    if (file.origin !== window.location.origin) {
      return { ok: false, message: '无法定位成果文件，可改用下载' }
    }
    const response = await fetch(file.pathname + file.search, { cache: 'no-store' })
    const body: { readonly ok: boolean; readonly data?: { readonly path?: string }; readonly error?: { readonly message?: string } } = await response.json()
    if (!response.ok || !body.ok || typeof body.data?.path !== 'string') {
      return { ok: false, message: body.error?.message ?? '无法定位成果文件，可改用下载' }
    }
    const realName = body.data.path.split(/[\\/]/).pop() ?? ''
    const gate = gateAttachment(realName)
    // 安装包、脚本与未知格式严格禁止系统应用打开直接运行，仅允许在资源管理器中显示（reveal）
    if (!gate.canNativeOpen) {
      const revealResult = await fileSession.openWorkspacePath({ path: body.data.path, action: 'reveal' })
      if (!revealResult.ok) return { ok: false, message: '资源管理器定位失败，请改用下载' }
      return { ok: true, message: '此格式不可直接运行，已在资源管理器中显示' }
    }
    const result = await fileSession.openWorkspacePath({ path: body.data.path })
    if (!result.ok) return { ok: false, message: '系统应用打开失败，请检查文件关联或改用下载' }
    return { ok: true }
  } catch {
    return { ok: false, message: '系统应用打开失败，可改用下载' }
  }
}

/**
 * 独立校验 locationUrl：仅允许归一化后的 tasks/deliverables/location 或 threads/files/location。
 * 绝不放行任意本地路径、file: 协议或 UNC。
 */
export function safeLocationUrl(value?: string): string | undefined {
  if (!value || typeof value !== 'string') return undefined
  if (/[\\\s]/.test(value)) return undefined
  if (!value.startsWith('/') || value.startsWith('//')) return undefined
  try {
    const url = new URL(value, 'http://localhost')
    return /^\/wb\/api\/workforce\/(?:tasks\/[^/]+\/deliverables\/[^/]+|threads\/[^/]+\/files\/[^/]+)\/location(?:\?[^#]*)?(?:#.*)?$/.test(url.pathname + url.search + url.hash) ? value : undefined
  } catch { return undefined }
}

/** 从合法的业务文件 URL 派生对应的 location 路由；非此类路由返回 undefined。 */
export function resolveLocationUrl(url?: string): string | undefined {
  if (!url) return undefined
  const safe = safeAttachmentUrl(url)
  if (!safe) return undefined
  try {
    const parsed = new URL(safe, 'http://localhost')
    if (/^\/wb\/api\/workforce\/(?:tasks\/[^/]+\/deliverables\/[^/]+|threads\/[^/]+\/files\/[^/]+)$/.test(parsed.pathname)) {
      parsed.pathname += '/location'
      return parsed.pathname + parsed.search
    }
    return undefined
  } catch { return undefined }
}

/**
 * 鉴权业务文件在资源管理器中显示（reveal）：
 * 优先使用 safeLocationUrl 校验的 locationUrl，或从 safeAttachmentUrl 的业务 route 派生 /location。
 * 调 /location 获取宿主磁盘真实路径 → openWorkspacePath({ action: 'reveal' })。
 * web 环境、无权限或非业务路由返回明确错误，不伪造、不静默下载。
 */
export async function revealNativeFile(
  target: string | { readonly locationUrl?: string | undefined; readonly url?: string | undefined }
): Promise<{ readonly ok: boolean; readonly message?: string }> {
  const locUrl = typeof target === 'string'
    ? (safeLocationUrl(target) ?? resolveLocationUrl(target))
    : (safeLocationUrl(target.locationUrl) ?? resolveLocationUrl(target.url))

  if (!locUrl) {
    return { ok: false, message: '无法获取本地文件路径，请改用下载' }
  }

  if (!fileSession) {
    return { ok: false, message: '当前环境不支持在资源管理器中查看，请使用下载' }
  }
  let supported = nativeOpenSupported()
  if (supported === undefined) {
    supported = await (desktopAvailable ?? Promise.resolve(false))
    desktopSupported = supported
  }
  if (!supported) {
    return { ok: false, message: '当前环境不支持在资源管理器中查看，请使用下载' }
  }

  try {
    const file = new URL(locUrl, window.location.href)
    if (file.origin !== window.location.origin) {
      return { ok: false, message: '无法定位文件在系统中的路径，请改用下载' }
    }
    const response = await fetch(file.pathname + file.search, { cache: 'no-store' })
    const body: { readonly ok: boolean; readonly data?: { readonly path?: string }; readonly error?: { readonly message?: string } } = await response.json()
    if (!response.ok || !body.ok || typeof body.data?.path !== 'string') {
      return { ok: false, message: body.error?.message ?? '无法获取本地文件路径，请改用下载' }
    }
    const result = await fileSession.openWorkspacePath({ path: body.data.path, action: 'reveal' })
    if (!result.ok) {
      return { ok: false, message: '资源管理器定位失败，请重试' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: '资源管理器定位失败，请重试' }
  }
}

/** Only web destinations and this application's authenticated file routes are renderable. */
export function safeAttachmentUrl(value: string): string | undefined {
  if (/[\\\s]/.test(value)) return undefined
  if (value.startsWith('/') && !value.startsWith('//')) {
    // 站内路径先归一化再跑白名单：URL 解析折叠 `..`/`%2e` 段，折叠后不匹配即拒绝。
    const url = new URL(value, 'http://localhost')
    return /^\/wb\/api\/workforce\/(?:materials\/[^/]+\/[^/]+|tasks\/[^/]+\/deliverables\/[^/]+|threads\/[^/]+\/files\/[^/]+)(?:\?[^#]*)?(?:#.*)?$/.test(url.pathname + url.search + url.hash) ? value : undefined
  }
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch { return undefined }
}

export function attachmentName(url: string): string {
  try { return decodeURIComponent(new URL(url, 'http://localhost').pathname.split('/').pop() ?? '') || '附件' } catch { return '附件' }
}

/** Office/压缩等真实二进制容器：能下载或交给系统应用打开，但不能按文本预览。 */
const BINARY_EXTENSIONS = /^(?:xls|xlsm|xlsx|xlt|xltx|doc|docm|docx|dot|dotx|ppt|pptm|pptx|pps|ppsx|pot|potx|odt|ods|odp|rtf|epub|zip|rar|7z|tar|gz|bz2|xz)$/i
/** Office/压缩 mime：按真实类别前缀匹配，OOXML/ODF/宏格式的完整子类型由 `(?:\..*)?` 吸收。PDF 不在此列。 */
const BINARY_MIME = /^(?:application\/(?:vnd\.(?:openxmlformats-officedocument|oasis\.opendocument|ms-excel|ms-powerpoint)|msword|rtf|epub\+zip|zip|x-7z-compressed|x-rar-compressed|gzip|x-tar|x-bzip2|x-xz)(?:\..*)?|text\/rtf)$/i

/** 脚本文件：不在对话、消息链接与时间线中展示。 */
const SCRIPT_EXTENSIONS = /^(?:cmd|bat|csh|ps1|psm1|psd1|sh|bash|zsh|fish)$/i
/** 可执行安装包：只允许在资源管理器中显示或下载，不在此执行、不预览。 */
const INSTALLER_EXTENSIONS = /^(?:aab|apk|appimage|appx|dmg|deb|exe|ipa|msi|msix|pkg|rpm|snap)$/i
/** Office 文档扩展名：交给系统应用打开，不内联预览。 */
const OFFICE_EXTENSIONS = /^(?:xls|xlsm|xlsx|xlt|xltx|doc|docm|docx|dot|dotx|ppt|pptm|pptx|pps|ppsx|pot|potx|odt|ods|odp|rtf|epub)$/i
const OFFICE_MIME = /^(?:application\/(?:vnd\.(?:openxmlformats-officedocument|oasis\.opendocument|ms-excel|ms-powerpoint)|msword|rtf|epub\+zip)(?:\..*)?|text\/rtf)$/i

/** 去版本后缀与 query/hash：判定只看基础文件名。 */
function normalizedName(name: string): string {
  return name.replace(/\s+v\d+$/i, '').replace(/[?#].*$/, '')
}

function extensionOf(name: string): string | undefined {
  const clean = normalizedName(name)
  return clean.includes('.') ? clean.split('.').pop()!.toLowerCase() : undefined
}

function normalizeMimeValue(mime?: string): string | undefined {
  const value = mime?.replace(/;.*$/, '').trim().toLowerCase()
  return value ? value : undefined
}

/**
 * 附件的集中格式门控：展示、预览、系统应用打开、外部显示四个能力由这里唯一决定。
 * 判定按归一化后的扩展名与 mime，query/hash 与版本后缀不影响；PDF 与图片保持可预览。
 */
export interface AttachmentGate {
  /** 是否在对话/时间线中展示（脚本为 false）。 */
  readonly visible: boolean
  /** 是否可应用内真实预览（图片/视频/音频/PDF/文本/Markdown）。 */
  readonly canPreview: boolean
  /** 是否可交给系统应用打开（Office 等；桌面会话下生效）。 */
  readonly canNativeOpen: boolean
  /** 只允许外部显示/下载：不预览、不交给系统应用执行（安装包、压缩包与未知格式）。 */
  readonly externalOnly: boolean
  /** 是否为可执行安装包（仅允许 reveal，严格禁止 byte 下载与 open）。 */
  readonly isInstaller?: boolean
  /** 给用户的说明，能力受限时展示。 */
  readonly note?: string
}

export function gateAttachment(name: string, mime?: string): AttachmentGate {
  const extension = extensionOf(name)
  const value = normalizeMimeValue(mime)
  if (extension && SCRIPT_EXTENSIONS.test(extension)) {
    return { visible: false, canPreview: false, canNativeOpen: false, externalOnly: true, note: '脚本文件不在对话中展示' }
  }
  if (extension && INSTALLER_EXTENSIONS.test(extension)) {
    return { visible: true, canPreview: false, canNativeOpen: false, externalOnly: true, isInstaller: true, note: '安装包不会在此打开或执行，请在资源管理器中查看' }
  }
  const office = (extension !== undefined && OFFICE_EXTENSIONS.test(extension)) || (value !== undefined && OFFICE_MIME.test(value))
  if (office) {
    return { visible: true, canPreview: false, canNativeOpen: true, externalOnly: false, note: '此格式不支持在线预览，用系统应用打开' }
  }
  const media = value !== undefined && (value.startsWith('image/') || value.startsWith('video/') || value.startsWith('audio/') || value === 'application/pdf')
  const mediaExt = extension !== undefined && /^(?:png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|mov|m4v|mp3|wav|m4a|ogg|flac|aac|pdf)$/i.test(extension)
  if (media || mediaExt) {
    return { visible: true, canPreview: true, canNativeOpen: true, externalOnly: false }
  }
  if ((value !== undefined && value.startsWith('text/')) || (extension !== undefined && TEXT_EXTENSIONS.test(extension))) {
    return { visible: true, canPreview: true, canNativeOpen: true, externalOnly: false }
  }
  return { visible: true, canPreview: false, canNativeOpen: false, externalOnly: true, note: '此格式不在此打开，请在资源管理器中查看或下载' }
}

/**
 * 附件分类：图片/视频/音频/PDF 之外，其余按扩展名或 mime 区分「可按文本预览」与「真实二进制」。
 * 二进制容器（Office 文档、压缩包）内容不是文本，送 fetch().text() 只会得到乱码。
 */
export function attachmentKind(url: string, mime?: string): AttachmentKind {
  const normMime = normalizeMimeValue(mime)
  const clean = normalizedName(url.includes('/') ? attachmentName(url) : url)
  const extension = extensionOf(clean)
  if (normMime?.startsWith('image/') || (extension !== undefined && /^(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(extension))) return 'image'
  if (normMime?.startsWith('video/') || (extension !== undefined && /^(?:mp4|webm|mov|m4v)$/i.test(extension))) return 'video'
  if (normMime?.startsWith('audio/') || (extension !== undefined && /^(?:mp3|wav|m4a|ogg|flac|aac)$/i.test(extension))) return 'audio'
  return normMime === 'application/pdf' || extension === 'pdf' ? 'pdf' : 'file'
}

/** 该附件是否含真实二进制容器（Office/压缩），内容不可当文本渲染。 */
export function isBinaryContainer(name: string, mime?: string): boolean {
  if (mime && BINARY_MIME.test(mime.replace(/;.*$/, '').trim())) return true
  const cleanName = name.replace(/\s+v\d+$/i, '')
  const extension = cleanName.includes('.') ? cleanName.split('.').pop() : undefined
  return extension ? BINARY_EXTENSIONS.test(extension) : false
}

export function isAttachmentUrl(url: string): boolean {
  return /^\/wb\/api\/workforce\/(materials|tasks|threads)\//.test(url)
    || /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|mov|m4v|mp3|wav|m4a|ogg|flac|aac|docx?|xlsx?|pptx?|pdf|csv|zip|txt|md|json|tar|gz)(?:[?#]|$)/i.test(url)
}

export function formatFileSize(size?: number): string {
  return size !== undefined && Number.isFinite(size) && size >= 0 ? fileSizeText(size) : '大小未知'
}

interface PreviewImage { readonly src: string; readonly alt: string }
const LIGHTBOX_LABELS = { dialog: '图片预览', close: '关闭图片预览' }
const READ_WINDOW = 40
const READ_LABELS: ReadBlockLabels = {
  codeLabel: '文本', wrapLabel: '自动换行', unwrapLabel: '原始列',
  window: (shown, total) => `显示 ${shown} / ${total} 行`,
  copy: '复制', copied: '已复制',
  collapseAria: '收起预览', expandAria: hidden => `展开剩余 ${hidden} 行`,
  collapse: '收起', expand: hidden => `展开剩余 ${hidden} 行`,
}
/** 模块级大小缓存：轮询重渲染与多张卡片共享同一 url 只发一次 HEAD。 */
const fileSizeCache = new Map<string, number>()
/** 每张同 url 卡片订阅共享探测结果；一张卸载不取消其他卡片的请求。 */
const fileSizePending = new Map<string, Promise<number | undefined>>()
/** 与宿主 material-files 的可读文本扩展名对齐：能否在线预览按扩展名决定。 */
const TEXT_EXTENSIONS = /^(?:txt|md|markdown|csv|tsv|json|xml|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|hpp|cs|swift|kt|php|sh|bash|ps1|yaml|yml|toml|ini|log)$/i

function fmtInfoTime(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 成果链接的核对信息（由调用方按当前任务快照解析，解析不到就不显示图标）。 */
export interface DeliverableInfo {
  readonly version: number
  readonly authorName: string
  readonly published: boolean
  readonly charCount: number
  readonly createdAt: string
}

export function isTextFile(url: string, name?: string): boolean {
  const cleanName = name ? name.replace(/\s+v\d+$/i, '') : ''
  const extension = (cleanName.includes('.') ? cleanName.split('.').pop() : attachmentName(url).split('.').pop())?.toLowerCase() ?? ''
  return TEXT_EXTENSIONS.test(extension) || /\.md(?:$|\?)/i.test(url) || /\.markdown(?:$|\?)/i.test(url)
}

/** 具备 WorkforceFilePreview 在线预览能力的类型（图片、视频、音频、PDF、文本、Markdown）。 */
export function isPreviewableAttachment(url: string, name?: string, mime?: string): boolean {
  return gateAttachment(name ?? attachmentName(url), mime ?? undefined).canPreview
}

/**
 * 所有入口统一的「打开」能力判定：能内联预览走弹窗；可交给系统应用走原生路径；
 * 其余（安装包、压缩包、未知格式）只允许外部显示或下载。
 * 一个文件只对应一个主动作，不出现预览/打开两个并列按钮。
 */
export function attachmentOpenMode(url: string, name?: string, mime?: string): 'preview' | 'native' | 'external' {
  const gate = gateAttachment(name ?? attachmentName(url), mime ?? undefined)
  if (gate.canPreview) return 'preview'
  return gate.canNativeOpen ? 'native' : 'external'
}
function downloadHref(url: string): string {
  if (!url.startsWith('/wb/api/workforce/')) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}download=1`
}

/** 附件与成果卡共用的预览弹窗：图片走 lightbox，PDF/文本/Markdown 走有界自适应弹窗。 */
export function WorkforceFilePreview({ url, name, onClose, mime }: {
  readonly url: string
  readonly name: string
  readonly onClose: () => void
  readonly mime?: string | undefined
}) {
  const cleanName = normalizedName(name)
  const normMime = normalizeMimeValue(mime)
  const kind = attachmentKind(cleanName.includes('.') ? cleanName : url, normMime)
  const close = useCallback(() => onClose(), [onClose])
  if (kind === 'image') return <WorkforceImageGallery images={[{ src: url, alt: name }]} initialIndex={0} onClose={close} />

  const extension = extensionOf(cleanName) ?? (extensionOf(attachmentName(url)) ?? 'file')
  const isMarkdown = extension === 'md' || extension === 'markdown' || /\.md(?:$|\?)/i.test(url) || /\.markdown(?:$|\?)/i.test(url)

  return (
    <Modal
      open
      headless
      title={name}
      className={`${tokenScopeClass} ${css.previewDialog}`}
      onClose={close}
    >
      <div
        className={css.previewContainer}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            close()
          }
        }}
      >
        <div className={css.previewHeader}>
          <div className={css.previewTitleRow}>
            <span className={css.previewIcon} data-extension={extension}>
              <FileTypeIcon path={cleanName || name} size={20} />
            </span>
            <h2 className={css.previewTitle} title={name}>{name}</h2>
            {isMarkdown && <span className={css.previewBadge}>Markdown</span>}
          </div>
          <button
            type="button"
            className={css.previewCloseBtn}
            aria-label="关闭文件预览"
            title="关闭 (Esc)"
            onClick={close}
          >
            <IconCloseOutlineRegular size={16} />
          </button>
        </div>
        <div className={css.previewBody} data-kind={kind} tabIndex={0}>
          {kind === 'pdf' ? (
            <FilePdfPreview url={url} name={name} mime={mime} />
          ) : kind === 'video' ? (
            <FileVideoPreview url={url} name={name} mime={mime} />
          ) : kind === 'audio' ? (
            <FileAudioPreview url={url} name={name} mime={mime} />
          ) : (
            <FileTextPreview url={url} name={name} mime={mime} />
          )}
        </div>
        <div className={css.previewFooter}>
          <div className={css.previewFooterInfo}>
            <a
              className={css.previewDownloadLink}
              href={downloadHref(url)}
              download={name}
              target="_blank"
              rel="noopener noreferrer"
            >
              下载文件
            </a>
          </div>
          <button type="button" className={css.previewFooterCloseBtn} onClick={close}>
            关闭
          </button>
        </div>
      </div>
    </Modal>
  )
}

const MAX_PDF_BYTES = 32 * 1024 * 1024

/**
 * PDF 预览组件：
 * - 仅对 safeAttachmentUrl 校验通过的安全业务 URL 发起 fetch；
 * - 检查 response.ok，服务端实际响应 Content-Type clean MIME 必须为 application/pdf（严格校验，不接受 octet 或声明 mime 回退）；
 * - 32MiB 大小门控保护；
 * - 检查文件前 5 字节 magic bytes 必须为 '%PDF-' (0x25, 0x50, 0x44, 0x46, 0x2D)，拒绝 HTML/脚本等伪装；
 * - 校验通过后生成 application/pdf Blob URL，交由浏览器原生 PDF 插件渲染，无 sandbox 避免 Chromium/Edge 插件拦截；
 * - 从不将 iframe 导航至未经真实字节核验的原 URL；
 * - 支持 URL 变更与卸载自动 AbortController 取消与 URL.revokeObjectURL 释放内存；
 * - 校验失败退到明确的提示与下载入口。
 */
function FilePdfPreview({ url, name }: {
  readonly url: string
  readonly name: string
  readonly mime?: string | undefined
}) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; blobUrl: string } | { status: 'failed'; message: string }>({ status: 'loading' })

  useEffect(() => {
    setState({ status: 'loading' })

    const safeUrl = safeAttachmentUrl(url)
    if (!safeUrl) {
      setState({ status: 'failed', message: 'PDF 来源链接不符合安全策略，无法在此预览。' })
      return
    }

    const controller = new AbortController()
    let activeBlobUrl: string | undefined

    void (async () => {
      try {
        const response = await fetch(safeUrl, {
          signal: controller.signal,
          redirect: 'error',
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const rawType = response.headers.get('content-type') ?? ''
        const cleanType = rawType.replace(/;.*$/, '').trim().toLowerCase()
        if (cleanType !== 'application/pdf') {
          throw new Error('服务端响应 MIME 不是 application/pdf')
        }

        const chunks: Uint8Array[] = []
        let totalBytes = 0
        const reader = response.body?.getReader()

        if (reader) {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) {
              totalBytes += value.byteLength
              if (totalBytes > MAX_PDF_BYTES) {
                await reader.cancel()
                throw new Error('PDF 超过 32MiB 限制')
              }
              chunks.push(value)
            }
          }
        } else {
          const buffer = await response.arrayBuffer()
          totalBytes = buffer.byteLength
          if (totalBytes > MAX_PDF_BYTES) throw new Error('PDF 超过 32MiB 限制')
          chunks.push(new Uint8Array(buffer))
        }

        let isPdfMagic = false
        if (totalBytes >= 5) {
          const head = new Uint8Array(5)
          let copied = 0
          for (const chunk of chunks) {
            const need = 5 - copied
            const take = Math.min(need, chunk.byteLength)
            head.set(chunk.subarray(0, take), copied)
            copied += take
            if (copied === 5) break
          }
          isPdfMagic = head[0] === 0x25 && // %
            head[1] === 0x50 && // P
            head[2] === 0x44 && // D
            head[3] === 0x46 && // F
            head[4] === 0x2d    // -
        }

        if (!isPdfMagic) {
          throw new Error('文件头不是合法 PDF 魔数')
        }

        const blob = new Blob(chunks as BlobPart[], { type: 'application/pdf' })
        activeBlobUrl = URL.createObjectURL(blob)
        if (!controller.signal.aborted) {
          setState({ status: 'ready', blobUrl: activeBlobUrl })
        } else {
          URL.revokeObjectURL(activeBlobUrl)
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          const msg = err instanceof Error && err.message.includes('32MiB')
            ? 'PDF 文件大小超过 32MiB，请下载后在系统应用中查看。'
            : 'PDF 文件验证失败或格式不正确，可直接下载查看。'
          setState({ status: 'failed', message: msg })
        }
      }
    })()

    return () => {
      controller.abort()
      if (activeBlobUrl) {
        URL.revokeObjectURL(activeBlobUrl)
      }
    }
  }, [url])

  if (state.status === 'loading') {
    return <p className={css.textStatus} role="status">正在加载 PDF 预览…</p>
  }

  if (state.status === 'failed') {
    return (
      <div className={css.mediaErrorContainer}>
        <p className={css.textStatus}>{state.message}</p>
        <a className={css.previewDownloadLink} href={downloadHref(url)} download={name} target="_blank" rel="noopener noreferrer">
          下载文件
        </a>
      </div>
    )
  }

  return (
    <iframe
      className={css.pdfFrame}
      src={state.blobUrl}
      title={`PDF 预览 ${name}`}
    />
  )
}

function FileVideoPreview({ url, name, mime }: {
  readonly url: string
  readonly name: string
  readonly mime?: string | undefined
}) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div className={css.mediaErrorContainer}>
        <p className={css.textStatus}>视频在线播放失败，可直接下载或在系统应用中打开查看。</p>
        <a className={css.previewDownloadLink} href={downloadHref(url)} download={name} target="_blank" rel="noopener noreferrer">
          下载视频文件
        </a>
      </div>
    )
  }
  return (
    <div className={css.videoPreviewWrapper}>
      <video
        className={css.previewVideo}
        controls
        preload="metadata"
        playsInline
        aria-label={name}
        onError={() => setFailed(true)}
      >
        <source src={url} type={mime || undefined} />
        您的浏览器不支持内联视频播放。
      </video>
    </div>
  )
}

function FileAudioPreview({ url, name, mime }: {
  readonly url: string
  readonly name: string
  readonly mime?: string | undefined
}) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div className={css.mediaErrorContainer}>
        <p className={css.textStatus}>音频在线播放失败，可直接下载或在系统应用中打开收听。</p>
        <a className={css.previewDownloadLink} href={downloadHref(url)} download={name} target="_blank" rel="noopener noreferrer">
          下载音频文件
        </a>
      </div>
    )
  }
  return (
    <div className={css.audioPreviewWrapper}>
      <audio
        className={css.previewAudio}
        controls
        preload="metadata"
        aria-label={name}
        onError={() => setFailed(true)}
      >
        <source src={url} type={mime || undefined} />
        您的浏览器不支持内联音频播放。
      </audio>
    </div>
  )
}

/** 文本弹窗正文：md 按 Markdown 渲染，其余文本进 ReadBlock；加载失败或二进制容器退到提示，绝不按 UTF-8 读取二进制。 */
function FileTextPreview({ url, name, mime }: {
  readonly url: string
  readonly name: string
  readonly mime?: string | undefined
}) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'text'; text: string } | { status: 'failed' }>({ status: 'loading' })
  const cleanName = name.replace(/\s+v\d+$/i, '')
  const extension = (cleanName.includes('.') ? cleanName.split('.').pop() : attachmentName(url).split('.').pop())?.toLowerCase() ?? ''
  const isMarkdown = extension === 'md' || extension === 'markdown' || /\.md(?:$|\?)/i.test(url) || /\.markdown(?:$|\?)/i.test(url)
  const kind = attachmentKind(cleanName.includes('.') ? cleanName : url, mime)
  // Office/压缩/安装包/音视频等二进制容器不按文本拉取，避免 fetch().text() 乱码
  const isBinary = isBinaryContainer(name, mime) || kind === 'video' || kind === 'audio' || kind === 'image' || kind === 'pdf'
  useEffect(() => {
    if (isBinary) return
    const controller = new AbortController()
    setState({ status: 'loading' })
    void fetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(String(response.status))
      const text = await response.text()
      setState({ status: 'text', text })
    }).catch(() => { if (!controller.signal.aborted) setState({ status: 'failed' }) })
    return () => controller.abort()
  }, [url, name, isBinary])
  if (isBinary) return <p className={css.textStatus}>此格式不支持在线文本预览，可用「⋯」菜单在系统应用中打开或下载。</p>
  if (state.status === 'loading') return <p className={css.textStatus} role="status">正在载入预览…</p>
  if (state.status === 'failed' || (!isTextFile(url, name) && !isMarkdown)) return <p className={css.textStatus}>此文件不支持在线预览，可直接打开或下载。</p>
  if (isMarkdown) return <div className={css.markdownBody}><WorkforceMessageText text={state.text} employees={[]} onDm={() => {}} /></div>
  const lines = state.text.split('\n').map((text, index) => ({ number: index + 1, text }))
  return <ReadBlock
    label={name}
    lines={lines}
    totalLines={lines.length}
    labels={READ_LABELS}
    maxLines={READ_WINDOW}
    lang={extension || attachmentName(url).split('.').pop()?.toLowerCase()}
  />
}


/** The host owns Escape/focus restoration; this owner adds same-message navigation. */
export function WorkforceImageGallery({ images, initialIndex, onClose }: {
  readonly images: readonly PreviewImage[]
  readonly initialIndex: number
  readonly onClose: () => void
}) {
  const [index, setIndex] = useState(initialIndex)
  const move = useCallback((delta: number) => setIndex(value => (value + delta + images.length) % images.length), [images.length])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        move(event.key === 'ArrowLeft' ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [move])
  const image = images[index]
  if (!image) return null
  return <>
    <ImageLightbox src={image.src} alt={image.alt} labels={LIGHTBOX_LABELS} onClose={onClose} />
    {images.length > 1 && createPortal(<div className={`${tokenScopeClass} ${css.galleryControls}`}>
      <button type="button" aria-label="上一张图片" onClick={() => move(-1)}>‹</button>
      <span aria-live="polite">{index + 1} / {images.length}</span>
      <button type="button" aria-label="下一张图片" onClick={() => move(1)}>›</button>
    </div>, document.body)}
  </>
}

/**
 * 正文内轻量文件链接：
 * 有本轮附件真源时，正文中的文件引用仅渲染为普通可点击文件名（点击仍按格式主能力触发 preview / native / external）；
 * web 端 Office/未知文件保留原 URL 原版本直接下载出口，安装包严格限制外部显示绝不提供下载。
 * 错误信息明确可见展示。
 */
export function WorkforceFileLink({
  url: authoredUrl,
  locationUrl: authoredLocationUrl,
  name,
  mime,
  sizeBytes: _sizeBytes,
  children,
}: {
  readonly url?: string | undefined
  readonly locationUrl?: string | undefined
  readonly name?: string | undefined
  readonly mime?: string | undefined
  readonly sizeBytes?: number | undefined
  readonly children?: ReactNode
}) {
  const url = authoredUrl ? safeAttachmentUrl(authoredUrl) : undefined
  const locationUrl = safeLocationUrl(authoredLocationUrl)
  const filename = name || (url ? attachmentName(url) : (locationUrl ? attachmentName(locationUrl) : '附件'))
  const kind = url ? attachmentKind(url, mime) : 'file'
  const [preview, setPreview] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const session = useWorkforceFileSession()

  const close = useCallback(() => setPreview(false), [])
  const gate = gateAttachment(filename, mime)
  if (!gate.visible) return null

  const mode = attachmentOpenMode(url ?? '', filename, mime)
  const locTarget = locationUrl ?? resolveLocationUrl(url)
  const canReveal = Boolean(session && locTarget)
  const canNative = Boolean(session && url)

  const triggerDownload = (dlUrl: string) => {
    const href = downloadHref(dlUrl)
    const a = document.createElement('a')
    a.href = href
    a.download = filename
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const handleAction = async () => {
    if (actionBusy) return
    setActionError(undefined)

    if (mode === 'preview' && url) {
      setPreview(true)
      return
    }

    if (gate.isInstaller) {
      if (canReveal) {
        setActionBusy(true)
        try {
          const result = await revealNativeFile({ locationUrl, url })
          if (!result.ok) setActionError(result.message || '在资源管理器中定位失败')
        } catch {
          setActionError('在资源管理器中定位失败')
        } finally {
          setActionBusy(false)
        }
      } else {
        setActionError('安装包仅支持在桌面版资源管理器中查看')
      }
      return
    }

    if (mode === 'native') {
      if (canNative) {
        setActionBusy(true)
        try {
          const result = await openNativeDeliverable(url ?? '', { action: 'open' })
          if (!result.ok) {
            setActionError(result.message || '系统应用打开失败，正在下载')
            if (url) triggerDownload(url)
          }
        } catch {
          setActionError('系统应用打开失败，正在下载')
          if (url) triggerDownload(url)
        } finally {
          setActionBusy(false)
        }
      } else if (url) {
        triggerDownload(url)
      } else {
        setActionError('无法获取下载链接')
      }
      return
    }

    // external (非安装包)
    if (canReveal) {
      setActionBusy(true)
      try {
        const result = await revealNativeFile({ locationUrl, url })
        if (!result.ok) {
          setActionError(result.message || '定位失败，正在下载')
          if (url) triggerDownload(url)
        }
      } catch {
        setActionError('在资源管理器中定位失败，正在下载')
        if (url) triggerDownload(url)
      } finally {
        setActionBusy(false)
      }
    } else if (url) {
      triggerDownload(url)
    } else {
      setActionError('无法获取下载链接')
    }
  }

  const label = children || filename
  const ext = extensionOf(filename) ?? 'file'
  const actionTitle = actionError
    ? actionError
    : mode === 'preview'
      ? `预览 ${filename}`
      : gate.isInstaller
        ? (canReveal ? `在资源管理器中查看 ${filename}` : `需桌面版支持查看 ${filename}`)
        : mode === 'native'
          ? (canNative ? `系统应用打开 ${filename}` : `下载 ${filename}`)
          : (canReveal ? `在资源管理器中查看 ${filename}` : `下载 ${filename}`)

  return (
    <span className={css.fileLinkWrapper}>
      <button
        type="button"
        className={css.fileLink}
        data-file-link="true"
        data-kind={kind}
        title={actionTitle}
        disabled={actionBusy}
        onClick={() => void handleAction()}
      >
        <span className={css.fileLinkIcon} data-extension={ext}>
          <FileTypeIcon path={filename} size={15} />
        </span>
        <span className={css.fileLinkText}>{label}</span>
      </button>
      {actionError && (
        <span className={css.fileLinkError} role="alert">
          ({actionError})
        </span>
      )}
      {preview && url && <WorkforceFilePreview url={url} name={filename} mime={mime} onClose={close} />}
    </span>
  )
}

export function WorkforceAttachment({
  url: authoredUrl,
  locationUrl: authoredLocationUrl,
  name,
  sizeBytes,
  mime,
  onImageOpen,
  deliverableInfo,
  compact = false,
}: {
  readonly url?: string | undefined
  readonly locationUrl?: string | undefined
  readonly name?: string | undefined
  readonly sizeBytes?: number | undefined
  readonly mime?: string | undefined
  readonly onImageOpen?: ((url: string) => void) | undefined
  /** 成果核对信息：给了就在「打开」左侧显示信息图标与 tooltip。 */
  readonly deliverableInfo?: DeliverableInfo | undefined
  /** 紧凑模式（附件栏网格内）：收紧大 inline 媒体展示，以文件卡展示并在点击预览时弹窗展开，避免网格被撑高。 */
  readonly compact?: boolean | undefined
}) {
  const url = authoredUrl ? safeAttachmentUrl(authoredUrl) : undefined
  const locationUrl = safeLocationUrl(authoredLocationUrl)
  const filename = name || (url ? attachmentName(url) : (locationUrl ? attachmentName(locationUrl) : '附件'))
  const kind = url ? attachmentKind(url, mime) : 'file'
  const [size, setSize] = useState(sizeBytes ?? (url === undefined ? undefined : fileSizeCache.get(url)))
  const [preview, setPreview] = useState(false)
  const [mediaError, setMediaError] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const session = useWorkforceFileSession()

  const close = useCallback(() => setPreview(false), [])

  useEffect(() => {
    setMediaError(false)
    setActionError(undefined)
    setSize(sizeBytes ?? (url === undefined ? undefined : fileSizeCache.get(url)))
    if (sizeBytes !== undefined || !url?.startsWith('/wb/api/workforce/')) return
    if (fileSizeCache.has(url)) return
    let pending = fileSizePending.get(url)
    if (pending === undefined) {
      pending = fetch(url, { method: 'HEAD' }).then(response => {
        const length = response.headers.get('content-length')
        if (!response.ok || length === null || !Number.isFinite(Number(length))) return undefined
        const value = Number(length)
        fileSizeCache.set(url, value)
        return value
      }).catch(() => undefined).finally(() => {
        fileSizePending.delete(url)
      })
      fileSizePending.set(url, pending)
    }
    let mounted = true
    void pending.then(value => { if (mounted && value !== undefined) setSize(value) })
    return () => { mounted = false }
  }, [url, sizeBytes])

  const gate = gateAttachment(filename, mime)
  // 脚本文件不在对话/时间线中展示
  if (!gate.visible) return null

  let download = url
  if (url?.startsWith('/wb/api/workforce/')) {
    const fileUrl = new URL(url, window.location.href)
    fileUrl.searchParams.set('download', '1')
    download = fileUrl.pathname + fileUrl.search + fileUrl.hash
  }

  const openImage = () => {
    if (!url) return
    onImageOpen ? onImageOpen(url) : setPreview(true)
  }

  const media = !compact && !mediaError && url && gate.canPreview ? (kind === 'image'
    ? <button type="button" className={css.thumbnail} aria-label={`预览图片 ${filename}`} onClick={openImage}>
      <img src={url} alt={filename} loading="lazy" data-message-image onError={() => setMediaError(true)} />
    </button>
    : kind === 'video'
      ? <video className={css.video} src={`${url}${url.includes('#') ? '' : '#t=0.1'}`} controls preload="metadata" playsInline aria-label={filename} onError={() => setMediaError(true)} />
      : kind === 'audio'
        ? <audio className={css.audio} src={url} controls preload="metadata" aria-label={filename} onError={() => setMediaError(true)} />
        : null) : null

  const extension = filename.includes('.') ? filename.split('.').pop()!.toUpperCase() : 'FILE'
  const mode = attachmentOpenMode(url ?? '', filename, mime)

  const locTarget = locationUrl ?? resolveLocationUrl(url)
  const canReveal = Boolean(session && locTarget)

  const handleAction = async (action: 'open' | 'reveal') => {
    if (actionBusy) return
    setActionBusy(true)
    setActionError(undefined)
    try {
      const result = action === 'reveal'
        ? await revealNativeFile({ locationUrl, url })
        : await openNativeDeliverable(url ?? '', { action: 'open' })
      if (!result.ok) {
        setActionError(result.message)
      }
    } catch {
      setActionError(action === 'reveal' ? '在资源管理器中定位失败，请重试' : '系统应用打开失败，请改用下载')
    } finally {
      setActionBusy(false)
    }
  }

  const mainAction = mode === 'preview' && url ? (
    <button
      type="button"
      className={css.mainActionBtn}
      aria-label={kind === 'image' ? `预览图片 ${filename}` : `预览 ${filename}`}
      onClick={() => (kind === 'image' && onImageOpen ? onImageOpen(url) : setPreview(true))}
    >
      {kind === 'image' ? '预览图片' : '预览'}
    </button>
  ) : mode === 'native' && url ? (
    <button type="button" className={css.mainActionBtn} disabled={actionBusy} onClick={() => void handleAction('open')}>打开</button>
  ) : (
    <button
      type="button"
      className={css.mainActionBtn}
      disabled={actionBusy || !canReveal}
      aria-label={`在资源管理器中显示 ${filename}`}
      title={canReveal ? '在资源管理器中显示' : session ? '无法获取本地文件路径' : '需桌面版支持在文件夹中查看'}
      onClick={() => void handleAction('reveal')}
    >
      文件夹
    </button>
  )

  return <span className={css.attachment} data-attachment-kind={kind}>
    {media}
    <span className={css.fileCard}>
      <span className={css.fileIcon} data-extension={extension.toLowerCase()}><FileTypeIcon path={filename} size={28} /></span>
      <span className={css.fileDetails}>
        <span className={css.fileName} title={filename}>{filename}</span>
        <span className={css.fileMeta}>
          {filename.includes('.') ? formatFileSize(size) : `${extension} · ${formatFileSize(size)}`}
          {mediaError ? ' · 播放失败，可打开或下载' : ''}
          {actionError ? ` · ${actionError}` : ''}
        </span>
      </span>
      {gate.note && deliverableInfo === undefined && (
        <Tooltip content={gate.note} side="top" align="end" openOnClick maxWidth={240}>
          <button type="button" className={css.infoIcon} aria-label={gate.note}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" />
            </svg>
          </button>
        </Tooltip>
      )}
      {deliverableInfo !== undefined && (
        <Tooltip
          content={`版本 v${deliverableInfo.version}\n作者 ${deliverableInfo.authorName}\n${deliverableInfo.published ? '最终版' : '草稿'}\n${deliverableInfo.charCount} 字\n${fmtInfoTime(deliverableInfo.createdAt)}`}
          side="top" align="end" openOnClick maxWidth={240}
        >
          <button type="button" className={css.infoIcon} aria-label={`成果信息 v${deliverableInfo.version}`}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" />
            </svg>
          </button>
        </Tooltip>
      )}
      <span className={css.cardActions}>
        {mainAction}
        <WorkforceNativeFileMenu
          url={url}
          locationUrl={locationUrl}
          name={filename}
          downloadUrl={download}
          downloadName={filename}
          mime={mime}
        />
      </span>
    </span>
    {preview && url && <WorkforceFilePreview url={url} name={filename} mime={mime} onClose={close} />}
  </span>
}

/** 一行可展开附件栏的条目：支持 url 与 locationUrl（安装包可仅给 locationUrl）。 */
export interface AttachmentBarItem {
  readonly url?: string | undefined
  readonly locationUrl?: string | undefined
  readonly name?: string | undefined
  readonly sizeBytes?: number | undefined
  readonly mime?: string | undefined
}

/**
 * 一行可展开的附件栏：默认收成一行（图标 + 数量 + 名称摘要），点开才逐条展开。
 * 真实展示这一轮真实生成/下载的可得文件，标明支持格式与实际预览能力。
 * 脚本文件由集中门控隐藏，不计入展示。
 */
export function AttachmentBar({
  items,
  label,
  supportedFormatsHint = true,
}: {
  readonly items: readonly AttachmentBarItem[]
  readonly label?: string | undefined
  readonly supportedFormatsHint?: boolean | undefined
}) {
  const [open, setOpen] = useState(false)
  const visible = items.filter(item => {
    const filename = item.name ?? (item.url ? attachmentName(item.url) : (item.locationUrl ? attachmentName(item.locationUrl) : '附件'))
    return gateAttachment(filename, item.mime).visible
  })
  if (visible.length === 0) return null
  const summary = visible.length === 1
    ? (visible[0]!.name ?? (visible[0]!.url ? attachmentName(visible[0]!.url) : '1 个文件'))
    : `${visible.length} 个文件`

  const colCount = Math.min(visible.length, 3)

  return (
    <div className={css.attachmentBarWrapper}>
      <button
        type="button"
        className={css.attachmentBarToggle}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className={css.fileIcon}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </span>
        <span className={css.attachmentBarTitleRow}>
          <span className={css.fileName}>{label ?? '本轮文件'} · {summary}</span>
          {supportedFormatsHint && (
            <Tooltip
              content="支持格式：图片（PNG、JPG、WEBP、GIF）；视频（MP4、WEBM、MOV）；音频（MP3、WAV）；文档（PDF、MD、TXT、CSV、JSON）；Office（DOCX、XLSX、PPTX 系统应用打开或下载）；安装包（在资源管理器中查看）。脚本文件已隐藏。"
              side="top" align="center" openOnClick maxWidth={280}
            >
              <span
                className={css.infoIcon}
                role="button"
                tabIndex={0}
                aria-label="格式支持说明"
                onClick={e => e.stopPropagation()}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }}
              >
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                  <circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" />
                </svg>
              </span>
            </Tooltip>
          )}
        </span>
        <span className={css.attachmentBarAction}>{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <div
          className={css.attachmentGrid}
          data-count={colCount}
          role="region"
          aria-label={label ?? '本轮文件'}
        >
          {visible.map((item, index) => (
            <WorkforceAttachment
              key={item.url || item.locationUrl || `${item.name}-${index}`}
              url={item.url}
              locationUrl={item.locationUrl}
              name={item.name}
              sizeBytes={item.sizeBytes}
              mime={item.mime}
              compact
            />
          ))}
        </div>
      )}
    </div>
  )
}
