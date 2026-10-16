/**
 * TEL-H 本地诊断 operational 子树：固定枚举/计数/秒数组成的安全投影。
 * 只输出类别与数量，永不输出任务正文、文件名、会话/线程 id、模型/供应商原名、
 * MCP serverName、工具名/参数、skill 名、job id/命令/PID/路径、批准理由或 callId。
 * 模型测试、停止观察、批准结果无法从现有状态重建，进程内各保留最近 20 条（重启丢失）。
 */
import type { WorkforceRuntime } from './runtime.ts'
import type { Binding } from './store.ts'
import type { WorkforceThread } from './types.ts'

export type OperationalCoverage = 'observed_window' | 'partial' | 'unavailable'
export type OperationalErrorCategory = 'missing_key' | 'invalid_key' | 'quota' | 'network' | 'model_unavailable' | 'missing_model' | 'permission' | 'cancelled' | 'unavailable' | 'internal' | 'unknown'
export type OperationalProviderClass = 'apikey' | 'account' | 'server' | 'other' | 'unknown'
export type OperationalToolClass = 'skill' | 'arithmetic' | 'delegate' | 'deliverable' | 'read_material' | 'shell' | 'file' | 'web' | 'question' | 'other_mcp' | 'other' | 'unknown'

/** 本发行版已知的公开模型 id → 类别名（id 本身是服务商公开名，不是用户自定义）；未命中一律 other，不回传原 id。 */
const MODEL_CLASSES: Record<string, string> = {
  'deepseek-v4-flash': 'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-v4-flash',
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'deepseek-chat': 'deepseek-chat',
  'deepseek-reasoner': 'deepseek-reasoner',
}

/** 已知工具名 → 固定类别；映射本身不携带命名空间。 */
const TOOL_CLASSES: Record<string, OperationalToolClass> = {
  skill: 'skill',
  wb_check_arithmetic: 'arithmetic',
  wb_delegate_employee: 'delegate',
  wb_read_deliverable: 'deliverable',
  wb_save_deliverable: 'deliverable',
  wb_publish_deliverable: 'deliverable',
  wb_read_material: 'read_material',
  ask_user_question: 'question',
  shell: 'shell', pwsh: 'shell', bash: 'shell', powershell: 'shell',
  read_file: 'file', write_file: 'file', apply_patch: 'file', edit: 'file', glob: 'file', grep: 'file',
  web_fetch: 'web', web_search: 'web', fetch: 'web',
}

/** byok 的 VerifyCategory 是本枚举的真子集，原样透传；未知值收窄为 unknown。 */
export function verifyErrorCategoryOf(category: unknown): OperationalErrorCategory {
  switch (category) {
    case 'missing_key': case 'invalid_key': case 'quota': case 'network':
    case 'model_unavailable': case 'missing_model': return category
    default: return 'unknown'
  }
}

export function providerClassOf(provider: string | undefined | null): OperationalProviderClass {
  if (typeof provider !== 'string' || !provider) return 'unknown'
  // Native credential-backed providers share the generic API-key classification.
  if (provider === 'deepseek-account') return 'account'
  return 'apikey'
}

export function modelClassOf(provider: string | undefined | null, model: string | undefined | null): string {
  if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) return 'unknown'
  return MODEL_CLASSES[model] ?? 'other'
}

export function toolClassOf(name: unknown): OperationalToolClass {
  if (typeof name !== 'string' || !name) return 'unknown'
  // 原生工具常带点号方法名（shell.run、web.fetch）：全名未命中再按首段归类，不回传原名。
  const mapped = TOOL_CLASSES[name] ?? TOOL_CLASSES[name.split('.')[0]!]
  if (mapped) return mapped
  if (name.startsWith('mcp__')) return 'other_mcp'
  return 'other'
}

const MAX_SECONDS = 604800
/** 秒数下限 0、上限 604800 的整秒截断；起点非法时返回 null（Count 缺失用 null，不填 0）。 */
export function secondsBetween(startIso: string, now = Date.now()): number | null {
  const start = Date.parse(startIso)
  if (!Number.isFinite(start)) return null
  return Math.min(MAX_SECONDS, Math.max(0, Math.floor((now - start) / 1000)))
}
export function elapsedSeconds(sinceMs: number, now = Date.now()): number {
  if (!Number.isFinite(sinceMs)) return 0
  return Math.min(MAX_SECONDS, Math.max(0, Math.floor((now - sinceMs) / 1000)))
}

export interface OperationalModelCheck {
  outcome: 'success' | 'failed' | 'aborted'
  errorCategory: OperationalErrorCategory | null
  providerClass: OperationalProviderClass
  modelClass: string
  elapsedSec: number
}

export interface OperationalStop {
  reason: 'user' | 'run_limit'
  phase: 'cancel_settled' | 'after_10s'
  elapsedSec: number
  turnState: 'running' | 'idle' | 'mixed' | 'unknown'
  jobsService: 'available' | 'unavailable'
  before: { running: number; stopping: number } | null
  after: { running: number; stopping: number } | null
  killErrors: number | null
  sessionsChecked: number
  sessionsTotal: number
  coverage: OperationalCoverage
}

export interface OperationalApproval {
  toolClass: OperationalToolClass
  outcome: 'allowed_once' | 'rejected' | 'cancelled'
  waitSec: number | null
}

/** 进程内有界环形；溢出丢弃最旧并计数，dropped>0 在投影里反映为 partial。 */
class OperationalRing<T> {
  private items: T[] = []
  dropped = 0
  push(item: T) {
    this.items.push(item)
    if (this.items.length > 20) { this.items.shift(); this.dropped++ }
  }
  snapshot(): T[] { return [...this.items] }
  clear() { this.items = []; this.dropped = 0 }
}

const modelChecks = new OperationalRing<OperationalModelCheck>()
const stops = new OperationalRing<OperationalStop>()
const approvals = new OperationalRing<OperationalApproval>()

export const operationalRecorder = {
  recordModelCheck: (record: OperationalModelCheck) => modelChecks.push(record),
  recordStop: (record: OperationalStop) => stops.push(record),
  recordApproval: (record: OperationalApproval) => approvals.push(record),
}
/** 测试复位：进程内环形不持久化，spec 之间需要干净起点时显式清空。 */
export function resetOperationalDiagnostics() {
  modelChecks.clear(); stops.clear(); approvals.clear()
}

export interface OperationalThread {
  status: string
  elapsedSec: number | null
  usage: { inputTokens: number; outputTokens: number; reportedSessions: number; totalSessions: number } | null
  tools: { toolClass: OperationalToolClass; done: number; error: number; running: number }[]
  skills: { assigned: number; matched: number; failed: number; notObserved: number; parseUnknown: number; coverage: OperationalCoverage }
  /** files=成果文件数，finalVersions=已标最终版的成果数 */
  artifacts: { files: number; finalVersions: number } | null
  coverage: OperationalCoverage
}

export interface OperationalDiagnostics {
  coverage: OperationalCoverage
  snapshot: {
    taskCounts: Record<string, number>
    employees: number
    threads: number
    materials: number
    deliverableVersions: number
    models: { providerClass: OperationalProviderClass; modelClass: string; count: number }[]
    mcp: { enabled: number; available: number; unavailable: number; credentialsMissing: number; unknown: number } | null
  } | null
  threads: OperationalThread[]
  modelChecks: OperationalModelCheck[]
  stops: OperationalStop[]
  approvals: OperationalApproval[]
}

/** binding 名下全部会话（根/子/直达/归档子级），本地配对用，id 不输出。 */
function bindingSessions(binding: Binding): string[] {
  return [...new Set([binding.rootId, ...Object.values(binding.children), ...Object.values(binding.directChildren ?? {}), ...(binding.archivedChildren ?? []).map(child => child.sessionId)])]
}

/** DM 线程的执行状态映射：idle 视为该轮执行结束，不算失败。 */
function threadStatus(thread: WorkforceThread, taskStatus: string | undefined): string {
  if (taskStatus) return taskStatus
  switch (thread.status) {
    case 'idle': return 'done'
    case 'running': return 'running'
    case 'error': return 'failed'
    case 'cancelled': return 'cancelled'
    case 'interrupted': return 'interrupted'
    default: return 'unknown'
  }
}

/** skill 工具的 {name} 参数只在本地解析比对 assigned 集合；解析不出返回 undefined。 */
function skillCallName(args: unknown): string | undefined {
  try {
    const parsed: unknown = JSON.parse(String(args ?? ''))
    return parsed && typeof parsed === 'object' && 'name' in parsed && typeof parsed.name === 'string' ? parsed.name : undefined
  } catch { return undefined }
}

/** 单线程安全投影：usage/工具配对/skill 匹配全部本地计算，只回计数与类别。 */
async function projectThread(runtime: WorkforceRuntime, thread: WorkforceThread, state: Awaited<ReturnType<WorkforceRuntime['store']['read']>>): Promise<OperationalThread> {
  const binding = state.bindings[thread.id]
  const task = thread.taskId === undefined ? state.tasks.find(item => item.threadId === thread.id) : state.tasks.find(item => item.id === thread.taskId)
  const status = threadStatus(thread, task?.status)
  const terminal = status !== 'running'
  const endMs = terminal ? Date.parse(thread.updatedAt) : Date.now()
  const startMs = Date.parse(thread.createdAt)
  const elapsedSec = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.min(MAX_SECONDS, Math.max(0, Math.floor((endMs - startMs) / 1000))) : null
  const row: OperationalThread = {
    status, elapsedSec,
    usage: null,
    tools: [],
    skills: { assigned: 0, matched: 0, failed: 0, notObserved: 0, parseUnknown: 0, coverage: 'unavailable' },
    artifacts: task ? { files: task.deliverables.length, finalVersions: task.deliverables.filter(item => item.publishedVersion !== undefined).length } : null,
    coverage: 'unavailable',
  }
  if (!binding) return row
  const sessions = bindingSessions(binding)
  const eventsBySession = await Promise.all(sessions.map(sessionId => runtime.operationalSessionEvents(sessionId)))
  // assigned=该线程会话实际跑过的员工的指定技能：负责人根会话（sessions[0]）没有模型回复或工具调用时
  // （直达任务的根会话只有建会话的元数据事件）其技能并未被实际加载要求，不计入；读不到事件的会话同规则处理且不报错。
  const rootRan = eventsBySession[0]?.some(event => event?.type === 'assistant/message' || event?.type === 'tool/call') === true
  const assignedEmployees = [...Object.keys(binding.children), ...Object.keys(binding.directChildren ?? {}), ...(binding.archivedChildren ?? []).map(child => child.employeeId)]
  if (rootRan) assignedEmployees.unshift(binding.ownerId)
  const assigned = new Set<string>()
  for (const employeeId of assignedEmployees) {
    for (const name of state.employees.find(item => item.id === employeeId)?.skills ?? []) assigned.add(name)
  }
  row.skills.assigned = assigned.size
  let readable = 0
  let inputTokens = 0, outputTokens = 0, reportedSessions = 0
  const tools = new Map<OperationalToolClass, { done: number; error: number; running: number }>()
  const skillLoaded = new Map<string, 'done' | 'error'>()
  let parseUnknown = 0
  const toolBucket = (toolClass: OperationalToolClass) => {
    const bucket = tools.get(toolClass) ?? { done: 0, error: 0, running: 0 }
    tools.set(toolClass, bucket)
    return bucket
  }
  for (const events of eventsBySession) {
    if (events === undefined) continue
    readable++
    let reported = false
    const calls = new Map<string, { name: unknown; skill?: string }>()
    for (const event of events) {
      if (event?.type === 'assistant/message') {
        const usage: unknown = event.data?.usage
        if (!usage || typeof usage !== 'object' || !('inputTokens' in usage) || !('outputTokens' in usage)) continue
        const { inputTokens: input, outputTokens: output } = usage as { inputTokens: unknown; outputTokens: unknown }
        if (typeof input !== 'number' || typeof output !== 'number' || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0) continue
        inputTokens += input; outputTokens += output; reported = true
      } else if (event?.type === 'tool/call') {
        const entry = { name: event.data?.name as unknown, skill: undefined as string | undefined }
        if (entry.name === 'skill') {
          // skill {name} 只本地比对 assigned 集合；解析不出记 parseUnknown，不算成功。
          const name = skillCallName(event.data?.arguments)
          if (name === undefined) parseUnknown++
          else entry.skill = name
        }
        calls.set(String(event.data?.callId ?? ''), entry)
      } else if (event?.type === 'tool/result') {
        const toolCallId = String(event.data?.message?.toolCallId ?? '')
        const call = calls.get(toolCallId)
        const failed = event.data?.message?.isError === true
        toolBucket(toolClassOf(call?.name))[failed ? 'error' : 'done']++
        if (call?.skill !== undefined && assigned.has(call.skill)) {
          if (!failed) skillLoaded.set(call.skill, 'done')
          else if (skillLoaded.get(call.skill) !== 'done') skillLoaded.set(call.skill, 'error')
        }
        if (call) calls.delete(toolCallId)
      }
    }
    if (reported) reportedSessions++
    for (const call of calls.values()) toolBucket(toolClassOf(call.name)).running++
  }
  row.tools = [...tools.entries()].map(([toolClass, bucket]) => ({ toolClass, ...bucket }))
  if (reportedSessions > 0) row.usage = { inputTokens, outputTokens, reportedSessions, totalSessions: sessions.length }
  let matched = 0, failed = 0
  for (const name of assigned) {
    const outcome = skillLoaded.get(name)
    if (outcome === 'done') matched++
    else if (outcome === 'error') failed++
  }
  row.skills = { assigned: assigned.size, matched, failed, notObserved: assigned.size - matched - failed, parseUnknown, coverage: readable === sessions.length ? 'observed_window' : readable === 0 && sessions.length > 0 ? 'unavailable' : 'partial' }
  row.coverage = sessions.length === 0 ? 'observed_window' : readable === sessions.length ? 'observed_window' : readable === 0 ? 'unavailable' : 'partial'
  return row
}

export interface OperationalSources {
  /** diagnostics 已解析的员工模型（provider/model 只本地入表，不输出）。 */
  employeeModels?: { provider: string | null; model: string | null }[]
  /** diagnostics 已取回的 MCP 状态；缺失时 mcp 汇总为 null。 */
  mcpServers?: { enabled: boolean; available: boolean | null; credentialsReady: boolean | null }[]
}

/** GET 时按需计算：无后台采集、不持久化第二份日志；state 读不出时环形仍可导出。 */
export async function collectOperational(runtime: WorkforceRuntime, sources: OperationalSources = {}): Promise<OperationalDiagnostics> {
  const rings = () => ({ modelChecks: modelChecks.snapshot(), stops: stops.snapshot(), approvals: approvals.snapshot() })
  let state: Awaited<ReturnType<WorkforceRuntime['store']['read']>>
  try { state = await runtime.store.read() }
  catch { return { coverage: 'unavailable', snapshot: null, threads: [], ...rings() } }
  const taskCounts: Record<string, number> = {}
  let deliverableVersions = 0
  for (const task of state.tasks) {
    taskCounts[task.status] = (taskCounts[task.status] ?? 0) + 1
    for (const deliverable of task.deliverables) deliverableVersions += deliverable.versions?.length || 1
  }
  const models = new Map<string, { providerClass: OperationalProviderClass; modelClass: string; count: number }>()
  for (const employee of sources.employeeModels ?? []) {
    const providerClass = providerClassOf(employee.provider ?? undefined), modelClass = modelClassOf(employee.provider, employee.model)
    const key = `${providerClass}|${modelClass}`
    const entry = models.get(key) ?? { providerClass, modelClass, count: 0 }
    entry.count++
    models.set(key, entry)
  }
  const mcp = sources.mcpServers === undefined ? null : { enabled: 0, available: 0, unavailable: 0, credentialsMissing: 0, unknown: 0 }
  if (mcp) for (const server of sources.mcpServers!) {
    if (server.enabled) mcp.enabled++
    if (server.available === true) mcp.available++
    else if (server.available === false) mcp.unavailable++
    else mcp.unknown++
    if (server.credentialsReady === false) mcp.credentialsMissing++
  }
  const threads = await Promise.all(
    state.threads.filter(thread => thread.kind !== 'channel')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20)
      .map(thread => projectThread(runtime, thread, state)),
  )
  const partial = modelChecks.dropped + stops.dropped + approvals.dropped > 0
    || threads.some(thread => thread.coverage !== 'observed_window')
  return {
    coverage: partial ? 'partial' : 'observed_window',
    snapshot: {
      taskCounts,
      employees: state.employees.length,
      threads: state.threads.length,
      materials: state.materials.length,
      deliverableVersions,
      models: [...models.values()],
      mcp,
    },
    threads,
    ...rings(),
  }
}
