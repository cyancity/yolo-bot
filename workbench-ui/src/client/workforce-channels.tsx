import { Button, TextInput } from './ui/primitives.ts'
import { Select } from './ui/select.tsx'
import { Dialog } from './ui/index.tsx'
/**
 * WorkforceChannels：Discord 风格频道列表与分组管理组件。
 * - 支持新建频道、重命名、复制、移动分组、删除（遇到 409 提示「频道里还有执行中的任务」）。
 * - 支持分组折叠/展开、新建分组、重命名/删除分组。
 * - 支持置顶频道与标记已读。
 */
import { useState, type MouseEvent } from 'react'
import type { HostChannel, HostChannelGroup } from './workforce-api.ts'
import type { Channel } from './workforce-types.ts'
import { ConfirmDialog, WorkforceContextMenu, type ContextMenuSection } from './workforce-context-menu.tsx'
import { WF } from './workforce-strings.ts'
import { getLocale } from './i18n.ts'
import css from './workforce-channels.module.css'

export interface ChannelGroup {
  readonly id: string
  readonly name: string
  readonly sort?: number | undefined
  readonly collapsed?: boolean | undefined
}

export interface WorkforceChannelsProps {
  readonly channels: readonly (Channel | HostChannel)[]
  readonly groups?: readonly HostChannelGroup[] | undefined
  readonly activeChannelId?: string | undefined
  readonly onSelectChannel: (channelId: string) => void
  readonly onCreateChannelReq?: ((name: string, groupId?: string | null | undefined) => Promise<string | undefined>) | undefined
  readonly onRenameChannelReq?: ((channelId: string, name: string) => Promise<void>) | undefined
  readonly onPatchChannelReq?: ((channelId: string, patch: { name?: string | undefined; groupId?: string | null | undefined; pinned?: boolean | undefined; sort?: number | undefined }) => Promise<void>) | undefined
  readonly onMarkChannelReadReq?: ((channelId: string) => Promise<void>) | undefined
  readonly onDuplicateChannelReq?: ((channelId: string) => Promise<void>) | undefined
  readonly onDeleteChannelReq?: ((channelId: string) => Promise<void>) | undefined
  readonly onCreateGroupReq?: ((name: string) => Promise<void>) | undefined
  readonly onRenameGroupReq?: ((groupId: string, name: string) => Promise<void>) | undefined
  readonly onDeleteGroupReq?: ((groupId: string) => Promise<void>) | undefined
}

const STORAGE_COLLAPSED_KEY = 'wb:channel-groups-collapsed:v1'
const STORAGE_CHANNELS_SECTION_COLLAPSED_KEY = 'wb:sidebar-channels-section-collapsed:v1'
const LEGACY_STORAGE_GROUPS_FALLBACK_KEY = 'wb:channel-groups-fallback:v1'

/** 未分组区的折叠态 key（非宿主分组 id，用独立前缀避免撞号）。 */
const UNGROUPED_KEY = '__ungrouped__'

function loadCollapsedMap(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_COLLAPSED_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, boolean>
  } catch {
    return {}
  }
}

function detectLegacyFallbackGroups(): { id: string; name: string }[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_GROUPS_FALLBACK_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed) && parsed.length > 0) {
      const valid = parsed.filter((item): item is { id: string; name: string } => (
        Boolean(item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string' && (item as { name: string }).name.trim().length > 0)
      ))
      return valid.length > 0 ? valid : null
    }
  } catch {}
  return null
}

export function WorkforceChannels({
  channels,
  groups: hostGroups,
  activeChannelId,
  onSelectChannel,
  onCreateChannelReq,
  onRenameChannelReq,
  onPatchChannelReq,
  onMarkChannelReadReq,
  onDuplicateChannelReq,
  onDeleteChannelReq,
  onCreateGroupReq,
  onRenameGroupReq,
  onDeleteGroupReq,
}: WorkforceChannelsProps) {
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>(loadCollapsedMap)
  const [sectionCollapsed, setSectionCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      return localStorage.getItem(STORAGE_CHANNELS_SECTION_COLLAPSED_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [legacyGroupsToSync, setLegacyGroupsToSync] = useState<{ id: string; name: string }[] | null>(detectLegacyFallbackGroups)
  const [syncingLegacy, setSyncingLegacy] = useState(false)
  const [opError, setOpError] = useState<{ message: string; retry?: () => Promise<void> | void } | null>(null)

  // 弹出菜单与弹窗状态
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    sections: readonly ContextMenuSection[]
  } | null>(null)

  const [createChannelModal, setCreateChannelModal] = useState<{ open: boolean; defaultGroupId?: string | undefined }>({ open: false })
  const [renameChannelModal, setRenameChannelModal] = useState<{ open: boolean; channelId: string; currentName: string }>({ open: false, channelId: '', currentName: '' })
  const [createGroupModal, setCreateGroupModal] = useState(false)
  const [renameGroupModal, setRenameGroupModal] = useState<{ open: boolean; groupId: string; currentName: string }>({ open: false, groupId: '', currentName: '' })
  const [deleteChannelConfirm, setDeleteChannelConfirm] = useState<{ open: boolean; channelId: string; channelName: string; error?: string | undefined }>({ open: false, channelId: '', channelName: '' })

  const toggleChannelsSectionCollapse = () => {
    const next = !sectionCollapsed
    setSectionCollapsed(next)
    try {
      localStorage.setItem(STORAGE_CHANNELS_SECTION_COLLAPSED_KEY, JSON.stringify(next))
    } catch {}
  }

  const toggleGroupCollapse = (groupId: string) => {
    const next = { ...collapsedMap, [groupId]: !collapsedMap[groupId] }
    setCollapsedMap(next)
    try {
      localStorage.setItem(STORAGE_COLLAPSED_KEY, JSON.stringify(next))
    } catch {
      // 忽略存储失败
    }
  }

  const executeWithCatch = async (actionDesc: string, action: () => Promise<void>) => {
    try {
      setOpError(null)
      await action()
    } catch (err: unknown) {
      const msg = getLocale() === 'en'
        ? `${actionDesc} failed: ${err instanceof Error ? err.message : String(err)}`
        : `${actionDesc}失败: ${err instanceof Error ? err.message : String(err)}`
      setOpError({
        message: msg,
        retry: () => executeWithCatch(actionDesc, action),
      })
    }
  }

  const handleSyncLegacyGroups = async () => {
    if (!legacyGroupsToSync || !onCreateGroupReq) return
    setSyncingLegacy(true)
    try {
      for (const grp of legacyGroupsToSync) {
        if (!rawGroups.some(g => g.name === grp.name)) {
          await onCreateGroupReq(grp.name)
        }
      }
      localStorage.removeItem(LEGACY_STORAGE_GROUPS_FALLBACK_KEY)
      setLegacyGroupsToSync(null)
    } catch (err: unknown) {
      setOpError({
        message: getLocale() === 'en'
          ? `Failed to sync local groups: ${err instanceof Error ? err.message : String(err)}`
          : `同步本地分组失败: ${err instanceof Error ? err.message : String(err)}`,
        retry: handleSyncLegacyGroups,
      })
    } finally {
      setSyncingLegacy(false)
    }
  }

  const handleDismissLegacyGroups = () => {
    try {
      localStorage.removeItem(LEGACY_STORAGE_GROUPS_FALLBACK_KEY)
    } catch {}
    setLegacyGroupsToSync(null)
  }

  const runChannelOp = (desc: string, handler: (() => Promise<unknown>) | undefined): void => {
    if (!handler) return
    void executeWithCatch(desc, async () => { await handler() })
  }


  // 分组数据：仅以宿主 groups 为准，去掉本地兜底
  const rawGroups = hostGroups ?? []
  const effectiveGroups: ChannelGroup[] = [...rawGroups]
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .map(g => ({
      id: g.id,
      name: g.name,
      sort: g.sort,
      collapsed: Boolean(collapsedMap[g.id]),
    }))

  // 分组名可空：UI 统一回退显示
  const groupDisplayName = (group: { name: string }): string => group.name.trim() || WF.channelUI.unnamedGroup

  // 频道数据：宿主 HostChannel 字段优先；groupName 是分组视图的可空显示名覆盖
  const normalizedChannels = channels
    .map(ch => {
      const hostCh = ch as HostChannel
      return {
        id: ch.id,
        name: hostCh.groupName?.trim() || ch.name,
        groupId: hostCh.groupId ?? null,
        pinned: Boolean(hostCh.pinned),
        unread: Boolean(hostCh.unread),
        sort: hostCh.sort ?? 0,
      }
    })
    .sort((a, b) => a.sort - b.sort)

  // 置顶频道
  const pinnedChannels = normalizedChannels.filter(ch => ch.pinned && ch.id !== 'general')

  // 处理频道右键菜单
  const openChannelContextMenu = (e: MouseEvent, channel: { id: string; name: string; groupId: string | null; pinned: boolean }) => {
    e.preventDefault()
    e.stopPropagation()

    const isGeneral = channel.id === 'general'

    // 任务大厅是最高层级：不进任何分组（包括未分组）。
    const moveGroupItems = [
      {
        id: 'group-none',
        label: WF.channelUI.ungrouped,
        disabled: isGeneral,
        onClick: () => { if (!isGeneral) runChannelOp(WF.channelUI.removeFromGroup, onPatchChannelReq ? () => onPatchChannelReq(channel.id, { groupId: null }) : undefined) },
      },
      ...effectiveGroups.map(g => ({
        id: `move-${g.id}`,
        label: groupDisplayName(g),
        disabled: isGeneral,
        onClick: () => { if (!isGeneral) runChannelOp(WF.channelUI.moveToGroup, onPatchChannelReq ? () => onPatchChannelReq(channel.id, { groupId: g.id }) : undefined) },
      })),
      {
        id: 'new-group-opt',
        label: WF.channelUI.newGroupEllipsis,
        onClick: () => setCreateGroupModal(true),
      },
    ]

    const sections: ContextMenuSection[] = [
      {
        id: 'read-and-pin',
        items: [
          {
            id: 'mark-read',
            label: WF.channelUI.markAsRead,
            onClick: () => runChannelOp(WF.channelUI.markReadOp, onMarkChannelReadReq ? () => onMarkChannelReadReq(channel.id) : undefined),
          },
          ...(!isGeneral ? [{
            id: 'toggle-pin',
            label: channel.pinned ? WF.channelUI.unpinChannel : WF.channelUI.pinChannel,
            onClick: () => runChannelOp(channel.pinned ? WF.channelUI.unpinChannel : WF.channelUI.pinChannel, onPatchChannelReq ? () => onPatchChannelReq(channel.id, { pinned: !channel.pinned }) : undefined),
          }] : []),
        ],
      },
      ...(!isGeneral ? [{
        id: 'link-and-move',
        items: [
          {
            id: 'copy-link',
            label: WF.channelUI.copyLink,
            onClick: () => {
              if (typeof navigator !== 'undefined' && navigator.clipboard) {
                void navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}#channel/${channel.id}`)
              }
            },
          },
          {
            id: 'move-group',
            label: WF.channelUI.moveToGroup,
            children: moveGroupItems,
          },
        ],
      }] : []),
      {
        id: 'channel-ops',
        items: [
          {
            id: 'edit-channel',
            label: WF.channelUI.editChannel,
            onClick: () => setRenameChannelModal({ open: true, channelId: channel.id, currentName: channel.name }),
          },
          ...(!isGeneral ? [{
            id: 'dup-channel',
            label: WF.channelUI.duplicateChannel,
            onClick: () => {
              if (onDuplicateChannelReq) runChannelOp(WF.channelUI.duplicateChannel, () => onDuplicateChannelReq(channel.id))
              else if (onCreateChannelReq) runChannelOp(WF.channelUI.duplicateChannel, () => onCreateChannelReq(`${channel.name}${WF.channelUI.duplicateCopySuffix}`, channel.groupId))
            },
          }] : []),
          {
            id: 'create-channel-here',
            label: WF.channelUI.createChannel,
            onClick: () => setCreateChannelModal({ open: true, defaultGroupId: channel.groupId ?? undefined }),
          },
        ],
      },
      {
        id: 'channel-danger',
        items: [
          {
            id: 'delete-channel',
            label: isGeneral ? WF.channelUI.deleteChannelGeneralDisabled : WF.channelUI.deleteChannel,
            danger: true,
            disabled: isGeneral,
            onClick: () => {
              if (!isGeneral) {
                setDeleteChannelConfirm({ open: true, channelId: channel.id, channelName: channel.name, error: undefined })
              }
            },
          },
        ],
      },
      {
        id: 'channel-id',
        items: [
          {
            id: 'copy-id',
            label: WF.channelUI.copyChannelId,
            onClick: () => {
              if (typeof navigator !== 'undefined' && navigator.clipboard) {
                void navigator.clipboard.writeText(channel.id)
              }
            },
          },
        ],
      },
    ]

    setContextMenu({ x: e.clientX, y: e.clientY, sections })
  }

  // 处理分组头右键菜单
  const openGroupContextMenu = (e: MouseEvent, group: ChannelGroup) => {
    e.preventDefault()
    e.stopPropagation()

    const sections: ContextMenuSection[] = [
      {
        id: 'group-channel-ops',
        items: [
          {
            id: 'create-ch-in-grp',
            label: WF.channelUI.createChannel,
            onClick: () => setCreateChannelModal({ open: true, defaultGroupId: group.id }),
          },
          {
            id: 'create-new-grp',
            label: WF.channelUI.newGroup,
            onClick: () => setCreateGroupModal(true),
          },
        ],
      },
      {
        id: 'group-edit',
        items: [
          {
            id: 'rename-group',
            label: WF.channelUI.renameGroup,
            onClick: () => setRenameGroupModal({ open: true, groupId: group.id, currentName: group.name }),
          },
          {
            id: 'delete-group',
            label: WF.channelUI.deleteGroup,
            danger: true,
            disabled: effectiveGroups.length <= 1,
            onClick: () => {
              if (onDeleteGroupReq) runChannelOp(WF.channelUI.deleteGroup, () => onDeleteGroupReq(group.id))
            },
          },
        ],
      },
    ]

    setContextMenu({ x: e.clientX, y: e.clientY, sections })
  }

  // 渲染单个频道按钮
  const renderChannelButton = (channel: { id: string; name: string; groupId: string | null; pinned: boolean; unread: boolean }) => {
    const isActive = activeChannelId === channel.id
    return (
      <Button variant="plain"
        key={channel.id}
        type="button"
        className={`${css.channelItem} ${isActive ? css.channelItemActive : ''}`}
        onClick={() => onSelectChannel(channel.id)}
        onContextMenu={e => openChannelContextMenu(e, channel)}
      >
        <span className={css.hashIcon}>#</span>
        <span className={css.channelName}>{channel.name}</span>
        {channel.pinned && (
          <span className={css.pinBadge} title={WF.channelUI.pinned}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="17" x2="12" y2="22"/>
              <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>
            </svg>
          </span>
        )}
        {channel.unread && <span className={css.unreadDot} title={WF.channelUI.hasUnread} />}
      </Button>
    )
  }

  // 执行删除频道（含 409 conflict 处理）
  const handleExecuteDeleteChannel = async () => {
    if (!onDeleteChannelReq) {
      setDeleteChannelConfirm({ open: false, channelId: '', channelName: '' })
      return
    }
    try {
      await onDeleteChannelReq(deleteChannelConfirm.channelId)
      setDeleteChannelConfirm({ open: false, channelId: '', channelName: '' })
    } catch (err: unknown) {
      const isConflict =
        (typeof err === 'object' && err !== null && ('status' in err && (err as { status: number }).status === 409))
        || (typeof err === 'object' && err !== null && ('code' in err && (err as { code: string }).code === 'conflict'))
        || (err instanceof Error && (err.message.includes('409') || err.message.includes('conflict') || err.message.includes('正在执行') || err.message.includes('任务')))

      const hint = isConflict ? WF.channelUI.channelHasRunningTasks : (err instanceof Error ? err.message : WF.channelUI.deleteChannelFailed)
      setDeleteChannelConfirm(prev => ({ ...prev, error: hint }))
    }
  }

  return (
    <div className={css.channelsContainer}>
      {/* 顶部标题与新建入口 */}
      {/* 顶部标题与新建入口（标题行点击折叠/展开整个频道区） */}
      <div className={css.topActionRow}>
        <Button variant="plain" type="button" className={css.sectionToggleBtn} onClick={toggleChannelsSectionCollapse} aria-expanded={!sectionCollapsed}>
          <span className={`${css.chevron} ${sectionCollapsed ? css.chevronCollapsed : ''}`}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </span>
          <span className={css.topTitle}>{WF.nav.channels}</span>
        </Button>
        {!sectionCollapsed && (
          <div className={css.topActions}>
            <Button variant="plain"
              type="button"
              className={css.iconBtn}
              title={WF.channelUI.newChannelBtn}
              aria-label={WF.channelUI.newChannelBtn}
              onClick={() => setCreateChannelModal({ open: true })}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </Button>
            <Button variant="plain"
              type="button"
              className={css.iconBtn}
              title={WF.channelUI.newGroupBtn}
              aria-label={WF.channelUI.newGroupBtn}
              onClick={() => setCreateGroupModal(true)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                <line x1="12" y1="11" x2="12" y2="17"/>
                <line x1="9" y1="14" x2="15" y2="14"/>
              </svg>
            </Button>
          </div>
        )}
      </div>

      {/* 旧版本本地暂存分组迁移提示 */}
      {legacyGroupsToSync && !sectionCollapsed && (
        <div className={css.migrationBanner} role="status">
          <span className={css.migrationText}>{WF.channelUI.legacyGroupsMigration(legacyGroupsToSync.length)}</span>
          <div className={css.migrationActions}>
            <Button variant="plain" type="button" className={css.syncBtn} disabled={syncingLegacy} onClick={() => void handleSyncLegacyGroups()}>
              {syncingLegacy ? WF.channelUI.syncing : WF.channelUI.sync}
            </Button>
            <Button variant="plain" type="button" className={css.dismissBtn} onClick={handleDismissLegacyGroups}>{WF.channelUI.ignore}</Button>
          </div>
        </div>
      )}

      {/* 操作失败提示（可重试） */}
      {opError && (
        <div className={css.errorBanner} role="alert">
          <span className={css.errorMessage}>{opError.message}</span>
          <span className={css.errorActions}>
            {opError.retry && <Button variant="plain" type="button" className={css.errorRetryBtn} onClick={() => void opError.retry?.()}>{WF.common.retry}</Button>}
            <Button variant="plain" type="button" className={css.errorDismissBtn} onClick={() => setOpError(null)} aria-label={WF.common.close}>×</Button>
          </span>
        </div>
      )}

      {/* 任务大厅：最高层级，固定置顶，不属于任何分组（含未分组）、不可置顶 */}
      {!sectionCollapsed && (() => {
        const general = normalizedChannels.find(ch => ch.id === 'general')
        if (!general) return null
        return (
          <div className={css.groupBlock}>
            <div className={css.channelList}>
              {renderChannelButton({ ...general, pinned: false })}
            </div>
          </div>
        )
      })()}

      {!sectionCollapsed && pinnedChannels.length > 0 && (
        <div className={css.groupBlock}>
          <div className={css.groupHeader} style={{ cursor: 'default' }}>
            <div className={css.groupHeaderLeft}>
              <span className={css.groupTitle}>{WF.channelUI.pinnedChannels}</span>
            </div>
          </div>
          <div className={css.channelList}>
            {pinnedChannels.map(renderChannelButton)}
          </div>
        </div>
      )}
      {!sectionCollapsed && (
        <>
      {/* 未分组频道：自有独立区，不并入任何分组；Discord 惯例排在各分组之前 */}
      {(() => {
        const unassignedChannels = normalizedChannels.filter(ch => !ch.groupId && !ch.pinned && ch.id !== 'general')
        if (unassignedChannels.length === 0) return null
        return (
          <div className={css.groupBlock}>
            <div className={css.groupHeader} onClick={() => toggleGroupCollapse(UNGROUPED_KEY)}>
              <div className={css.groupHeaderLeft}>
                <span className={`${css.chevron} ${collapsedMap[UNGROUPED_KEY] ? css.chevronCollapsed : ''}`}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </span>
                <span className={css.groupTitle}>{WF.channelUI.ungrouped}</span>
              </div>
              <Button variant="plain"
                type="button"
                className={css.groupAddBtn}
                title={WF.channelUI.createChannelInUngrouped}
                aria-label={WF.channelUI.createChannelInUngrouped}
                onClick={e => { e.stopPropagation(); setCreateChannelModal({ open: true }) }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"/>
                  <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
              </Button>
            </div>
            {!collapsedMap[UNGROUPED_KEY] && (
              <div className={css.channelList}>
                {unassignedChannels.map(renderChannelButton)}
              </div>
            )}
          </div>
        )
      })()}

      {/* 各分组列表 */}
      {effectiveGroups.map(group => {
        const groupChannels = normalizedChannels.filter(ch => ch.groupId === group.id && !ch.pinned && ch.id !== 'general')
        return (
          <div key={group.id} className={css.groupBlock}>
            <div
              className={css.groupHeader}
              onClick={() => toggleGroupCollapse(group.id)}
              onContextMenu={e => openGroupContextMenu(e, group)}
            >
              <div className={css.groupHeaderLeft}>
                <span className={`${css.chevron} ${group.collapsed ? css.chevronCollapsed : ''}`}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </span>
                <span className={css.groupTitle}>{groupDisplayName(group)}</span>
              </div>
              <Button variant="plain"
                type="button"
                className={css.groupAddBtn}
                title={WF.channelUI.createChannelInGroup(groupDisplayName(group))}
                aria-label={WF.channelUI.createChannelInGroup(groupDisplayName(group))}
                onClick={e => {
                  e.stopPropagation()
                  setCreateChannelModal({ open: true, defaultGroupId: group.id })
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"/>
                  <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
              </Button>
            </div>

            {!group.collapsed && (
              <div className={css.channelList}>
                {groupChannels.map(renderChannelButton)}
              </div>
            )}
          </div>
        )
      })}

        </>
      )}

      {/* 右键菜单挂载 */}
      {contextMenu && (
        <WorkforceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          sections={contextMenu.sections}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* 新建频道弹窗 */}
      {createChannelModal.open && (
        <CreateChannelModal
          groups={effectiveGroups}
          defaultGroupId={createChannelModal.defaultGroupId}
          onClose={() => setCreateChannelModal({ open: false })}
          onSubmit={async (name, groupId) => {
            setCreateChannelModal({ open: false })
            await executeWithCatch(WF.channelUI.createChannel, async () => {
              const createdId = onCreateChannelReq ? await onCreateChannelReq(name, groupId) : undefined
              // 创建成功立即选中，不用等下一轮轮询。
              if (createdId) onSelectChannel(createdId)
            })
          }}
        />
      )}

      {/* 重命名频道弹窗 */}
      {renameChannelModal.open && (
        <RenameModal
          title={WF.channelUI.renameChannelTitle}
          initialValue={renameChannelModal.currentName}
          onClose={() => setRenameChannelModal({ open: false, channelId: '', currentName: '' })}
          onSubmit={async nextName => {
            if (onRenameChannelReq) {
              await onRenameChannelReq(renameChannelModal.channelId, nextName)
            } else if (onPatchChannelReq) {
              await onPatchChannelReq(renameChannelModal.channelId, { name: nextName })
            }
            setRenameChannelModal({ open: false, channelId: '', currentName: '' })
          }}
        />
      )}

      {/* 新建分组弹窗 */}
      {createGroupModal && (
        <RenameModal
          title={WF.channelUI.newGroupModalTitle}
          initialValue=""
          placeholder={WF.channelUI.groupPlaceholderExample}
          allowEmpty
          onClose={() => setCreateGroupModal(false)}
          onSubmit={async name => {
            const trimmed = name.trim()
            if (onCreateGroupReq) {
              await executeWithCatch(WF.channelUI.newGroup, async () => {
                await onCreateGroupReq(trimmed)
                setCreateGroupModal(false)
              })
            } else {
              setOpError({ message: WF.channelUI.groupFeatureUnavailable })
              setCreateGroupModal(false)
            }
          }}
        />
      )}

      {/* 重命名分组弹窗 */}
      {renameGroupModal.open && (
        <RenameModal
          title={WF.channelUI.renameGroupTitle}
          initialValue={renameGroupModal.currentName}
          placeholder={WF.channelUI.renameGroupPlaceholder}
          allowEmpty
          onClose={() => setRenameGroupModal({ open: false, groupId: '', currentName: '' })}
          onSubmit={async nextName => {
            if (onRenameGroupReq) {
              await executeWithCatch(WF.channelUI.renameGroup, async () => {
                await onRenameGroupReq(renameGroupModal.groupId, nextName)
                setRenameGroupModal({ open: false, groupId: '', currentName: '' })
              })
            } else {
              setOpError({ message: WF.channelUI.groupFeatureUnavailable })
              setRenameGroupModal({ open: false, groupId: '', currentName: '' })
            }
          }}
        />
      )}

      {/* 删除频道二次确认 */}
      {deleteChannelConfirm.open && (
        <ConfirmDialog
          title={WF.channelUI.deleteChannelTitle}
          message={WF.channelUI.deleteChannelConfirm(deleteChannelConfirm.channelName)}
          confirmLabel={WF.channelUI.deleteChannelTitle}
          danger
          error={deleteChannelConfirm.error}
          onCancel={() => setDeleteChannelConfirm({ open: false, channelId: '', channelName: '', error: undefined })}
          onConfirm={handleExecuteDeleteChannel}
        />
      )}
    </div>
  )
}

/** 新建频道模态弹窗 */
function CreateChannelModal({
  groups,
  defaultGroupId,
  onClose,
  onSubmit,
}: {
  readonly groups: readonly ChannelGroup[]
  readonly defaultGroupId?: string | undefined
  readonly onClose: () => void
  readonly onSubmit: (name: string, groupId?: string | undefined) => void | Promise<void>
}) {
  const [name, setName] = useState('')
  // 顶部「新建频道」默认落在未分组；只有从某个分组行点「+」才预选该分组。
  const [groupId, setGroupId] = useState(defaultGroupId ?? '')
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await onSubmit(trimmed, groupId || undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      size="sm"
      title={WF.channelUI.createChannel}
      closeLabel={WF.common.cancel}
      onClose={onClose}
      busy={busy}
      onSubmit={e => void handleSubmit(e)}
      secondaryAction={{
        label: WF.common.cancel,
        onInvoke: onClose,
        disabled: busy,
      }}
      primaryAction={{
        label: WF.common.confirm,
        type: 'submit',
        disabled: busy || !name.trim(),
        loading: busy,
      }}
    >
      <div className={css.formItem}>
        <label className={css.formLabel} htmlFor="new-channel-name">{WF.channelUI.channelNameLabel}</label>
        <TextInput
          id="new-channel-name"
          type="text"
          value={name}
          placeholder={WF.channelUI.channelNameExamplePlaceholder}
          maxLength={30}
          autoFocus
          onChange={e => setName(e.target.value)}
        />
      </div>
      <div className={css.formItem}>
        <label className={css.formLabel} htmlFor="channel-group-select">{WF.channelUI.groupSelectLabel}</label>
        <Select
          id="channel-group-select"
          value={groupId}
          onChange={e => setGroupId(e.target.value)}
        >
          <option value="">{WF.channelUI.ungrouped}</option>
          {groups.map(g => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </Select>
      </div>
    </Dialog>
  )
}

/** 单行文本重命名/输入模态弹窗；allowEmpty 时留空也提交 ''（由调用方决定空语义）。 */
function RenameModal({
  title,
  initialValue,
  placeholder,
  allowEmpty,
  onClose,
  onSubmit,
}: {
  readonly title: string
  readonly initialValue: string
  readonly placeholder?: string | undefined
  readonly allowEmpty?: boolean | undefined
  readonly onClose: () => void
  readonly onSubmit: (value: string) => void | Promise<void>
}) {
  const [val, setVal] = useState(initialValue)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = val.trim()
    if ((!trimmed && allowEmpty !== true) || busy) return
    setBusy(true)
    try { await onSubmit(trimmed) } finally { setBusy(false) }
  }

  return (
    <Dialog
      size="sm"
      title={title}
      closeLabel={WF.common.cancel}
      onClose={onClose}
      busy={busy}
      onSubmit={e => void handleSubmit(e)}
      secondaryAction={{
        label: WF.common.cancel,
        onInvoke: onClose,
        disabled: busy,
      }}
      primaryAction={{
        label: WF.common.confirm,
        type: 'submit',
        disabled: busy || (!val.trim() && allowEmpty !== true),
        loading: busy,
      }}
    >
      <div className={css.formItem}>
        <TextInput
          type="text"
          value={val}
          placeholder={placeholder || WF.channelUI.defaultNamePlaceholder}
          maxLength={30}
          autoFocus
          onChange={e => setVal(e.target.value)}
        />
      </div>
    </Dialog>
  )
}
