import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type {
  CheckedPath, EmployeeExecutionPolicy, EmployeePolicyDependencies, EmployeeShellRequest,
  EmployeeToolCall, EmployeeToolDecision, EmployeeToolPolicy, EmployeeToolProvider, EmployeeWorkspace, PathAccess,
} from './employee-tool-contract.js'
import { parseEmployeeShell, type ParsedEmployeeShell } from './employee-shell-parser.js'

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i
const MUTATIONS: Partial<Record<PathAccess, true>> = { write: true, 'move-source': true, 'move-target': true, delete: true }
const SHELL_SHAPES: Readonly<Record<string, Readonly<Record<string, 'value' | 'switch'>>>> = {
  'get-childitem': { literalpath: 'value', path: 'value', recurse: 'switch', force: 'switch', directory: 'switch', file: 'switch', name: 'switch' },
  'new-item': { path: 'value', itemtype: 'value', force: 'switch' },
  'move-item': { literalpath: 'value', path: 'value', destination: 'value', force: 'switch' },
  'remove-item': { literalpath: 'value', path: 'value', recurse: 'switch', force: 'switch' },
}

function validatePathSpelling(raw: string): void {
  if (!raw.trim() || /[\x00-\x1f<>"|?*]/.test(raw) || /^[\\/]{2}/.test(raw) || raw.startsWith('\\')
    || /^[a-z]:(?:$|[^\\/])/i.test(raw) || (/^[a-z]:/i.test(raw) && process.platform !== 'win32')) {
    throw new Error('Employee paths must be ordinary local filesystem paths')
  }
  const withoutDrive = raw.replace(/^[a-z]:/i, '')
  if (withoutDrive.includes(':') || (process.platform === 'win32' && /^[\\/]/.test(raw) && !/^[a-z]:[\\/]/i.test(raw))) {
    throw new Error('Employee paths cannot use drive-relative, device, provider, or alternate-stream aliases')
  }
  for (const segment of withoutDrive.split(/[\\/]/)) {
    if (!segment || segment === '.' || segment === '..') continue
    if (/[. ]$/.test(segment) || WINDOWS_RESERVED.test(segment.split('.')[0]!.trimEnd())) throw new Error('Employee paths cannot use reserved or trailing-dot/space aliases')
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function assertContained(root: string, target: string): void {
  const part = relative(root, target)
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Employee path escapes the assigned workspace')
}

async function inspectPath(path: string, signal: AbortSignal): Promise<'file' | 'directory'> {
  signal.throwIfAborted()
  const info = await lstat(path)
  signal.throwIfAborted()
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1)) {
    throw new Error('Employee paths cannot traverse links, hardlinks, or special files')
  }
  const canonical = await realpath(path)
  signal.throwIfAborted()
  if (!samePath(path, canonical)) throw new Error('Employee paths cannot use junctions or filesystem aliases')
  return info.isFile() ? 'file' : 'directory'
}

async function canonicalRoot(workspace: EmployeeWorkspace, signal: AbortSignal): Promise<string> {
  validatePathSpelling(workspace.root)
  if (!isAbsolute(workspace.root)) throw new Error('Employee workspace binding must contain an absolute root')
  const root = resolve(workspace.root)
  let current = parse(root).root
  if (await inspectPath(current, signal) !== 'directory') throw new Error('Employee workspace ancestor is not a directory')
  for (const segment of relative(current, root).split(sep).filter(Boolean)) {
    current = join(current, segment)
    if (await inspectPath(current, signal) !== 'directory') throw new Error('Employee workspace ancestor is not a directory')
  }
  return root
}

async function resolveLocalPath(raw: string, access: PathAccess, workspace: EmployeeWorkspace, signal: AbortSignal, shellCwd?: string): Promise<CheckedPath> {
  signal.throwIfAborted()
  validatePathSpelling(raw)
  const root = await canonicalRoot(workspace, signal)
  // Native cwd is an immutable session fact, not this employee's relative-path base.
  const target = resolve(shellCwd ?? root, raw.replace(/\\/g, '/'))
  assertContained(root, target)
  if (samePath(target, root) && MUTATIONS[access]) throw new Error('Employee tools cannot mutate the workspace root')
  let current = root
  let existingAncestor = root
  let type: CheckedPath['type'] = 'directory'
  const segments = relative(root, target).split(sep).filter(Boolean)
  for (let index = 0; index < segments.length; index++) {
    if (type !== 'directory') throw new Error('Employee path ancestor is not a directory')
    current = join(current, segments[index]!)
    try {
      type = await inspectPath(current, signal)
      existingAncestor = current
    } catch (error) {
      signal.throwIfAborted()
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      type = 'absent'
      break
    }
  }
  if (type === 'absent' && access !== 'read' && access !== 'write' && access !== 'move-target') throw new Error('Employee path does not exist')
  signal.throwIfAborted()
  const checked: CheckedPath = { absolutePath: target, existingAncestor, root, type }
  if (type === 'directory' && (access === 'search' || access === 'move-source' || access === 'move-target' || access === 'delete')) {
    await validateTree(checked, signal)
  }
  return checked
}

async function validateTree(target: CheckedPath, signal: AbortSignal): Promise<void> {
  const pending = [target.absolutePath]
  while (pending.length) {
    signal.throwIfAborted()
    const path = pending.pop()!
    validatePathSpelling(path)
    assertContained(target.root, path)
    if (await inspectPath(path, signal) === 'directory') {
      const entries = await readdir(path)
      signal.throwIfAborted()
      for (const entry of entries) pending.push(join(path, entry))
    }
  }
}

function toolArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Employee tool arguments must be an object')
  return value as Record<string, unknown>
}

function stringArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string') throw new Error(`Employee tool requires a literal ${key}`)
  return value
}

function rejectEscalation(args: Record<string, unknown>): void {
  if (args.sandbox_permissions !== undefined || args.justification !== undefined || args.sandboxPolicy !== undefined
    || args.env !== undefined || args.dshEnv !== undefined || args.stdin !== undefined) {
    throw new Error('Employee tools cannot request escalation or execution-environment overrides')
  }
}

function validatedShellShape(parsed: ParsedEmployeeShell): ParsedEmployeeShell {
  const command = parsed.command.toLowerCase()
  const shape = Object.hasOwn(SHELL_SHAPES, command) ? SHELL_SHAPES[command] : undefined
  if (!shape) throw new Error('Employee shell cmdlet is not approved; arbitrary scripts are unavailable')
  const parameters: Record<string, string | boolean> = Object.create(null)
  for (const [rawKey, value] of Object.entries(parsed.parameters)) {
    const key = rawKey.toLowerCase()
    if (!Object.hasOwn(shape, key) || Object.hasOwn(parameters, key)
      || (shape[key] === 'switch' ? value !== true : typeof value !== 'string')) {
      throw new Error('Employee shell parameter shape is not approved')
    }
    parameters[key] = value
  }
  if (parameters.path !== undefined && parameters.literalpath !== undefined) throw new Error('Employee shell requires exactly one path parameter')
  if (command === 'new-item') {
    if (typeof parameters.path !== 'string' || typeof parameters.itemtype !== 'string' || parameters.itemtype.toLowerCase() !== 'directory') {
      throw new Error('Employee New-Item is limited to explicit Directory creation')
    }
  } else {
    if (parameters.path === undefined && parameters.literalpath === undefined) {
      if (command !== 'get-childitem') throw new Error('Employee shell requires an explicit literal path')
      parameters.literalpath = '.'
    }
    if (command === 'move-item' && typeof parameters.destination !== 'string') throw new Error('Employee Move-Item requires a literal destination')
  }
  return { command, parameters }
}

async function checkedShell(command: string, workspace: EmployeeWorkspace, signal: AbortSignal, parseShell: NonNullable<EmployeePolicyDependencies['parseShell']>, shellCwd?: string): Promise<string> {
  signal.throwIfAborted()
  const parsed = validatedShellShape(await parseShell(command, signal))
  signal.throwIfAborted()
  const pathKey = parsed.parameters.literalpath === undefined ? 'path' : 'literalpath'
  const rawPath = parsed.parameters[pathKey]
  if (typeof rawPath !== 'string') throw new Error('Employee shell requires a literal path')
  if (pathKey === 'path' && /[\[\]]/.test(rawPath)) throw new Error('Employee shell paths cannot use wildcard syntax')
  const access: PathAccess = parsed.command === 'get-childitem' ? 'search'
    : parsed.command === 'new-item' ? 'write' : parsed.command === 'move-item' ? 'move-source' : 'delete'
  const source = await resolveLocalPath(rawPath, access, workspace, signal, shellCwd)
  parsed.parameters[pathKey] = source.absolutePath
  if (parsed.command === 'move-item') {
    const destination = parsed.parameters.destination
    if (typeof destination !== 'string') throw new Error('Employee Move-Item requires a literal destination')
    if (/[\[\]]/.test(destination)) throw new Error('Employee shell destination cannot use wildcard syntax')
    const target = await resolveLocalPath(destination, 'move-target', workspace, signal, shellCwd)
    // A directory destination implicitly appends the source's leaf name. Inspect that
    // real mutation target too, rather than validating only its parent directory.
    if (target.type === 'directory') {
      await resolveLocalPath(join(target.absolutePath, parse(source.absolutePath).base), 'move-target', workspace, signal)
    }
    parsed.parameters.destination = target.absolutePath
  }
  signal.throwIfAborted()
  // PowerShell also treats the four smart single-quote characters as delimiters.
  // Duplicate the original character, not an ASCII substitute: filenames must
  // round-trip unchanged through the actual parser before the executor sees them.
  const canonicalCommand = [parsed.command, ...Object.entries(parsed.parameters).map(([key, value]) =>
    value === true ? `-${key}` : `-${key} '${String(value).replace(/['\u2018-\u201b]/g, quote => quote + quote)}'`)].join(' ')
  const reparsed = validatedShellShape(await parseShell(canonicalCommand, signal))
  signal.throwIfAborted()
  if (reparsed.command !== parsed.command || Object.keys(reparsed.parameters).length !== Object.keys(parsed.parameters).length
    || Object.entries(parsed.parameters).some(([key, value]) => reparsed.parameters[key] !== value)) {
    throw new Error('Employee shell canonical command did not preserve its checked literal parameters')
  }
  return canonicalCommand
}

class LocalEmployeePolicy implements EmployeeToolPolicy {
  readonly provider = 'local' as const
  private readonly parseShell: NonNullable<EmployeePolicyDependencies['parseShell']>

  constructor(dependencies: EmployeePolicyDependencies) {
    this.parseShell = dependencies.parseShell ?? parseEmployeeShell
  }

  executionPolicy(workspace: EmployeeWorkspace): EmployeeExecutionPolicy {
    return { mode: 'workspace-write', workspaceRoot: workspace.root, sessionId: workspace.sessionId }
  }

  resolvePath(input: { raw: string; cwd?: string; access: PathAccess }, workspace: EmployeeWorkspace, signal: AbortSignal): Promise<CheckedPath> {
    return resolveLocalPath(input.raw, input.access, workspace, signal)
  }

  async evaluate(call: EmployeeToolCall, workspace: EmployeeWorkspace): Promise<EmployeeToolDecision> {
    call.signal.throwIfAborted()
    try {
      const args = toolArguments(call.arguments)
      rejectEscalation(args)
      if (call.name === 'glob' || call.name === 'grep') {
        const raw = args.path === undefined ? '.' : stringArgument(args, 'path')
        const searchTarget = await this.resolvePath({ raw, access: 'search' }, workspace, call.signal)
        return { kind: 'allow', plan: { searchTarget } }
      }
      if (call.name === 'read' || call.name === 'read_image' || call.name === 'write' || call.name === 'edit') {
        await this.resolvePath({ raw: stringArgument(args, 'file_path'), access: call.name === 'write' || call.name === 'edit' ? 'write' : 'read' }, workspace, call.signal)
      } else if (call.name === 'str_replace_editor') {
        const command = stringArgument(args, 'command')
        if (!['view', 'create', 'str_replace', 'insert'].includes(command)) throw new Error('Unknown employee editor command')
        const target = await this.resolvePath({ raw: stringArgument(args, 'path'), access: command === 'view' ? 'read' : 'write' }, workspace, call.signal)
        if (command === 'view' && target.type === 'directory') await validateTree(target, call.signal)
      } else if (call.name === 'present') {
        if (!Array.isArray(args.files)) throw new Error('Employee present requires files')
        for (const file of args.files) {
          const target = await this.resolvePath({ raw: stringArgument(toolArguments(file), 'path'), access: 'read' }, workspace, call.signal)
          if (target.type !== 'file') throw new Error('Employee present requires regular files')
        }
      } else if (call.name === 'pwsh') {
        let shellCwd: string | undefined
        if (args.workdir !== undefined) {
          const workdir = await this.resolvePath({ raw: stringArgument(args, 'workdir'), access: 'read' }, workspace, call.signal)
          if (workdir.type !== 'directory') throw new Error('Employee shell workdir must be a directory')
          shellCwd = workdir.absolutePath
        }
        await checkedShell(stringArgument(args, 'command'), workspace, call.signal, this.parseShell, shellCwd)
      }
      // Definition identity and business/skill/job admission belong to the installer guard.
      call.signal.throwIfAborted()
      return { kind: 'allow', plan: {} }
    } catch (error) {
      call.signal.throwIfAborted()
      return { kind: 'deny', reason: error instanceof Error ? error.message : 'Employee tool policy denied the call' }
    }
  }

  async prepareShell(request: EmployeeShellRequest, workspace: EmployeeWorkspace, signal: AbortSignal): Promise<EmployeeShellRequest> {
    if (request.signal && request.signal !== signal) signal = AbortSignal.any([signal, request.signal])
    signal.throwIfAborted()
    request.signal?.throwIfAborted()
    if (request.sandboxPolicy && request.sandboxPolicy.mode !== 'workspace-write') throw new Error('Employee shell cannot widen sandbox permissions')
    let shellCwd: string | undefined
    if (request.workdir !== undefined && !samePath(resolve(request.workdir), resolve(workspace.nativeCwd))) {
      const target = await this.resolvePath({ raw: request.workdir, access: 'read' }, workspace, signal)
      if (target.type !== 'directory') throw new Error('Employee shell workdir must be a directory')
      shellCwd = target.absolutePath
    }
    const command = await checkedShell(request.command, workspace, signal, this.parseShell, shellCwd)
    const root = await canonicalRoot(workspace, signal)
    const temporary = await this.resolvePath({ raw: '.tmp', access: 'write' }, workspace, signal)
    if (temporary.type === 'file') throw new Error('Employee private temporary path must be a directory')
    await mkdir(temporary.absolutePath, { recursive: true, mode: 0o700 })
    await this.resolvePath({ raw: temporary.absolutePath, access: 'read' }, workspace, signal)
    signal.throwIfAborted()
    request.signal?.throwIfAborted()
    return {
      ...request, command, workdir: shellCwd ?? root, signal,
      sandboxPolicy: { ...request.sandboxPolicy, ...this.executionPolicy(workspace), workspaceRoot: root },
      env: { ...request.env, TMP: temporary.absolutePath, TEMP: temporary.absolutePath, TMPDIR: temporary.absolutePath },
    }
  }
}

/** Selecting another provider replaces the implementation, never the native tool schema. */
export function createEmployeePolicy(provider: EmployeeToolProvider, dependencies: EmployeePolicyDependencies = {}): EmployeeToolPolicy {
  if (provider === 'local') return new LocalEmployeePolicy(dependencies)
  if (provider === 'native') {
    if (!dependencies.native || dependencies.native.provider !== 'native') throw new Error('Native employee logical-root policy is unavailable')
    return dependencies.native
  }
  if (provider !== 'pass-through') throw new Error('Unknown employee tool policy provider')
  const { nativePolicy, nativeResolvePath } = dependencies
  if (!nativePolicy || !nativeResolvePath) throw new Error('Pass-through requires real native path and execution-policy capabilities')
  return {
    provider,
    async evaluate(call) {
      call.signal.throwIfAborted()
      return { kind: 'allow', plan: {} }
    },
    resolvePath(input, workspace, signal) {
      signal.throwIfAborted()
      return nativeResolvePath(input.raw, input.cwd ?? workspace.nativeCwd, signal)
    },
    async prepareShell(request, workspace, signal) {
      signal.throwIfAborted()
      request.signal?.throwIfAborted()
      return { ...request, sandboxPolicy: request.sandboxPolicy ?? nativePolicy(workspace) }
    },
    executionPolicy: nativePolicy,
  }
}
