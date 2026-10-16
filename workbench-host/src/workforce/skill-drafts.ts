/**
 * 沉淀技能草稿：草稿存 workforce state（skillDrafts），不落任何活跃 skill 根；
 * 安装才写入 $DSH_HOME/skills/<slug>/SKILL.md。
 */
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { requiredText, safeName, type WorkforceStore } from './store.ts'
import { parseFrontmatter } from '../skills.ts'
import { WorkforceError, type WorkforceSkillDraft, type WorkforceSkillFinding, type WorkforceUserSkill } from './types.ts'

const stamp = () => new Date().toISOString()

/** Shared fence for both reviewed drafts and public user-root CRUD. */
export async function checkedSkillRoot(root: string, create = false): Promise<string> {
  const path = resolve(root)
  if (create) await mkdir(path, { recursive: true })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkforceError('bad_request', '用户技能根必须是独立目录，不能是链接')
  return realpath(path)
}

export async function checkedSkillDirectory(root: string, name: string): Promise<string> {
  const canonical = await checkedSkillRoot(root)
  const path = join(canonical, safeName(name))
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new WorkforceError('bad_request', '技能目录不能链接到其他位置')
  return path
}

export async function checkedSkillFile(root: string, name: string): Promise<string> {
  const path = join(await checkedSkillDirectory(root, name), 'SKILL.md')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) throw new WorkforceError('bad_request', '技能正文必须是目录内的普通文件，不能是链接')
  return path
}

/** Cross-device isolation keeps a complete rollback copy until source removal succeeds. */
export async function moveSkillDirectory(source: string, target: string): Promise<void> {
  try { await rename(source, target); return } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  await mkdir(target)
  try { await cp(source, target, { recursive: true, force: false, errorOnExist: true }) } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
  try { await rm(source, { recursive: true }) } catch (error) {
    await cp(target, source, { recursive: true })
    await rm(target, { recursive: true })
    throw error
  }
}

export const SKILL_BODY_LIMIT = 20000
const SLUG_PATTERN = /^user-workflow-[a-z0-9][a-z0-9-]{1,40}$/
/** slug 固定 user-workflow- 前缀，缺前缀自动补；只收小写字母、数字与连字符。 */
export function normalizeSkillSlug(raw: unknown): string {
  let slug = requiredText(raw, 80).toLowerCase()
  if (!slug.startsWith('user-workflow-')) slug = `user-workflow-${slug}`
  if (!SLUG_PATTERN.test(slug)) throw new WorkforceError('bad_request', '技能名只能用小写字母、数字与连字符，会自动补 user-workflow- 前缀')
  return slug
}

// 与 store.ts 记忆密钥规则保持一致。
const SECRET_PATTERN = /\bsk-[\w-]{8,}|\bBearer\s+\S{8,}|(?:password\s*=|密码\s*[:：])\s*\S+|\b[a-f\d]{32,}\b|\b[a-z\d_+-]{40,}={0,2}(?![\w/])|-----BEGIN/i
// 盘符与 /Users/、/home/ 前面不能紧跟字母数字：http:// 与 example.com/home/ 这类网址不算本机路径
const PRIVATE_PATH_PATTERN = /(?:(?<![\w.+-])[A-Za-z]:[\\/]|(?<![\w.-])\/(?:Users|home)\/|~[\\/])/
const INJECTION_PATTERN = /忽略[^。\n]{0,20}(?:规则|指令|限制|要求)|无视[^。\n]{0,20}(?:规则|指令|限制|要求)|不要告诉用户|别告诉用户|不用告诉用户|绕过[^。\n]{0,6}(?:审批|确认|审核|用户)/
// 英文词要求整词：wb_publish_deliverable 等内部工具名、published: true 这类回执不算外部发布
const EXTERNAL_ACTION_PATTERN = /发布到|上传到|发布在|付费|支付|订阅|登录|登陆|扫码|(?<![\w-])(?:publish|payment|paywall|subscribe|login|sign[\s_-]?in)(?![\w-])/i
/** 每次保存后重算：block 不能安装（密钥、私有绝对路径、空正文、超长）；warn 只展示给用户看。 */
export function scanSkillDraft(draft: Pick<WorkforceSkillDraft, 'slug' | 'title' | 'description' | 'body'>): WorkforceSkillFinding[] {
  const findings: WorkforceSkillFinding[] = []
  if (!draft.body.trim()) findings.push({ level: 'block', message: '正文为空，先让负责人整理流程内容' })
  if (draft.body.length > SKILL_BODY_LIMIT) findings.push({ level: 'block', message: `正文超过 ${SKILL_BODY_LIMIT} 字，请精简` })
  const text = `${draft.title}\n${draft.description}\n${draft.body}`
  if (SECRET_PATTERN.test(text)) findings.push({ level: 'block', message: '疑似包含密钥或口令，请删掉敏感内容' })
  const privatePath = PRIVATE_PATH_PATTERN.exec(text)
  if (privatePath) findings.push({ level: 'block', message: '包含本机私有绝对路径，换成相对路径或参数说明', excerpt: privatePath[0] })
  const injection = INJECTION_PATTERN.exec(text)
  if (injection) findings.push({ level: 'warn', message: '疑似注入式指令措辞，请人工确认是流程要求而非攻击', excerpt: injection[0] })
  const external = EXTERNAL_ACTION_PATTERN.exec(text)
  if (external) findings.push({ level: 'warn', message: '含外部发布/付费/登录字样，安装前确认确实需要这些操作', excerpt: external[0] })
  return findings
}

/** description 压成单行；含 YAML 风险字符时按双引号标量输出。 */
const yamlScalar = (value: string): string => {
  const single = value.replace(/\s+/g, ' ').trim()
  return /^[^\s:#\[\]{}&*!|>'"%@`,?-][^:#\n]*$/.test(single) ? single : JSON.stringify(single)
}
/** SKILL.md：frontmatter name/description + 正文 + 末尾一行来源（任务标题与安装日期）。 */
export function renderSkillMarkdown(draft: WorkforceSkillDraft, taskTitle: string, installedAt: string): string {
  const source = `任务「${taskTitle.replace(/<!--|-->/g, '')}」，${installedAt.slice(0, 10)} 沉淀`
  return `---\nname: ${draft.slug}\ndescription: ${yamlScalar(draft.description)}\n---\n\n${draft.body.trim()}\n\n<!-- 来源：${source} -->\n`
}

/**
 * 创建沉淀请求：默认 running 任务 409；已鉴权的内部负责人路径可显式传 allowRunning: true。
 * 同任务存在未安装的草稿就先复用那份（幂等）。
 */
export async function findOrCreateSkillDraft(store: WorkforceStore, taskId: string, note?: string, options?: { allowRunning?: boolean }): Promise<{ draft: WorkforceSkillDraft; created: boolean }> {
  return store.change(state => {
    const task = state.tasks.find(item => item.id === taskId)
    if (!task) throw new WorkforceError('not_found', '任务不存在')
    // 先认已有草稿：第一次请求会把任务重新置 running，重复发起应返回同一份而非 409
    const live = state.skillDrafts.find(item => item.taskId === taskId && item.status !== 'installed')
    if (live) return { draft: structuredClone(live), created: false }
    if (task.status === 'running' && options?.allowRunning !== true) throw new WorkforceError('conflict', '任务结束后再沉淀')
    const time = stamp()
    const draft: WorkforceSkillDraft = {
      id: randomUUID(), taskId, slug: '', title: task.title || '未命名流程', description: '', body: '', status: 'requested',
      ...(note !== undefined ? { note } : {}), findings: [], createdAt: time, updatedAt: time,
    }
    state.skillDrafts.push(draft)
    return { draft, created: true }
  })
}

export async function listSkillDrafts(store: WorkforceStore): Promise<WorkforceSkillDraft[]> {
  return (await store.read()).skillDrafts
}
export async function getSkillDraft(store: WorkforceStore, draftId: string): Promise<WorkforceSkillDraft> {
  const draft = (await store.read()).skillDrafts.find(item => item.id === draftId)
  if (!draft) throw new WorkforceError('not_found', '技能草稿不存在')
  return draft
}

/** 保存/编辑草稿字段并重算扫描；nextStatus 用于负责人提交时落成 drafted。installed 后拒绝。 */
export async function saveSkillDraftFields(store: WorkforceStore, draftId: string, fields: { slug?: unknown; title?: unknown; description?: unknown; body?: unknown; note?: unknown }, editedBy: string, nextStatus?: WorkforceSkillDraft['status']): Promise<WorkforceSkillDraft> {
  return store.change(state => {
    const draft = state.skillDrafts.find(item => item.id === draftId)
    if (!draft) throw new WorkforceError('not_found', '技能草稿不存在')
    if (draft.status === 'installed') throw new WorkforceError('conflict', '已安装的草稿不能再修改')
    if (fields.slug !== undefined) draft.slug = normalizeSkillSlug(fields.slug)
    if (fields.title !== undefined) draft.title = requiredText(fields.title, 200)
    if (fields.description !== undefined) draft.description = requiredText(fields.description, 1000)
    if (fields.body !== undefined) {
      if (typeof fields.body !== 'string') throw new WorkforceError('bad_request', '正文必须是字符串')
      draft.body = fields.body
    }
    if (fields.note !== undefined) draft.note = requiredText(fields.note, 1000)
    // 只与未安装的草稿去重；撞已安装 slug 的情况由安装时目录存在检查兜住
    if (draft.slug && state.skillDrafts.some(item => item.id !== draft.id && item.status !== 'installed' && item.slug === draft.slug)) throw new WorkforceError('conflict', '另一份草稿已使用这个技能名')
    if (nextStatus !== undefined) draft.status = nextStatus
    draft.findings = scanSkillDraft(draft)
    draft.editedBy = editedBy
    draft.updatedAt = stamp()
    return structuredClone(draft)
  })
}

/** 用户退回草稿（仅 drafted 可退）：status=returned + 意见。 */
export async function markSkillDraftReturned(store: WorkforceStore, draftId: string, note: string): Promise<WorkforceSkillDraft> {
  return store.change(state => {
    const draft = state.skillDrafts.find(item => item.id === draftId)
    if (!draft) throw new WorkforceError('not_found', '技能草稿不存在')
    if (draft.status !== 'drafted') throw new WorkforceError('conflict', '只有待审核的草稿可以退回')
    draft.status = 'returned'
    draft.note = requiredText(note, 1000)
    draft.updatedAt = stamp()
    return structuredClone(draft)
  })
}

export async function deleteSkillDraft(store: WorkforceStore, draftId: string): Promise<void> {
  await store.change(state => {
    const draft = state.skillDrafts.find(item => item.id === draftId)
    if (!draft) throw new WorkforceError('not_found', '技能草稿不存在')
    if (draft.status === 'installed') throw new WorkforceError('conflict', '已安装的草稿不能删除')
    state.skillDrafts = state.skillDrafts.filter(item => item.id !== draftId)
  })
}

/**
 * 安装：写 $DSH_HOME/skills/<slug>/SKILL.md（同目录临时文件再 rename；目录已存在拒绝）。
 * 落盘成功才改 state：草稿 installed、安装记录（含正文 sha256）、勾选员工追加技能名。
 */
export async function installSkillDraft(store: WorkforceStore, userSkillsRoot: string, draftId: string, employeeIds: readonly string[] = [], refresh?: () => void | Promise<void>): Promise<{ draft: WorkforceSkillDraft; path: string }> {
  let directory: string | undefined, refreshStarted = false
  return store.change(async state => {
    const draft = state.skillDrafts.find(item => item.id === draftId)
    if (!draft) throw new WorkforceError('not_found', '技能草稿不存在')
    if (draft.status !== 'drafted') throw new WorkforceError('conflict', '只有待审核的草稿可以安装')
    const findings = scanSkillDraft(draft)
    const block = findings.find(item => item.level === 'block')
    if (block) throw new WorkforceError('conflict', `草稿还有必须处理的问题：${block.message}`)
    const task = state.tasks.find(item => item.id === draft.taskId)
    for (const id of employeeIds) if (!state.employees.some(item => item.id === id)) throw new WorkforceError('not_found', `员工不存在：${id}`)
    const installedAt = stamp()
    const markdown = renderSkillMarkdown(draft, task?.title ?? draft.taskId, installedAt)
    const root = await checkedSkillRoot(userSkillsRoot, true)
    const dir = join(root, safeName(draft.slug)), path = join(dir, 'SKILL.md')
    try { await mkdir(dir) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkforceError('conflict', '目标技能目录已存在，请换一个技能名')
      throw error
    }
    directory = dir
    await checkedSkillDirectory(root, draft.slug)
    const temporary = join(dir, `SKILL-${randomUUID()}.tmp`)
    await writeFile(temporary, markdown, { flag: 'wx' })
    await rename(temporary, path)
    const sha256 = createHash('sha256').update(markdown).digest('hex')
    draft.status = 'installed'
    draft.installedAt = installedAt
    draft.findings = findings
    draft.updatedAt = installedAt
    state.installedSkills.push({ slug: draft.slug, draftId: draft.id, installedAt, sha256 })
    const bind = new Set(employeeIds)
    for (const employee of state.employees) if (bind.has(employee.id) && !employee.skills.includes(draft.slug)) employee.skills.push(draft.slug)
    refreshStarted = true
    await refresh?.()
    return { draft: structuredClone(draft), path }
  }, async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    if (refreshStarted) await refresh?.()
  })
}

/** 读 $DSH_HOME/skills 一层目录：name/description 取 frontmatter，origin 按安装记录判断。 */
export async function listUserSkills(store: WorkforceStore, userSkillsRoot: string): Promise<WorkforceUserSkill[]> {
  const state = await store.read()
  let entries
  try { entries = await readdir(await checkedSkillRoot(userSkillsRoot), { withFileTypes: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const skills: WorkforceUserSkill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    let raw
    try { raw = await readFile(await checkedSkillFile(userSkillsRoot, entry.name), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    const meta = parseFrontmatter(raw)
    skills.push({
      name: meta.name ?? entry.name, description: meta.description ?? '',
      origin: state.installedSkills.some(item => item.slug === entry.name) ? 'workflow' : 'user',
    })
  }
  return skills
}

/**
 * 禁用：只对 origin=workflow 生效。目录移到 <数据根>/workforce/skills-disabled/<name>-<时间>/，
 * 并从所有员工 skills 移除；不删除文件。目录已不在也照常解绑。
 */
export async function disableUserSkill(store: WorkforceStore, userSkillsRoot: string, name: string, refresh?: () => void | Promise<void>): Promise<{ name: string; movedTo?: string }> {
  const skillName = safeName(requiredText(name, 80))
  let source: string | undefined, target: string | undefined, movedTo: string | undefined
  let refreshStarted = false
  return store.change(async state => {
    if (!state.installedSkills.some(item => item.slug === skillName)) throw new WorkforceError('not_found', '只能禁用通过沉淀安装的技能')
    try { source = await checkedSkillDirectory(userSkillsRoot, skillName) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (source !== undefined) {
      const disabledRoot = await checkedSkillRoot(join(store.directory, 'skills-disabled'), true)
      target = join(disabledRoot, `${skillName}-${stamp().replace(/[:.]/g, '-')}-${randomUUID()}`)
      await moveSkillDirectory(source, target)
      movedTo = target
    }
    state.installedSkills = state.installedSkills.filter(item => item.slug !== skillName)
    for (const employee of state.employees) employee.skills = employee.skills.filter(item => item !== skillName)
    if (state.userSkillOrigins) delete state.userSkillOrigins[skillName]
    if (state.userSkillHashes) delete state.userSkillHashes[skillName]
    refreshStarted = true
    await refresh?.()
    return { name: skillName, ...(movedTo !== undefined ? { movedTo } : {}) }
  }, async () => {
    if (movedTo !== undefined) await moveSkillDirectory(target!, source!)
    if (refreshStarted) await refresh?.()
  })
}
