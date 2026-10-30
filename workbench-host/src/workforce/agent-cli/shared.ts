import type { Readable, Writable } from 'node:stream'
import type { AgentCli } from '../types.ts'
import { AGENT_CLIS } from '../agent-config.ts'
import type { AgentApproval } from '../agent-approval.ts'

export const AGENT_CLI_LABELS = Object.fromEntries(AGENT_CLIS.map(({ id, label }) => [id, label])) as Record<AgentCli, string>
export interface AgentConfig { cli: AgentCli; model?: string }
export interface AgentChild {
  stdin: Writable
  stdout: Readable
  done: Promise<{ exitCode: number | null }>
  collected: { stderr?: { readFrom(offset: number): { text: string } } }
  terminate(): void
  waitForExit(signal: AbortSignal): Promise<boolean>
}
export interface AgentRun {
  agent: any
  callId: string
  cwd: string
  task: string
  config: AgentConfig
  signal: AbortSignal
  child: AgentChild
  approve: AgentApproval
  show(title: string, id?: string): void
}

const progress = new Map<string, Map<string, string>>()
const key = (owner: string, callId: string) => `${owner}:${callId}`
export function currentAgentProgress(owner: string, callId: string): string { return [...(progress.get(key(owner, callId))?.values() ?? [])].join('\n') }
export function clearAgentProgress(owner: string, callId: string): void { progress.delete(key(owner, callId)) }
export function showAgentProgress(owner: string, callId: string, title: string, id?: string): void {
  const text = title.trim().replace(/[\r\n]+/g, ' ').slice(0, 1000)
  if (!text) return
  const runKey = key(owner, callId)
  const rows = progress.get(runKey) ?? new Map<string, string>()
  const rowKey = id === undefined ? 'status' : `tool:${id}`
  rows.delete('status')
  rows.delete(rowKey)
  rows.set(rowKey, text)
  while ([...rows.values()].join('\n').length > 6000) rows.delete(rows.keys().next().value!)
  progress.set(runKey, rows)
}

/** Windows restricted tokens break Node pipes and Git Bash; ask before using the host subprocess without a sandbox. */
export async function approveFullAccess(agent: any, callId: string, cwd: string, cli: AgentCli, signal: AbortSignal, approve: AgentApproval): Promise<void> {
  signal.throwIfAborted()
  const label = AGENT_CLI_LABELS[cli]
  const zh = `${label} 将在项目目录 ${cwd} 中运行开发任务，权限为 danger-full-access，可以执行命令和修改文件。`
  const decision = await approve({ agent, toolName: 'wb_run_agent', callId, reason: zh, displayReason: { en: `Run ${label} with danger-full-access in ${cwd}.`, zh }, signal })
  signal.throwIfAborted()
  if (decision !== 'allowed-once') throw new Error(decision === 'rejected' ? `${label} 的完整权限运行未获批准` : decision === 'unavailable' ? `${label} 的完整权限审批不可用` : `${label} 的运行审批已取消`)
}

export function taskPrompt(task: string): string {
  return `${task}\n\n向产品负责人汇报完成情况和验收方式。除非用户明确要求，不贴代码、不列文件改动。命令因权限或系统限制失败时，不要反复尝试或绕过，请停止并说明问题。`
}

export function processError(child: AgentChild, label: string): Error {
  const stderr = child.collected.stderr?.readFrom(0).text.trim().slice(-2000)
  return new Error(`${label} 进程意外退出${stderr ? `：${stderr}` : ''}`)
}

export async function stopChild(child: AgentChild, label: string): Promise<void> {
  try { child.stdin.end() } catch { /* The process may already have closed its input. */ }
  try { child.terminate() } catch { /* Still wait to verify the process is gone. */ }
  const stopped = await child.waitForExit(AbortSignal.timeout(10000)).catch(() => false)
  if (!stopped) throw new Error(`${label} 进程 10 秒内未停止，可能仍在后台运行，请检查后再派发`)
}
