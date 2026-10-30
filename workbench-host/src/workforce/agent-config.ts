import { WorkforceError, type AgentCli, type WorkforceEmployee } from './types.ts'
import type { Subprocess } from './image-generation.ts'

export const AGENT_TOOL = 'wb_run_agent'
export const AGENT_CLIS: ReadonlyArray<{ id: AgentCli; label: string }> = [
  { id: 'kimi', label: 'Kimi' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'opencode', label: 'OpenCode' },
]

export function parseEmployeeAgent(input: unknown): WorkforceEmployee['agent'] {
  if (input === null) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WorkforceError('bad_request', '外部 Agent 配置必须是对象或 null')
  const { cli, model } = input as Record<string, unknown>
  if (!AGENT_CLIS.some(item => item.id === cli)) throw new WorkforceError('bad_request', '外部 Agent CLI 必须是 kimi、codex、claude 或 opencode')
  if (model !== undefined && (typeof model !== 'string' || !/^[A-Za-z0-9._:/-]{1,120}$/.test(model.trim()))) throw new WorkforceError('bad_request', '外部 Agent 模型名无效')
  return { cli: cli as AgentCli, ...(typeof model === 'string' ? { model: model.trim() } : {}) }
}

export function withAgentDenied(denied: readonly string[], employee: Pick<WorkforceEmployee, 'agent'>): readonly string[] {
  return employee.agent ? denied : [...denied, AGENT_TOOL]
}

export function agentInstruction(employee: Pick<WorkforceEmployee, 'agent'>): string {
  if (!employee.agent) return ''
  const label = AGENT_CLIS.find(item => item.id === employee.agent!.cli)!.label
  return `\n已配置外部 Agent ${label}。开发、修改代码和修复项目类任务必须用 wb_run_agent 交给该 CLI 执行，传完整需求、约束和验收要求；等待真实结果回来后再核对。进程退出不等于任务成功，须如实报告未完成项。遇到权限或沙箱拒绝不要重试或绕过，停止并报告限制。外部 Agent 需要频道绑定项目目录；普通办公和对话任务按原流程处理。`
}

interface AgentCliStatus { id: AgentCli; label: string; installed: boolean }
const cache = new WeakMap<Subprocess, { expires: number; clis: AgentCliStatus[] }>()

export async function detectAgentClis(subprocess: Subprocess | undefined, signal: AbortSignal, refresh = false): Promise<{ clis: AgentCliStatus[] }> {
  signal.throwIfAborted()
  if (!subprocess) return { clis: AGENT_CLIS.map(cli => ({ ...cli, installed: false })) }
  const cached = cache.get(subprocess)
  if (!refresh && cached && cached.expires > Date.now()) return { clis: structuredClone(cached.clis) }
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  const clis = await Promise.all(AGENT_CLIS.map(async cli => {
    try {
      await subprocess.resolveExecutable(cli.id, undefined, deadline)
      return { ...cli, installed: true }
    } catch {
      return { ...cli, installed: false }
    }
  }))
  signal.throwIfAborted()
  cache.set(subprocess, { expires: Date.now() + 30_000, clis })
  return { clis: structuredClone(clis) }
}
