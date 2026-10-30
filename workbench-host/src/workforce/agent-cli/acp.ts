import { createInterface } from 'node:readline'
import { AGENT_CLI_LABELS, processError, taskPrompt, type AgentRun } from './shared.ts'

export async function runAcp(run: AgentRun): Promise<string> {
  const { agent, callId, cwd, task, config, signal, child, show, approve } = run
  const label = AGENT_CLI_LABELS[config.cli]
  const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>()
  let answer = '', sequence = 0, sessionId = ''
  let failure: Error | undefined
  const failed = (error?: Error) => {
    failure ??= error ?? processError(child, label)
    for (const waiter of pending.values()) waiter.reject(failure)
    pending.clear()
  }
  const aborted = () => failed(new Error(`${label} 任务已取消`))
  const send = (message: unknown) => {
    signal.throwIfAborted()
    if (child.stdin.destroyed || child.stdin.writableEnded) throw failure ?? processError(child, label)
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (failure) return reject(failure)
    const id = ++sequence
    pending.set(id, { resolve, reject })
    try { send({ jsonrpc: '2.0', id, method, params }) } catch (error) { pending.delete(id); reject(error) }
  })
  const receive = async (message: any) => {
    if (typeof message.id === 'number' && !message.method) {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message ?? `${label} 请求失败`))
      else waiter.resolve(message.result)
      return
    }
    if (message.method === 'session/update') {
      if (message.params?.sessionId !== sessionId) return
      const update = message.params?.update
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') answer = (answer + update.content.text).slice(-12000)
      else if ((update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') && typeof update.title === 'string') show(update.title, typeof update.toolCallId === 'string' ? update.toolCallId : undefined)
      return
    }
    if (message.id === undefined) return
    try {
      if (message.method !== 'session/request_permission') throw new Error(`不支持 ${label} 请求：${message.method}`)
      if (!sessionId || message.params?.sessionId !== sessionId || signal.aborted) throw new Error('任务已停止或会话不匹配')
      const options = Array.isArray(message.params?.options) ? message.params.options : []
      const allow = options.find((item: any) => item.kind === 'allow_once' && typeof item.optionId === 'string')
      const reject = options.find((item: any) => item.kind === 'reject_once' && typeof item.optionId === 'string')
      const title = typeof message.params?.toolCall?.title === 'string' ? message.params.toolCall.title.slice(0, 500) : '执行需要确认的操作'
      show(`${label} 等待审批：${title}`)
      const decision = allow ? await approve({ agent, toolName: 'wb_run_agent', callId, reason: `${label}：${title}`, signal }) : 'cancelled'
      const selected = !signal.aborted && decision === 'allowed-once' ? allow : decision === 'rejected' ? reject : undefined
      send({ jsonrpc: '2.0', id: message.id, result: selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { outcome: { outcome: 'cancelled' } } })
      if (selected && selected === allow) show(title, typeof message.params?.toolCall?.toolCallId === 'string' ? message.params.toolCall.toolCallId : undefined)
    } catch (error) {
      if (!signal.aborted) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
    }
  }
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const closed = () => failed()
  lines.on('line', line => {
    let message: unknown
    try { message = JSON.parse(line) } catch { return }
    if (message && typeof message === 'object') void receive(message).catch(failed)
  })
  child.stdin.on('error', failed)
  child.stdout.on('error', failed)
  lines.on('error', failed)
  lines.on('close', closed)
  signal.addEventListener('abort', aborted, { once: true })
  void child.done.then(() => failed(), (error: Error) => failed(error))
  try {
    signal.throwIfAborted()
    await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'yolo-bot', version: '0.2' } })
    const created = await request('session/new', { cwd, mcpServers: [] })
    if (typeof created?.sessionId !== 'string' || !created.sessionId) throw new Error(`${label} 未返回有效会话`)
    sessionId = created.sessionId
    if (config.cli === 'opencode' && config.model) {
      const modelOption = Array.isArray(created.configOptions) ? created.configOptions.find((option: any) => option.type === 'select' && (option.category === 'model' || option.id === 'model')) : undefined
      if (modelOption && typeof modelOption.id === 'string') {
        await request('session/set_config_option', { sessionId, configId: modelOption.id, value: config.model })
      } else {
        show(`${label} 未提供 ACP 模型选项，使用 CLI 默认模型`)
      }
    }
    const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: taskPrompt(task) }] })
    signal.throwIfAborted()
    if (result?.stopReason !== 'end_turn') throw new Error(`${label} 停止：${result?.stopReason ?? '未知原因'}`)
    return answer
  } finally {
    signal.removeEventListener('abort', aborted)
    lines.off('close', closed)
    lines.close()
    failed(new Error(`${label} 会话已结束`))
  }
}
