import type { Context, Plugin, Fiber } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { CheckedCallPlan, EmployeeToolDecision, EmployeeToolInstallation, EmployeeToolPolicy, EmployeeWorkspace } from './employee-tool-contract.js'
import { capability, employeeCallContext, employeeFs, employeeShell, employeeSubprocess, invoke, type NativeSearch } from './employee-capabilities.js'
import { installEmployeeSkillResources } from './employee-tool-resources.js'

type NativeAgent = NonNullable<ToolExecution['agent']>
type NativeModule = { apply?: (ctx: Context, config: unknown) => void; default?: Plugin; name?: string; plugin: Plugin }
// Public Cordis FiberState.ACTIVE is 2; the npm package erases its const enum.
const ACTIVE_FIBER_STATE = 2
const moduleTools = [
  ['tool-fs', ['read', 'write', 'edit', 'read_image']],
  ['tool-fs-search', ['glob', 'grep']],
  ['tool-pwsh', ['pwsh']],
  ['tool-str-replace-editor', ['str_replace_editor']],
  ['tool-present', ['present']],
] as const
const workforceNames: Record<string, true | undefined> = Object.fromEntries(['wb_remember', 'wb_forget', 'wb_recall', 'wb_delegate_employee', 'wb_read_material', 'wb_read_deliverable', 'wb_save_deliverable', 'wb_publish_deliverable', 'wb_save_skill_draft', 'wb_install_skill_draft', 'wb_check_arithmetic', 'wb_generate_image', 'wb_run_agent'].map(name => [name, true]))

async function officialModule(loader: Record<string, unknown>, name: string): Promise<NativeModule> {
  const imported: unknown = await invoke(loader, 'import', `@deepseek-ai/dsh-${name}`)
  const module = capability(imported, name)
  if (typeof module.apply !== 'function' && typeof module.default !== 'function') throw new Error(`Native module ${name} has no official plugin entrypoint`)
  // Root exports may be an apply object or a default service class.
  const plugin = (typeof module.apply === 'function' ? module : module.default) as Plugin
  return { ...module, plugin } as NativeModule
}

/** Accepts the real agent object, not a replacement carrying a fabricated cwd. */
export async function installEmployeeNativeTools(agentValue: unknown, workspace: EmployeeWorkspace, policy: EmployeeToolPolicy, options: { deniedTools?: readonly string[] } = {}): Promise<EmployeeToolInstallation> {
  const candidate = capability(agentValue, 'employee agent')
  const context = capability(candidate.ctx, 'scoped agent context')
  const loader = capability(invoke(context, 'get', 'loader'), 'public native host loader')
  const cordis = capability(await invoke(loader, 'import', '@deepseek-ai/cordis'), 'native Cordis namespace')
  const HostContext = cordis.Context
  if (typeof HostContext !== 'function') throw new Error('Native Cordis Context unavailable')
  const isContext: unknown = Reflect.get(HostContext, 'is')
  if (typeof isContext !== 'function' || !isContext(candidate.ctx)) throw new Error('Employee tools require the real native scoped agent context')
  // The host's own runtime identity check validated this native Context.
  const ctx = candidate.ctx as Context
  const session = capability(candidate.session, 'employee session')
  const header = capability(session.header, 'employee session header')
  if (header.id !== workspace.sessionId || header.cwd !== workspace.nativeCwd) throw new Error('Employee workspace does not match immutable native metadata')
  // Native tool APIs use the agent itself as the opaque scope key. Validation above
  // establishes the structural fields used here; no fake agent is constructed.
  const agent = agentValue as NativeAgent
  const tools = ctx.tools
  if (!tools) throw new Error('Employee tools require native tools service')
  const captured = new Map<string, ToolDefinition>()
  for (const schema of tools.schemas(agent)) {
    const definition = tools.get(schema.name, agent)
    if (definition) captured.set(schema.name, definition)
  }
  const jobs = ctx.get('jobs')
  if (jobs !== undefined) {
    const registry = capability(jobs, 'jobs')
    for (const method of ['list', 'kill', 'wait']) if (typeof registry[method] !== 'function') throw new Error(`Native jobs ${method}() unavailable`)
  }
  let active = 0
  const activeTokens = new Set<symbol>()
  let disposed = false
  const assertQuiescent = () => {
    if (active !== 0 || activeTokens.size !== 0) throw new Error('Employee tool calls are still active')
    if (jobs !== undefined) {
      const list = invoke(capability(jobs, 'jobs'), 'list', header.id)
      if (!Array.isArray(list)) throw new Error('Native jobs service returned invalid list')
      if (list.some(rawJob => { const job = capability(rawJob, 'job'); return job.owner === header.id && (job.status === 'running' || job.status === 'stopping') })) throw new Error('Employee jobs are still active')
    }
  }
  if (policy.provider === 'pass-through') {
    const observer = ctx.plugin({ name: 'employee-native-observation', apply(owner: Context) {
      owner.on('tools/pre-execute', (exec, next) => { activeTokens.add(exec.token); return next() })
      owner.on('tools/result', exec => { activeTokens.delete(exec.token) })
      owner.on('tools/execute', async (_exec, next) => {
        active++
        try { return await next() } finally { active-- }
      })
    } })
    if (observer.inertia) await observer.inertia
    if (observer.state !== ACTIVE_FIBER_STATE) { await observer.dispose(); throw new Error('Native tool observation failed to activate') }
    return { workspace, policy, definitions: captured, async dispose() { assertQuiescent(); if (disposed) return; disposed = true; await observer.dispose() } }
  }
  const baseFs = capability(ctx.get('fs'), 'filesystem')
  const baseShell = capability(ctx.get('shell'), 'sandboxed shell')
  const baseSubprocess = capability(ctx.get('subprocess'), 'subprocess')
  capability(ctx.get('sandboxPolicy'), 'sandbox policy')
  for (const method of ['resolve', 'lstat', 'stat', 'processPath', 'fileUrl', 'contains', 'readText', 'streamText', 'readBytes', 'readByteRange', 'listDir', 'writeText', 'editText']) {
    if (typeof baseFs[method] !== 'function') throw new Error(`Native filesystem ${method}() unavailable`)
  }
  if (typeof baseShell.resolve !== 'function' || typeof baseShell.execute !== 'function' || baseShell.sandboxMode === undefined || typeof baseSubprocess.spawn !== 'function') throw new Error('Native sandboxed execution services unavailable')
  // Import through the host loader so package roots and scope WeakMaps have
  // exactly the same module identities as the standing preset composition.
  const scopeModule: unknown = await invoke(loader, 'import', '@deepseek-ai/dsh-scope')
  const scopeApi = capability(scopeModule, 'scope')
  const scopeOf = scopeApi.scopeOf
  const scopeChainOf = scopeApi.scopeChainOf
  if (typeof scopeOf !== 'function' || typeof scopeChainOf !== 'function') throw new Error('Native scope ancestry API unavailable')
  const chain: unknown = scopeChainOf(scopeOf(ctx))
  if (!Array.isArray(chain) || chain[0] !== agent || chain.some(scope => typeof scope !== 'object' || scope === null)) throw new Error('Native scope chain does not belong to the real employee agent')
  const scopes: unknown[] = [...chain, undefined]
  const selected: { module: NativeModule; config: unknown; names: readonly string[] }[] = []
  for (const [name, names] of moduleTools) {
    const present = names.filter(tool => captured.has(tool))
    if (!present.length) {
      if (name === 'tool-fs' || name === 'tool-fs-search' || name === 'tool-pwsh') throw new Error(`Required native module ${name} is unavailable`)
      continue
    }
    const module = await officialModule(loader, name)
    const plugin = module.plugin
    const runtime = ctx.registry.get(plugin)
    if (!runtime) throw new Error(`Cannot capture effective native config for ${name}`)
    const fibers = [...runtime.fibers].filter(fiber => fiber.state === ACTIVE_FIBER_STATE && scopes.includes(scopeOf(fiber.ctx)))
    fibers.sort((left, right) => scopes.indexOf(scopeOf(left.ctx)) - scopes.indexOf(scopeOf(right.ctx)))
    const chosen = fibers[0]
    if (!chosen || chosen.config === undefined) throw new Error(`Native ${name} effective Fiber.config unavailable`)
    if (fibers[1] && scopeOf(fibers[1].ctx) === scopeOf(chosen.ctx)) throw new Error(`Ambiguous native ${name} configuration`)
    selected.push({ module, config: chosen.config, names: present })
  }
  const search = selected.find(entry => entry.module.name === 'tool-fs-search')?.module as unknown as NativeSearch | undefined
  if (!search || typeof search.resolveRgPath !== 'function' || typeof search.buildGlobCommand !== 'function' || typeof search.buildGrepCommand !== 'function' || typeof search.parseGlobArgs !== 'function' || typeof search.parseGrepArgs !== 'function') throw new Error('Official native search command helpers unavailable')
  const rg = await search.resolveRgPath()
  const spill = await officialModule(loader, 'spill-local')
  const shellEnv = await officialModule(loader, 'shell-env')
  const shellEnvRuntime = ctx.registry.get(shellEnv.plugin)
  const shellEnvFibers = shellEnvRuntime ? [...shellEnvRuntime.fibers].filter(fiber => fiber.state === ACTIVE_FIBER_STATE && scopes.includes(scopeOf(fiber.ctx))) : []
  shellEnvFibers.sort((left, right) => scopes.indexOf(scopeOf(left.ctx)) - scopes.indexOf(scopeOf(right.ctx)))
  const retention = await officialModule(loader, 'spill-policy')
  const retentionRuntime = ctx.registry.get(retention.plugin)
  const retentionFibers = retentionRuntime ? [...retentionRuntime.fibers].filter(fiber => fiber.state === ACTIVE_FIBER_STATE && scopes.includes(scopeOf(fiber.ctx))) : []
  retentionFibers.sort((left, right) => scopes.indexOf(scopeOf(left.ctx)) - scopes.indexOf(scopeOf(right.ctx)))
  const retentionFiber = retentionFibers[0]
  if (!retention.apply || !retentionFiber || retentionFiber.config === undefined || (retentionFibers[1] && scopeOf(retentionFibers[1].ctx) === scopeOf(retentionFiber.ctx))) throw new Error('Native spill retention effective config unavailable or ambiguous')
  if (!shellEnvFibers[0] || shellEnvFibers[0].config === undefined || (shellEnvFibers[1] && scopeOf(shellEnvFibers[1].ctx) === scopeOf(shellEnvFibers[0].ctx))) throw new Error('Native shellEnv effective config unavailable or ambiguous')
  const definitions = new Map<string, ToolDefinition>()
  const admissions = new Map<symbol, Promise<EmployeeToolDecision>>()
  const admitted = new Map<symbol, CheckedCallPlan>()
  const denied = new Set(options.deniedTools ?? [])
  let broker: Fiber | undefined
  let currentGeneration = 0, mountedGeneration = 0
  const releaseIdentityGate = ctx.tools.guard(exec => disposed || broker?.state !== ACTIVE_FIBER_STATE || currentGeneration !== mountedGeneration || exec.agent !== agent || denied.has(exec.name) || !definitions.has(exec.name) || ctx.tools.get(exec.name, agent) !== definitions.get(exec.name) || !admitted.has(exec.token) ? 'Employee tool has no valid identity-bound admission' : undefined)
  const releaseResults = ctx.on('tools/result', exec => {
    activeTokens.delete(exec.token)
    admitted.delete(exec.token)
    admissions.delete(exec.token)
  })
  try {
    let ownerContext: Context | undefined
    broker = ctx.plugin({ name: 'employee-native-tools', inject: ['skills', 'tools', 'systemPrompt', 'workingDirectory'], apply(owner: Context) { currentGeneration++; ownerContext = owner } })
    if (broker.inertia) await broker.inertia
    if (broker.state !== ACTIVE_FIBER_STATE || !ownerContext) throw new Error('Employee private broker failed to activate')
    mountedGeneration = currentGeneration
    // Providers must belong to an ACTIVE broker before dependent child fibers load.
    const owner = ownerContext
    const temporary = await policy.resolvePath({ raw: join(workspace.root, '.tmp'), access: 'write' }, workspace, new AbortController().signal)
    await mkdir(temporary.absolutePath, { recursive: true, mode: 0o700 })
    invoke(capability(owner.get('systemPrompt'), 'system prompt'), 'section', {
      name: 'employee-logical-workspace',
      order: 0,
      text: `Employee file, search, shell and present tools resolve relative paths in the logical workspace ${workspace.root}. Native session metadata still reports ${workspace.nativeCwd}; that native cwd is not the employee tool root. Readable resources and output spills are staged inside the logical workspace. Loading a skill does not authorize execution of its scripts.`,
    })
        let privateCtx = owner
        for (const name of ['fs', 'shell', 'subprocess', 'sandboxPolicy', 'shellEnv', 'spillStore']) privateCtx = privateCtx.isolate(name)
        privateCtx.provide('fs', employeeFs(baseFs, workspace, policy))
        privateCtx.provide('shell', employeeShell(baseShell, workspace, policy))
        privateCtx.provide('subprocess', employeeSubprocess(baseSubprocess, workspace, search, rg))
        privateCtx.provide('sandboxPolicy', { resolve(request: { session?: unknown }) {
          if (request.session !== agent.session) throw new Error('Employee sandbox policy used by a different session')
          return policy.executionPolicy(workspace)
        } })
        const envFiber = privateCtx.plugin(shellEnv.plugin, shellEnvFibers[0]!.config)
        if (envFiber.inertia) await envFiber.inertia
        if (envFiber.state !== ACTIVE_FIBER_STATE) throw new Error('Private native shellEnv failed to activate')
        const spillFiber = privateCtx.plugin(spill.plugin, { root: join(workspace.root, '.tmp'), cleanupPeriodDays: 0 })
        if (spillFiber.inertia) await spillFiber.inertia
        if (spillFiber.state !== ACTIVE_FIBER_STATE) throw new Error('Private native spillStore failed to activate')
        const projectSkillResult = await installEmployeeSkillResources(owner, workspace, policy, agent)
        owner.tools.restrict({ allow: [] })
        owner.tools.presentAs('native')
        for (const [name, definition] of captured) {
          if ((name === 'skill' || name === 'job_output' || name === 'job_list' || name === 'job_kill' || Object.hasOwn(workforceNames, name)) && !denied.has(name)) {
            const visible = owner.tools.get(name, agent)
            if (visible !== definition) owner.tools.register(definition)
            definitions.set(name, definition)
          }
        }
        for (const entry of selected) {
          const nativeApply = entry.module.apply
          const plugin = entry.module.name === 'tool-present' && nativeApply ? {
            ...entry.module,
            name: 'employee-native-tool-present',
            apply(mount: Context, config: unknown) {
              const tools = new Proxy(mount.tools, { get(target, key, receiver) {
                if (key !== 'register') return Reflect.get(target, key, receiver)
                return (definition: ToolDefinition) => target.register({ ...definition, async execute(raw, exec) {
                  const args = capability(raw, 'native present arguments')
                  if (!Array.isArray(args.files)) throw new Error('Native present requires files')
                  const files = await Promise.all(args.files.map(async rawFile => {
                    const file = capability(rawFile, 'native presented file')
                    if (typeof file.path !== 'string') throw new Error('Native present requires a path')
                    const checked = await policy.resolvePath({ raw: file.path, access: 'read' }, workspace, exec.signal)
                    return { ...file, path: checked.absolutePath }
                  }))
                  return definition.execute({ ...args, files }, exec)
                } })
              } })
              return nativeApply(mount.extend({ tools }), config)
            },
          } : entry.module.name === 'tool-fs' && nativeApply ? {
            ...entry.module,
            name: 'employee-native-tool-fs',
            apply(mount: Context, config: unknown) {
              // Native optional image composition must explicitly consume the
              // isolated fs provider, rather than inherit a global service trace.
              const composition = mount.extend({ inject(services: unknown, callback: unknown, ...rest: unknown[]) {
                const dependencies = Array.isArray(services) && services.includes('attachments')
                  ? [...services, 'tools', 'fs', 'systemPrompt']
                  : services
                return invoke(capability(mount, 'native image composition'), 'inject', dependencies, callback, ...rest)
              } })
              return nativeApply(composition, config)
            },
          } : entry.module.plugin
          const moduleFiber = privateCtx.plugin(plugin, entry.config)
          if (moduleFiber.inertia) await moduleFiber.inertia
          if (moduleFiber.state !== ACTIVE_FIBER_STATE) throw new Error(`Private native ${entry.module.name} failed to activate`)
          for (const name of entry.names) {
            const definition = owner.tools.get(name, agent)
            const original = captured.get(name)
            if (!definition || definition === original || !original || !isDeepStrictEqual(definition.parameters, original.parameters) || !isDeepStrictEqual(definition.output.schema, original.output.schema)) throw new Error(`Private native ${name} schema or definition mismatch`)
            definitions.set(name, definition)
          }
        }
        owner.on('tools/pre-execute', async (exec, next) => {
          activeTokens.add(exec.token)
          active++
          try {
            if (disposed || exec.agent !== agent || denied.has(exec.name) || owner.tools.get(exec.name, agent) !== definitions.get(exec.name) || !definitions.has(exec.name)) return { kind: 'deny', reason: 'Employee tool identity is not authorized' }
            let decision = admissions.get(exec.token)
            if (!decision) {
              decision = policy.evaluate({ name: exec.name, arguments: exec.arguments, agent: exec.agent, token: exec.token, signal: exec.signal }, workspace)
              admissions.set(exec.token, decision)
            }
            const result = await decision
            if (result.kind === 'deny') return result
            admitted.set(exec.token, result.plan)
            return await next()
          } finally { active-- }
        })
        owner.on('tools/execute', async (exec, next) => {
          const plan = admitted.get(exec.token)
          if (!plan) throw new Error('Employee execution lost admission')
          active++
          try { return await projectSkillResult(exec, await employeeCallContext.run({ exec, plan }, next)) }
          finally { active--; admitted.delete(exec.token); admissions.delete(exec.token) }
        })
        // The original global retention prepends an outer waterfall listener.
        // Append the private native policy inside it, so W-backed bounding runs
        // first and the original sees the already bounded content.
        const retentionContext = privateCtx.extend({ on: (...args: unknown[]) => {
          if (args[0] !== 'tools/post-execute' && args[0] !== 'tools/ptc-dispatch-log') throw new Error('Unexpected native retention hook')
          const eventOptions = capability(args[2] ?? {}, 'native retention event options')
          args[2] = { ...eventOptions, prepend: false }
          return invoke(capability(privateCtx, 'private retention context'), 'on', ...args)
        } })
        retention.apply(retentionContext, retentionFiber.config)
    return { workspace, policy, definitions, async dispose() {
      assertQuiescent()
      if (disposed) return
      disposed = true
      await broker!.dispose()
      admissions.clear(); admitted.clear()
      releaseIdentityGate()
      releaseResults()
    } }
  } catch (error: unknown) {
    if (broker) await broker.dispose()
    releaseIdentityGate()
    releaseResults()
    throw error
  }
}
