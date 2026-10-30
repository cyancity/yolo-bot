/**
 * workforce fetch client — Host API shape v1 + 修订（2026-10-09）。
 * 同 origin /wb/api，envelope {ok,data}|{ok,error}。
 * 路径集中在这里；Host 修订时只改本文件与 workforce-types.ts。
 */
import type { QuestionCardAnswer } from './workforce-question-card.tsx'
import {
  API_PREFIX, WorkbenchApiError, type FetchLike,
} from './transport.ts'
import type {
  Channel, Employee, EmployeeInput, McpServer, McpServerInput, SendResult, SkillSummary, Task, Thread, WorkforceActivity, WorkforceFile, WorkforceMessage, WorkforceSession, WorkforceSkillDraft, WorkforceTemplate, WorkforceUserSkill,
} from './workforce-types.ts'
import { MAX_ATTACHMENT_BYTES, type UploadedAttachment } from './workforce-upload.ts'


export interface HostChannel extends Channel {
  readonly groupId?: string | undefined; readonly projectDirectory?: string | undefined
  readonly sort?: number | undefined
  readonly pinned?: boolean | undefined
  readonly readAt?: string | undefined
  readonly unread?: boolean | undefined
  /** 分组（Discord 式）侧栏显示名覆盖；缺省回落到 name。 */
  readonly groupName?: string | undefined
  /** 群聊会话列表标题；缺省回落到成员名串再到 name。 */
  readonly groupChatName?: string | undefined
  /** 群聊成员员工 id；缺省=全员。 */
  readonly memberIds?: readonly string[] | undefined
}

export interface HostChannelGroup {
  readonly id: string
  readonly name: string
  readonly sort?: number | undefined
  readonly createdAt?: string | undefined
}

export type WorkforceMemoryScope = 'global' | 'channel' | 'employee'
export interface WorkforceMemory {
  readonly id: string
  readonly scope: WorkforceMemoryScope
  readonly scopeId?: string
  readonly text: string
  readonly source: { readonly by: string; readonly threadId?: string; readonly messageId?: string }
  readonly createdAt: string
  readonly updatedAt: string
}
export interface WorkforceMemories {
  readonly memories: readonly WorkforceMemory[]
  readonly limits: Readonly<Record<WorkforceMemoryScope, number>>
  /** Keys: global:, channel:<id>, employee:<id>. */
  readonly usage: Readonly<Record<string, number>>
}
type Envelope<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
export type ProviderKind = 'apikey'

export interface ModelProviderInfo {
  readonly id: string
  readonly displayName: string
  readonly kind: ProviderKind
  readonly configured: boolean
  readonly credentialRef?: string | undefined
  /** 原生 provider 是否显式要求 API Key；false 时交给宿主认证，不猜测凭据引用。 */
  readonly requiresApiKey?: boolean | undefined
  readonly writable?: boolean | undefined
  readonly keySource?: string | undefined
  /** One entry per model: id 用于选择与保存，name（若有）只用于显示。 */
  readonly models: readonly ProviderModelInfo[]
  readonly description?: string | undefined
}

export interface ProviderModelInfo {
  readonly id: string
  readonly name?: string | undefined
}

export interface DefaultModelSelection {
  readonly provider: string
  readonly model: string
}

export interface WorkforceModelsState {
  readonly providers: readonly ModelProviderInfo[]
  readonly defaultModel?: DefaultModelSelection | undefined
}

/**
 * 宿主返回的模型目录有两种形态：`{id, name?}` 对象（llm listModels）与裸字符串。
 * 两种都归一成 ProviderModelInfo；对象形态必须取 id，String(obj) 会把
 * "[object Object]" 直接泄漏到界面。
 */
function readProviderModel(item: unknown): ProviderModelInfo {
  if (typeof item === 'string') return { id: item }
  if (item && typeof item === 'object') {
    const m = item as Record<string, unknown>
    const id = String(m['id'] ?? m['model'] ?? '')
    const name = typeof m['name'] === 'string' && m['name'] !== '' ? m['name'] : undefined
    return { id, ...(name !== undefined ? { name } : {}) }
  }
  return { id: String(item ?? '') }
}


export class WorkforceApi {
  constructor(private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${API_PREFIX}${path}`, {
      headers: { 'content-type': 'application/json' },
      ...init,
    })
    let body: Envelope<T>
    try {
      body = (await response.json()) as Envelope<T>
    } catch {
      throw new WorkbenchApiError({
        code: response.status === 404 ? 'host_unavailable' : 'invalid_response',
        message: response.status === 404
          ? '工作台接口不可用（HTTP 404），请检查后端插件是否已启用且与 DSH 版本兼容。'
          : '工作台接口未返回有效数据，请重试或检查后端插件。',
      }, response.status)
    }
    if (!body.ok) throw new WorkbenchApiError(body.error, response.status)
    if (response.ok === false) throw new WorkbenchApiError({ code: 'invalid_response', message: '请求未完成，请重试' }, response.status)
    return body.data
  }

  // ---------------------------------------------------------------- employees

  /** GET /workforce/employees → {employees} */
  async employees(): Promise<Employee[]> {
    const data = await this.call<{ employees: Employee[] }>('/workforce/employees', { cache: 'no-store' })
    return data.employees
  }

  createEmployee(input: EmployeeInput): Promise<{ employee: Employee }> {
    return this.call('/workforce/employees', { method: 'POST', body: JSON.stringify(input) })
  }

  updateEmployee(id: string, patch: Partial<EmployeeInput>): Promise<{ employee: Employee }> {
    return this.call(`/workforce/employees/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  }

  deleteEmployee(id: string): Promise<{ deleted: boolean }> {
    return this.call(`/workforce/employees/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  memories(scope?: WorkforceMemoryScope, scopeId?: string): Promise<WorkforceMemories> {
    const query = new URLSearchParams()
    if (scope !== undefined) query.set('scope', scope)
    if (scopeId !== undefined) query.set('scopeId', scopeId)
    return this.call(`/workforce/memories${query.size > 0 ? `?${query}` : ''}`, { cache: 'no-store' })
  }

  createMemory(input: { scope: WorkforceMemoryScope; scopeId?: string | undefined; text: string }): Promise<{ memory: WorkforceMemory }> {
    return this.call('/workforce/memories', { method: 'POST', body: JSON.stringify(input) })
  }

  updateMemory(id: string, text: string): Promise<{ memory: WorkforceMemory }> {
    return this.call(`/workforce/memories/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ text }) })
  }

  deleteMemory(id: string): Promise<{ deleted: true }> {
    return this.call(`/workforce/memories/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  // ----------------------------------------------------------------- channels

  /** GET /workforce/channels → {channels, groups} */
  async channels(): Promise<HostChannel[]> {
    const data = await this.call<{ channels: HostChannel[]; groups?: HostChannelGroup[] }>('/workforce/channels', { cache: 'no-store' })
    return data.channels
  }

  async channelsWithGroups(): Promise<{ channels: HostChannel[]; groups: HostChannelGroup[] }> {
    const data = await this.call<{ channels: HostChannel[]; groups?: HostChannelGroup[] }>('/workforce/channels', { cache: 'no-store' })
    return { channels: data.channels, groups: data.groups ?? [] }
  }
  // ------------------------------------------------------------------ threads

  /** GET /workforce/threads → {threads} */
  async threads(): Promise<Thread[]> {
    const data = await this.call<{ threads: Thread[] }>('/workforce/threads', { cache: 'no-store' })
    return data.threads
  }

  /** 最新页或 before 之前的历史页；before 不包含在返回页内。files 为线程级完整真实文件历史（原生 present + 成果），不随分页截断。 */
  async threadMessages(threadId: string, options?: { limit?: number; before?: string }): Promise<{ messages: WorkforceMessage[]; cursor: string; thread: Thread; hasMore: boolean; activity?: WorkforceActivity[]; sessions?: WorkforceSession[]; files?: WorkforceFile[] }> {
    const params = new URLSearchParams()
    if (options?.limit !== undefined) params.set('limit', String(options.limit))
    if (options?.before !== undefined) params.set('before', options.before)
    const query = params.size === 0 ? '' : `?${params}`
    return this.call(`/workforce/threads/${encodeURIComponent(threadId)}/messages${query}`, { cache: 'no-store' })
  }

  /** GET /workforce/threads/:id/files → 线程级真实文件历史（原生 present + 原生文件工具 + 成果版本）。 */
  async threadFiles(threadId: string): Promise<{ files: WorkforceFile[] }> {
    return this.call(`/workforce/threads/${encodeURIComponent(threadId)}/files`, { cache: 'no-store' })
  }

  /**
   * 发送：频道 thread = 建任务（返回可能带 task）；DM thread = 直接路由。
   * body {text, employeeIds?, requestId?} — 重试沿用同一次发送的 requestId。
   */
  sendMessage(threadId: string, text: string, employeeIds?: readonly string[], requestId?: string): Promise<SendResult> {
    const list = employeeIds === undefined ? [] : [...employeeIds]
    return this.call(`/workforce/threads/${encodeURIComponent(threadId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, ...(requestId === undefined ? {} : { requestId }), ...(list.length === 0 ? {} : { employeeIds: list, employeeId: list[0] }) }),
    })
  }

  /** 重投原问题给同一员工，不改写原生历史。 */
  regenerateMessage(threadId: string, messageId: string): Promise<SendResult> {
    return this.call(`/workforce/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/regenerate`, {
      method: 'POST', body: '{}',
    })
  }

  /** DM ensure：POST /workforce/dm {employeeId} → {thread}（存在即复用）。 */
  ensureDm(employeeId: string): Promise<{ thread: Thread }> {
    return this.call('/workforce/dm', { method: 'POST', body: JSON.stringify({ employeeId }) })
  }

  // ---------------------------------------------------------------- materials

  /** 文本 API 入口：POST JSON {name, content} → {material}。 */
  uploadMaterial(name: string, content: string): Promise<{ material: { id: string; name: string; url: string } }> {
    return this.call('/workforce/materials', { method: 'POST', body: JSON.stringify({ name, content }) })
  }

  /** 任意文件按原始字节上传，返回可直接读取的材料地址。 */
  async uploadFile(file: File): Promise<UploadedAttachment> {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('单个附件不能超过 32 MiB')
    const { material } = await this.call<{ material: UploadedAttachment }>('/workforce/materials', {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-workforce-filename': encodeURIComponent(file.name),
      },
      body: file,
    })
    return material
  }

  // -------------------------------------------------------------------- tasks

  /** GET /workforce/tasks → {tasks} */
  async tasks(): Promise<Task[]> {
    const data = await this.call<{ tasks: Task[] }>('/workforce/tasks', { cache: 'no-store' })
    return data.tasks
  }

  /** POST /workforce/tasks/:taskId/cancel → {cancelled} */
  cancelTask(taskId: string): Promise<{ cancelled: boolean }> {
    return this.call(`/workforce/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: '{}' })
  }

  /** POST /workforce/threads/:id/asks/:requestId → 回答员工提问或审批 */
  answerAsk(threadId: string, requestId: string, payload: { answers?: QuestionCardAnswer[]; outcome?: 'allowed-once' | 'rejected' }): Promise<unknown> {
    return this.call(`/workforce/threads/${encodeURIComponent(threadId)}/asks/${encodeURIComponent(requestId)}`, { method: 'POST', body: JSON.stringify(payload) })
  }

  /** 产物下载地址（Host 返回的 url 也走这条路径）；带版本时追加 `?v=N` 取指定版本。 */
  deliverableUrl(taskId: string, name: string, version?: number): string {
    const base = `${API_PREFIX}/workforce/tasks/${encodeURIComponent(taskId)}/deliverables/${encodeURIComponent(name)}`
    return version === undefined ? base : `${base}?v=${version}`
  }

  /** POST /workforce/tasks/:taskId/deliverables/:name/publish → 更新后的整条任务（publishedBy='user'）。 */
  async publishDeliverable(taskId: string, name: string, version: number): Promise<Task> {
    const data = await this.call<{ task: Task }>(
      `/workforce/tasks/${encodeURIComponent(taskId)}/deliverables/${encodeURIComponent(name)}/publish`,
      { method: 'POST', body: JSON.stringify({ version }) },
    )
    return data.task
  }

  // ------------------------------------------------------------ skill drafts 

  /** POST /workforce/tasks/:taskId/skill-draft {note?} → {draft}；任务 running 时宿主 409。 */
  async requestSkillDraft(taskId: string, note?: string): Promise<WorkforceSkillDraft> {
    const data = await this.call<{ draft: WorkforceSkillDraft }>(
      `/workforce/tasks/${encodeURIComponent(taskId)}/skill-draft`,
      { method: 'POST', body: JSON.stringify(note === undefined ? {} : { note }) },
    )
    return data.draft
  }

  /** GET /workforce/skill-drafts → {drafts} */
  async skillDrafts(): Promise<WorkforceSkillDraft[]> {
    const data = await this.call<{ drafts: WorkforceSkillDraft[] }>('/workforce/skill-drafts', { cache: 'no-store' })
    return data.drafts
  }

  /** GET /workforce/skill-drafts/:id → {draft} */
  async skillDraft(id: string): Promise<WorkforceSkillDraft> {
    const data = await this.call<{ draft: WorkforceSkillDraft }>(`/workforce/skill-drafts/${encodeURIComponent(id)}`, { cache: 'no-store' })
    return data.draft
  }

  /** PATCH /workforce/skill-drafts/:id {slug?,title?,description?,body?} → {draft}（用户编辑，editedBy=user）。 */
  async updateSkillDraft(id: string, patch: { slug?: string; title?: string; description?: string; body?: string }): Promise<WorkforceSkillDraft> {
    const data = await this.call<{ draft: WorkforceSkillDraft }>(`/workforce/skill-drafts/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    })
    return data.draft
  }

  /** POST /workforce/skill-drafts/:id/return {note} → {draft}（宿主再给负责人发退回消息）。 */
  async returnSkillDraft(id: string, note: string): Promise<WorkforceSkillDraft> {
    const data = await this.call<{ draft: WorkforceSkillDraft }>(`/workforce/skill-drafts/${encodeURIComponent(id)}/return`, {
      method: 'POST', body: JSON.stringify({ note }),
    })
    return data.draft
  }

  /** DELETE /workforce/skill-drafts/:id → {deleted}（只删草稿记录，不动已安装技能）。 */
  deleteSkillDraft(id: string): Promise<{ deleted: boolean }> {
    return this.call(`/workforce/skill-drafts/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  /** POST /workforce/skill-drafts/:id/install {employeeIds} → {draft, path}；绑定结果看员工快照的 skills。 */
  async installSkillDraft(id: string, employeeIds: readonly string[]): Promise<{ draft: WorkforceSkillDraft; path: string }> {
    const data = await this.call<{ draft: WorkforceSkillDraft; path: string }>(
      `/workforce/skill-drafts/${encodeURIComponent(id)}/install`,
      { method: 'POST', body: JSON.stringify({ employeeIds: [...employeeIds] }) },
    )
    return data
  }

  /** GET /workforce/user-skills → {skills}：$DSH_HOME/skills 一层目录（origin 标注来源）。 */
  async userSkills(): Promise<WorkforceUserSkill[]> {
    const data = await this.call<{ skills: WorkforceUserSkill[] }>('/workforce/user-skills', { cache: 'no-store' })
    return data.skills
  }

  /** POST /workforce/user-skills/:name/disable → {name, movedTo?}：只对 origin=workflow 生效，目录移到数据根并从员工 skills 移除。 */
  disableUserSkill(name: string): Promise<{ name: string; movedTo?: string }> {
    return this.call(`/workforce/user-skills/${encodeURIComponent(name)}/disable`, { method: 'POST' })
  }

  // ------------------------------------------------------------------- models

  /**
   * GET /workforce/models
   * 原生注册模型来源的目录与凭据元数据，以及全局默认选择。
   */
  async models(): Promise<WorkforceModelsState> {
    const raw = await this.call<Record<string, unknown>>('/workforce/models', { cache: 'no-store' })
    const rawProviders = Array.isArray(raw['providers']) ? raw['providers'] : []
    const providers: ModelProviderInfo[] = rawProviders.map((item: unknown) => {
      const p = (item && typeof item === 'object') ? item as Record<string, unknown> : {}
      const id = String(p['id'] ?? p['provider'] ?? '')
      const displayName = String(p['displayName'] ?? p['name'] ?? id)
      const kind: ProviderKind = 'apikey'
      const configured = Boolean(p['configured'])
      const credentialRef = typeof p['credentialRef'] === 'string' ? p['credentialRef'] : undefined
      const requiresApiKey = typeof p['requiresApiKey'] === 'boolean' ? p['requiresApiKey'] : undefined
      const writable = typeof p['writable'] === 'boolean' ? p['writable'] : undefined
      const keySource = typeof p['keySource'] === 'string' ? p['keySource'] : undefined
      const models = Array.isArray(p['models']) ? p['models'].map(readProviderModel) : []
      const description = typeof p['description'] === 'string' ? p['description'] : undefined
      return { id, displayName, kind, configured, credentialRef, requiresApiKey, writable, keySource, models, description }
    })

    const rawDefault = (raw['defaultModel'] ?? raw['currentSelection']) as Record<string, unknown> | undefined
    const defaultModel: DefaultModelSelection | undefined = rawDefault && typeof rawDefault['provider'] === 'string' && typeof rawDefault['model'] === 'string'
      ? { provider: rawDefault['provider'], model: rawDefault['model'] }
      : undefined

    return {
      providers,
      defaultModel,
    }
  }

  /** PUT /workforce/models/key {provider, key} */
  saveModelKey(provider: string, key: string): Promise<{ ok: boolean }> {
    return this.call('/workforce/models/key', {
      method: 'PUT',
      body: JSON.stringify({ provider, key }),
    })
  }

  /** DELETE /workforce/models/key {provider} */
  deleteModelKey(provider: string): Promise<{ ok: boolean }> {
    return this.call('/workforce/models/key', {
      method: 'DELETE',
      body: JSON.stringify({ provider }),
    })
  }

  /** PUT /workforce/models/default {provider, model} */
  saveDefaultModel(provider: string, model: string): Promise<{ ok: boolean }> {
    return this.call('/workforce/models/default', {
      method: 'PUT',
      body: JSON.stringify({ provider, model }),
    })
  }

  // ------------------------------------------------------- skills / MCP / templates

  /** GET /workforce/skills → {skills}：当前目录的全量 skill 摘要。 */
  async skills(): Promise<SkillSummary[]> {
    const data = await this.call<{ skills: SkillSummary[] }>('/workforce/skills', { cache: 'no-store' })
    return data.skills
  }

  /** GET /workforce/mcp-servers → {servers}（含凭据/挂载状态，不含密钥值）。 */
  async mcpServers(): Promise<McpServer[]> {
    const data = await this.call<{ servers: McpServer[] }>('/workforce/mcp-servers', { cache: 'no-store' })
    return data.servers
  }

  createMcpServer(input: McpServerInput): Promise<{ server: McpServer }> {
    return this.call('/workforce/mcp-servers', { method: 'POST', body: JSON.stringify(input) })
  }

  updateMcpServer(id: string, patch: Partial<McpServerInput>): Promise<{ server: McpServer }> {
    return this.call(`/workforce/mcp-servers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  }

  deleteMcpServer(id: string): Promise<{ deleted: boolean }> {
    return this.call(`/workforce/mcp-servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  /** GET /workforce/templates → {templates}（注册模板提供者的目录与 enabled 标记）。 */
  async templates(): Promise<WorkforceTemplate[]> {
    const data = await this.call<{ templates: WorkforceTemplate[] }>('/workforce/templates', { cache: 'no-store' })
    return data.templates
  }

  patchTemplate(id: string, enabled: boolean): Promise<{ enabledTemplates: string[] }> {
    return this.call(`/workforce/templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) })
  }

  applyTemplate(id: string): Promise<{ created: string[]; skipped: string[] }> {
    return this.call(`/workforce/templates/${encodeURIComponent(id)}/apply`, { method: 'POST', body: '{}' })
  }

  // ------------------------------------------------------------------ channels & profile

  /** POST /workforce/channels {name, groupId?, sort?, groupName?, groupChatName?, memberIds?} */
  createChannel(input: { name: string; groupId?: string | null | undefined; sort?: number | undefined; groupName?: string | undefined; groupChatName?: string | undefined; memberIds?: readonly string[] | undefined }): Promise<{ channel: HostChannel }> {
    return this.call('/workforce/channels', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  /** PATCH /workforce/channels/:id {name?, groupId?, sort?, pinned?, groupName?, groupChatName?, memberIds?}（可空字段传 null 清除） */
  patchChannel(id: string, patch: { projectDirectory?: string | null | undefined; name?: string | undefined; groupId?: string | null | undefined; sort?: number | undefined; pinned?: boolean | undefined; groupName?: string | null | undefined; groupChatName?: string | null | undefined; memberIds?: readonly string[] | null | undefined }): Promise<{ channel: HostChannel }> {
    return this.call(`/workforce/channels/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  }

  /** POST /workforce/channels/:id/read */
  markChannelRead(id: string): Promise<{ channel: HostChannel }> {
    return this.call(`/workforce/channels/${encodeURIComponent(id)}/read`, {
      method: 'POST',
      body: '{}',
    })
  }

  /** DELETE /workforce/channels/:id */
  deleteChannel(id: string): Promise<{ deleted: boolean }> {
    return this.call(`/workforce/channels/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  /** POST /workforce/channels/:id/duplicate */
  duplicateChannel(id: string): Promise<{ channel: HostChannel }> {
    return this.call(`/workforce/channels/${encodeURIComponent(id)}/duplicate`, {
      method: 'POST',
      body: '{}',
    })
  }

  /** GET /workforce/channel-groups */
  async channelGroups(): Promise<HostChannelGroup[]> {
    const data = await this.call<{ groups: HostChannelGroup[] }>('/workforce/channel-groups', { cache: 'no-store' })
    return data.groups
  }

  /** POST /workforce/channel-groups {name, sort?} */
  createChannelGroup(input: { name: string; sort?: number | undefined }): Promise<{ group: HostChannelGroup }> {
    return this.call('/workforce/channel-groups', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  /** PATCH /workforce/channel-groups/:id {name?, sort?} */
  patchChannelGroup(id: string, patch: { name?: string | undefined; sort?: number | undefined }): Promise<{ group: HostChannelGroup }> {
    return this.call(`/workforce/channel-groups/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  }

  /** DELETE /workforce/channel-groups/:id */
  deleteChannelGroup(id: string): Promise<{ deleted: boolean }> {
    return this.call(`/workforce/channel-groups/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  /** PATCH /workforce/threads/:id {pinned?, markRead?} */
  patchThread(id: string, patch: { pinned?: boolean | undefined; markRead?: boolean | undefined }): Promise<{ thread: Thread }> {
    return this.call(`/workforce/threads/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  }

  /** GET /workforce/profile */
  async userProfile(): Promise<{ profile: { name: string; avatarUrl?: string | undefined } }> {
    return this.call('/workforce/profile', { cache: 'no-store' })
  }

  /** PUT /workforce/profile {name?, avatarUrl?} */
  saveUserProfile(profile: { name?: string | undefined; avatarUrl?: string | null | undefined }): Promise<{ ok?: boolean; saved?: boolean }> {
    return this.call('/workforce/profile', {
      method: 'PUT',
      body: JSON.stringify(profile),
    })
  }
}
