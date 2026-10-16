/** Core-only UI facade. Extension slots receive navigation capabilities, not this face. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { WorkforceApi } from './workforce-api.ts'
import { WorkforceSource } from './workforce-source.ts'
import { WorkforceModelsSource } from './workforce-models-source.ts'
import { bindWorkforceFileSession } from './workforce-attachments.tsx'
import { normalizeZoom, type PrefsSource, type ZoomPref } from './prefs.ts'

export interface WorkbenchFace {
  readonly workforce: WorkforceSource
  readonly hooks: { readonly prefs: PrefsSource }
  toggleSidebar(): void
  openNativeChat(sessionId: string | undefined): void
  setZoom(zoom: ZoomPref): Promise<void>
}
export function createWorkbenchFace(ctx: Context, deps: { readonly prefs: PrefsSource }): WorkbenchFace {
  bindWorkforceFileSession(ctx.get?.('remote.session'))
  const api = new WorkforceApi()
  const models = new WorkforceModelsSource(api)
  const workforce = new WorkforceSource(api, 2000, models, ctx.sessions)
  return {
    workforce,
    hooks: { prefs: deps.prefs },
    toggleSidebar: () => ctx.layout.toggleSidebar(),
    openNativeChat(sessionId) {
      if (sessionId !== undefined && sessionId !== '') ctx.uiWorkspace.openSession(sessionId as SessionId)
      else ctx.layout.selectPanel(null)
    },
    setZoom: zoom => deps.prefs.patch({ zoom: normalizeZoom(zoom) }),
  }
}
