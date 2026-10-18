import { constants, copyFileSync, lstatSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, relative, isAbsolute, dirname, extname } from 'node:path'
import type { EmployeeToolPolicy, EmployeeWorkspace } from './employee-tool-contract.js'
import type { Context } from '@deepseek-ai/cordis'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Job output sources are synchronous; stage their genuine executor spill before native rendering. */
export function employeeSpillProjection(workspace: EmployeeWorkspace, options: { preserveExtension?: boolean } = {}): (raw: unknown) => unknown {
  const copies = new Map<string, { path: string; size: number; sourceMtime: number; copyMtime: number }>()
  return raw => {
    if (typeof raw !== 'object' || raw === null || !('spillPath' in raw) || typeof raw.spillPath !== 'string') return raw
    const source = raw.spillPath
    if (within(workspace.root, source)) return raw
    let cursor = source
    while (true) {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('Executor spill contains a link')
      const parent = dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
    const info = lstatSync(source)
    if (!info.isFile() || info.nlink !== 1) throw new Error('Executor spill is not an independent regular file')
    const folder = join(workspace.root, '.tmp')
    if (!within(realpathSync(workspace.root), realpathSync(folder)) || lstatSync(folder).isSymbolicLink()) throw new Error('Employee spill directory escaped its root')
    const existing = copies.get(source)
    const extension = options.preserveExtension ? (/^\.(?:png|jpe?g|webp|gif)$/i.test(extname(source)) ? extname(source) : '') : '.txt'
    const destination = existing?.path ?? join(folder, `${randomUUID()}${extension}`)
    if (existing) {
      const target = lstatSync(destination)
      if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1) throw new Error('Employee spill copy was replaced')
      if (existing.size !== info.size || existing.sourceMtime !== info.mtimeMs || target.size !== existing.size || target.mtimeMs !== existing.copyMtime) {
        copyFileSync(source, destination)
        copies.set(source, { path: destination, size: info.size, sourceMtime: info.mtimeMs, copyMtime: lstatSync(destination).mtimeMs })
      }
    } else {
      copyFileSync(source, destination, constants.COPYFILE_EXCL)
      copies.set(source, { path: destination, size: info.size, sourceMtime: info.mtimeMs, copyMtime: lstatSync(destination).mtimeMs })
    }
    return { ...raw, spillPath: destination }
  }
}
function within(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

/** Copies provider resources, never links or shared inodes. Copies confer no execution authority. */
export async function stageEmployeeResource(source: string, ws: EmployeeWorkspace, policy: EmployeeToolPolicy, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const root = await realpath(source)
  if (!(await lstat(root)).isDirectory()) throw new Error('Skill directory resource is not a directory')
  const workspaceRoot = await realpath(ws.root)
  if (within(workspaceRoot, root)) {
    // Already-local resources need a full tree fence, not another nested copy.
    const checked = await policy.resolvePath({ raw: source, access: 'search' }, ws, signal)
    if (checked.type !== 'directory') throw new Error('Skill directory resource is not a directory')
    return checked.absolutePath
  }
  // A native provider may expose a linked skill root. Only its resolved tree is
  // copied; descendant links remain forbidden and confer no filesystem access.
  const id = createHash('sha256').update(root).digest('hex').slice(0, 16)
  const resourceName = `${id}-${randomUUID()}`
  const destination = join(ws.root, '.resources', resourceName)
  if (within(root, join(workspaceRoot, '.resources', resourceName))) throw new Error('Skill resource destination would be inside its source tree')
  async function copy(current: string, target: string): Promise<void> {
    signal.throwIfAborted()
    const info = await lstat(current)
    if (info.isSymbolicLink() || !within(root, await realpath(current))) throw new Error('Skill resources contain a link')
    const checked = await policy.resolvePath({ raw: target, access: 'write' }, ws, signal)
    if (info.isDirectory()) {
      await mkdir(checked.absolutePath, { recursive: true, mode: 0o700 })
      for (const name of await readdir(current)) await copy(join(current, name), join(checked.absolutePath, name))
    } else if (info.isFile() && info.nlink === 1) {
      const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const opened = await handle.stat()
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error('Skill resource changed during staging')
        const output = await open(checked.absolutePath, 'wx', 0o600)
        try {
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            signal.throwIfAborted()
            await output.write(chunk as Buffer)
          }
        } finally { await output.close() }
      } finally { await handle.close() }
    } else throw new Error('Skill resources must be ordinary independent files')
  }
  await copy(root, destination)
  return destination
}

/** Projects loaded resources while preserving native providers, tool identity and catalog semantics. */
export async function installEmployeeSkillResources(ctx: Context, workspace: EmployeeWorkspace, policy: EmployeeToolPolicy, agentScope: object): Promise<(exec: ToolExecution, result: ToolExecutionResult) => Promise<ToolExecutionResult>> {
  const skills = ctx.skills
  const workingDirectory = ctx.get('workingDirectory') as { ensure(agent: unknown, signal: AbortSignal): Promise<string> } | undefined
  if (!workingDirectory || typeof workingDirectory.ensure !== 'function') throw new Error('Native working directory service unavailable')
  if (!skills || typeof skills.snapshot !== 'function' || typeof skills.get !== 'function') throw new Error('Native skill provider projection API unavailable')
  const catalog = await skills.snapshot({ cwd: workspace.nativeCwd, scope: agentScope })
  if (!catalog.complete) throw new Error('Native employee skill catalog is incomplete')
  ctx.on('agent/pre-step', async (step, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const messages = await Promise.all(decision.messages.map(async message => {
      if (message.source.kind !== 'skill-invocation') return message
      const skill = await skills.get(message.source.name, { cwd: await workingDirectory.ensure(step.agent, step.signal), scope: agentScope, signal: step.signal })
      if (!skill) throw new Error(`Native invoked skill ${message.source.name} became unavailable`)
      if (skill.resourceBase?.kind !== 'directory') return message
      const resourceBase = { kind: 'directory' as const, path: await stageEmployeeResource(skill.resourceBase.path, workspace, policy, step.signal) }
      return { ...message, content: [{ type: 'text' as const, text: renderSkillContent({ ...skill, resourceBase }) }] }
    }))
    return { ...decision, messages }
  }, { prepend: true })
  return async (exec, result) => {
    if (exec.name !== 'skill' || result.isError) return result
    const value = result.value
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return result
    const resource = value.resourceBase
    if (typeof resource !== 'object' || resource === null || Array.isArray(resource) || resource.kind !== 'directory' || typeof resource.path !== 'string') return result
    const path = await stageEmployeeResource(resource.path, workspace, policy, exec.signal)
    // Native tools normalizes an authored around-dispatch result through the
    // original output schema and renderer before any retention policy runs.
    return { ...result, value: { ...value, resourceBase: { kind: 'directory', path } } }
  }
}
