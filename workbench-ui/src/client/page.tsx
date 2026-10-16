/** Main-panel owner of page content, notices and overlays. */
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { WorkbenchFace } from './face.ts'
import type { WorkbenchChromeProps, WorkbenchPageProps as ExtensionPageProps } from '../extension.ts'
import type { WorkbenchNavActions, WorkbenchNavState } from './nav.ts'
import { CORE_CHANNELS_PAGE, CORE_CANVAS_PAGE, CORE_EMPLOYEES_PAGE } from './nav.ts'
import { AppHeaderProvider, WorkbenchSurface } from './ui/index.tsx'
import { useZoom, zoomStyle } from './ui/zoom.ts'
import { GlobalModelAccess } from './workforce-models.tsx'
import css from './workbench.module.css'

type NavHandle = EngineStoreHandle<WorkbenchNavState, WorkbenchNavActions>
export type WorkbenchPageProps = ComposedProps<'main', string,
  'workbench.pages' | 'workbench.notice' | 'workbench.overlay', NavHandle,
  WorkbenchFace & { chrome: WorkbenchChromeProps }>

export function WorkbenchPage(props: WorkbenchPageProps) {
  const view = props.useStore(value => value.view)
  const { zoom } = useZoom(props.usePrefs(value => value.zoom))
  const chrome: WorkbenchChromeProps = { ...props.chrome, activePageId: view.kind === 'extension' ? view.id : null }
  const pageId = view.kind === 'extension' ? view.id : view.kind === 'employees' ? CORE_EMPLOYEES_PAGE : view.kind === 'canvas' ? CORE_CANVAS_PAGE : CORE_CHANNELS_PAGE
  const page: ExtensionPageProps = { ...chrome, location: view.kind === 'extension' ? view.location : { route: '' } }
  return <WorkbenchSurface className={css.root} style={zoomStyle(zoom)} data-workbench-root>
    {props.renderSlot('workbench.notice', chrome)}
    <AppHeaderProvider><div className={css.body}>{props.renderSlot('workbench.pages', page, { entryKey: pageId })}</div></AppHeaderProvider>
    {props.renderSlot('workbench.overlay', chrome)}
    <GlobalModelAccess source={props.workforce.models} />
  </WorkbenchSurface>
}
