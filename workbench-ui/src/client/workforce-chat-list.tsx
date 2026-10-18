/**
 * WorkforceChatList：微信桌面式会话列表 — channel（群聊）与 DM（私信）混排一列。
 * 置顶在前，其余按最近真实消息时间（频道含其 task thread 的 updatedAt）倒序；
 * 行 = 头像（群聊为成员拼格）+ 名称 + 预览 + 右侧微信式时间 + 未读点。
 * 只做展示视图，不发额外请求。
 */
import { Button, TextInput, Checkbox } from './ui/primitives.ts'
import { memo, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { HostChannel } from './workforce-api.ts'
import type { Employee, Thread, ThreadMessages, WorkforceMessage } from './workforce-types.ts'
import type { AvatarStyle, TypingEffect } from './workforce-prefs.ts'
import type { AvatarMotionState } from './workforce-avatar-motion.ts'
import { WorkforceAvatar } from './workforce-avatar.tsx'
import { ConfirmDialog, WorkforceContextMenu, type ContextMenuSection } from './workforce-context-menu.tsx'
import { cx } from './ui/index.tsx'
import dialogCss from './workforce-channels.module.css'
import css from './workforce-chat-list.module.css'
import { WF } from './workforce-strings.ts'
import { getLocale } from './i18n.ts'
import { stripMarkdown } from './workforce-strip-markdown.ts'
export interface ChatChannelPatch {
  readonly pinned?: boolean | undefined
  readonly groupChatName?: string | null | undefined
  readonly memberIds?: readonly string[] | null | undefined
}

export interface ChatCreateInput {
  readonly name: string
  readonly groupChatName?: string | undefined
  readonly memberIds?: readonly string[] | undefined
}

export interface WorkforceChatListProps {
  readonly channels: readonly HostChannel[]
  readonly threads: readonly Thread[]
  readonly employees: readonly Employee[]
  readonly messages: Readonly<Record<string, ThreadMessages>>
  readonly activeChannelId?: string | undefined
  readonly activeDmEmployeeId?: string | undefined
  readonly avatarStyle?: AvatarStyle | undefined
  readonly typingEffect?: TypingEffect | undefined
  /** 员工实时动作（thinking/tool/typing → 头像眼睛），来自 sidebar 的活动汇总。 */
  readonly employeeMotion?: Readonly<Record<string, AvatarMotionState>> | undefined
  readonly onSelectChannel: (channelId: string) => void
  readonly onSelectDm: (employeeId: string) => void
  readonly onCreateChatReq?: ((input: ChatCreateInput) => Promise<string | undefined>) | undefined
  readonly onPatchChannelReq?: ((channelId: string, patch: ChatChannelPatch) => Promise<void>) | undefined
  readonly onMarkChannelReadReq?: ((channelId: string) => Promise<void>) | undefined
  readonly onDuplicateChannelReq?: ((channelId: string) => Promise<void>) | undefined
  readonly onDeleteChannelReq?: ((channelId: string) => Promise<void>) | undefined
  readonly onPatchThreadReq?: ((threadId: string, patch: { readonly pinned?: boolean | undefined; readonly markRead?: boolean | undefined }) => Promise<void>) | undefined
  readonly onPatchEmployeeReq?: ((employeeId: string, patch: { readonly name?: string }) => Promise<void>) | undefined
}

type ChatRow =
  | { readonly kind: 'channel'; readonly key: string; readonly channel: HostChannel; readonly title: string; readonly members: readonly Employee[] }
  | { readonly kind: 'dm'; readonly key: string; readonly employee: Employee; readonly thread?: Thread | undefined; readonly title: string }
  | { readonly kind: 'dm-stale'; readonly key: string; readonly thread: Thread; readonly title: string }

interface RowMeta {
  readonly activityTs: string
  readonly pinned: boolean
  readonly unread: boolean
  readonly unreadCount?: number | undefined
  readonly running: boolean
  readonly subtitle: string
}

/** 微信会话时间：当天 HH:MM；昨天；一周内 星期X；今年 M月D日；更早 YYYY年M月D日。 */
export function chatTimeLabel(ts: string | undefined): string {
  if (ts === undefined || ts === '') {
    ts = new Date().toISOString()
  }
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) {
    const now = new Date()
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  }
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((startOfToday - startOfDate) / 86400000)
  if (days <= 0) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (days === 1) return WF.chatList.yesterday
  if (days < 7 && days > 1) {
    return WF.chatList.weekday(date.getDay())
  }
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${m}-${d}`
}

/** 群聊标题：群名覆盖 → 成员名串（仅显式配了成员时）→ 频道兜底名。 */
export function chatTitleOf(channel: HostChannel, members: readonly Employee[]): string {
  const override = channel.groupChatName?.trim()
  if (override) return override
  if (channel.memberIds !== undefined && members.length > 0) return members.map(m => m.name).join('、')
  return channel.name.trim() || WF.common.groupChat
}

/** 已缓存消息里的最新一条真实正文；与宿主 lastMessageAt 同口径——只认用户/员工普通文本，
 *  工具、提问/审批卡片、系统/提示行、过程文本都不算。未拉过页的会话返回 undefined，不发请求。 */
function lastCachedMessage(threadIds: readonly string[], messages: Readonly<Record<string, ThreadMessages>>): WorkforceMessage | undefined {
  let best: WorkforceMessage | undefined
  for (const threadId of threadIds) {
    for (const message of messages[threadId]?.list ?? []) {
      if (message.intermediate === true) continue
      const hasText = Boolean(message.text && message.text.trim())
      const hasTool = message.tool !== undefined
      const hasQuestion = message.question !== undefined
      const hasApproval = message.approval !== undefined
      const isSystem = message.role === 'system' || message.tip === true
      if (!hasText && !hasTool && !hasQuestion && !hasApproval && !isSystem) continue
      if (best === undefined || message.ts > best.ts) best = message
    }
  }
  return best
}

function previewOf(message: WorkforceMessage): string {
  const senderPrefix = message.senderName ? `${message.senderName}: ` : ''
  if (message.tool !== undefined) {
    const status = message.tool.status
    if (status === 'running') return `${senderPrefix}${WF.employee.running}…`
    if (status === 'error') return `${senderPrefix}${WF.common.failed}`
    return `${senderPrefix}${WF.common.done}`
  }
  if (message.question !== undefined) {
    const q = message.question.items[0]?.question?.trim() || message.question.items[0]?.header?.trim()
    return `${senderPrefix}${q ? `${WF.chatList.questionPrefix}${q}` : WF.chatList.awaitingAnswer}`
  }
  if (message.approval !== undefined) {
    const tool = message.approval.toolName?.trim() || message.approval.displayReason?.trim() || message.approval.reason?.trim()
    return `${senderPrefix}${tool ? `${WF.chatList.approvalPrefix}${tool}` : WF.chatList.awaitingApproval}`
  }
  if (message.role === 'system' || message.tip === true) {
    const t = message.text.replace(/\s+/g, ' ').trim()
    return t || WF.chatList.systemNotification
  }
  const text = stripMarkdown(message.text)
  return message.role === 'agent' ? `${senderPrefix}${text}` : (message.senderName ? `${message.senderName}: ${text}` : text)
}

/** 会话排序只认真实正文消息时间；任务线程 createdAt 即首条用户消息时间，可作缺省回退；
 *  已缓存的真实正文时间用于宿主尚未回写 lastMessageAt 的旧会话。channel/dm 线程的
 *  createdAt 是创建/ensure 时间而非消息时间，不作回退。 */
function threadActivityTs(thread: Thread, cachedTs: string | undefined): string {
  if (thread.lastMessageAt !== undefined && thread.lastMessageAt !== '') return thread.lastMessageAt
  const base = thread.kind === 'task' ? thread.createdAt ?? '' : ''
  const cand = (cachedTs ?? '') > base ? cachedTs! : base
  if (cand) return cand
  return thread.updatedAt || thread.createdAt || ''
}

/** 频道会话的活动面：合并频道本体与全部任务线程。 */
function channelMeta(channel: HostChannel, threads: readonly Thread[], messages: Readonly<Record<string, ThreadMessages>>, employees: readonly Employee[], _members: readonly Employee[]): RowMeta {
  const related = threads.filter(thread => thread.channelId === channel.id)
  const last = lastCachedMessage(related.map(thread => thread.id), messages)
  let activityTs = related.reduce((max, thread) => {
    const ts = threadActivityTs(thread, last?.threadId === thread.id ? last.ts : undefined)
    return ts > max ? ts : max
  }, '')
  if (!activityTs) {
    for (const thread of related) {
      const ts = thread.updatedAt || thread.createdAt || ''
      if (ts > activityTs) activityTs = ts
    }
  }
  if (!activityTs) {
    activityTs = channel.createdAt || new Date().toISOString()
  }
  const running = related.some(thread => thread.status === 'running')
  const activeNames = [
    ...new Set(
      related
        .flatMap(thread => messages[thread.id]?.activity ?? [])
        .map(activity => employees.find(employee => employee.id === activity.employeeId)?.name)
        .filter((name): name is string => Boolean(name)),
    ),
  ]
  const subtitle = last !== undefined
    ? previewOf(last)
    : running
      ? `${activeNames.length > 0 ? `${activeNames.join(', ')} ` : ''}${WF.employee.running}…`
      : WF.chatList.noPreview
  const unreadCount = channel && typeof channel === 'object' && 'unreadCount' in channel && typeof channel.unreadCount === 'number'
    ? channel.unreadCount
    : undefined
  return {
    activityTs,
    pinned: channel.pinned === true,
    unread: channel.unread === true || Boolean(unreadCount && unreadCount > 0),
    unreadCount,
    running,
    subtitle,
  }
}

function dmMeta(thread: Thread | undefined, _fallbackTitle: string, messages: Readonly<Record<string, ThreadMessages>>, employee?: Employee): RowMeta {
  const running = thread?.status === 'running'
  const last = thread ? lastCachedMessage([thread.id], messages) : undefined
  let activityTs = thread ? threadActivityTs(thread, last?.ts) : ''
  if (!activityTs && running && thread) {
    activityTs = thread.updatedAt || thread.createdAt || ''
  }
  const unread = Boolean(thread && typeof thread === 'object' && 'unread' in thread && thread.unread === true)
  const unreadCount = thread && typeof thread === 'object' && 'unreadCount' in thread && typeof thread.unreadCount === 'number'
    ? thread.unreadCount
    : undefined
  const pinned = Boolean(thread && typeof thread === 'object' && 'pinned' in thread && thread.pinned === true)
  const subtitle = last !== undefined
    ? previewOf(last)
    : running
      ? `${WF.employee.running}…`
      : employee?.title?.trim() || employee?.persona?.trim() || WF.chatList.noPreview
  return {
    activityTs,
    pinned,
    unread: unread || Boolean(unreadCount && unreadCount > 0),
    unreadCount,
    running,
    subtitle,
  }
}

function PinGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  )
}

/** 微信群头像：成员 bot 头像拼格（≤3 名成员自适应 1/2/3 格，≥4 取前 4）；无成员落「群」字。
 *  格内一律静态：不传 state/live/typingEffect，侧栏多行不跑动画；memo 避免列表重渲染逐行重画。 */
const GroupAvatar = memo(function GroupAvatar({ members, avatarStyle }: {
  readonly members: readonly Employee[]
  readonly avatarStyle?: AvatarStyle | undefined
}) {
  const faces = members.slice(0, 4)
  return (
    <span className={css.chatGroupAvatar} data-faces={faces.length} aria-hidden="true">
      {faces.length === 0 ? (
        <span className={css.chatAvatarFallback}>{WF.chatList.groupFallbackChar}</span>
      ) : (
        <span className={css.chatAvatarGrid} data-count={faces.length}>
          {faces.map(employee => (
            <span key={employee.id} className={css.chatAvatarCell}>
              <WorkforceAvatar
                name={employee.name}
                color={employee.avatarColor}
                role={employee.role}
                style={avatarStyle}
                size={36}
                title={employee.name}
              />
            </span>
          ))}
        </span>
      )}
    </span>
  )
})

export function WorkforceChatList({
  channels,
  threads,
  employees,
  messages,
  activeChannelId,
  activeDmEmployeeId,
  avatarStyle,
  typingEffect,
  employeeMotion,
  onSelectChannel,
  onSelectDm,
  onCreateChatReq,
  onPatchChannelReq,
  onMarkChannelReadReq,
  onDuplicateChannelReq,
  onDeleteChannelReq,
  onPatchThreadReq,
  onPatchEmployeeReq,
}: WorkforceChatListProps) {
  const [opError, setOpError] = useState<{ message: string; retry?: () => Promise<void> | void } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sections: readonly ContextMenuSection[] } | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{ channelId: string; current: string; fallback: string; opener: HTMLElement } | undefined>()
  const [renameEmployeeTarget, setRenameEmployeeTarget] = useState<{ employeeId: string; current: string; opener: HTMLElement } | undefined>()
  const [deleteTarget, setDeleteTarget] = useState<{ channelId: string; title: string; error?: string | undefined } | undefined>()

  const executeWithCatch = async (actionDesc: string, action: () => Promise<void>) => {
    try {
      setOpError(null)
      await action()
    } catch (err: unknown) {
      setOpError({
        message: getLocale() === 'en'
          ? `${actionDesc} failed: ${err instanceof Error ? err.message : String(err)}`
          : `${actionDesc}失败: ${err instanceof Error ? err.message : String(err)}`,
        retry: () => executeWithCatch(actionDesc, action),
      })
    }
  }
  const runOp = (desc: string, handler: (() => Promise<unknown>) | undefined): void => {
    if (!handler) return
    void executeWithCatch(desc, async () => { await handler() })
  }

  const employeeById = useMemo(() => new Map(employees.map(employee => [employee.id, employee])), [employees])

  const rows = useMemo(() => {
    const membersOf = (channel: HostChannel): readonly Employee[] =>
      channel.memberIds === undefined
        ? employees
        : channel.memberIds.map(id => employeeById.get(id)).filter((employee): employee is Employee => employee !== undefined)
    const list: { row: ChatRow; meta: RowMeta }[] = []
    for (const channel of channels) {
      const members = membersOf(channel)
      const row: ChatRow = { kind: 'channel', key: `ch:${channel.id}`, channel, title: chatTitleOf(channel, members), members }
      list.push({ row, meta: channelMeta(channel, threads, messages, employees, members) })
    }
    const dmThreads = new Map<string, Thread>()
    const stale: Thread[] = []
    for (const thread of threads) {
      if (thread.kind !== 'dm' || thread.employeeId === undefined) continue
      if (employeeById.has(thread.employeeId)) dmThreads.set(thread.employeeId, thread)
      else stale.push(thread)
    }
    for (const employee of employees) {
      const thread = dmThreads.get(employee.id)
      const row: ChatRow = { kind: 'dm', key: `dm:${employee.id}`, employee, thread, title: employee.name }
      list.push({ row, meta: dmMeta(thread, employee.title, messages, employee) })
    }
    for (const thread of stale) {
      const row: ChatRow = { kind: 'dm-stale', key: `dm-stale:${thread.id}`, thread, title: thread.title.trim() || WF.common.employee }
      list.push({ row, meta: dmMeta(thread, WF.chatList.historySession, messages) })
    }
    return list.sort((a, b) =>
      Number(b.meta.pinned) - Number(a.meta.pinned)
      || Number(Boolean(b.meta.activityTs)) - Number(Boolean(a.meta.activityTs))
      || b.meta.activityTs.localeCompare(a.meta.activityTs)
      || a.row.title.localeCompare(b.row.title))
  }, [channels, threads, employees, messages, employeeById])

  const openChannelMenu = (e: MouseEvent, row: Extract<ChatRow, { kind: 'channel' }>, meta: RowMeta) => {
    e.preventDefault()
    e.stopPropagation()
    // 右键行是稳定的真实触发点：菜单项点击后 menu 先卸载，modal 不能靠 document.activeElement 找回它。
    const opener = e.currentTarget as HTMLElement
    const channel = row.channel
    const isGeneral = channel.id === 'general'
    const sections: ContextMenuSection[] = [
      {
        id: 'chat-status',
        items: [
          { id: 'mark-read', label: WF.sidebarActions.markAsRead, onClick: () => runOp(WF.sidebarActions.markAsRead, onMarkChannelReadReq ? () => onMarkChannelReadReq(channel.id) : undefined) },
          ...(!isGeneral ? [{
            id: 'toggle-pin',
            label: meta.pinned ? WF.chatList.unpinChat : WF.chatList.pinChat,
            onClick: () => runOp(meta.pinned ? WF.chatList.unpinChat : WF.chatList.pinChat, onPatchChannelReq ? () => onPatchChannelReq(channel.id, { pinned: !meta.pinned }) : undefined),
          }] : []),
        ],
      },
      {
        id: 'chat-ops',
        items: [
          {
            id: 'rename-chat',
            label: WF.chatList.groupChatName,
            onClick: () => setRenameTarget({ channelId: channel.id, current: channel.groupChatName ?? '', fallback: chatTitleOf(channel, row.members), opener }),
          },
          ...(!isGeneral && onDuplicateChannelReq ? [{
            id: 'dup-chat',
            label: WF.chatList.duplicateChat,
            onClick: () => runOp(WF.chatList.duplicateChat, () => onDuplicateChannelReq(channel.id)),
          }] : []),
        ],
      },
      {
        id: 'chat-danger',
        items: [
          {
            id: 'delete-chat',
            label: isGeneral ? WF.chatList.deleteChatGeneralDisabled : WF.chatList.deleteChat,
            danger: true,
            disabled: isGeneral,
            onClick: () => { if (!isGeneral) setDeleteTarget({ channelId: channel.id, title: row.title, error: undefined }) },
          },
        ],
      },
      {
        id: 'chat-id',
        items: [
          {
            id: 'copy-id',
            label: WF.chatList.copySessionId,
            onClick: () => { if (typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(channel.id) },
          },
        ],
      },
    ]
    setContextMenu({ x: e.clientX, y: e.clientY, sections })
  }

  const openDmMenu = (e: MouseEvent, thread: Thread | undefined, targetId: string, meta: RowMeta, employeeName: string) => {
    e.preventDefault()
    e.stopPropagation()
    const opener = e.currentTarget as HTMLElement
    const sections: ContextMenuSection[] = [
      {
        id: 'dm-status',
        items: [
          {
            id: 'mark-read',
            label: WF.sidebarActions.markAsRead,
            onClick: () => { if (thread) runOp(WF.sidebarActions.markAsRead, onPatchThreadReq ? () => onPatchThreadReq(thread.id, { markRead: true }) : undefined) },
          },
          {
            id: 'toggle-pin',
            label: meta.pinned ? WF.chatList.unpinChat : WF.chatList.pinChat,
            onClick: () => { if (thread) runOp(meta.pinned ? WF.chatList.unpinChat : WF.chatList.pinChat, onPatchThreadReq ? () => onPatchThreadReq(thread.id, { pinned: !meta.pinned }) : undefined) },
          },
          {
            id: 'rename-bot',
            label: WF.sidebarActions.rename,
            onClick: () => setRenameEmployeeTarget({ employeeId: targetId, current: employeeName, opener }),
          },
        ],
      },
      {
        id: 'dm-id',
        items: [
          {
            id: 'copy-id',
            label: WF.sidebarActions.copyId,
            onClick: () => { if (typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(targetId) },
          },
        ],
      },
    ]
    setContextMenu({ x: e.clientX, y: e.clientY, sections })
  }

  const renderUnreadBadge = (meta: RowMeta): ReactNode => {
    if (!meta.unread && (!meta.unreadCount || meta.unreadCount <= 0)) return null
    if (meta.unreadCount && meta.unreadCount > 0) {
      const text = meta.unreadCount > 99 ? '99+' : String(meta.unreadCount)
      return (
        <span className={css.chatBadgeCount} title={WF.ui.unreadCount(meta.unreadCount)}>
          {text}
        </span>
      )
    }
    return <span className={css.chatBadgeDot} title={WF.chatList.hasUnread} />
  }

  const renderRow = ({ row, meta }: { row: ChatRow; meta: RowMeta }) => {
    if (row.kind === 'channel') {
      const active = activeChannelId === row.channel.id
      const displayName = row.title
      return (
        <Button variant="plain"
          key={row.key}
          type="button"
          className={cx(css.chatItem, active && css.chatItemActive, meta.pinned && css.chatItemPinned)}
          onClick={() => onSelectChannel(row.channel.id)}
          onContextMenu={e => openChannelMenu(e, row, meta)}
        >
          <span className={css.chatAvatarBox}>
            <GroupAvatar members={row.members} avatarStyle={avatarStyle} />
            {renderUnreadBadge(meta)}
          </span>
          <span className={css.chatBody}>
            <span className={css.chatLine}>
              <span className={css.chatNameWrap}>
                <span className={css.chatNameText} title={displayName}>{displayName}</span>
              </span>
              <span className={css.chatTime}>{chatTimeLabel(meta.activityTs)}</span>
            </span>
            <span className={css.chatLine}>
              <span className={css.chatPreview}>{meta.subtitle}</span>
              {meta.pinned && <span className={css.chatPin} title={WF.common.pinned}><PinGlyph /></span>}
            </span>
          </span>
        </Button>
      )
    }
    const isStale = row.kind === 'dm-stale'
    const employee = isStale ? undefined : row.employee
    const thread = row.thread
    const targetId = isStale ? row.thread.employeeId! : row.employee.id
    const active = activeDmEmployeeId === targetId
    const displayName = employee?.name?.trim() || row.title.trim() || WF.common.employee
    const isLeader = employee?.isLeader === true
    const roleTag = isStale
      ? WF.common.offline
      : isLeader && !displayName.includes(WF.common.lead)
        ? WF.common.lead
        : undefined

    return (
      <Button variant="plain"
        key={row.key}
        type="button"
        className={cx(css.chatItem, active && css.chatItemActive, meta.pinned && css.chatItemPinned, isStale && css.chatItemDimmed)}
        onClick={() => onSelectDm(targetId)}
        onContextMenu={e => openDmMenu(e, thread, targetId, meta, displayName)}
      >
        <span className={css.chatAvatarBox}>
          <span className={css.chatSingleAvatar}>
            <WorkforceAvatar
              name={displayName}
              color={employee?.avatarColor}
              role={employee?.role}
              {...(isStale ? { tone: '#8a8a80' } : {})}
              style={avatarStyle}
              typingEffect={typingEffect}
              size={36}
              state={isStale ? 'idle' : (employeeMotion?.[targetId] ?? 'idle')}
              live={!isStale && Boolean(employeeMotion?.[targetId])}
            />
          </span>
          {renderUnreadBadge(meta)}
        </span>
        <span className={css.chatBody}>
          <span className={css.chatLine}>
            <span className={css.chatNameWrap}>
              <span className={css.chatNameText} title={displayName}>{displayName}</span>
              {roleTag && <span className={css.chatTag}>{roleTag}</span>}
            </span>
            <span className={css.chatTime}>{chatTimeLabel(meta.activityTs)}</span>
          </span>
          <span className={css.chatLine}>
            <span className={css.chatPreview}>{meta.subtitle}</span>
            {meta.pinned && <span className={css.chatPin} title={WF.common.pinned}><PinGlyph /></span>}
          </span>
        </span>
      </Button>
    )
  }

  const handleCreate = async (input: { title: string; memberIds: readonly string[] }) => {
    const title = input.title.trim()
    const members = input.memberIds.map(id => employeeById.get(id)).filter((employee): employee is Employee => employee !== undefined)
    const allSelected = input.memberIds.length > 0 && input.memberIds.length === employees.length
    // 微信空群名回退：前 3 名成员名串；全选与不选一样视为全员，不落 memberIds。
    const fallback = members.length > 0
      ? `${members.slice(0, 3).map(employee => employee.name).join(', ')}${members.length > 3 ? WF.chatList.etAl(members.length) : ''}`
      : WF.common.groupChat
    await executeWithCatch(WF.common.createGroupChat, async () => {
      const createdId = onCreateChatReq
        ? await onCreateChatReq({ name: title || fallback, groupChatName: title || undefined, memberIds: members.length > 0 && !allSelected ? input.memberIds : undefined })
        : undefined
      setCreateOpen(false)
      if (createdId) onSelectChannel(createdId)
    })
  }

  const handleExecuteDelete = async () => {
    if (!deleteTarget || !onDeleteChannelReq) { setDeleteTarget(undefined); return }
    try {
      await onDeleteChannelReq(deleteTarget.channelId)
      setDeleteTarget(undefined)
    } catch (err: unknown) {
      const isConflict =
        (typeof err === 'object' && err !== null && ('status' in err && (err as { status: number }).status === 409))
        || (typeof err === 'object' && err !== null && ('code' in err && (err as { code: string }).code === 'conflict'))
        || (err instanceof Error && (err.message.includes('409') || err.message.includes('conflict') || err.message.includes('正在执行') || err.message.includes('任务')))
      setDeleteTarget(prev => prev && { ...prev, error: isConflict ? WF.chatList.deleteChatHasRunningTasks : (err instanceof Error ? err.message : WF.chatList.deleteChatFailed) })
    }
  }

  return (
    <div className={css.chatRoot} data-section="sidebar-chat-list">

      {opError && (
        <div className={dialogCss.errorBanner} role="alert">
          <span className={dialogCss.errorMessage}>{opError.message}</span>
          <span className={dialogCss.errorActions}>
            {opError.retry && <Button variant="plain" type="button" className={dialogCss.errorRetryBtn} onClick={() => void opError.retry?.()}>{WF.common.retry}</Button>}
            <Button variant="plain" type="button" className={dialogCss.errorDismissBtn} onClick={() => setOpError(null)} aria-label={WF.common.close}>×</Button>
          </span>
        </div>
      )}

      <div className={css.chatList}>
        {rows.length === 0 && <div className={css.chatEmpty}>{WF.chatList.emptyChats}</div>}
        {rows.map(renderRow)}
      </div>

      {contextMenu && (
        <WorkforceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          sections={contextMenu.sections}
          onClose={() => setContextMenu(null)}
        />
      )}

      {createOpen && (
        <CreateChatModal
          employees={employees}
          onClose={() => setCreateOpen(false)}
          onSubmit={handleCreate}
        />
      )}

      {renameTarget !== undefined && (
        <ChatNameModal
          current={renameTarget.current}
          fallback={renameTarget.fallback}
          restoreFocus={renameTarget.opener}
          onClose={() => setRenameTarget(undefined)}
          onSubmit={async value => {
            const target = renameTarget
            setRenameTarget(undefined)
            await executeWithCatch(WF.chatList.groupChatName, async () => {
              await onPatchChannelReq?.(target.channelId, { groupChatName: value === '' ? null : value })
            })
          }}
        />
      )}
      {renameEmployeeTarget !== undefined && (
        <ChatNameModal
          current={renameEmployeeTarget.current}
          fallback={renameEmployeeTarget.current}
          title={WF.sidebarActions.renameEmployee}
          inputLabel={WF.sidebarActions.employeeName}
          hint=""
          restoreFocus={renameEmployeeTarget.opener}
          onClose={() => setRenameEmployeeTarget(undefined)}
          onSubmit={async value => {
            const target = renameEmployeeTarget
            setRenameEmployeeTarget(undefined)
            const newName = value.trim()
            if (!newName) return
            await executeWithCatch(WF.sidebarActions.renameEmployee, async () => {
              await onPatchEmployeeReq?.(target.employeeId, { name: newName })
            })
          }}
        />
      )}

      {deleteTarget !== undefined && (
        <ConfirmDialog
          title={WF.chatList.deleteChatTitle}
          message={WF.chatList.deleteChatConfirm(deleteTarget.title)}
          confirmLabel={WF.chatList.deleteChatTitle}
          danger
          error={deleteTarget.error}
          onCancel={() => setDeleteTarget(undefined)}
          onConfirm={handleExecuteDelete}
        />
      )}
    </div>
  )
}

/** 发起群聊：可选群名 + 勾选员工（不选 = 全员）。单一主动作「完成」。 */
export function CreateChatModal({ employees, onClose, onSubmit }: {
  readonly employees: readonly Employee[]
  readonly onClose: () => void
  readonly onSubmit: (input: { title: string; memberIds: readonly string[] }) => void | Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  // Esc 关闭（autoFocus 输入内也生效）并在关闭后把焦点还给触发点。
  const previousFocus = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null)
  useEffect(() => () => previousFocus.current?.focus(), [])

  const toggle = (id: string) => {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try { await onSubmit({ title, memberIds: [...picked] }) }
    finally { setBusy(false) }
  }

  const modal = (
    <div className={dialogCss.dialogBackdrop} onClick={onClose}>
      <div className={dialogCss.dialogCard} role="dialog" aria-modal="true" aria-label={WF.common.createGroupChat}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); onClose() } }}>
        <h3 className={dialogCss.dialogTitle}>{WF.common.createGroupChat}</h3>
        <form className={dialogCss.dialogForm} onSubmit={e => void submit(e)}>
          <div className={dialogCss.formItem}>
            <label className={dialogCss.formLabel} htmlFor="new-chat-name">{WF.chatList.groupChatNameOptional}</label>
            <TextInput
              id="new-chat-name"
              type="text"
              className={dialogCss.inputField}
              value={title}
              placeholder={WF.chatList.chatNamePlaceholder}
              maxLength={30}
              autoFocus
              onChange={e => setTitle(e.target.value)}
            />
          </div>
          <div className={dialogCss.formItem}>
            <label className={dialogCss.formLabel}>{WF.chatList.selectMembersLabel}</label>
            <div className={css.memberList} role="group" aria-label={WF.chatList.selectMembersAria}>
              {employees.map(employee => (
                <label key={employee.id} className={css.memberRow}>
                  <Checkbox checked={picked.has(employee.id)} onCheckedChange={() => toggle(employee.id)} />
                  <span className={css.memberName}>{employee.name}{employee.isLeader && <span className={css.chatTag}>{WF.common.lead}</span>}</span>
                </label>
              ))}
              {employees.length === 0 && <span className={css.chatPreview}>{WF.chatList.noEmployeesHint}</span>}
            </div>
          </div>
          <div className={dialogCss.dialogFooter}>
            <Button variant="plain" type="button" className={dialogCss.cancelBtn} onClick={onClose}>{WF.common.cancel}</Button>
            <Button variant="plain" type="submit" className={dialogCss.submitBtn} disabled={busy}>{busy ? WF.chatList.creating : WF.chatList.finish}</Button>
          </div>
        </form>
      </div>
    </div>
  )
  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal
}

/** 群聊名称编辑：留空保存 = 清除覆盖，回退到成员名串显示。 */
function ChatNameModal({ current, fallback, title = WF.chatList.groupChatName, inputLabel, hint = WF.chatList.chatNameHint, restoreFocus, onClose, onSubmit }: {
  readonly current: string
  readonly fallback: string
  readonly title?: string | undefined
  readonly inputLabel?: string | undefined
  readonly hint?: string | undefined
  /** 真实触发元素（右键捕获的会话行）；关闭时仍在 DOM 就恢复焦点给它。 */
  readonly restoreFocus?: HTMLElement | undefined
  readonly onClose: () => void
  readonly onSubmit: (value: string) => void | Promise<void>
}) {
  const [value, setValue] = useState(current)
  const [busy, setBusy] = useState(false)
  // Esc 关闭（autoFocus 输入内也生效）并在关闭后把焦点还给触发点。
  const previousFocus = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null)
  useEffect(() => () => {
    const target = (restoreFocus !== undefined && restoreFocus.isConnected) ? restoreFocus : (previousFocus.current?.isConnected ? previousFocus.current : undefined)
    target?.focus()
  }, [restoreFocus])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try { await onSubmit(value.trim()) }
    finally { setBusy(false) }
  }
  const modal = (
    <div className={dialogCss.dialogBackdrop} onClick={onClose}>
      <div className={dialogCss.dialogCard} role="dialog" aria-modal="true" aria-label={title}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); onClose() } }}>
        <h3 className={dialogCss.dialogTitle}>{title}</h3>
        <form className={dialogCss.dialogForm} onSubmit={e => void submit(e)}>
          <div className={dialogCss.formItem}>
            {inputLabel && <label className={dialogCss.formLabel}>{inputLabel}</label>}
            <TextInput
              type="text"
              className={dialogCss.inputField}
              value={value}
              placeholder={fallback}
              maxLength={30}
              autoFocus
              onChange={e => setValue(e.target.value)}
            />
            {hint && <span className={css.chatHint}>{hint}</span>}
          </div>
          <div className={dialogCss.dialogFooter}>
            <Button variant="plain" type="button" className={dialogCss.cancelBtn} onClick={onClose}>{WF.common.cancel}</Button>
            <Button variant="plain" type="submit" className={dialogCss.submitBtn} disabled={busy}>{busy ? WF.models.saving : WF.common.save}</Button>
          </div>
        </form>
      </div>
    </div>
  )
  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal
}
