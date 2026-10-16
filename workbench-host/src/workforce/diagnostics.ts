import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import manifest from '../../package.json' with { type: 'json' }
import type { WorkforceRuntime } from './runtime.ts'
import type { EmployeeMcp } from './mcp.ts'
import { collectOperational, type OperationalDiagnostics } from './operational-diagnostics.ts'

export interface DiagnosticSources {
  defaultModel?: () => unknown
  mcp?: Pick<EmployeeMcp, 'status'>
}
export interface WorkforceDiagnostics {
  generatedAt: string
  environment: { workbenchVersion: string; harnessVersion: string | null; platform: string; arch: string; nodeVersion: string; runtimeMode: string }
  counts: { employees: number; channels: number; tasks: Record<string, number>; threads: number; memories: Record<string, number>; materials: number; deliverableVersions: number } | null
  recentFailures: { id: string; threadId: string; status: string; error: string; updatedAt: string; sessionIds: string[] }[]
  employeeModels: { id: string; provider: string | null; model: string | null }[]
  mcpServers: { id: string; serverName: string; enabled: boolean; available: boolean | null; credentialsReady: boolean | null; errors: string[] }[]
  conversation?: { taskId: string; threadId: string; messages: { id: string; ts: string; role: string; senderId: string; text: string; tool?: { name: string; status: string } }[] }
  errors: { section: string; message: string }[]
  privacy: string
  /** TEL-H：固定枚举/计数/秒数的安全投影；不含正文、名称、id、参数或路径。 */
  operational: OperationalDiagnostics
}

const home = homedir()
const normalizedHome = home.replace(/\\/g, '/')
const HOME_PREFIXES = (home === normalizedHome ? [home] : [home, normalizedHome]).map(path =>
  new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[/\\\\\\s"\'<>;,]|$)', 'gi'))

/** Common secret spellings only; this is not an exhaustive secret detector. */
export function redactDiagnosticText(value: string): string {
  let text = value.replace(/\bsk-[A-Za-z0-9_-]+/gi, '[已遮蔽]')
    .replace(/\bBearer\s+[^\s"'<>;,]+/gi, 'Bearer [已遮蔽]')
    .replace(/(\b(?:api[_-]?key|key|token|access[_-]?token|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;<>]+)/gi, '$1[已遮蔽]')
    .replace(/\bAuthorization\s+[^\r\n]+/gi, 'Authorization [已遮蔽]')
  for (const prefix of HOME_PREFIXES) text = text.replace(prefix, '~')
  return text.replace(/\b[A-Za-z]:[\\/][^\r\n"'<>;,]+/g, '[路径已遮蔽]')
    .replace(/(^|[\s("'=])\/(?:[^\s/"'<>;,]+\/)*[^\s"'<>;,]+/g, '$1[路径已遮蔽]')
}

async function harnessVersion(): Promise<string | null> {
  const require = createRequire(import.meta.url)
  for (const specifier of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-web-app/package.json']) {
    try {
      const value: unknown = JSON.parse(await readFile(require.resolve(specifier), 'utf8'))
      if (value && typeof value === 'object' && 'version' in value && typeof value.version === 'string') return value.version
    } catch { /* A source checkout may expose module entries but not package.json exports. */ }
  }
  let directory: string
  try { directory = dirname(require.resolve('@deepseek-ai/dsh-tools')) } catch { return null }
  for (let depth = 0; depth < 10; depth++) {
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (value && typeof value === 'object' && 'name' in value && (value.name === '@deepseek-ai/dsh-root' || value.name === '@deepseek-ai/dsh') && 'version' in value && typeof value.version === 'string') return value.version
    } catch { /* Skip unrelated parent directories without a readable harness manifest. */ }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

const harnessMetadata = harnessVersion()

export async function collectWorkforceDiagnostics(runtime: WorkforceRuntime, taskId?: string, sources: DiagnosticSources = {}): Promise<WorkforceDiagnostics> {
  const report: WorkforceDiagnostics = {
    generatedAt: new Date().toISOString(),
    environment: { workbenchVersion: manifest.version, harnessVersion: await harnessMetadata, platform: process.platform, arch: process.arch, nodeVersion: process.version, runtimeMode: process.env.WB_RUNTIME_MODE ?? 'unspecified' },
    counts: null, recentFailures: [], employeeModels: [], mcpServers: [], errors: [],
    operational: { coverage: 'unavailable', snapshot: null, threads: [], modelChecks: [], stops: [], approvals: [] },
    privacy: '默认不包含对话、记忆或材料正文。仅按你的选择附加任务对话（所选任务的最近 50 条消息，含工具名与状态、不含工具参数）；常见密钥形态已遮蔽，但不能保证识别全部秘密。文件不会自动上传。',
  }
  if (report.environment.harnessVersion === null) report.errors.push({ section: 'environment', message: '无法读取 harness 版本' })
  try {
    const state = await runtime.store.read()
    const tasks: Record<string, number> = {}, memories: Record<string, number> = { global: 0, channel: 0, employee: 0 }
    let deliverableVersions = 0
    for (const task of state.tasks) {
      tasks[task.status] = (tasks[task.status] ?? 0) + 1
      for (const deliverable of task.deliverables) deliverableVersions += deliverable.versions?.length || 1
    }
    for (const memory of state.memories) memories[memory.scope] = (memories[memory.scope] ?? 0) + 1
    report.counts = { employees: state.employees.length, channels: state.channels.length, tasks, threads: state.threads.length, memories, materials: state.materials.length, deliverableVersions }
    report.recentFailures = state.tasks.filter(task => task.status === 'failed' || task.status === 'interrupted')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20).map(task => {
        const binding = state.bindings[task.threadId]
        return { id: task.id, threadId: task.threadId, status: task.status, error: redactDiagnosticText(task.error ?? '').slice(0, 300), updatedAt: task.updatedAt,
          sessionIds: binding ? [...new Set([binding.rootId, ...Object.values(binding.children), ...Object.values(binding.directChildren ?? {}), ...(binding.archivedChildren ?? []).map(child => child.sessionId)])] : [] }
      })
    let defaultProvider: string | null = null, defaultModel: string | null = null
    try {
      if (!sources.defaultModel) throw new Error('原生默认模型读取入口不可用')
      const selection = sources.defaultModel()
      if (!selection || typeof selection !== 'object' || !('provider' in selection) || typeof selection.provider !== 'string' || !('model' in selection) || typeof selection.model !== 'string') throw new Error('尚未选择默认模型或模型服务不可用')
      defaultProvider = selection.provider; defaultModel = selection.model
    } catch (error) { report.errors.push({ section: 'models', message: redactDiagnosticText(error instanceof Error ? error.message : String(error)).slice(0, 300) }) }
    report.employeeModels = state.employees.map(employee => {
      const slash = employee.model?.indexOf('/') ?? -1
      return { id: employee.id, provider: slash > 0 ? employee.model!.slice(0, slash) : defaultProvider, model: slash > 0 ? employee.model!.slice(slash + 1) : employee.model ?? defaultModel }
    })
    report.mcpServers = await Promise.all(state.mcpServers.map(async server => {
      const base = { id: server.id, serverName: server.serverName, enabled: server.enabled }
      try {
        if (!sources.mcp) throw new Error('MCP 状态服务不可用')
        const status = await sources.mcp.status(server)
        return { ...base, available: status.available, credentialsReady: status.credentials.every(row => row.configured), errors: status.errors.map(error => redactDiagnosticText(error).slice(0, 300)) }
      } catch (error) {
        const message = redactDiagnosticText(error instanceof Error ? error.message : String(error)).slice(0, 300)
        report.errors.push({ section: `mcp:${server.id}`, message })
        return { ...base, available: null, credentialsReady: null, errors: [message] }
      }
    }))
    if (taskId !== undefined) {
      const task = state.tasks.find(task => task.id === taskId)
      if (!task) report.errors.push({ section: 'conversation', message: '指定任务不存在，未附加对话' })
      else {
        try {
          const page = await runtime.messagePage(task.threadId, { limit: 50 })
          report.conversation = { taskId: task.id, threadId: task.threadId, messages: page.messages.map(message => ({ id: message.id, ts: message.ts, role: message.role, senderId: message.senderId, text: redactDiagnosticText(message.text), ...(message.tool ? { tool: { name: message.tool.name, status: message.tool.status } } : {}) })) }
        } catch (error) { report.errors.push({ section: 'conversation', message: redactDiagnosticText(error instanceof Error ? error.message : String(error)).slice(0, 300) }) }
      }
    }
  } catch (error) {
    const message = error instanceof SyntaxError ? '工作台 state 无法解析（SyntaxError），其他环境信息仍可导出' : redactDiagnosticText(error instanceof Error ? error.message : String(error)).slice(0, 300)
    report.errors.push({ section: 'state', message })
  }
  // TEL-H：operational 只含枚举/计数/秒数；员工 provider/model 与 MCP 状态只作本地类别映射入参。
  try { report.operational = await collectOperational(runtime, { employeeModels: report.employeeModels, mcpServers: report.mcpServers }) }
  catch (error) { report.errors.push({ section: 'operational', message: redactDiagnosticText(error instanceof Error ? error.message : String(error)).slice(0, 300) }) }
  // Redact selected identifiers too: custom model ids/server names may contain copied credentials or paths.
  const pending: unknown[] = [report]
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    const object = value as Record<string, unknown>
    for (const key of Object.keys(object)) {
      const child = object[key]
      if (typeof child === 'string') object[key] = redactDiagnosticText(child)
      else if (child && typeof child === 'object') pending.push(child)
    }
  }
  return report
}
