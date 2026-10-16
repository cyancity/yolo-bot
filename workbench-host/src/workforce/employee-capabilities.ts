import { AsyncLocalStorage } from 'node:async_hooks'
import { relative } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { CheckedCallPlan, EmployeeShellRequest, EmployeeToolPolicy, EmployeeWorkspace } from './employee-tool-contract.js'
import { employeeSpillProjection } from './employee-tool-resources.js'

export interface EmployeeAdmission { exec: ToolExecution; plan: CheckedCallPlan }
export const employeeCallContext = new AsyncLocalStorage<EmployeeAdmission>()
type Capability = Record<string, unknown>
type NativeMethod = (...args: unknown[]) => unknown
export function capability(value: unknown, name: string): Capability {
  if (typeof value !== 'object' || value === null) throw new Error(`Employee tools require native ${name}`)
  return value as Capability
}
export function invoke(service: Capability, name: string, ...args: unknown[]): unknown {
  const method = service[name]
  if (typeof method !== 'function') throw new Error(`Employee tools require native ${name}()`)
  return (method as NativeMethod).apply(service, args)
}
function call(): EmployeeAdmission {
  const current = employeeCallContext.getStore()
  if (!current) throw new Error('Employee capability used without admitted tool execution')
  current.exec.signal.throwIfAborted()
  return current
}
function adapter(base: Capability, overrides: Capability): Capability {
  return new Proxy(overrides, { get(target, key) {
    if (Reflect.has(target, key)) return Reflect.get(target, key)
    const value: unknown = Reflect.get(base, key)
    return typeof value === 'function' ? value.bind(base) : value
  } })
}

export function employeeFs(base: Capability, ws: EmployeeWorkspace, policy: EmployeeToolPolicy): Capability {
  const targets = new WeakSet<object>()
  const projectAttachment = employeeSpillProjection(ws, { preserveExtension: true })
  const targetPath = (target: unknown): string => {
    if (typeof target !== 'object' || target === null || !targets.has(target)) throw new Error('Unrecognized employee filesystem target')
    const path = invoke(base, 'processPath', target)
    if (typeof path !== 'string') throw new Error('Native filesystem lacks local process paths')
    return path
  }
  const check = async (target: unknown, access: 'read' | 'write') => {
    const { exec } = call()
    await policy.resolvePath({ raw: targetPath(target), access }, ws, exec.signal)
  }
  const overrides: Capability = {
    async resolve(raw: string, options?: { signal?: AbortSignal }) {
      const { exec } = call()
      const checked = await policy.resolvePath({ raw, access: 'read' }, ws, options?.signal ?? exec.signal)
      const target: unknown = await invoke(base, 'resolve', checked.absolutePath, { cwd: ws.root, signal: options?.signal ?? exec.signal })
      if (typeof target !== 'object' || target === null) throw new Error('Native filesystem returned no target')
      targets.add(target)
      await check(target, 'read')
      return target
    },
    async lstat(raw: string, _options: unknown, signal?: AbortSignal) {
      const checked = await policy.resolvePath({ raw, access: 'read' }, ws, signal ?? call().exec.signal)
      return invoke(base, 'lstat', checked.absolutePath, { cwd: ws.root }, signal ?? call().exec.signal)
    },
    processPath(target: unknown) { call(); return targetPath(target) },
    fileUrl(target: unknown) { call(); targetPath(target); return invoke(base, 'fileUrl', target) },
    contains(parent: unknown, child: unknown) { call(); targetPath(parent); targetPath(child); return invoke(base, 'contains', parent, child) },
    // Native output retention calls this only for backend-owned attachment paths;
    // it receives an independent W copy rather than widening the model read root.
    processPathFromHostPath(hostPath: string) {
      const nativePath = invoke(base, 'processPathFromHostPath', hostPath)
      if (nativePath === undefined) return undefined
      if (typeof nativePath !== 'string') throw new Error('Native attachment path mapping is invalid')
      const projected = capability(projectAttachment({ spillPath: nativePath }), 'native attachment projection')
      return projected.spillPath
    },
  }
  for (const name of ['stat', 'readText', 'streamText', 'readBytes', 'readByteRange', 'watch']) {
    overrides[name] = async (target: unknown, ...rest: unknown[]) => {
      await check(target, 'read')
      return invoke(base, name, target, ...rest)
    }
  }
  overrides.listDir = async (target: unknown, ...rest: unknown[]) => {
    await check(target, 'read')
    const entries: unknown = await invoke(base, 'listDir', target, ...rest)
    if (!Array.isArray(entries)) throw new Error('Native filesystem returned invalid directory entries')
    for (const rawEntry of entries) {
      const entry = capability(rawEntry, 'directory entry')
      const child = capability(entry.target, 'directory target')
      const path = invoke(base, 'processPath', child)
      if (typeof path !== 'string') throw new Error('Native filesystem lacks directory process paths')
      await policy.resolvePath({ raw: path, access: 'read' }, ws, call().exec.signal)
      targets.add(child)
    }
    return entries
  }
  for (const name of ['writeText', 'editText']) {
    overrides[name] = async (target: unknown, ...rest: unknown[]) => {
      await check(target, 'write')
      // Observation/version arguments stay untouched; only the owned native policy slot changes.
      rest[3] = policy.executionPolicy(ws)
      return invoke(base, name, target, ...rest)
    }
  }
  return adapter(base, overrides)
}

export interface NativeSearch {
  resolveRgPath(): Promise<string>
  buildGlobCommand(input: unknown): string[]
  buildGrepCommand(input: unknown): string[]
  parseGlobArgs(input: unknown): unknown
  parseGrepArgs(input: unknown): unknown
}
export function employeeSubprocess(base: Capability, ws: EmployeeWorkspace, native: NativeSearch, rg: string): Capability {
  return adapter(base, { spawn(specValue: unknown) {
    const { exec, plan } = call()
    if ((exec.name !== 'glob' && exec.name !== 'grep') || !plan.searchTarget) throw new Error('Employee subprocess has no admitted search target')
    const spec = capability(specValue, 'search spawn specification')
    const expected = exec.name === 'glob'
      ? native.buildGlobCommand(native.parseGlobArgs(exec.arguments))
      : native.buildGrepCommand(native.parseGrepArgs(exec.arguments))
    const argv = [rg, '--no-config', ...expected]
    const actual = spec.argv
    if (!Array.isArray(actual) || actual.length !== argv.length || spec.cwd !== ws.nativeCwd) throw new Error('Employee search argv differs from native controlled command')
    for (let index = 0; index < argv.length; index++) if (actual[index] !== argv[index]) throw new Error('Employee search argv differs from native controlled command')
    const separator = argv.indexOf('--')
    // For the canonical W root, cwd=W plus '.' names the same checked target
    // while preserving native relative rg output. Other canonical targets stay absolute.
    const target = relative(ws.root, plan.searchTarget.absolutePath) === '' ? '.' : plan.searchTarget.absolutePath
    const adjusted = separator < 0 ? [...argv, '--', target] : [...argv.slice(0, separator + 1), target]
    return invoke(base, 'spawn', { ...spec, argv: adjusted, cwd: ws.root })
  } })
}

export function employeeShell(base: Capability, ws: EmployeeWorkspace, policy: EmployeeToolPolicy): Capability {
  if (base.sandboxMode === undefined) throw new Error('Employee tools require an actual sandboxed shell executor')
  const projectSpill = employeeSpillProjection(ws)
  return adapter(base, {
    resolve(request: unknown) { call(); return invoke(base, 'resolve', request) },
    async execute(raw: EmployeeShellRequest) {
      const { exec } = call()
      // Native jobs replace the caller lifetime with their own cancellation controller.
      const signal = raw.signal ?? exec.signal
      const args = capability(exec.arguments, 'shell arguments')
      let request = raw
      if (typeof args.workdir === 'string') {
        // The native module resolves relative workdir against immutable native cwd.
        // Restore only backend path intent against W; never alter logged arguments.
        const checked = await policy.resolvePath({ raw: args.workdir, access: 'read' }, ws, signal)
        if (checked.type !== 'directory') throw new Error('Employee shell workdir is not a directory')
        request = { ...raw, workdir: checked.absolutePath }
      }
      const prepared = await policy.prepareShell(request, ws, signal)
      if (typeof prepared.workdir !== 'string' || prepared.sandboxPolicy?.workspaceRoot !== ws.root) throw new Error('Employee shell policy did not bind the workspace')
      const directory = await policy.resolvePath({ raw: prepared.workdir, access: 'read' }, ws, signal)
      if (directory.type !== 'directory' || directory.absolutePath !== prepared.workdir) throw new Error('Employee shell workdir is not a canonical workspace directory')
      const execution = capability(await invoke(base, 'execute', invoke(base, 'resolve', prepared)), 'shell execution handle')
      const observed = capability(execution.observed, 'shell observed streams')
      const streams: Capability = {}
      for (const name of ['stdout', 'stderr']) {
        const stream = capability(observed[name], `shell ${name} stream`)
        streams[name] = adapter(stream, { readFrom(offset: number) { return projectSpill(invoke(stream, 'readFrom', offset)) } })
      }
      return adapter(execution, {
        observed: streams,
        async result() {
          const result = capability(await invoke(execution, 'result'), 'native shell result')
          return { ...result, stdout: projectSpill(result.stdout), stderr: projectSpill(result.stderr) }
        },
      })
    },
  })
}
