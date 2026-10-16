/** Core navigation column: registered page entries, channels, DMs and user identity. */
import { Icon, type IconName } from './ui/icons.tsx'
import { useEffect, useDeferredValue, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the 'sidebar' slot spec, SidebarOwnerProps, and the
// GlobalStandardProps.usePanelInfo merge.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the sidebar.brand.*/sidebar.settings SlotMap merges.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { PreferenceFields, WorkbenchChromeProps } from '../extension.ts'
import { cx, WorkbenchSurface } from './ui/index.tsx'
import { SIDEBAR_TAKEOVER_FIELD, type PrefsSource } from './prefs.ts'
import { PANEL_ID, type WorkbenchNavActions, type WorkbenchNavState, type WorkbenchView } from './nav.ts'
import { S } from './strings.ts'
import { WF } from './workforce-strings.ts'
import css from './workbench.module.css'
import sub from './sidebar.module.css'
import workforceCss from './workforce.module.css'
import searchCss from './workforce-sidebar-search.module.css'
import dialogCss from './workforce-channels.module.css'
import type { WorkforceSource } from './workforce-source.ts'
import type { Employee, Thread, WorkforceMessage } from './workforce-types.ts'
import { DEFAULT_CHANNEL } from './nav.ts'
import { SidebarListSkeleton, useDelayedLoading } from './workforce-skeleton.tsx'
import { WorkforceAvatar } from './workforce-avatar.tsx'
import type { AvatarMotionState } from './workforce-avatar-motion.ts'
import { WorkforceChannels } from './workforce-channels.tsx'
import { WorkforceChatList, CreateChatModal } from './workforce-chat-list.tsx'
import { WorkforceContextMenu, type ContextMenuSection } from './workforce-context-menu.tsx'
import { UserProfileModal, useUserProfile } from './workforce-profile.tsx'
import { useWorkforcePrefs, type AvatarStyle } from './workforce-prefs.ts'
import { DSH_AVATAR_DATA_URL } from './dsh-icon.ts'
type NavHandle = EngineStoreHandle<WorkbenchNavState, WorkbenchNavActions>

/** Registrant inject face for the sidebar occupant. */
export interface WorkbenchSidebarInjected {
  readonly hooks: { prefs: PrefsSource }
  patchPrefs(fields: PreferenceFields): void
  openWorkbench(): void
  openChat(sessionId: string | undefined): void
  toggleColumn(): void
  workforce: WorkforceSource
  chrome: WorkbenchChromeProps
  navigation: { getSnapshot(): number; subscribe(listener: () => void): () => void; entries(): readonly { id: string; order: number }[] }
}

/** Composed props of the 'sidebar' single-slot entry. */
export type WorkbenchSidebarProps = ComposedProps<
  'sidebar',
  string,
  'sidebar.brand.mark' | 'sidebar.brand.name' | 'sidebar.settings' | 'workbench.navigation' | 'workbench.context',
  NavHandle,
  WorkbenchSidebarInjected
>

/**
 * Composed props of the shadow occupant in the official shell's
 * 'sidebar.workspaces' seat. Used when the official ui-sidebar module is part
 * of the boot manifest: the root 'sidebar' single slot and its sidebar.* child
 * declarations belong to the official entry, so the workforce column mounts
 * inside its region area at shadowing priority instead.
 */
export type WorkbenchSidebarRegionProps = ComposedProps<
  'sidebar.workspaces',
  string,
  'workbench.navigation' | 'workbench.context',
  NavHandle,
  WorkbenchSidebarInjected
>

interface NavItem {
  readonly glyph: IconName
  readonly label: string
  readonly view?: WorkbenchView
}

const NAV_ITEMS: readonly NavItem[] = [
  { glyph: 'today', label: S.nav.today, view: { kind: 'home' } },
]

function itemActive(view: WorkbenchView, item: NavItem): boolean {
  if (item.view === undefined) return false
  return view.kind === item.view.kind
}

/** 原生 AppFrame 窄屏判定：viewport <1024px 时侧栏按 narrowExpanded 覆盖桌面宽度偏好。 */
const narrowViewport = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1023.98px)').matches

/** Chevron glyphs for the brand-row collapse control (inline, no icon-table entry). */
function ToggleGlyph({ collapsed }: { readonly collapsed: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={collapsed ? 'm13 6 6 6-6 6 M5 6v12' : 'M11 6l-6 6 6 6 M19 6v12'} />
    </svg>
  )
}

/** Plain-props sidebar body — the testable seam under the slot entry. */
export interface SidebarBodyProps {
  readonly collapsed: boolean
  readonly view: WorkbenchView
  /** True while the workbench panel is the selected main panel. */
  readonly workbenchActive: boolean
  /** True while the native conversation occupies the main column. */
  readonly chatActive: boolean
  readonly brandMark: ReactNode
  readonly brandName: ReactNode
  /** Resolved `sidebar.settings` content (trigger row / rail icon). */
  readonly settings: ReactNode
  readonly onNavigate: (view: WorkbenchView) => void
  readonly onChat: () => void
  /** Collapse or re-expand the column (brand-row icon). */
  readonly onToggle: () => void
}

/** One nav row: glyph + label in wide mode, glyph-only in the rail. */
function NavRow({ item, active, collapsed, onNavigate }: {
  readonly item: NavItem
  readonly active: boolean
  readonly collapsed: boolean
  readonly onNavigate: (view: WorkbenchView) => void
}) {
  const label = item.label
  return (
    <button
      type="button"
      className={cx(css.sideItem, active && css.sideItemActive)}
      title={collapsed ? label : undefined}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onClick={() => { if (item.view !== undefined) onNavigate(item.view) }}
    >
      <span className={css.sideGlyph} aria-hidden="true"><Icon name={item.glyph} /></span>
      {!collapsed && <span className={css.sideLabel}>{item.label}</span>}
    </button>
  )
}


/** The sidebar column body, driven entirely by resolved props. */
export function SidebarBody(props: SidebarBodyProps) {
  const collapsed = props.collapsed
  return (
    <WorkbenchSurface className={cx(css.side, collapsed && css.sideCollapsed)}>
      <div className={css.sideBrand}>
        <span className={css.sideMark} aria-hidden={collapsed ? undefined : true}>{props.brandMark}</span>
        {!collapsed && <span className={css.sideName}>{props.brandName}</span>}
        <button
          type="button"
          className={css.sideToggle}
          title={collapsed ? S.nav.expand : S.nav.collapse}
          aria-label={collapsed ? S.nav.expand : S.nav.collapse}
          onClick={props.onToggle}
        >
          <ToggleGlyph collapsed={collapsed} />
        </button>
      </div>
      <nav className={css.sideNav} aria-label={S.brand}>
        {NAV_ITEMS.map(item => <NavRow key={item.label} item={item} collapsed={collapsed}
          active={props.workbenchActive && itemActive(props.view, item)} onNavigate={props.onNavigate} />)}
        <button
          type="button"
          className={`${css.sideItem} ${props.chatActive ? css.sideItemActive : ''}`}
          title={collapsed ? S.nav.chat : undefined}
          aria-label={S.nav.chat}
          aria-current={props.chatActive ? 'page' : undefined}
          onClick={props.onChat}
        >
          <span className={css.sideGlyph} aria-hidden="true"><Icon name="chat" /></span>
          {!collapsed && <span className={css.sideLabel}>{S.nav.chat}</span>}
        </button>
      </nav>
      <div className={css.sideFoot}>
        <div className={css.sideSettings}>{props.settings}</div>
      </div>
    </WorkbenchSurface>
  )
}

/**
 * props members shared by the two entry shapes: the root 'sidebar' owner
 * (native sidebar module absent) and the 'sidebar.workspaces' shadow occupant
 * (native sidebar module present). Both receive the same injected face; only
 * the renderSlot key set differs.
 */
interface SidebarCoreProps extends Omit<WorkbenchSidebarInjected, 'hooks'> {
  readonly useStore: WorkbenchSidebarProps['useStore']
  readonly actions: WorkbenchSidebarProps['actions']
  readonly usePrefs: WorkbenchSidebarProps['usePrefs']
  readonly usePanelInfo: WorkbenchSidebarProps['usePanelInfo']
  readonly renderSlot: {
    (key: 'workbench.navigation', owner: WorkbenchChromeProps, opts?: { readonly only?: string }): ReactNode
    (key: 'workbench.context', owner: WorkbenchChromeProps): ReactNode
  }
}

/** Shared state/actions behind both sidebar mount shapes. `collapsed` decides the narrow-viewport auto-fold. */
function useSidebarCore(props: SidebarCoreProps, collapsed: boolean) {
  const view = props.useStore(value => value.view)
  const snapshot = useSyncExternalStore(props.workforce.subscribe, props.workforce.getSnapshot, props.workforce.getSnapshot)
  const [prefs] = useWorkforcePrefs()
  const [profileModalOpen, setProfileModalOpen] = useState(false)
  const userProfile = useUserProfile()
  const [renameBotTarget, setRenameBotTarget] = useState<{ id: string; name: string } | null>(null)
  const [dmContextMenu, setDmContextMenu] = useState<{
    x: number
    y: number
    sections: readonly ContextMenuSection[]
  } | null>(null)
  const [dmCollapsed, setDmCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      return localStorage.getItem('wb:sidebar-dm-section-collapsed:v1') === 'true'
    } catch {
      return false
    }
  })

  const toggleDmSection = () => {
    const next = !dmCollapsed
    setDmCollapsed(next)
    try {
      localStorage.setItem('wb:sidebar-dm-section-collapsed:v1', JSON.stringify(next))
    } catch {}
  }


  const openDmContextMenu = (e: React.MouseEvent, targetId: string, name: string) => {
    e.preventDefault()
    e.stopPropagation()
    const hostThread = snapshot.threads.find((t: Thread) => t.kind === 'dm' && t.employeeId === targetId) as (Thread & { pinned?: boolean }) | undefined
    const isPinned = Boolean(hostThread?.pinned)
    const sections: ContextMenuSection[] = [
      {
        id: 'dm-status',
        items: [
          {
            id: 'mark-read',
            label: WF.sidebarActions.markAsRead,
            onClick: () => {
              if (hostThread) void props.workforce.patchThread(hostThread.id, { markRead: true })
            },
          },
          {
            id: 'toggle-pin',
            label: isPinned ? WF.sidebarActions.unpinDm : WF.sidebarActions.pinDm,
            onClick: () => {
              if (hostThread) void props.workforce.patchThread(hostThread.id, { pinned: !isPinned })
            },
          },
          {
            id: 'rename-bot',
            label: WF.sidebarActions.rename,
            onClick: () => {
              setRenameBotTarget({ id: targetId, name })
            },
          },
        ],
      },
      {
        id: 'dm-id',
        items: [
          {
            id: 'copy-id',
            label: WF.sidebarActions.copyId,
            onClick: () => {
              if (typeof navigator !== 'undefined' && navigator.clipboard) {
                void navigator.clipboard.writeText(targetId)
              }
            },
          },
        ],
      },
    ]
    setDmContextMenu({ x: e.clientX, y: e.clientY, sections })
  }

  const showSidebarSkeleton = useDelayedLoading(
    snapshot.phase === 'loading' && snapshot.channels.length === 0,
    150,
  )
  const navigationVersion = useSyncExternalStore(props.navigation.subscribe, props.navigation.getSnapshot, props.navigation.getSnapshot)
  void navigationVersion
  const activePanelId = props.usePanelInfo(info => info.activePanelId)
  const chrome: WorkbenchChromeProps = {
    ...props.chrome,
    activePageId: view.kind === 'extension' ? view.id : null,
    openWorkbench: props.openWorkbench,
    navigate: (id, location) => {
      props.chrome.navigate(id, location)
      if (!collapsed && narrowViewport()) props.toggleColumn()
    },
  }
  const navigate = (next: WorkbenchView): void => {
    props.actions.setView(next)
    props.openWorkbench()
    // 窄视口（原生阈值 <1024px）下侧栏常驻挤压正文不可读（390 实测抽屉内容仅 29px）：
    // 选频道/员工后收起侧栏回正文。已收起不 toggle，避免把 rail 导航又展开。
    if (!collapsed && narrowViewport()) props.toggleColumn()
  }

  const pinOf = (employeeId: string): boolean =>
    Boolean((snapshot.threads.find(t => t.kind === 'dm' && t.employeeId === employeeId) as { pinned?: boolean } | undefined)?.pinned)
  const activeEmployees = [...snapshot.employees].sort((a, b) => Number(pinOf(b.id)) - Number(pinOf(a.id)))

  const deletedThreads = snapshot.threads.filter(
    (thread: Thread) => thread.kind === 'dm' && thread.employeeId && !snapshot.employees.some((employee: Employee) => employee.id === thread.employeeId)
  )
  const activeActivities = useMemo(() => {
    const table: Record<string, AvatarMotionState> = {}
    if (snapshot.messages) {
      for (const tm of Object.values(snapshot.messages)) {
        if (tm?.activity) {
          for (const a of tm.activity) {
            if (a?.employeeId && a?.state) {
              table[a.employeeId] =
                a.state === 'tool' ? 'searching' : a.state === 'typing' ? 'working' : 'thinking'
            }
          }
        }
      }
    }
    return table
  }, [snapshot.messages])

  return {
    view, snapshot, prefs, activePanelId, chrome, navigate, navigation: props.navigation,
    workforce: props.workforce,
    profileModalOpen, setProfileModalOpen, renameBotTarget, setRenameBotTarget, dmContextMenu, setDmContextMenu,
    dmCollapsed, toggleDmSection, openDmContextMenu, showSidebarSkeleton,
    pinOf, activeEmployees, deletedThreads, activeActivities, userProfile,
  }
}

type SidebarCore = ReturnType<typeof useSidebarCore>

/** 频道列内容：品牌名行（可选）、上下文 seat、频道/私信列表与页脚。 */
function SidebarChannelColumn({ core, brandName, context }: {
  readonly core: SidebarCore
  /** Mode A 根槽入口传入 sidebar.brand.name 渲染结果；Mode B 省略（官方 brand 行保留）。 */
  readonly brandName?: ReactNode
  readonly context: ReactNode
}) {
  const { view, snapshot, prefs, navigate } = core
  const [createChatOpen, setCreateChatOpen] = useState(false)
  // 导航结构由 style 决定（sidebar-chat-list 卡 D2 判据）：WeChat 会话优先单列表，
  // Discord 分组频道 + 私信区。旧 sidebarMode 只作 V1 迁移读取，不再入偏好。
  const chatStyle = prefs.style === 'wechat'
  return (
    <div className={workforceCss.channelColumn}>
      {brandName !== undefined && (
        <div className={workforceCss.workspaceBrand}>
          <SidebarHistorySearch
            messages={snapshot.messages}
            threads={snapshot.threads}
            channels={snapshot.channels}
            employees={snapshot.employees}
            avatarStyle={prefs.avatarStyle}
            onNavigate={navigate}
            onAddChat={() => setCreateChatOpen(true)}
          />
        </div>
      )}
      {context}
      {createChatOpen && (
        <CreateChatModal
          employees={snapshot.employees}
          onClose={() => setCreateChatOpen(false)}
          onSubmit={async input => {
            setCreateChatOpen(false)
            const fallback = input.memberIds.length > 0
              ? snapshot.employees.filter(e => input.memberIds.includes(e.id)).map(e => e.name).join('、')
              : WF.common.groupChat
            const name = input.title.trim() || fallback
            const created = await core.workforce.createChannel(name, null, {
              groupChatName: input.title.trim() || undefined,
              memberIds: input.memberIds.length > 0 ? input.memberIds : undefined,
            })
            navigate({ kind: 'channel', id: created.id })
          }}
        />
      )}
      <div className={workforceCss.channelScroll}>
        {core.showSidebarSkeleton ? (
          <SidebarListSkeleton />
        ) : chatStyle ? (
          <WorkforceChatList
            channels={snapshot.channels}
            threads={snapshot.threads}
            employees={snapshot.employees}
            messages={snapshot.messages}
            activeChannelId={view.kind === 'home' ? DEFAULT_CHANNEL : view.kind === 'channel' ? view.id : undefined}
            activeDmEmployeeId={view.kind === 'dm' ? view.id : undefined}
            avatarStyle={prefs.avatarStyle}
            typingEffect={prefs.typingEffect}
            employeeMotion={core.activeActivities}
            onSelectChannel={channelId => navigate({ kind: 'channel', id: channelId })}
            onSelectDm={employeeId => navigate({ kind: 'dm', id: employeeId })}
            onCreateChatReq={async input => {
              const created = await core.workforce.createChannel(input.name, null, { groupChatName: input.groupChatName, memberIds: input.memberIds })
              return created.id
            }}
            onPatchChannelReq={async (channelId, patch) => {
              await core.workforce.patchChannel(channelId, patch)
            }}
            onMarkChannelReadReq={async (channelId) => {
              await core.workforce.markChannelRead(channelId)
            }}
            onDuplicateChannelReq={async (channelId) => {
              await core.workforce.duplicateChannel(channelId)
            }}
            onDeleteChannelReq={async (channelId) => {
              await core.workforce.deleteChannel(channelId)
              if (view.kind === 'channel' && view.id === channelId) {
                navigate({ kind: 'channel', id: DEFAULT_CHANNEL })
              }
            }}
            onPatchThreadReq={async (threadId, patch) => {
              await core.workforce.patchThread(threadId, patch)
            }}
            onPatchEmployeeReq={async (employeeId, patch) => {
              if (patch.name !== undefined) {
                await core.workforce.updateEmployee(employeeId, { name: patch.name })
              }
            }}
          />
        ) : <>
          <WorkforceChannels
            channels={snapshot.channels}
            groups={core.workforce.getChannelGroups()}
            activeChannelId={view.kind === 'home' ? DEFAULT_CHANNEL : view.kind === 'channel' ? view.id : undefined}
            onSelectChannel={channelId => navigate({ kind: 'channel', id: channelId })}
            onCreateChannelReq={async (name, groupId) => {
              const created = await core.workforce.createChannel(name, groupId)
              return created.id
            }}
            onRenameChannelReq={async (channelId, name) => {
              await core.workforce.renameChannel(channelId, name)
            }}
            onPatchChannelReq={async (channelId, patch) => {
              await core.workforce.patchChannel(channelId, patch)
            }}
            onMarkChannelReadReq={async (channelId) => {
              await core.workforce.markChannelRead(channelId)
            }}
            onDuplicateChannelReq={async (channelId) => {
              await core.workforce.duplicateChannel(channelId)
            }}
            onDeleteChannelReq={async (channelId) => {
              await core.workforce.deleteChannel(channelId)
              if (view.kind === 'channel' && view.id === channelId) {
                navigate({ kind: 'channel', id: DEFAULT_CHANNEL })
              }
            }}
            onCreateGroupReq={async (name) => {
              await core.workforce.createChannelGroup(name)
            }}
            onRenameGroupReq={async (groupId, name) => {
              await core.workforce.patchChannelGroup(groupId, { name })
            }}
            onDeleteGroupReq={async (groupId) => {
              await core.workforce.deleteChannelGroup(groupId)
            }}
          />
          <div className={sub.sectionDivider} role="separator" aria-orientation="horizontal" />
          <button type="button" className={sub.dmSectionHeadBtn} onClick={core.toggleDmSection} aria-expanded={!core.dmCollapsed}>
            <span className={`${sub.dmChevron} ${core.dmCollapsed ? sub.dmChevronCollapsed : ''}`}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </span>
            {WF.nav.dms}
          </button>
          {!core.dmCollapsed && core.activeEmployees.map(employee => (
            <button
              key={employee.id}
              type="button"
              className={cx(workforceCss.listItem, view.kind === 'dm' && view.id === employee.id && workforceCss.listItemActive)}
              onClick={() => navigate({ kind: 'dm', id: employee.id })}
              onContextMenu={e => core.openDmContextMenu(e, employee.id, employee.name)}
            >
              <span className={sub.dmAvatarWrap}>
                <WorkforceAvatar
                  name={employee.name}
                  color={employee.avatarColor}
                  role={employee.role}
                  style={prefs.avatarStyle}
                  size={20}
                  state={core.activeActivities[employee.id] ?? 'idle'}
                  live={Boolean(core.activeActivities[employee.id])}
                />
              </span>
              <span className={workforceCss.listLabel}>{employee.name}</span>
              {employee.isLeader && <span className={workforceCss.employeeLabel}>{WF.common.lead}</span>}
              {core.pinOf(employee.id) && (
                <span className={sub.dmPinBadge} title={WF.common.pinned}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="17" x2="12" y2="22"/>
                    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>
                  </svg>
                </span>
              )}
            </button>
          ))}
          {!core.dmCollapsed && core.deletedThreads.map((thread: Thread) => (
            <button
              key={thread.id}
              type="button"
              className={cx(
                workforceCss.listItem,
                sub.dmItemDimmed,
                view.kind === 'dm' && view.id === thread.employeeId && workforceCss.listItemActive
              )}
              onClick={() => navigate({ kind: 'dm', id: thread.employeeId! })}
              onContextMenu={e => core.openDmContextMenu(e, thread.employeeId!, thread.title)}
            >
              <span className={sub.dmAvatarWrap}>
                <WorkforceAvatar
                  name={thread.title || WF.common.employee}
                  tone="#8a8a80"
                  style={prefs.avatarStyle}
                  size={20}
                  state="sleeping"
                  live={false}
                />
              </span>
              <span className={workforceCss.listLabel}>{thread.title}</span>
              <span className={workforceCss.employeeLabel}>{WF.common.offline}</span>
            </button>
          ))}
        </>}
        {snapshot.error && <div className={workforceCss.streamError} role="alert">{snapshot.error}</div>}
      </div>

    </div>
  )
}

/** Profile modal + DM context menu shared by both mount shapes. */
function SidebarOverlays({ core }: { readonly core: SidebarCore }) {
  return <>
    {core.profileModalOpen && <UserProfileModal onClose={() => core.setProfileModalOpen(false)} />}
    {core.dmContextMenu && (
      <WorkforceContextMenu
        x={core.dmContextMenu.x}
        y={core.dmContextMenu.y}
        sections={core.dmContextMenu.sections}
        onClose={() => core.setDmContextMenu(null)}
      />
    )}
    {core.renameBotTarget && (
      <RenameBotModal
        employeeId={core.renameBotTarget.id}
        currentName={core.renameBotTarget.name}
        onClose={() => core.setRenameBotTarget(null)}
        onSubmit={async nextName => {
          const targetId = core.renameBotTarget?.id
          if (!targetId) return
          core.setRenameBotTarget(null)
          await core.workforce.updateEmployee(targetId, { name: nextName })
        }}
      />
    )}
  </>
}

/** Bot rename modal portaled to document.body */
function RenameBotModal({
  currentName,
  onClose,
  onSubmit,
}: {
  readonly employeeId: string
  readonly currentName: string
  readonly onClose: () => void
  readonly onSubmit: (name: string) => Promise<void> | void
}) {
  const [val, setVal] = useState(currentName)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = val.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await onSubmit(trimmed)
    } finally {
      setBusy(false)
    }
  }

  const modal = (
    <div className={dialogCss.dialogBackdrop} onClick={onClose}>
      <div
        className={dialogCss.dialogCard}
        role="dialog"
        aria-modal="true"
        aria-label={WF.sidebarActions.renameEmployee}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.key === 'Escape' && !busy) {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <h3 className={dialogCss.dialogTitle}>{WF.sidebarActions.renameEmployee}</h3>
        <form className={dialogCss.dialogForm} onSubmit={e => void handleSubmit(e)}>
          <div className={dialogCss.formItem}>
            <label className={dialogCss.formLabel} htmlFor="rename-bot-name-input">{WF.sidebarActions.employeeName}</label>
            <input
              id="rename-bot-name-input"
              ref={inputRef}
              type="text"
              className={dialogCss.inputField}
              value={val}
              placeholder={WF.common.enterNewName}
              maxLength={30}
              onChange={e => setVal(e.target.value)}
            />
          </div>
          <div className={dialogCss.dialogFooter}>
            <button type="button" className={dialogCss.cancelBtn} onClick={onClose} disabled={busy}>{WF.common.cancel}</button>
            <button type="submit" className={dialogCss.submitBtn} disabled={busy || !val.trim()}>{busy ? WF.models.saving : WF.common.confirm}</button>
          </div>
        </form>
      </div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal
}

/** Keyword search matching result */
interface SearchResultItem {
  readonly messageId: string
  readonly threadId: string
  readonly text: string
  readonly ts: string
  readonly role: 'user' | 'agent' | 'system'
  readonly senderName: string
  readonly navView: WorkbenchView
  readonly targetTitle: string
  readonly avatarEmployee?: Employee | undefined
}

function formatSearchTime(ts: string): string {
  try {
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return ''
    const now = new Date()
    const isSameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
    if (isSameDay) {
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }
    return `${date.getMonth() + 1}/${date.getDate()}`
  } catch {
    return ''
  }
}

/** Highlight snippet around keyword */
function HighlightedSnippet({ text, query }: { readonly text: string; readonly query: string }) {
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const index = lowerText.indexOf(lowerQuery)
  if (index === -1) {
    return <span>{text.slice(0, 80)}</span>
  }
  const start = Math.max(0, index - 20)
  const end = Math.min(text.length, index + query.length + 40)
  const prefix = (start > 0 ? '…' : '') + text.slice(start, index)
  const matched = text.slice(index, index + query.length)
  const suffix = text.slice(index + query.length, end) + (end < text.length ? '…' : '')

  return (
    <span>
      {prefix}
      <span className={searchCss.highlight}>{matched}</span>
      {suffix}
    </span>
  )
}

/** Top sidebar search box for chat history */
function SidebarHistorySearch({
  messages,
  threads,
  channels,
  employees,
  avatarStyle,
  onNavigate,
  onAddChat,
}: {
  readonly messages?: Readonly<Record<string, { readonly list: readonly WorkforceMessage[] }>> | undefined
  readonly threads: readonly Thread[]
  readonly channels: readonly { readonly id: string; readonly name: string; readonly groupChatName?: string | null }[]
  readonly employees: readonly Employee[]
  readonly avatarStyle?: AvatarStyle | undefined
  readonly onNavigate: (view: WorkbenchView) => void
  readonly onAddChat?: (() => void) | undefined
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const deferredQuery = useDeferredValue(query)
  const containerRef = useRef<HTMLDivElement>(null)

  const employeeMap = useMemo(() => new Map(employees.map(e => [e.id, e])), [employees])
  const channelMap = useMemo(() => new Map(channels.map(c => [c.id, c])), [channels])
  const threadMap = useMemo(() => new Map(threads.map(t => [t.id, t])), [threads])

  const results = useMemo<SearchResultItem[]>(() => {
    const q = deferredQuery.trim().toLowerCase()
    if (!q || !messages) return []

    const matches: SearchResultItem[] = []
    for (const [threadId, threadMsgs] of Object.entries(messages)) {
      if (!threadMsgs?.list) continue
      const thread = threadMap.get(threadId)

      let navView: WorkbenchView | undefined
      let targetTitle: string = WF.common.session
      let avatarEmployee: Employee | undefined

      if (thread?.kind === 'dm' && thread.employeeId) {
        navView = { kind: 'dm', id: thread.employeeId }
        const emp = employeeMap.get(thread.employeeId)
        avatarEmployee = emp
        targetTitle = emp ? emp.name : (thread.title || WF.nav.dms)
      } else if (thread?.kind === 'channel' && thread.channelId) {
        navView = { kind: 'channel', id: thread.channelId }
        const ch = channelMap.get(thread.channelId)
        targetTitle = ch?.groupChatName?.trim() || ch?.name || thread.title || WF.nav.channels
      } else if (thread?.taskId) {
        if (thread.channelId) {
          navView = { kind: 'channel', id: thread.channelId }
          const ch = channelMap.get(thread.channelId)
          targetTitle = ch?.groupChatName?.trim() || ch?.name || WF.common.channelTask
        } else if (thread.employeeId) {
          navView = { kind: 'dm', id: thread.employeeId }
          const emp = employeeMap.get(thread.employeeId)
          avatarEmployee = emp
          targetTitle = emp ? emp.name : WF.common.employeeTask
        }
      } else {
        // Fallback for threadId if matching a channel directly
        const ch = channelMap.get(threadId)
        if (ch) {
          navView = { kind: 'channel', id: ch.id }
          targetTitle = ch.groupChatName?.trim() || ch.name
        }
      }

      if (!navView) continue

      for (const msg of threadMsgs.list) {
        if (msg.text && msg.text.toLowerCase().includes(q)) {
          const senderEmp = employeeMap.get(msg.senderId)
          matches.push({
            messageId: msg.id,
            threadId,
            text: msg.text,
            ts: msg.ts,
            role: msg.role,
            senderName: msg.senderName || senderEmp?.name || (msg.role === 'user' ? WF.common.me : WF.common.bot),
            navView,
            targetTitle,
            avatarEmployee: senderEmp ?? avatarEmployee,
          })
          if (matches.length >= 40) break
        }
      }
      if (matches.length >= 40) break
    }

    // Sort by timestamp descending
    matches.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    return matches
  }, [deferredQuery, messages, threadMap, employeeMap, channelMap])

  // Click outside to close dropdown
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setQuery('')
      setOpen(false)
    }
  }

  const handleSelectResult = (item: SearchResultItem) => {
    onNavigate(item.navView)
    setOpen(false)
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('workforce:jump-to-message', {
          detail: { messageId: item.messageId, threadId: item.threadId },
        })
      )
    }, 120)
  }

  const isSearching = query.trim().length > 0

  return (
    <div className={searchCss.searchContainer} ref={containerRef} onKeyDown={handleKeyDown}>
      <div className={searchCss.searchRow}>
        <div className={searchCss.searchBar}>
          <span className={searchCss.searchIcon} aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </span>
          <input
            type="text"
            className={searchCss.searchInput}
            placeholder={WF.common.search}
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setOpen(true)
            }}
            onFocus={() => {
              if (query.trim()) setOpen(true)
            }}
          />
          {isSearching && (
            <button
              type="button"
              className={searchCss.clearBtn}
              title={WF.common.clearSearch}
              aria-label={WF.common.clearSearch}
              onClick={() => {
                setQuery('')
                setOpen(false)
              }}
            >
              ×
            </button>
          )}
        </div>
        {onAddChat && (
          <button
            type="button"
            className={searchCss.addChatBtn}
            title={WF.common.createGroupChat}
            aria-label={WF.common.createGroupChat}
            onClick={onAddChat}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9"/>
              <line x1="12" y1="8" x2="12" y2="16" />
              <line x1="8" y1="12" x2="16" y2="12" />
            </svg>
          </button>
        )}
      </div>

      {open && isSearching && (
        <div className={searchCss.dropdownPopover} role="listbox">
          {results.length === 0 ? (
            <div className={searchCss.noResults}>{WF.common.noMatchingMessages}</div>
          ) : (
            results.map(item => (
              <button
                key={`${item.threadId}-${item.messageId}`}
                type="button"
                className={searchCss.resultItem}
                onClick={() => handleSelectResult(item)}
              >
                {item.avatarEmployee ? (
                  <span className={searchCss.resultAvatar}>
                    <WorkforceAvatar
                      name={item.avatarEmployee.name}
                      color={item.avatarEmployee.avatarColor}
                      role={item.avatarEmployee.role}
                      style={avatarStyle}
                      size={20}
                    />
                  </span>
                ) : (
                  <span className={searchCss.resultAvatar}>
                    <WorkforceAvatar
                      name={item.senderName}
                      tone="#8a8a80"
                      style={avatarStyle}
                      size={20}
                    />
                  </span>
                )}
                <div className={searchCss.resultContent}>
                  <div className={searchCss.resultMetaRow}>
                    <span className={searchCss.resultTargetName}>{item.targetTitle}</span>
                    <span className={searchCss.resultTime}>{formatSearchTime(item.ts)}</span>
                  </div>
                  <div className={searchCss.resultAuthorRow}>
                    <span>{item.senderName}</span>
                  </div>
                  <div className={searchCss.resultSnippet}>
                    <HighlightedSnippet text={item.text} query={deferredQuery.trim()} />
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}


/**
 * The 'sidebar' occupant: wires the nav store, panel selection, catalog and
 * prefs onto the plain-props body.
 */
export function WorkbenchSidebar(props: WorkbenchSidebarProps) {
  const core = useSidebarCore(props, props.collapsed)
  // 侧栏接管开关（workbench.prefs.sidebarTakeover，默认开）：关掉即回退经典导航体。
  const takeover = props.usePrefs(value => value[SIDEBAR_TAKEOVER_FIELD] !== false)
  const brandMark = props.renderSlot('sidebar.brand.mark', { size: 20 }, { fallback: <span>{S.nav.brandGlyph}</span> })

  if (!takeover) {
    return (
      <SidebarBody
        collapsed={props.collapsed}
        view={core.view}
        workbenchActive={core.activePanelId === PANEL_ID}
        chatActive={core.activePanelId === null}
        brandMark={brandMark}
        brandName={props.renderSlot('sidebar.brand.name', {}, { fallback: <span>{S.brand}</span> })}
        settings={props.renderSlot('sidebar.settings', { wide: !props.collapsed })}
        onNavigate={core.navigate}
        onChat={() => props.openChat(undefined)}
        onToggle={props.toggleColumn}
      />
    )
  }

  return (
    <WorkbenchSurface className={workforceCss.sidebar} data-workforce-sidebar data-wb-style={core.prefs.style}>
      <nav className={workforceCss.rail} aria-label={WF.common.workbenchNav}>
        <div className={workforceCss.railUser}>
          <button
            type="button"
            className={workforceCss.railUserBtn}
            title={WF.common.userProfileTitle(core.userProfile.name || WF.common.user)}
            aria-label={WF.common.userProfileAria}
            onClick={() => core.setProfileModalOpen(true)}
          >
            <WorkforceAvatar
              name={core.userProfile.name || WF.common.user}
              isUser={true}
              size={36}
            />
          </button>
        </div>
        {core.navigation.entries().map(entry => <span key={entry.id}>
          {props.renderSlot('workbench.navigation', core.chrome, { only: entry.id })}
        </span>)}
        <div className={workforceCss.railFoot}>
          {props.renderSlot('sidebar.settings', { wide: false })}
        </div>
      </nav>
      {!props.collapsed && (
        <SidebarChannelColumn
          core={core}
          brandName={props.renderSlot('sidebar.brand.name', {}, { fallback: <span>{S.brand}</span> })}
          context={props.renderSlot('workbench.context', core.chrome)}
        />
      )}
      <SidebarOverlays core={core} />
    </WorkbenchSurface>
  )
}

/**
 * Shadow occupant of the official shell's 'sidebar.workspaces' seat, mounted
 * only while sidebarTakeover is on. The official chrome (brand row, panel list,
 * settings foot) stays live around it, so the slot is revoked by disposing the
 * registration rather than by rendering a fallback.
 */
export function WorkbenchSidebarRegion(props: WorkbenchSidebarRegionProps) {
  const takeover = props.usePrefs(value => value[SIDEBAR_TAKEOVER_FIELD] !== false)
  const core = useSidebarCore(props, !props.wide)
  const onReturnToDsh = () => {
    props.patchPrefs({ [SIDEBAR_TAKEOVER_FIELD]: false })
    props.openChat(undefined)
  }
  if (!takeover) return null
  const safeRender = <T,>(fn: () => T): T | undefined => {
    try {
      return fn()
    } catch {
      return undefined
    }
  }
  return (
    <WorkbenchSurface className={workforceCss.region} data-workforce-sidebar data-wb-style={core.prefs.style}>
      <nav className={workforceCss.regionRail} aria-label={WF.common.workbenchNav}>
        <div className={workforceCss.railUser}>
          <button
            type="button"
            className={workforceCss.railUserBtn}
            title={WF.common.userProfileTitle(core.userProfile.name || WF.common.user)}
            aria-label={WF.common.userProfileAria}
            onClick={() => core.setProfileModalOpen(true)}
          >
            <WorkforceAvatar
              name={core.userProfile.name || WF.common.user}
              isUser={true}
              size={36}
            />
          </button>
        </div>
        {core.navigation.entries().map(entry => <span key={entry.id}>
          {safeRender(() => props.renderSlot('workbench.navigation', core.chrome, { only: entry.id }))}
        </span>)}
        <div className={workforceCss.railFoot}>
          <button
            type="button"
            className={workforceCss.railButton}
            title={S.nav.chat}
            aria-label={S.nav.chat}
            data-action="return-native"
            onClick={onReturnToDsh}
          >
            <img
              src={DSH_AVATAR_DATA_URL}
              alt={S.nav.chat}
              width={26}
              height={26}
              style={{ borderRadius: '6px', objectFit: 'contain' }}
            />
          </button>
        </div>
      </nav>
      {props.wide && (
        <SidebarChannelColumn
          core={core}
          brandName={<span>{S.brand}</span>}
          context={safeRender(() => props.renderSlot('workbench.context', core.chrome))}
        />
      )}
      <SidebarOverlays core={core} />
    </WorkbenchSurface>
  )
}
