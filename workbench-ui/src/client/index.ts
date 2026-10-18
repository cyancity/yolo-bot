/** Core panel and navigation owners on the official client ModuleLoader/slot lifecycle. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { createPrefsStore, SIDEBAR_TAKEOVER_FIELD } from './prefs.ts'
import { initLocale } from './i18n.ts'
import { WF } from './workforce-strings.ts'
import { createWorkbenchFace } from './face.ts'
import { createWorkbenchNavStore, CORE_CHANNELS_PAGE, CORE_CANVAS_PAGE, CORE_EMPLOYEES_PAGE, PANEL_ID } from './nav.ts'
import { WorkbenchPage } from './page.tsx'
import { WorkbenchSidebar, WorkbenchSidebarRegion, type WorkbenchSidebarInjected } from './sidebar.tsx'
import { installTakeoverStyles } from './takeover-style.ts'
import { WorkbenchSettingsSection, type WorkbenchSettingsInjected } from './settings.tsx'
import { WorkbenchUiService } from './ui-service.tsx'
import { WorkforceWorkspace } from './workforce-workspace.tsx'
import { Icon } from './ui/icons.tsx'
import { createElement, useSyncExternalStore } from 'react'
import type { WorkbenchChromeProps, WorkbenchPageProps } from '../extension.ts'
import { S } from './strings.ts'

export { PANEL_ID }

/** Boot-manifest module id of the official sidebar shell (package name). */
const OFFICIAL_SIDEBAR_MODULE = '@deepseek-ai/dsh-client-ui-sidebar'

/**
 * Whether the official sidebar shell is part of this boot manifest. When it
 * is, the root 'sidebar' single slot and every sidebar.* child declaration
 * belong to its entry; mounting ours there would throw on the shared single
 * slot or the redeclared children. Manifest first — the module list is fixed
 * at boot and does not depend on which plugin's apply() ran first. Without a
 * manifest (tests, alternate shells) fall back to the committed ledger state.
 */
function officialSidebarPlanned(ctx: ClientContext): boolean {
  const boot = (globalThis as { __DSH_BOOT__?: { entries?: readonly { id?: unknown }[] } }).__DSH_BOOT__
  if (boot && Array.isArray(boot.entries)) {
    return boot.entries.some(entry => entry !== null && typeof entry === 'object' && entry.id === OFFICIAL_SIDEBAR_MODULE)
  }
  return ctx.slots.entries('sidebar').length > 0 || ctx.slots.spec('sidebar.brand.mark') !== undefined
}

/** 官方侧栏 panellist 里的工作台行图标（owner 只传几何与选中态）。 */
function SidebarPanelGlyph({ size }: { size: number; active: boolean }) {
  return createElement(Icon, { name: 'users', width: size, height: size })
}

export const inject = ['slots', 'layout', 'sessions', 'uiWorkspace']

export function apply(ctx: ClientContext): void {
  const prefs = createPrefsStore()
  initLocale(ctx, prefs)
  const navHandle = createWorkbenchNavStore()
  const nav = navHandle.create()
  const navStore = { ...navHandle, create: () => nav }
  const face = createWorkbenchFace(ctx, { prefs })
  const chrome: WorkbenchChromeProps = {
    get activePageId() {
      const view = nav.getSnapshot().view
      return view.kind === 'extension' ? view.id : null
    },
    navigate: (id, location) => ctx.workbenchUi.navigate(id, location),
    openWorkbench: () => ctx.layout.selectPanel(PANEL_ID),
  }
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: PANEL_ID,
      children: {
        'workbench.pages': { kind: 'keyed', scope: 'root' },
        'workbench.previews': { kind: 'keyed', scope: 'root' },
        'workbench.notice': { kind: 'list', scope: 'root' },
        'workbench.overlay': { kind: 'list', scope: 'root' },
      }, store: navStore, inject: () => ({ ...face, chrome }),
    }, WorkbenchPage)
    ctx.layout.selectPanel(PANEL_ID)
  })
  const sidebarInjected = (): WorkbenchSidebarInjected => ({
    hooks: { prefs },
    patchPrefs: fields => prefs.patch(fields),
    openWorkbench: chrome.openWorkbench, openChat: face.openNativeChat, toggleColumn: face.toggleSidebar,
    sidebarHidden: () => {
      const view = nav.getSnapshot().view
      return view.kind === 'extension' && view.sidebar === 'hidden'
    },
    workforce: face.workforce, chrome,
    navigation: {
      getSnapshot: () => ctx.slots.getVersion('workbench.navigation'),
      subscribe: listener => ctx.slots.subscribe('workbench.navigation', listener),
      entries: () => ctx.slots.entriesOfSlot('workbench.navigation').map(entry => ({ id: entry.options.id!, order: entry.options.order ?? 0 }))
        .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    },
  })

  if (officialSidebarPlanned(ctx)) {
    // 官方 ui-sidebar 在场：根 'sidebar' 单槽与其 sidebar.* 子 seat 都归官方 entry，
    // 竞争注册或重复声明都会使双方抛错。改为 shadow 它声明的 sidebar.workspaces
    // 单槽（更低 priority 者渲染；撤注册即还原官方 WorkspaceBrowser），并在官方
    // panellist 里补一行工作台面板入口。侧栏接管开关关掉时整段撤注册，官方界面原样恢复。
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: PANEL_ID, order: -10, label: () => S.brand,
    }, SidebarPanelGlyph))
    ctx.slots.inject('sidebar.workspaces', () => {
      let dispose: (() => void) | undefined
      let removeStyles: (() => void) | undefined
      const reconcile = () => {
        const on = prefs.getSnapshot()[SIDEBAR_TAKEOVER_FIELD] !== false
        if (on === (dispose !== undefined)) return
        if (on) {
          removeStyles = installTakeoverStyles()
          dispose = ctx.slots.register({ name: 'sidebar.workspaces', priority: -10,
            children: {
              'workbench.navigation': { kind: 'list', scope: 'root' },
              'workbench.context': { kind: 'single', scope: 'root' },
            }, store: navStore, inject: sidebarInjected }, WorkbenchSidebarRegion)
        } else {
          dispose?.()
          dispose = undefined
          removeStyles?.()
          removeStyles = undefined
        }
      }
      reconcile()
      const unsubscribe = prefs.subscribe(reconcile)
      const unsubscribeLayout = ctx.layout?.panelInfo?.subscribe?.(() => {
        if (ctx.layout?.panelInfo?.getSnapshot()?.activePanelId === PANEL_ID) {
          if (prefs.getSnapshot()[SIDEBAR_TAKEOVER_FIELD] === false) {
            prefs.patch({ [SIDEBAR_TAKEOVER_FIELD]: true })
          }
        }
      })
      return () => {
        unsubscribe()
        unsubscribeLayout?.()
        dispose?.()
        removeStyles?.()
      }
    })
  } else {
    // 无官方侧栏（白标/精简 profile）：独占根 'sidebar' 槽并声明全部子 seat。
    ctx.slots.inject('sidebar', () => ctx.slots.register({ name: 'sidebar',
      children: {
        'sidebar.brand.mark': { kind: 'single', scope: 'root' },
        'sidebar.brand.name': { kind: 'single', scope: 'root' },
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'workbench.navigation': { kind: 'list', scope: 'root' },
        'workbench.context': { kind: 'single', scope: 'root' },
      }, store: navStore,
      inject: sidebarInjected,
    }, WorkbenchSidebar))
  }

  const ui = new WorkbenchUiService(ctx, nav, prefs)
  ctx.slots.inject('workbench.pages', () => ctx.slots.inject('workbench.navigation', function* () {
    const CorePage = (_props: WorkbenchPageProps) => {
      const state = useSyncExternalStore(nav.subscribe, nav.getSnapshot, nav.getSnapshot)
      const view = state.view.kind === 'extension' ? { kind: 'home' as const } : state.view
      return createElement(WorkforceWorkspace, { source: face.workforce, view, setView: nav.actions.setView, onNavigation: face.toggleSidebar })
    }
    yield ui.registerPage({ id: CORE_CHANNELS_PAGE, label: () => WF.nav.channels, order: -20, icon: () => createElement(Icon, { name: 'chat' }), component: CorePage })
    yield ui.registerPage({ id: CORE_CANVAS_PAGE, label: () => WF.nav.canvas, order: -15, icon: () => createElement(Icon, { name: 'direction' }), component: CorePage })
    yield ui.registerPage({ id: CORE_EMPLOYEES_PAGE, label: () => WF.nav.employees, order: -10, icon: () => createElement(Icon, { name: 'profile' }), component: CorePage })
  }))

  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'workbench', order: 20, label: () => S.settings.tab,
    children: { 'workbench.settings': { kind: 'list', scope: 'root' } },
    store: navStore,
    inject: (): WorkbenchSettingsInjected => ({ setZoom: face.setZoom, patchPrefs: fields => prefs.patch(fields), hooks: { prefs }, chrome }),
  }, WorkbenchSettingsSection))
}
