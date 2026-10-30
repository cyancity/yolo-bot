/** Core bot composition and public extension services. Runtime identifiers remain stable. */
import { join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import manifest from '../package.json' with { type: 'json' }
import type { Admission } from './extension.ts'
import { API_PREFIX, WorkbenchRouter } from './routes.ts'
import { WorkbenchLifecycle } from './info.ts'
import { WorkbenchUserSkills } from './user-skills.ts'
import { createModelsHandler } from './models.ts'
import { registerSkills } from './skills.ts'
import { WorkforceStore } from './workforce/store.ts'
import { WorkforceRuntime } from './workforce/runtime.ts'
import { createWorkforceHandler } from './workforce/routes.ts'
import { EmployeeMcp } from './workforce/mcp.ts'
import { WorkbenchTemplateService } from './workforce/templates.ts'
import { registerWorkforceTools } from './workforce/tools.ts'
import type { EmployeeToolProvider } from './workforce/employee-tool-contract.ts'

export const name = 'workbench'
export const inject = ['webServer', 'tools', 'skills']

export interface Config {
  /** Empty resolves to <DSH_HOME>/workbench. */
  root: string
  /** Persistent projection cache; false uses cold native event reads. */
  sessionEventCache?: boolean
  /** local confines employee tools; native requires a logical-root-capable host provider. */
  employeeToolProvider?: EmployeeToolProvider
}

export const Config: z<Config> = z.object({
  root: z.string().default(''),
  sessionEventCache: z.boolean().default(true),
  employeeToolProvider: z.union([z.const('local'), z.const('native'), z.const('pass-through')]).default('local'),
})

interface ConnectionLike { admit(request: { readonly headers: unknown }): Admission }
interface WebServerLike {
  register(route: { kind: 'prefix'; path: string; handler(request: IncomingMessage, response: ServerResponse): Promise<void> }): () => void
}

export function apply(ctx: Context, config: Config): void {
  const root = resolve(config.root || join(resolveDshHome(), 'workbench'))
  const userRoot = join(resolveDshHome(), 'skills')
  const get = (service: string): unknown => ctx.get(service)
  const workforce = new WorkforceRuntime(new WorkforceStore(root), get, userRoot, config.sessionEventCache, config.employeeToolProvider)
  const lifecycle = new WorkbenchLifecycle(manifest.version, () => workforce.isIdle())
  workforce.lifecycle = lifecycle
  const refresh = registerSkills(ctx as never)
  workforce.refreshSkills = refresh
  const userSkills = new WorkbenchUserSkills(workforce.store, userRoot, refresh, lifecycle)
  const templates = new WorkbenchTemplateService(workforce.store, lifecycle)
  const employeeMcp = new EmployeeMcp(workforce, get)
  workforce.mcpSignatureOf = agent => employeeMcp.mountedSignature(agent)
  employeeMcp.install(ctx as never)
  registerWorkforceTools(workforce, ctx as never)

  ctx.effect(() => ctx.provide('workbenchInfo', lifecycle), 'workbench: lifecycle')
  ctx.effect(() => ctx.provide('workbenchSkills', userSkills), 'workbench: user skills')
  ctx.effect(() => ctx.provide('workbenchTemplates', templates), 'workbench: templates')
  ctx.on('agent/created', async ({ agent }) => { await workforce.prepareEmployeeScope(agent) }, { global: true })
  ctx.on('agent/assistant-stream', ({ agent, frame }: { agent: { session: { id: string } }; frame: { type: string; chunk?: { type: string; text?: string } } }) => workforce.noteAssistantFrame(agent.session.id, frame), { global: true })
  ctx.on('agent/disposed', ({ agent }: { agent: { session: { id: string } } }) => workforce.noteAssistantDisposed(agent.session.id), { global: true })
  ctx.effect(() => () => workforce.dispose(), 'workbench: workforce agents')
  ctx.inject(['agents', 'sessionQuery', 'sessionPersistence'], () => {
    workforce.markNativeReady()
    void workforce.recover().catch(() => console.warn('workbench workforce recovery unavailable'))
    void workforce.sweepEventCache().catch(() => {})
  })

  ctx.inject(['connection'], webCtx => {
    const connection = webCtx.get('connection') as ConnectionLike
    const webServer = webCtx.get('webServer') as WebServerLike
    const router = new WorkbenchRouter(root, request => connection.admit(request), lifecycle, value => workforce.registerEmployeeScopeContribution(value))
    const missing = async (_request: IncomingMessage, response: ServerResponse): Promise<void> => {
      router.http.sendError(response, 404, { code: 'not_found', message: '接口不存在' })
    }
    // The dispatcher is the single admission owner; standalone handlers retain their test seam.
    const admitted = () => ({})
    webCtx.effect(() => router.registerRoute({
      id: 'core.health', prefix: '/health',
      async handle(request, response) {
        if (new URL(request.url ?? '/', 'http://localhost').pathname !== API_PREFIX + '/health' || request.method !== 'GET') return missing(request, response)
        router.http.sendJson(response, 200, { ok: true, data: { name: manifest.name, version: lifecycle.version, apiVersion: lifecycle.apiVersion } })
      },
    }), 'workbench: health')
    webCtx.effect(() => router.registerRoute({
      id: 'core.models', prefix: '/workforce/models',
      handle: createModelsHandler({ get }, admitted, missing),
    }), 'workbench: native models')
    webCtx.effect(() => router.registerRoute({
      id: 'core.workforce', prefix: '/workforce',
      handle: createWorkforceHandler(workforce, admitted, missing, {
        skills: ctx.get('skills') as never,
        skillScope: async () => {
          const presets = get('agentPresets') as { acquireScope(): Promise<{ key: object } & AsyncDisposable> } | undefined
          return await presets?.acquireScope()
        },
        mcp: employeeMcp,
        credentials: () => get('credentials') as never,
        launchEnvironment: () => get('launchEnvironment') as never,
        subprocess: () => get('subprocess') as never,
        templates,
        userSkills,
        info: lifecycle,
        sessionPersistence: () => get('sessionPersistence'),
        defaultModel: () => {
          const defaults = get('agentDefaultModel')
          return defaults && typeof defaults === 'object' && 'currentSelection' in defaults && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : undefined
        },
        userSkillsRoot: userRoot,
      }),
    }), 'workbench: workforce routes')
    webCtx.effect(() => webCtx.provide('workbenchHost', router), 'workbench: host extensions')
    webCtx.effect(() => webServer.register({ kind: 'prefix', path: API_PREFIX, handler: (request, response) => router.handle(request, response) }), 'workbench: API front door')
  })
}
