import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { UserSkill, UserSkillContent, UserSkillInput, WorkbenchSkills } from './extension.ts'
import type { WorkbenchLifecycle } from './info.ts'
import { parseFrontmatter } from './skills.ts'
import { checkedSkillDirectory, checkedSkillFile, checkedSkillRoot, moveSkillDirectory, scanSkillDraft } from './workforce/skill-drafts.ts'
import { safeName, type State, type WorkforceStore } from './workforce/store.ts'
import { WorkforceError } from './workforce/types.ts'

const digest = (content: string) => createHash('sha256').update(content).digest('hex')
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const own = (values: Record<string, string> | undefined, name: string) => values && Object.hasOwn(values, name) ? values[name] : undefined

async function replaceContent(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function validateContent(name: string, input: UserSkillInput): { description: string; content: string; origin?: string } {
  safeName(name)
  if (!input || typeof input.content !== 'string') throw new WorkforceError('bad_request', '技能正文无效')
  const meta = parseFrontmatter(input.content)
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(input.content)
  if (!frontmatter || meta.name !== name || typeof meta.description !== 'string' || !meta.description.trim()) throw new WorkforceError('bad_request', 'frontmatter 必须包含与目录相同的 name 和非空 description')
  const body = input.content.slice(frontmatter[0].length)
  // Scan all frontmatter fields as well as the body, using the existing core blockers.
  const findings = scanSkillDraft({ slug: name, title: input.content.slice(0, frontmatter[0].length), description: meta.description, body })
  const block = findings.find(item => item.level === 'block')
  if (block) throw new WorkforceError('bad_request', block.message)
  if (input.origin !== undefined && (typeof input.origin !== 'string' || !input.origin.trim() || input.origin.length > 200)) throw new WorkforceError('bad_request', '技能来源无效')
  return { description: meta.description, content: input.content, ...(input.origin !== undefined ? { origin: input.origin } : {}) }
}

/** User-only file operations share the workforce transaction and rollback barrier. */
export class WorkbenchUserSkills implements WorkbenchSkills {
  private readonly root: string
  constructor(private readonly store: WorkforceStore, userRoot: string, private readonly refresh?: () => void | Promise<void>, private readonly lifecycle?: WorkbenchLifecycle) {
    this.root = resolve(userRoot)
  }

  userRoot(): string { return this.root }

  private async operation<T>(action: () => Promise<T>): Promise<T> {
    const release = this.lifecycle?.operation()
    try { return await action() } finally { release?.() }
  }
  private origin(state: Readonly<State>, name: string): string {
    return own(state.userSkillOrigins, name) ?? (state.installedSkills.some(item => item.slug === name) ? 'workflow' : 'user')
  }
  private async content(name: string, state: Readonly<State>): Promise<UserSkillContent> {
    safeName(name)
    let content: string
    try { content = await readFile(await checkedSkillFile(this.root, name), 'utf8') }
    catch (error) { if (missing(error)) throw new WorkforceError('not_found', '用户技能不存在'); throw error }
    const meta = parseFrontmatter(content)
    if (meta.name !== name) throw new WorkforceError('bad_request', '技能目录与 frontmatter name 不一致')
    return { name, description: meta.description ?? '', origin: this.origin(state, name), content }
  }

  list(): Promise<readonly UserSkill[]> {
    return this.operation(() => this.store.snapshot(async state => {
      let root: string
      try { root = await checkedSkillRoot(this.root) } catch (error) { if (missing(error)) return []; throw error }
      const result: UserSkill[] = []
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        try {
          const { content: _content, ...skill } = await this.content(entry.name, state)
          result.push(skill)
        } catch (error) {
          if (error instanceof WorkforceError && error.code === 'not_found') continue
          throw error
        }
      }
      return result.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    }))
  }

  read(name: string): Promise<UserSkillContent> {
    return this.operation(() => this.store.snapshot(state => this.content(name, state)))
  }

  create(name: string, input: UserSkillInput): Promise<UserSkillContent> {
    const value = validateContent(name, input)
    return this.operation(async () => {
      let directory: string | undefined
      let refreshStarted = false
      return this.store.change(async state => {
        const root = await checkedSkillRoot(this.root, true)
        const target = join(root, name)
        try { await mkdir(target) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkforceError('conflict', '用户技能目录已存在')
          throw error
        }
        directory = target
        await checkedSkillDirectory(root, name)
        await replaceContent(join(directory, 'SKILL.md'), value.content)
        const origin = value.origin ?? 'user'
        state.userSkillOrigins = { ...state.userSkillOrigins, [name]: origin }
        state.userSkillHashes = { ...state.userSkillHashes, [name]: digest(value.content) }
        refreshStarted = true
        await this.refresh?.()
        return { name, description: value.description, origin, content: value.content }
      }, async () => {
        if (directory !== undefined) await rm(directory, { recursive: true, force: true })
        if (refreshStarted) await this.refresh?.()
      })
    })
  }

  update(name: string, input: UserSkillInput): Promise<UserSkillContent> {
    const value = validateContent(name, input)
    return this.operation(async () => {
      let path: string | undefined, previous: string | undefined
      let written = false, refreshStarted = false
      return this.store.change(async state => {
        const old = await this.content(name, state)
        path = await checkedSkillFile(this.root, name)
        previous = old.content
        await replaceContent(path, value.content)
        written = true
        const origin = value.origin ?? old.origin
        const sha256 = digest(value.content)
        state.userSkillOrigins = { ...state.userSkillOrigins, [name]: origin }
        state.userSkillHashes = { ...state.userSkillHashes, [name]: sha256 }
        for (const item of state.installedSkills) if (item.slug === name) item.sha256 = sha256
        refreshStarted = true
        await this.refresh?.()
        return { name, description: value.description, origin, content: value.content }
      }, async () => {
        if (written && path !== undefined && previous !== undefined) await replaceContent(path, previous)
        if (refreshStarted) await this.refresh?.()
      })
    })
  }

  remove(name: string): Promise<void> {
    safeName(name)
    return this.operation(async () => {
      let source: string | undefined, target: string | undefined
      let moved = false, refreshStarted = false
      await this.store.change(async state => {
        await this.content(name, state)
        source = await checkedSkillDirectory(this.root, name)
        const quarantine = await checkedSkillRoot(join(this.store.directory, 'skills-removed'), true)
        target = join(quarantine, `${name}-${randomUUID()}`)
        await moveSkillDirectory(source, target)
        moved = true
        state.installedSkills = state.installedSkills.filter(item => item.slug !== name)
        for (const employee of state.employees) employee.skills = employee.skills.filter(item => item !== name)
        if (state.userSkillOrigins) delete state.userSkillOrigins[name]
        if (state.userSkillHashes) delete state.userSkillHashes[name]
        refreshStarted = true
        await this.refresh?.()
      }, async () => {
        if (moved) await moveSkillDirectory(target!, source!)
        if (refreshStarted) await this.refresh?.()
      })
    })
  }

  changed(names: readonly string[]): Promise<void> {
    const selected = [...new Set(names.map(name => safeName(name)))]
    return this.operation(async () => {
      let refreshStarted = false
      await this.store.change(async state => {
        for (const name of selected) {
          let content: string
          try { content = await readFile(await checkedSkillFile(this.root, name), 'utf8') }
          catch (error) { if (missing(error)) throw new WorkforceError('not_found', '用户技能不存在'); throw error }
          validateContent(name, { content })
          const sha256 = digest(content)
          state.userSkillHashes = { ...state.userSkillHashes, [name]: sha256 }
          for (const item of state.installedSkills) if (item.slug === name) item.sha256 = sha256
        }
        refreshStarted = true
        await this.refresh?.()
      }, async () => { if (refreshStarted) await this.refresh?.() })
    })
  }
}
