/** Core conversation navigation and opaque extension-owned page selection. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ExtensionLocation } from '../extension.ts'

/** 本插件的主面板 key（'workbench'）。 */
export const PANEL_ID = 'workbench' as MainPanelId

export type WorkbenchView =
  | { readonly kind: 'home' }
  | { readonly kind: 'channel'; readonly id: string }
  | { readonly kind: 'dm'; readonly id: string }
  | { readonly kind: 'employees' }
  | { readonly kind: 'canvas' }
  | { readonly kind: 'extension'; readonly id: string; readonly location: ExtensionLocation }
export type WorkbenchNavState = { view: WorkbenchView }
export type WorkbenchNavActions = { setView: (draft: WorkbenchNavState, view: WorkbenchView) => void }
export const DEFAULT_CHANNEL = 'general'
export const CORE_CHANNELS_PAGE = 'workbench.channels'
export const CORE_CANVAS_PAGE = 'workbench.canvas'
export const CORE_EMPLOYEES_PAGE = 'workbench.employees'

export function createWorkbenchNavStore(): EngineStoreHandle<WorkbenchNavState, WorkbenchNavActions> {
  return defineStore({
    init: (): WorkbenchNavState => ({ view: { kind: 'home' } }),
    actions: { setView: (draft, view: WorkbenchView) => { draft.view = view } },
  })
}
