/**
 * WorkforceChatList：微信桌面式会话列表 — channel（群聊）与 DM（私信）混排一列。
 * 置顶在前，其余按最近真实消息时间（频道含其 task thread 的 updatedAt）倒序；
 * 行 = 头像（群聊为成员拼格）+ 名称 + 预览 + 右侧微信式时间 + 未读点。
 * 行为来源见 docs/wip/chat-sidebar.md 的调研记录；只做展示视图，不发额外请求。
 */
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { List } from '@lobehub/ui'
import type { HostChannel } from './workforce-api.ts'
import type { Employee, Thread, ThreadMessages } from './workforce-types.ts'
import type { AvatarMotionState } from './workforce-avatar-motion.ts'
import { WorkforceAvatar } from './workforce-avatar.tsx'
import { ConfirmDialog, WorkforceContextMenu, type ContextMenuSection } from './workforce-context-menu.tsx'
import { cx } from './ui/index.tsx'
import dialogCss from './workforce-channels.module.css'
import css from './workforce-chat-list.module.css'
import { chatTimeLabel, chatTitleOf, channelMeta, dmMeta, GroupAvatar, PinGlyph, type RowMeta } from './workforce-chat-list-data.tsx'
import { CreateChatModal, ChatNameModal } from './workforce-chat-list-forms.tsx'
export { chatTimeLabel, chatTitleOf } from './workforce-chat-list-data.tsx'
export { CreateChatModal } from './workforce-chat-list-forms.tsx'
import { WF } from './workforce-strings.ts'

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

export function WorkforceChatList({
  channels,
  threads,
  employees,
  messages,
  activeChannelId,
  activeDmEmployeeId,
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
        message: `${actionDesc} ${WF.common.failed}: ${err instanceof Error ? err.message : String(err)}`,
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
            label: meta.pinned ? WF.sidebarActions.unpinDm : WF.chatList.pinChat,
            onClick: () => runOp(meta.pinned ? WF.sidebarActions.unpinDm : WF.chatList.pinChat, onPatchChannelReq ? () => onPatchChannelReq(channel.id, { pinned: !meta.pinned }) : undefined),
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
            label: meta.pinned ? WF.sidebarActions.unpinDm : WF.chatList.pinChat,
            onClick: () => { if (thread) runOp(meta.pinned ? WF.sidebarActions.unpinDm : WF.chatList.pinChat, onPatchThreadReq ? () => onPatchThreadReq(thread.id, { pinned: !meta.pinned }) : undefined) },
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
        <span className={css.chatBadgeCount} title={String(meta.unreadCount) + ' ' + WF.chatList.hasUnread}>
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
        <List.Item
          key={row.key}
          active={active}
          align="center"
          avatar={<span className={css.chatAvatarBox}>
            <GroupAvatar members={row.members} />
            {renderUnreadBadge(meta)}
          </span>}
          className={css.chatItem}
          padding={8}
          role="button"
          tabIndex={0}
          aria-current={active ? 'page' : undefined}
          onClick={() => onSelectChannel(row.channel.id)}
          onContextMenu={e => openChannelMenu(e, row, meta)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onSelectChannel(row.channel.id)
            }
          }}
          title={
            <span className={css.chatLine}>
              <span className={css.chatNameWrap}>
                <span className={css.chatNameText} title={displayName}>{displayName}</span>
              </span>
              <span className={css.chatTime}>{chatTimeLabel(meta.activityTs)}</span>
            </span>
          }
          description={
            <span className={css.chatLine}>
              <span className={css.chatPreview}>{meta.subtitle}</span>
              {meta.pinned && <span className={css.chatPin} title={WF.common.pinned}><PinGlyph /></span>}
            </span>
          }
        />
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
      : isLeader && !displayName.includes('负责人')
        ? WF.common.lead
        : undefined

    return (
      <List.Item
        key={row.key}
        active={active}
        align="center"
        avatar={<span className={css.chatAvatarBox}>
          <span className={css.chatSingleAvatar}>
            <WorkforceAvatar
              name={displayName}
              color={employee?.avatarColor}
              role={employee?.role}
              {...(isStale ? { tone: '#8a8a80' } : {})}
              size={36}
              state={isStale ? 'idle' : (employeeMotion?.[targetId] ?? 'idle')}
              live={!isStale && Boolean(employeeMotion?.[targetId])}
            />
          </span>
          {renderUnreadBadge(meta)}
        </span>}
        className={cx(css.chatItem, isStale && css.chatItemDimmed)}
        padding={8}
        role="button"
        tabIndex={0}
        aria-current={active ? 'page' : undefined}
        onClick={() => onSelectDm(targetId)}
        onContextMenu={e => openDmMenu(e, thread, targetId, meta, displayName)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelectDm(targetId)
          }
        }}
        title={
          <span className={css.chatLine}>
            <span className={css.chatNameWrap}>
              <span className={css.chatNameText} title={displayName}>{displayName}</span>
              {roleTag && <span className={css.chatTag}>{roleTag}</span>}
            </span>
            <span className={css.chatTime}>{chatTimeLabel(meta.activityTs)}</span>
          </span>
        }
        description={
          <span className={css.chatLine}>
            <span className={css.chatPreview}>{meta.subtitle}</span>
            {meta.pinned && <span className={css.chatPin} title={WF.common.pinned}><PinGlyph /></span>}
          </span>
        }
      />
    )
  }

  const handleCreate = async (input: { title: string; memberIds: readonly string[] }) => {
    const title = input.title.trim()
    const members = input.memberIds.map(id => employeeById.get(id)).filter((employee): employee is Employee => employee !== undefined)
    const allSelected = input.memberIds.length > 0 && input.memberIds.length === employees.length
    // 微信空群名回退：前 3 名成员名串；全选与不选一样视为全员，不落 memberIds。
    const fallback = members.length > 0
      ? `${members.slice(0, 3).map(employee => employee.name).join('、')}${members.length > 3 ? WF.chatList.etAl(members.length) : ''}`
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
            {opError.retry && <button type="button" className={dialogCss.errorRetryBtn} onClick={() => void opError.retry?.()}>{WF.common.retry}</button>}
            <button type="button" className={dialogCss.errorDismissBtn} onClick={() => setOpError(null)} aria-label={WF.common.close}>×</button>
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
          title={WF.chatList.deleteChat}
          message={WF.chatList.deleteChatConfirm(deleteTarget.title)}
          confirmLabel={WF.common.delete}
          danger
          error={deleteTarget.error}
          onCancel={() => setDeleteTarget(undefined)}
          onConfirm={handleExecuteDelete}
        />
      )}
    </div>
  )
}
