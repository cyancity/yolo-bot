import { memo } from 'react'
import { Icon } from './ui/icons.tsx'
import type { HostChannel } from './workforce-api.ts'
import type { Employee, Thread, ThreadMessages, WorkforceMessage } from './workforce-types.ts'
import { WorkforceAvatar } from './workforce-avatar.tsx'
import { WF } from './workforce-strings.ts'
import { approvalToolLabel } from './workforce-agent-run.ts'
import css from './workforce-chat-list.module.css'
export interface RowMeta {
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
  if (days < 7 && days > 1) return WF.chatList.weekday(date.getDay())
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
    if (status === 'running') return `${senderPrefix}${WF.common.running}`
    if (status === 'error') return `${senderPrefix}${WF.common.failed}`
    return `${senderPrefix}${WF.common.done}`
  }
  if (message.question !== undefined) {
    const q = message.question.items[0]?.question?.trim() || message.question.items[0]?.header?.trim()
    return `${senderPrefix}${q ? `${WF.chatList.questionPrefix}${q}` : WF.chatList.awaitingAnswer}`
  }
  if (message.approval !== undefined) {
    const tool = (message.approval.toolName && approvalToolLabel(message.approval.toolName.trim())) || message.approval.displayReason?.trim() || message.approval.reason?.trim()
    return `${senderPrefix}${tool ? `${WF.chatList.approvalPrefix}${tool}` : WF.chatList.awaitingApproval}`
  }
  if (message.role === 'system' || message.tip === true) {
    const t = message.text.replace(/\s+/g, ' ').trim()
    return t || WF.chatList.systemNotification
  }
  const text = message.text.replace(/\s+/g, ' ').trim()
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
export function channelMeta(channel: HostChannel, threads: readonly Thread[], messages: Readonly<Record<string, ThreadMessages>>, employees: readonly Employee[], _members: readonly Employee[]): RowMeta {
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
      ? `${activeNames.length > 0 ? `${activeNames.join('、')} ` : ''}${WF.common.running}`
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

export function dmMeta(thread: Thread | undefined, _fallbackTitle: string, messages: Readonly<Record<string, ThreadMessages>>, employee?: Employee): RowMeta {
  const running = thread?.status === 'running'
  const last = thread ? lastCachedMessage([thread.id], messages) : undefined
  let activityTs = thread ? threadActivityTs(thread, last?.ts) : ''
  if (!activityTs && thread) {
    activityTs = thread.updatedAt || thread.createdAt || ''
  }
  if (!activityTs && employee) {
    activityTs = employee.updatedAt || employee.createdAt || ''
  }
  if (!activityTs) {
    activityTs = new Date().toISOString()
  }
  const unread = Boolean(thread && typeof thread === 'object' && 'unread' in thread && thread.unread === true)
  const unreadCount = thread && typeof thread === 'object' && 'unreadCount' in thread && typeof thread.unreadCount === 'number'
    ? thread.unreadCount
    : undefined
  const pinned = Boolean(thread && typeof thread === 'object' && 'pinned' in thread && thread.pinned === true)
  const subtitle = last !== undefined
    ? previewOf(last)
    : running
      ? WF.common.running
      : WF.chatList.noPreview
  return {
    activityTs,
    pinned,
    unread: unread || Boolean(unreadCount && unreadCount > 0),
    unreadCount,
    running,
    subtitle,
  }
}

export function PinGlyph() {
  return (
    <Icon name="pin" width={12} height={12} />
  )
}

/** 微信群头像：成员 bot 头像拼格（≤3 名成员自适应 1/2/3 格，≥4 取前 4）；无成员落「群」字。
 *  格内一律静态：不传 state/live，侧栏多行不跑动画；memo 避免列表重渲染逐行重画。 */
export const GroupAvatar = memo(function GroupAvatar({ members }: {
  readonly members: readonly Employee[]
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
