import { constants, copyFileSync, lstatSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, relative, isAbsolute, dirname, extname } from 'node:path'
import type { EmployeeToolPolicy, EmployeeWorkspace } from './employee-tool-contract.js'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillDefinition, SkillSummary, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import { isDeepStrictEqual } from 'node:util'

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
  // Check the spelling too: realpath alone would hide a provider-owned junction.
  let cursor = source
  while (true) {
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Skill resources contain a link')
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
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

/** Keeps the native skill loader/catalog intact, including user-explicit /skill loads. */
export async function installEmployeeSkillResources(ctx: Context, workspace: EmployeeWorkspace, policy: EmployeeToolPolicy, agentScope: object, parentScope: object | undefined): Promise<void> {
  const skills = ctx.skills
  if (!skills || typeof skills.snapshot !== 'function' || typeof skills.get !== 'function' || typeof skills.registerProvider !== 'function') throw new Error('Native skill provider projection API unavailable')
  const signal = new AbortController().signal
  const inheritedOptions: SkillViewOptions = { cwd: workspace.nativeCwd, scope: parentScope, signal }
  const inherited = await skills.snapshot(inheritedOptions)
  const original = await skills.snapshot({ ...inheritedOptions, scope: agentScope })
  if (!original.complete) throw new Error('Native employee skill catalog is incomplete')
  // Capture own winners before registration; subsequent base lookups use the
  // inherited parent scope, so they cannot recurse into these projections.
  const owned = new Map<string, SkillDefinition>()
  for (const summary of original.skills) {
    if (isDeepStrictEqual(summary, inherited.skills.find(item => item.name === summary.name))) continue
    const definition = await skills.get(summary.name, { ...inheritedOptions, scope: agentScope })
    if (!definition) throw new Error(`Native employee skill ${summary.name} became unavailable`)
    if (definition.resourceBase?.kind === 'directory') throw new Error(`Own skill provider \"${summary.provider}\" has directory resources for \"${summary.name}\" but the native registry has no public replacement seam`)
    owned.set(summary.name, definition)
  }
  const ownedProviders = new Set([...owned.values()].filter(definition => definition.provider !== 'runtime').map(definition => definition.provider))
  for (const summary of original.skills) {
    if (ownedProviders.has(summary.provider) && summary.resourceBase?.kind === 'directory') throw new Error(`Own skill provider \"${summary.provider}\" has visible directory resources but cannot be projected without replacing its native registration`)
  }
  if (!inherited.complete) throw new Error('Native inherited skill catalog is incomplete')
  const registered = new Set<string>()
  const runtimeRegistered = new Map<string, { original: SkillDefinition; dispose: () => void }>()
  const project = async (definition: SkillDefinition, callerSignal: AbortSignal): Promise<SkillDefinition> => {
    if (definition.resourceBase?.kind !== 'directory') return definition
    return { ...definition, resourceBase: { kind: 'directory', path: await stageEmployeeResource(definition.resourceBase.path, workspace, policy, callerSignal) } }
  }
  const synchronize = async (callerSignal: AbortSignal): Promise<void> => {
    const catalog = await skills.snapshot({ ...inheritedOptions, signal: callerSignal })
    if (!catalog.complete) throw new Error('Native inherited skill catalog is incomplete')
    const winners = new Map<string, SkillSummary>(catalog.skills.map(summary => [summary.name, summary]))
    for (const [name, definition] of owned) winners.set(name, definition)
    for (const summary of winners.values()) {
      if (summary.provider === 'runtime') {
        const previous = runtimeRegistered.get(summary.name)
        const definition = owned.get(summary.name) ?? await skills.get(summary.name, { ...inheritedOptions, signal: callerSignal })
        if (!definition) throw new Error(`Native runtime skill ${summary.name} became unavailable`)
        if (owned.has(summary.name) || (previous && isDeepStrictEqual(previous.original, definition))) continue
        const projected = await project(definition, callerSignal)
        previous?.dispose()
        const dispose = skills.register(projected)
        const installed = await skills.get(summary.name, { ...inheritedOptions, scope: agentScope, signal: callerSignal })
        if (!isDeepStrictEqual(installed, projected)) { dispose(); throw new Error(`Native runtime skill ${summary.name} could not be projected in the employee scope`) }
        runtimeRegistered.set(summary.name, { original: definition, dispose })
        continue
      }
      // Same-layer native providers with no directory resources need no projection;
      // their original definitions remain live and keep native loading semantics.
      if (ownedProviders.has(summary.provider) || registered.has(summary.provider)) continue
      const provider = summary.provider
      try {
      skills.registerProvider(control => ({
        name: provider,
        async list(options) {
          const listing = await skills.snapshot({ cwd: options.cwd ?? workspace.nativeCwd, scope: parentScope, signal: options.signal ?? control.signal })
          const winners = new Map<string, SkillSummary>(listing.skills.map(item => [item.name, item]))
          for (const [name, definition] of owned) winners.set(name, definition)
          const candidates: SkillCandidate[] = [...winners.values()].filter(item => item.provider === provider).map(item => ({ ...item, rank: 0, locator: item.name }))
          return { candidates, complete: listing.complete }
        },
        async get(candidate, options) {
          const caller = options.signal ?? control.signal
          const definition = owned.get(candidate.name) ?? await skills.get(candidate.name, { cwd: options.cwd ?? workspace.nativeCwd, scope: parentScope, signal: caller })
          if (!definition || definition.provider !== provider) return undefined
          return project(definition, caller)
        },
      }))
      } catch (error: unknown) {
        // Equal catalog summaries cannot expose which layer owns a provider.
        // Native's exact same-layer collision is the public admission fact;
        // it leaves the original registration intact.
        if (!(error instanceof Error) || error.message !== `a skill provider named "${provider}" is already registered in this scope`) throw error
        const current = await skills.snapshot({ ...inheritedOptions, scope: agentScope, signal: callerSignal })
        if (!current.complete) throw new Error('Native employee skill catalog is incomplete')
        for (const item of current.skills) {
          if (item.provider !== provider) continue
          const definition = await skills.get(item.name, { ...inheritedOptions, scope: agentScope, signal: callerSignal })
          if (!definition) throw new Error(`Own skill provider "${provider}" became unavailable`)
          if (definition.resourceBase?.kind === 'directory') throw new Error(`Own skill provider "${provider}" has directory resources but the native registry has no public replacement seam`)
        }
        ownedProviders.add(provider)
        continue
      }
      registered.add(provider)
    }
    for (const [name, registration] of runtimeRegistered) {
      if (winners.has(name)) continue
      registration.dispose()
      runtimeRegistered.delete(name)
    }
  }
  await synchronize(signal)
  ctx.on('agent/pre-step', async (step, next) => {
    await synchronize(step.signal)
    return next()
  }, { prepend: true })
}
