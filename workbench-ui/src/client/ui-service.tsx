/** Official slot registrations and navigation form one disposable page lifecycle. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { WorkbenchUi, WorkbenchPageRegistration, WorkbenchPageProps, WorkbenchChromeProps, ExtensionLocation, WorkbenchPreferences } from '../extension.ts'
import type { WorkbenchNavState, WorkbenchView } from './nav.ts'
import { CORE_CHANNELS_PAGE, CORE_CANVAS_PAGE, CORE_EMPLOYEES_PAGE } from './nav.ts'
import { Dialog, PageShell, cx } from './ui/index.tsx'
import { Icon } from './ui/icons.tsx'
import css from './workforce.module.css'

interface NavigationSource {
  getSnapshot(): WorkbenchNavState
  subscribe(listener: () => void): () => void
  actions: { setView(view: WorkbenchView): void }
}

export class WorkbenchUiService extends Service implements WorkbenchUi {
  private readonly pages = new Map<string, () => void>()
  readonly components = { PageShell, Dialog }
  constructor(ctx: Context, private readonly nav: NavigationSource, readonly preferences: WorkbenchPreferences) {
    super(ctx, 'workbenchUi')
  }
  openWorkbench(): void { this.ctx.layout.selectPanel('workbench' as Parameters<typeof this.ctx.layout.selectPanel>[0]) }
  navigate(id: string, location: ExtensionLocation = { route: '' }): void {
    if (!this.pages.has(id)) { this.nav.actions.setView({ kind: 'home' }); return }
    if (id === CORE_CHANNELS_PAGE) { this.nav.actions.setView({ kind: 'home' }); return }
    if (id === CORE_CANVAS_PAGE) { this.nav.actions.setView({ kind: 'canvas' }); return }
    if (id === CORE_EMPLOYEES_PAGE) { this.nav.actions.setView({ kind: 'employees' }); return }
    this.nav.actions.setView({ kind: 'extension', id, location })
  }
  registerPage(page: WorkbenchPageRegistration): () => void {
    if (this.pages.has(page.id)
      || this.ctx.slots.entries('workbench.pages').some(entry => entry.options.key === page.id)
      || this.ctx.slots.entries('workbench.navigation').some(entry => entry.options.id === page.id)) {
      throw new Error(`Duplicate workbench page id: ${page.id}`)
    }
    const releases: (() => void)[] = []
    const corePage = page.id === CORE_CHANNELS_PAGE || page.id === CORE_EMPLOYEES_PAGE || page.id === CORE_CANVAS_PAGE
    const NavigationEntry = (props: WorkbenchChromeProps) => {
      const active = corePage
        ? page.id === CORE_CANVAS_PAGE
          ? this.nav.getSnapshot().view.kind === 'canvas'
          : page.id === CORE_EMPLOYEES_PAGE
            ? this.nav.getSnapshot().view.kind === 'employees'
            : this.nav.getSnapshot().view.kind === 'home' || ['channel', 'dm'].includes(this.nav.getSnapshot().view.kind)
        : props.activePageId === page.id
      const label = typeof page.label === 'function' ? page.label() : page.label
      const Glyph = page.icon
      return <button type="button" className={cx(css.railButton, active && css.railActive)} title={label} aria-label={label} aria-current={active ? 'page' : undefined}
        onClick={() => { props.openWorkbench(); props.navigate(page.id) }}>
        {Glyph ? <Glyph /> : <Icon name="folder" />}
      </button>
    }
    const PageEntry = ({ activePageId, location, navigate, openWorkbench }: WorkbenchPageProps) =>
      <page.component activePageId={activePageId} location={location} navigate={navigate} openWorkbench={openWorkbench} />
    const dispose = () => {
      if (this.pages.get(page.id) !== dispose) return
      this.pages.delete(page.id)
      for (const release of releases.reverse()) release()
      const view = this.nav.getSnapshot().view
      if (view.kind === 'extension' && view.id === page.id) this.nav.actions.setView({ kind: 'home' })
    }
    try {
      releases.push(this.ctx.slots.register({ name: 'workbench.pages', key: page.id }, PageEntry))
      releases.push(this.ctx.slots.register({ name: 'workbench.navigation', id: page.id, label: page.label, order: page.order ?? 0, inject: () => ({}) }, NavigationEntry))
      this.pages.set(page.id, dispose)
      return this.ctx.effect(() => dispose)
    } catch (error) {
      this.pages.delete(page.id)
      for (const release of releases.reverse()) release()
      throw error
    }
  }
}
