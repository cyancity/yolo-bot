import { randomUUID } from 'node:crypto'
import { AGENT_TOOL } from './agent-config.ts'
import type { WorkforceStore } from './store.ts'

export interface AgentApprovalRequest {
  agent: any
  toolName: string
  callId: string
  reason: string
  displayReason?: { en: string; zh: string }
  signal: AbortSignal
}
export type AgentApproval = (request: AgentApprovalRequest) => Promise<string>

export const nativeAgentApproval: AgentApproval = async request => {
  const approval = request.agent.ctx.get('approval')
  if (!approval) throw new Error('外部 Agent 需要完整权限运行，但当前没有审批服务')
  return approval.request(request)
}

function approvalState(session: any): { policy: any; turn: string | undefined } {
  let policy: any, turn: string | undefined
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq)
    if (!policy && event?.type === 'approval/policy') policy = event.data
    if (!turn && (event?.type === 'turn/start' || event?.type === 'turn/end')) turn = event.type
    if (policy && turn) break
  }
  return { policy, turn }
}

/** The native delegated `never` policy stays intact; only this configured workforce capability can ask through its own audited card. */
export async function requestWorkforceAgentApproval(
  request: AgentApprovalRequest,
  store: WorkforceStore,
  eventsOf: (sessionId: string) => Promise<readonly any[]>,
  ask: AgentApproval,
): Promise<string> {
  const { agent, signal } = request
  const approval = agent.ctx.get('approval')
  if (!approval || request.toolName !== AGENT_TOOL) return nativeAgentApproval(request)
  const session = agent.session
  const { policy } = approvalState(session)
  if (policy?.policy !== 'never' || policy.source !== 'delegation' || approval.config?.policy === 'never') return nativeAgentApproval(request)
  const state = await store.read()
  const binding = Object.values(state.bindings).find(row => Object.values(row.children).includes(session.id))
  const employeeId = binding && Object.entries(binding.children).find(([, id]) => id === session.id)?.[0]
  if (!binding || !state.employees.find(row => row.id === employeeId)?.agent) return nativeAgentApproval(request)
  const parentPolicy = (await eventsOf(binding.rootId)).filter(event => event.type === 'approval/policy').at(-1)?.data.policy
  if (parentPolicy === 'never') return nativeAgentApproval(request)
  signal.throwIfAborted()
  const current = approvalState(session)
  if (current.policy?.policy !== 'never' || current.policy.source !== 'delegation' || approval.config?.policy === 'never') return nativeAgentApproval(request)
  if (current.turn !== 'turn/start') throw new Error('外部 Agent 审批需要正在运行的员工回合')
  const id = randomUUID()
  session.append('approval/asked', { id, toolName: AGENT_TOOL, callId: request.callId, reason: request.reason })
  let outcome = 'unavailable'
  try {
    const answer = await ask(request)
    if (['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(answer)) outcome = signal.aborted ? 'cancelled' : answer
  } finally {
    session.append('approval/decided', { id, outcome })
  }
  return outcome
}
