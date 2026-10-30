import { createInterface } from 'node:readline'
import { KimiTerminals } from './kimi-acp-terminal.ts'

const progress = new Map<string, string>()
const key = (owner: string, callId: string) => `${owner}:${callId}`
export function currentKimiProgress(owner: string, callId: string): string { return progress.get(key(owner, callId)) ?? '' }
export class KimiStillRunning extends Error {}

export async function runKimiAcp(agent: any, callId: string, cwd: string, home: string, task: string, signal: AbortSignal): Promise<string> {
  const ctx = agent.ctx
  const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
  const sandbox = ctx.get('sandbox'), subprocess = ctx.get('subprocess')
  if (!policy || !sandbox || !subprocess || policy.mode !== 'workspace-write') throw new Error('Kimi 需要项目目录的宿主写入权限')
  const executable = await subprocess.resolveExecutable('kimi', undefined, signal)
  const wrapped = await sandbox.confine([executable, 'acp'], policy, signal)
  const child = subprocess.spawn({ argv: wrapped.argv, cwd, signal, graceMs: 3000, env: { KIMI_CODE_HOME: home }, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16000 } } })
  if (!child.stdin || !child.stdout) {
    try { child.terminate() } catch { /* Verify termination below. */ }
    let stopped = false
    try { stopped = await child.waitForExit(AbortSignal.timeout(10000)) } catch { /* Keep the temporary profile. */ }
    if (!stopped) throw new KimiStillRunning('Kimi 进程未完全停止，临时目录保留')
    throw new Error('Kimi 连接不可用')
  }
  const terminals = new KimiTerminals(subprocess, sandbox, policy, cwd, signal)
  const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>()
  const messages: string[] = []; let answer = ''
  let sequence = 0, sessionId = ''
  const show = (text: string) => { if (text.trim()) { messages.push(text); progress.set(key(agent.session.id, callId), messages.join('\n').slice(-6000)) } }
  child.stdin.on('error', () => { failed() })
  const send = (message: unknown) => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`) }
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
  const receive = async (message: any) => {
    if (typeof message.id === 'number' && !message.method) {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message ?? 'Kimi 请求失败'))
      else waiter.resolve(message.result)
      return
    }
    if (message.method === 'session/update') {
      if (message.params?.sessionId !== sessionId) return
      const update = message.params?.update
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') answer += update.content.text
      else if (update?.sessionUpdate === 'tool_call' && typeof update.title === 'string') show(update.title)
      return
    }
    if (message.id === undefined) return
    try {
      let result: unknown
      if (message.method === 'session/request_permission') {
        if (!sessionId || message.params?.sessionId !== sessionId || signal.aborted) throw new Error('任务已停止或会话不匹配')
        const options = Array.isArray(message.params?.options) ? message.params.options : []
        const allow = options.find((item: any) => item.kind === 'allow_once' && typeof item.optionId === 'string')
        const reject = options.find((item: any) => item.kind === 'reject_once' && typeof item.optionId === 'string')
        const approval = ctx.get('approval')
        const title = typeof message.params?.toolCall?.title === 'string' ? message.params.toolCall.title.slice(0, 500) : 'Kimi 请求执行需要确认的操作'
        const decision = allow && approval ? await approval.request({ agent, toolName: 'wb_run_kimi', callId, reason: title, signal }) : 'cancelled'
        const selected = !signal.aborted && decision === 'allowed-once' ? allow : decision === 'rejected' ? reject : undefined
        result = selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { outcome: { outcome: 'cancelled' } }
      } else if (message.method?.startsWith('terminal/')) {
        if (message.params?.sessionId !== sessionId) throw new Error('Kimi 会话不匹配')
        result = await terminals.request(message.method, message.params)
      } else throw new Error(`不支持 Kimi 请求：${message.method}`)
      send({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
    }
  }
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', line => { try { void receive(JSON.parse(line)).catch(failed) } catch { /* Ignore non-protocol output. */ } })
  const failed = () => {
    for (const waiter of pending.values()) waiter.reject(new Error('Kimi 进程意外退出'))
    pending.clear()
  }
  void child.done.then(failed, failed)
  try {
    await request('initialize', { protocolVersion: 1, clientCapabilities: { terminal: true }, clientInfo: { name: 'yolo-bot', version: '0.2' } })
    const created = await request('session/new', { cwd, mcpServers: [] })
    sessionId = created.sessionId
    const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `${task}\n\n向产品负责人汇报完成情况和验收方式。除非用户明确要求，不贴代码、不列文件改动。命令因权限或系统限制失败时，不要反复尝试或绕过，请停止并说明问题。` }] })
    if (result?.stopReason !== 'end_turn') throw new Error(`Kimi 停止：${result?.stopReason ?? '未知原因'}`)
    return [messages.join('\n'), answer].filter(Boolean).join('\n\n').slice(-12000)
  } finally {
    terminals.close()
    lines.close()
    try { child.stdin.end() } catch { /* Continue cleanup. */ }
    try { child.terminate() } catch { /* Continue cleanup. */ }
    let terminalsStopped = false
    try { terminalsStopped = await terminals.dispose() } catch { /* Keep the temporary profile. */ }
    let stopped = false
    try { stopped = await child.waitForExit(AbortSignal.timeout(10000)) } catch { stopped = false }
    progress.delete(key(agent.session.id, callId))
    if (!stopped || !terminalsStopped) throw new KimiStillRunning('Kimi 进程未完全停止，临时目录保留')
  }
}
