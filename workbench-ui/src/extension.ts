/** Public type-only browser contract; importing it never imports the core UI or React runtime. */
import type { ComponentType, ReactNode } from 'react'
import type {} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

export type ExtensionDisposer = () => void

/** Opaque extension-owned location. The core does not parse routes or parameter names. */
export interface ExtensionLocation {
  readonly route: string
  readonly params?: Readonly<Record<string, string>>
}

export interface WorkbenchChromeProps {
  readonly activePageId: string | null
  navigate(id: string, location?: ExtensionLocation): void
  openWorkbench(): void
}

export interface WorkbenchPageProps extends WorkbenchChromeProps {
  readonly location: ExtensionLocation
}

export interface WorkbenchPageRegistration {
  readonly id: string
  readonly label: string | (() => string)
  readonly order?: number
  readonly icon?: ComponentType
  readonly component: ComponentType<WorkbenchPageProps>
}

export interface WorkbenchUi {
  /** Atomically registers the page and its navigation entry, or registers neither. */
  registerPage(page: WorkbenchPageRegistration): ExtensionDisposer
  navigate(id: string, location?: ExtensionLocation): void
  openWorkbench(): void
  readonly preferences: WorkbenchPreferences
  readonly components: {
    readonly PageShell: ComponentType<WorkbenchPageShellProps>
    readonly Dialog: ComponentType<WorkbenchDialogProps>
  }
}

export type PreferenceValue =
  | null | boolean | number | string
  | readonly PreferenceValue[]
  | { readonly [key: string]: PreferenceValue }

export type PreferenceFields = Readonly<Record<string, PreferenceValue>>

/** Shared workbench.prefs.v1 container; extensions own fields, not independent whole-object writers. */
export interface WorkbenchPreferences {
  getSnapshot(): PreferenceFields
  subscribe(listener: () => void): ExtensionDisposer
  /** Serialized, persisted shallow merge. Unknown fields survive; null is a value, not deletion. */
  patch(fields: PreferenceFields): Promise<void>
}

/** Root-scoped slots share only navigation capabilities, never a core Store or business face. */
export interface WorkbenchSlotMap {
  'workbench.pages': { kind: 'keyed'; scope: 'root'; owner: WorkbenchPageProps }
  'workbench.navigation': { kind: 'list'; scope: 'root'; owner: WorkbenchChromeProps }
  'workbench.notice': { kind: 'list'; scope: 'root'; owner: WorkbenchChromeProps }
  'workbench.overlay': { kind: 'list'; scope: 'root'; owner: WorkbenchChromeProps }
  'workbench.settings': { kind: 'list'; scope: 'root'; owner: WorkbenchChromeProps }
  /** Optional navigation-header context; no occupant in an unextended core. */
  'workbench.context': { kind: 'single'; scope: 'root'; owner: WorkbenchChromeProps }
}

/** Minimal shared presentation contracts; components remain provided by the shared client runtime. */
export interface WorkbenchPageShellProps {
  readonly maxWidth?: number | undefined
  readonly header?: ReactNode
  readonly subnav?: ReactNode
  readonly banner?: ReactNode
  readonly children?: ReactNode
}

export interface WorkbenchDialogProps {
  readonly title: string
  readonly closeLabel: string
  readonly children: ReactNode
  readonly busy?: boolean
  readonly fullScreen?: boolean
  onClose(): void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap extends WorkbenchSlotMap {}
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workbenchUi: WorkbenchUi
  }
}
