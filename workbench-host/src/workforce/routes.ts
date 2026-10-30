import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdmitFn, WorkbenchInfo, WorkbenchSkills } from '../extension.ts'
import { serveFile } from '../http-files.ts'
import { WorkforceError, type WorkforceThread } from './types.ts'
import { requiredText, safeName } from './store.ts'
import type { WorkforceRuntime } from './runtime.ts'
import type { EmployeeMcp } from './mcp.ts'
import { WorkbenchTemplateService } from './templates.ts'
import type { SkillsService } from '../skills.ts'
import { MAX_MATERIAL_BYTES, MATERIAL_SIZE_ERROR, attachmentDisposition, isActiveMaterial, isInstallerName, isPreviewableMime, materialMime } from './material-files.ts'
import { collectWorkforceDiagnostics } from './diagnostics.ts'
import { createWorkforceBackup } from './backup.ts'
import { DEFAULT_IMAGE_PROVIDER, detectCodex, parseImageProvider, type Subprocess } from './image-generation.ts'

/** Explicit core handler dependencies; optional native surfaces retain standalone test seams. */
export interface WorkforceHandlerDeps {
  skills?: SkillsService
  skillScope?: () => Promise<({ key: object } & AsyncDisposable) | undefined>
  mcp?: EmployeeMcp
  templates?: WorkbenchTemplateService
  userSkills?: WorkbenchSkills
  info?: WorkbenchInfo
  defaultModel?: () => unknown
  sessionPersistence?: () => unknown
  /** $DSH_HOME/skills：安装根与备份复制的来源目录。 */
  userSkillsRoot?: string
  credentials?: () => { describe(ref: string): Promise<unknown>; set(ref: string, value: string): Promise<void>; unset(ref: string): Promise<void> } | undefined
  subprocess?: () => Subprocess | undefined
}

interface SkillListLike extends SkillsService {
  list(options?: Record<string, unknown>): Promise<unknown[]>
}

const PREFIX = '/wb/api/workforce'
const send = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
const ok = (res: ServerResponse, data: unknown) => send(res, 200, { ok: true, data })
/** 未读判定用的真实正文时间：lastMessageAt（正文投影/一次性迁移）；task 线程兼容
 *  取 createdAt=首条用户消息时间。无正文 ''——创建/ensure/改名/取消只动 updatedAt，不复活已读。 */
const threadContentAt = (thread: WorkforceThread): string => thread.lastMessageAt ?? (thread.kind === 'task' ? thread.createdAt ?? '' : '')
async function rawBody(req: IncomingMessage, limit: number, oversized: string): Promise<Buffer> {
  if (Number(req.headers['content-length']) > limit) {
    req.resume()
    throw new WorkforceError('bad_request', oversized)
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) {
      req.resume()
      throw new WorkforceError('bad_request', oversized)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}
async function body(req: IncomingMessage, limit = 2 * 1024 * 1024, oversized = '请求过大'): Promise<Record<string, unknown>> {
  const bytes = await rawBody(req, limit, oversized)
  let value: unknown
  try { value = bytes.length ? JSON.parse(bytes.toString('utf8')) : {} }
  catch { throw new WorkforceError('bad_request', '请求不是合法 JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkforceError('bad_request', '请求必须是对象')
  return value as Record<string, unknown>
}

async function serveWorkforceFile(req: IncomingMessage, res: ServerResponse, path: string, name: string, mime: string, download: boolean): Promise<void> {
  // 安装包类（exe/msi/dmg/…）只给外部 location/reveal 通道，GET/HEAD/download=1 一律拒字节：
  // 统一在共用出口拦截，避免任一 nativematerials 分支漏 gate。
  if (isInstallerName(name)) throw new WorkforceError('not_found', '安装包只可在文件夹中打开')
  const active = isActiveMaterial(name, mime)
  // 图片/视频/音频/PDF/文本默认可内联预览；?download=1 强制附件；Office/未知保守按附件下载。
  if (download || active || !isPreviewableMime(mime)) res.setHeader('content-disposition', attachmentDisposition(name))
  if (active) res.setHeader('content-security-policy', `sandbox; default-src 'none'`)
  await serveFile(req, res, path, name, active ? 'application/octet-stream' : mime)
}

export function createWorkforceHandler(runtime: WorkforceRuntime, admit: AdmitFn, fallback: (req: IncomingMessage, res: ServerResponse) => Promise<void>, deps: WorkforceHandlerDeps = {}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return fallback(req, res)
    const rejection = admit(req).rejection
    if (rejection) return send(res, rejection, { ok: false, error: { code: 'local_admission_required', message: '本机会话未授权' } })
    try {
      const seg = url.pathname.slice(PREFIX.length).split('/').filter(Boolean).map(value => { try { return decodeURIComponent(value) } catch { throw new WorkforceError('bad_request', '路径编码无效') } })
      const method = req.method ?? 'GET'
      const store = runtime.store
      const materialUpload = seg[0] === 'materials' && seg.length === 1 && method === 'POST'
      const encodedName = req.headers['x-workforce-filename']
      if (materialUpload && encodedName !== undefined) {
        if (typeof encodedName !== 'string') throw new WorkforceError('bad_request', '附件文件名无效')
        let name: string
        try { name = decodeURIComponent(encodedName) }
        catch { throw new WorkforceError('bad_request', '附件文件名编码无效') }
        safeName(name)
        const bytes = await rawBody(req, MAX_MATERIAL_BYTES, MATERIAL_SIZE_ERROR)
        return ok(res, { material: await store.uploadBytes(name, bytes, req.headers['content-type']) })
      }
      const input = ['POST', 'PATCH', 'PUT'].includes(method)
        ? await body(req, materialUpload ? MAX_MATERIAL_BYTES : undefined, materialUpload ? MATERIAL_SIZE_ERROR : undefined)
        : {}
      if (seg[0] === 'backup' && seg.length === 1 && method === 'POST') return ok(res, await createWorkforceBackup(store, deps.sessionPersistence?.(), deps.userSkillsRoot, deps.info))
      if (seg[0] === 'diagnostics' && seg.length === 1 && method === 'GET') {
        const taskId = url.searchParams.get('taskId')
        return ok(res, await collectWorkforceDiagnostics(runtime, taskId === null ? undefined : requiredText(taskId, 120), { mcp: deps.mcp, defaultModel: deps.defaultModel }))
      }
      // 桌面版「保存到本机」：同源 collect 一次，写到数据根 diagnostics/（wx 不覆盖），UI 拿路径后可系统级 reveal。
      if (seg[0] === 'diagnostics' && seg[1] === 'export' && seg.length === 2 && method === 'POST') {
        const report = await collectWorkforceDiagnostics(runtime, input.taskId === undefined ? undefined : requiredText(input.taskId, 120), { mcp: deps.mcp, defaultModel: deps.defaultModel })
        const directory = join(store.directory, 'diagnostics')
        await mkdir(directory, { recursive: true })
        const stamp = report.generatedAt.replace(/[:.]/g, '-')
        let path = join(directory, `workbench-diagnostics-${stamp}.json`), suffix = 1
        for (;;) {
          try { await writeFile(path, JSON.stringify(report, null, 2), { flag: 'wx' }); break }
          catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST' || suffix > 9) throw error
            path = join(directory, `workbench-diagnostics-${stamp}-${++suffix}.json`)
          }
        }
        return ok(res, { path })
      }
      if (seg[0] === 'memories') {
        if (seg.length === 1 && method === 'GET') return ok(res, await store.listMemories(url.searchParams.get('scope') || undefined, url.searchParams.get('scopeId') || undefined))
        if (seg.length === 1 && method === 'POST') return ok(res, { memory: await store.saveMemory(input) })
        if (seg.length === 2 && method === 'PATCH') return ok(res, { memory: await store.saveMemory(input, seg[1]) })
        if (seg.length === 2 && method === 'DELETE') { await store.deleteMemory(seg[1]!); return ok(res, { deleted: true }) }
      }
      if (seg[0] === 'employees') {
        if (seg.length === 1 && method === 'GET') return ok(res, { employees: (await store.read()).employees })
        if (seg.length === 1 && method === 'POST') return ok(res, { employee: await store.saveEmployee(input) })
        if (seg.length === 2 && method === 'PATCH') return ok(res, { employee: await store.saveEmployee(input, seg[1]) })
        if (seg.length === 2 && method === 'DELETE') { await store.deleteEmployee(seg[1]!); return ok(res, { deleted: true }) }
      }
      if (seg[0] === 'channels') {
        if (seg.length === 1 && method === 'GET') {
          const state = await store.read()
          const channels = state.channels.map(channel => ({ ...channel, unread: state.threads.some(thread => thread.channelId === channel.id && threadContentAt(thread) > (channel.readAt ?? '')) }))
          return ok(res, { channels, groups: state.channelGroups })
        }
        if (seg.length === 1 && method === 'POST') return ok(res, { channel: await store.saveChannel(input) })
        if (seg.length === 2) {
          if (method === 'PATCH') return ok(res, { channel: await store.saveChannel(input, seg[1]) })
          if (method === 'DELETE') { await store.deleteChannel(seg[1]!); return ok(res, { deleted: true }) }
        }
        if (seg.length === 3 && method === 'POST') {
          if (seg[2] === 'read') return ok(res, { channel: await store.markChannelRead(seg[1]!) })
          if (seg[2] === 'duplicate') return ok(res, { channel: await store.duplicateChannel(seg[1]!) })
        }
      }
      if (seg[0] === 'channel-groups') {
        if (seg.length === 1 && method === 'GET') return ok(res, { groups: (await store.read()).channelGroups })
        if (seg.length === 1 && method === 'POST') return ok(res, { group: await store.saveChannelGroup(input) })
        if (seg.length === 2) {
          if (method === 'PATCH') return ok(res, { group: await store.saveChannelGroup(input, seg[1]) })
          if (method === 'DELETE') { await store.deleteChannelGroup(seg[1]!); return ok(res, { deleted: true }) }
        }
      }
      if (seg[0] === 'profile') {
        if (seg.length === 1 && method === 'GET') return ok(res, { profile: await store.profile() })
        if (seg.length === 1 && method === 'PUT') { await store.saveProfile(input); return ok(res, { saved: true }) }
      }
      if (seg[0] === 'threads') {
        if (seg.length === 1 && method === 'GET') {
          await runtime.backfillDmLastMessage(await store.read())
          const state = await store.read()
          const threads = state.threads.map(thread => thread.kind !== 'dm' ? thread : { ...thread, unread: threadContentAt(thread) > (thread.readAt ?? '') })
          return ok(res, { threads })
        }
        if (seg.length === 2 && method === 'PATCH') return ok(res, { thread: await store.patchDmThread(seg[1]!, { ...(typeof input.pinned === 'boolean' ? { pinned: input.pinned } : {}), ...(input.markRead === true ? { markRead: true } : {}) }) })
        if (seg.length === 3 && seg[2] === 'messages') {
          if (method === 'GET') return ok(res, await runtime.messagePage(seg[1]!, { limit: url.searchParams.get('limit') ?? undefined, before: url.searchParams.get('before') ?? undefined }))
          if (method === 'POST') {
            if (input.employeeId !== undefined && typeof input.employeeId !== 'string') throw new WorkforceError('bad_request', '员工 id 无效')
            if (input.employeeIds !== undefined && (!Array.isArray(input.employeeIds) || (input.employeeIds as unknown[]).some(item => typeof item !== 'string' || !item.trim()))) throw new WorkforceError('bad_request', '员工 id 列表无效')
            return ok(res, await runtime.send(seg[1]!, input.text, (input.employeeIds as string[] | undefined) ?? (input.employeeId as string | undefined), { requestId: input.requestId }))
          }
        }
        if (seg.length === 4 && seg[2] === 'asks' && method === 'POST') return ok(res, await runtime.answerAsk(seg[1]!, seg[3]!, input))
        if (seg.length === 5 && seg[2] === 'messages' && seg[4] === 'regenerate' && method === 'POST') return ok(res, await runtime.regenerateMessage(seg[1]!, seg[3]!))
        // 线程级真实文件历史与字节/reveal：身份解析回真实归属会话事件并重做安全验证，
        // 不给任意路径读取；安装包类只给 location。
        if (seg.length === 3 && seg[2] === 'files' && method === 'GET') return ok(res, { files: await runtime.threadFiles(seg[1]!) })
        if (seg.length === 5 && seg[2] === 'files' && seg[4] === 'location' && method === 'GET') {
          const entry = await runtime.fileEntry(seg[1]!, seg[3]!)
          const info = await stat(entry.path).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkforceError('not_found', '文件不存在')
            throw error
          })
          if (!info.isFile()) throw new WorkforceError('not_found', '文件不存在')
          return ok(res, { path: resolve(entry.path) })
        }
        if (seg.length === 4 && seg[2] === 'files' && ['GET', 'HEAD'].includes(method)) {
          const entry = await runtime.fileEntry(seg[1]!, seg[3]!)
          if (entry.installer) throw new WorkforceError('not_found', '安装包只可在文件夹中打开')
          return serveWorkforceFile(req, res, entry.path, entry.name, entry.mime, url.searchParams.get('download') === '1')
        }
      }
      if (seg[0] === 'dm' && seg.length === 1 && method === 'POST') return ok(res, { thread: await runtime.ensureDm(requiredText(input.employeeId, 120)) })
      if (seg[0] === 'materials') {
        if (seg.length === 1 && method === 'POST') {
          return ok(res, { material: await store.upload(input.name, input.content) })
        }
        if (seg.length === 2 && method === 'GET') return ok(res, await store.material(seg[1]!))
        if (seg.length === 3 && ['GET', 'HEAD'].includes(method)) {
          const { material, path } = await store.materialFile(seg[1]!, seg[2]!)
          // return await 而非裸 return：try/catch 只护住已 await 的段，裸 return 的 rejection 会在
          // 处理器返回后才发生，绕过 catch 造成请求挂死；materials 分支无 installer 前置 gate，
          // 安装包（serveWorkforceFile L66 404）与 serveFile IO 失败都走这里，必须并进 catch。
          return await serveWorkforceFile(req, res, path, material.name, material.mime, url.searchParams.get('download') === '1')
        }
      }
      if (seg[0] === 'tasks') {
        if (seg.length <= 2 && method === 'GET') {
          await runtime.refreshTasks()
          const tasks = (await store.read()).tasks
          if (seg.length === 1) return ok(res, { tasks })
          const task = tasks.find(item => item.id === seg[1])
          if (!task) throw new WorkforceError('not_found', '任务不存在')
          return ok(res, { task })
        }
        if (seg.length === 3 && seg[2] === 'cancel' && method === 'POST') return ok(res, await runtime.cancel(seg[1]!))
        if (seg.length === 4 && seg[2] === 'deliverables' && ['GET', 'HEAD'].includes(method)) {
          const { filename, path } = await store.deliverableFile(seg[1]!, seg[3]!, url.searchParams.get('v'))
          // 安装包成果只可在文件夹中打开：不给字节路由，避免「native execute 绕过」。
          if (isInstallerName(filename)) throw new WorkforceError('not_found', '安装包只可在文件夹中打开')
          return serveWorkforceFile(req, res, path, filename, materialMime(filename), url.searchParams.get('download') === '1')
        }
        if (seg.length === 5 && seg[2] === 'deliverables' && seg[4] === 'location' && method === 'GET') {
          const file = await store.deliverableFile(seg[1]!, seg[3]!, url.searchParams.get('v'))
          const info = await stat(file.path).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkforceError('not_found', '成果文件不存在')
            throw error
          })
          if (!info.isFile()) throw new WorkforceError('not_found', '成果文件不存在')
          return ok(res, { path: resolve(file.path) })
        }
        if (seg.length === 5 && seg[2] === 'deliverables' && seg[4] === 'publish' && method === 'POST') {
          return ok(res, { task: await store.publishDeliverable(seg[1]!, seg[3]!, input.version, 'user') })
        }
        // 已结束任务发起沉淀（宿主建 requested 草稿并在任务线程请求负责人整理）
        if (seg.length === 3 && seg[2] === 'skill-draft' && method === 'POST') {
          return ok(res, { draft: await runtime.requestSkillDraft(seg[1]!, input.note) })
        }
      }
      // 草稿列表/详情/用户编辑/退回/删除/安装；只有 PATCH 与 install 会改草稿字段与 state
      if (seg[0] === 'skill-drafts') {
        if (seg.length === 1 && method === 'GET') return ok(res, { drafts: await runtime.listSkillDrafts() })
        if (seg.length === 2 && method === 'GET') return ok(res, { draft: await runtime.skillDraft(seg[1]!) })
        if (seg.length === 2 && method === 'PATCH') return ok(res, { draft: await runtime.patchSkillDraft(seg[1]!, input) })
        if (seg.length === 3 && seg[2] === 'return' && method === 'POST') return ok(res, { draft: await runtime.returnSkillDraft(seg[1]!, input.note) })
        if (seg.length === 2 && method === 'DELETE') { await runtime.deleteSkillDraft(seg[1]!); return ok(res, { deleted: true }) }
        if (seg.length === 3 && seg[2] === 'install' && method === 'POST') {
          return ok(res, await runtime.installSkillDraft(seg[1]!, Array.isArray(input.employeeIds) ? input.employeeIds : []))
        }
      }
      // Existing installed-workflow disabling remains non-destructive; generic CRUD shares the host service.
      if (seg[0] === 'user-skills') {
        if (seg.length === 1 && method === 'GET') return ok(res, { skills: await (deps.userSkills?.list() ?? runtime.listUserSkills()) })
        if (seg.length === 3 && seg[2] === 'disable' && method === 'POST') return ok(res, await runtime.disableUserSkill(seg[1]!))
        const skills = deps.userSkills
        if (!skills) throw new WorkforceError('unavailable', '用户技能服务不可用')
        if (seg.length === 3 && seg[2] === 'content' && method === 'GET') return ok(res, await skills.read(seg[1]!))
        if ((seg.length === 1 && method === 'POST') || (seg.length === 2 && method === 'PUT')) {
          if (typeof input.content !== 'string') throw new WorkforceError('bad_request', '技能内容必须是字符串')
          if (input.origin !== undefined && typeof input.origin !== 'string') throw new WorkforceError('bad_request', '来源必须是字符串')
          const fields = { content: input.content, ...(typeof input.origin === 'string' ? { origin: input.origin } : {}) }
          return ok(res, seg.length === 1 ? await skills.create(requiredText(input.name, 120), fields) : await skills.update(seg[1]!, fields))
        }
        if (seg.length === 2 && method === 'DELETE') { await skills.remove(seg[1]!); return ok(res, { deleted: true }) }
      }
      if (seg[0] === 'skills' && seg.length === 1 && method === 'GET') {
        const skills = deps.skills as SkillListLike | undefined
        const scope = await deps.skillScope?.()
        try {
          const list = skills && typeof skills.list === 'function' ? await skills.list({ scope: scope?.key }) : []
          const userSkills = await (deps.userSkills?.list() ?? runtime.listUserSkills()).catch(() => [])
          const names = new Set(list.flatMap(item => { const name = (item as { name?: unknown })?.name; return typeof name === 'string' ? [name] : [] }))
          return ok(res, { skills: [...list, ...userSkills.filter(item => !names.has(item.name))] })
        } finally { await scope?.[Symbol.asyncDispose]() }
      }
      if (seg[0] === 'mcp-servers') {
        if (seg.length === 1 && method === 'GET') {
          const servers = (await store.read()).mcpServers
          return ok(res, { servers: await Promise.all(servers.map(async server => ({ ...server, status: await deps.mcp?.status(server) }))) })
        }
        if (seg.length === 1 && method === 'POST') return ok(res, { server: await store.saveMcpServer(input) })
        if (seg.length === 2 && method === 'PATCH') return ok(res, { server: await store.saveMcpServer(input, seg[1]) })
        if (seg.length === 2 && method === 'DELETE') { await store.deleteMcpServer(seg[1]!); return ok(res, { deleted: true }) }
      }
      if (seg[0] === 'image-provider') {
        const credentials = deps.credentials?.()
        const status = async (refresh = false) => {
          const provider = (await store.read()).imageProvider
          const effective = provider ?? DEFAULT_IMAGE_PROVIDER
          const info = effective.kind === 'openai' && credentials ? await credentials.describe(effective.keyRef).catch(() => undefined) : undefined
          const codex = await detectCodex(deps.subprocess?.(), new AbortController().signal, refresh)
          return { provider: provider ?? null, effective, keyConfigured: (info as { configured?: boolean } | undefined)?.configured === true, codex }
        }
        if (seg.length === 1 && method === 'GET') return ok(res, await status(url.searchParams.get('refresh') === '1'))
        if (seg.length === 1 && method === 'PUT') { await store.saveImageProvider(parseImageProvider(input.provider)); return ok(res, await status()) }
        if (seg.length === 2 && seg[1] === 'key' && (method === 'PUT' || method === 'DELETE')) {
          const provider = (await store.read()).imageProvider
          if (provider?.kind !== 'openai') throw new WorkforceError('bad_request', '请先保存接口类型的生图服务')
          if (!credentials) throw new WorkforceError('unavailable', '凭据服务不可用')
          if (method === 'PUT') await credentials.set(provider.keyRef, requiredText(input.value, 4000))
          else await credentials.unset(provider.keyRef)
          return ok(res, await status())
        }
      }
      if (seg[0] === 'templates') {
        const templates = deps.templates ?? new WorkbenchTemplateService(store)
        if (seg.length === 1 && method === 'GET') return ok(res, { templates: await templates.list() })
        if (seg.length === 2 && method === 'PATCH') {
          if (typeof input.enabled !== 'boolean') throw new WorkforceError('bad_request', 'enabled 必须是布尔值')
          await templates.setEnabled(seg[1]!, input.enabled)
          return ok(res, { enabledTemplates: (await templates.list()).filter(item => item.enabled).map(item => item.id) })
        }
        if (seg.length === 3 && seg[2] === 'apply' && method === 'POST') return ok(res, await templates.applyResult(seg[1]!))
      }
      throw new WorkforceError('not_found', '数字员工接口不存在')
    } catch (error) {
      const known = error instanceof WorkforceError
      const code = known ? error.code : 'internal'
      const status = code === 'not_found' ? 404 : code === 'bad_request' ? 400 : code === 'conflict' ? 409 : code === 'internal' ? 500 : 503
      const message = known ? error.message : (error instanceof Error ? error.message : '数字员工服务暂不可用，请重试')
      send(res, status, { ok: false, error: { code, message } })
    }
  }
}
