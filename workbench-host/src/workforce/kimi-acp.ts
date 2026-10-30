import { createInterface } from 'node:readline'

const progress = new Map<string, string>()
const key = (owner: string, callId: string) => `${owner}:${callId}`
export function currentKimiProgress(owner: string, callId: string): string { return progress.get(key(owner, callId)) ?? '' }

/**
 * Kimi runs as the user, outside the DSH sandbox, after a danger-full-access approval.
 * The Windows ACL sandbox (restricted token, Low integrity) breaks Node child processes
 * with piped stdio (`spawn EPERM`) and Git Bash (`NtCreateDirectoryObject` 0xC0000022),
 * so Kimi's own shell cannot work inside it. Kimi keeps its own permission mode.
 */
async function approveFullAccess(agent: any, callId: string, cwd: string, signal: AbortSignal): Promise<void> {
  const ctx = agent.ctx
  const mode = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })?.mode ?? 'danger-full-access'
  if (mode === 'danger-full-access') return
  const approval = ctx.get('approval')
  if (!approval) throw new Error('Kimi 需要完整权限运行，但当前没有审批服务')
  const zh = `Kimi 将在项目目录 ${cwd} 中运行开发任务，权限为 danger-full-access，可以执行命令和修改文件。`
  const decision = await approval.request({ agent, toolName: 'wb_run_kimi', callId, reason: zh, displayReason: { en: `Run Kimi with danger-full-access in ${cwd}.`, zh }, signal })
  if (decision !== 'allowed-once') throw new Error(decision === 'rejected' ? '用户拒绝了 Kimi 的完整权限运行' : 'Kimi 的运行审批已取消')
}

export async function runKimiAcp(agent: any, callId: string, cwd: string, task: string, signal: AbortSignal): Promise<string> {
  await approveFullAccess(agent, callId, cwd, signal)
  const ctx = agent.ctx
  const subprocess = ctx.get('subprocess')
  if (!subprocess) throw new Error('宿主没有可用的子进程服务')
  const executable = await subprocess.resolveExecutable('kimi', undefined, signal)
  const child = subprocess.spawn({ argv: [executable, 'acp'], cwd, signal, graceMs: 3000, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16000 } } })
  const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>()
  const messages: string[] = []; let answer = ''
  let sequence = 0, sessionId = ''
  const show = (text: string) => { if (text.trim()) { messages.push(text); progress.set(key(agent.session.id, callId), messages.join('\n').slice(-6000)) } }
  const failed = () => {
    const stderr = child.collected.stderr?.readFrom(0)?.text?.trim()
    for (const waiter of pending.values()) waiter.reject(new Error(stderr ? `Kimi 进程意外退出：${stderr.slice(-2000)}` : 'Kimi 进程意外退出'))
    pending.clear()
  }
  child.stdin.on('error', failed)
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
      if (message.method !== 'session/request_permission') throw new Error(`不支持 Kimi 请求：${message.method}`)
      if (!sessionId || message.params?.sessionId !== sessionId || signal.aborted) throw new Error('任务已停止或会话不匹配')
      const options = Array.isArray(message.params?.options) ? message.params.options : []
      const allow = options.find((item: any) => item.kind === 'allow_once' && typeof item.optionId === 'string')
      const reject = options.find((item: any) => item.kind === 'reject_once' && typeof item.optionId === 'string')
      const approval = ctx.get('approval')
      const title = typeof message.params?.toolCall?.title === 'string' ? message.params.toolCall.title.slice(0, 500) : 'Kimi 请求执行需要确认的操作'
      const decision = allow && approval ? await approval.request({ agent, toolName: 'wb_run_kimi', callId, reason: title, signal }) : 'cancelled'
      const selected = !signal.aborted && decision === 'allowed-once' ? allow : decision === 'rejected' ? reject : undefined
      send({ jsonrpc: '2.0', id: message.id, result: selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { outcome: { outcome: 'cancelled' } } })
    } catch (error) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
    }
  }
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', line => { try { void receive(JSON.parse(line)).catch(failed) } catch { /* Ignore non-protocol output. */ } })
  void child.done.then(failed, failed)
  try {
    await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'yolo-bot', version: '0.2' } })
    const created = await request('session/new', { cwd, mcpServers: [] })
    sessionId = created.sessionId
    const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `${task}\n\n向产品负责人汇报完成情况和验收方式。除非用户明确要求，不贴代码、不列文件改动。命令因权限或系统限制失败时，不要反复尝试或绕过，请停止并说明问题。` }] })
    if (result?.stopReason !== 'end_turn') throw new Error(`Kimi 停止：${result?.stopReason ?? '未知原因'}`)
    return [messages.join('\n'), answer].filter(Boolean).join('\n\n').slice(-12000)
  } finally {
    lines.close()
    try { child.stdin.end() } catch { /* Continue cleanup. */ }
    try { child.terminate() } catch { /* Continue cleanup. */ }
    let stopped = false
    try { stopped = await child.waitForExit(AbortSignal.timeout(10000)) } catch { stopped = false }
    progress.delete(key(agent.session.id, callId))
    if (!stopped) throw new Error('Kimi 进程 10 秒内未停止，可能仍在后台运行，请检查后再派发')
  }
}
