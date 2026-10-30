import { createInterface } from 'node:readline'
import { AGENT_CLI_LABELS, taskPrompt, type AgentConfig, type AgentRun } from './shared.ts'

export function streamArgv(config: AgentConfig, cwd: string): string[] {
  if (config.cli === 'codex') return ['exec', '--json', '--skip-git-repo-check', '-s', 'danger-full-access', '-c', 'approval_policy="never"', '-C', cwd, ...(config.model ? ['-m', config.model] : []), '-']
  return ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', ...(config.model ? ['--model', config.model] : [])]
}

export async function runJsonStream(run: AgentRun): Promise<string> {
  const { child, config, signal, task, show } = run
  const label = AGENT_CLI_LABELS[config.cli]
  const seen = new Set<string>()
  let answer = '', completed = false, reportedError = '', diagnosticError = ''
  let streamError: Error | undefined
  const failed = (error: Error) => {
    streamError ??= error
    try { child.terminate() } catch { /* The outer runner also verifies process cleanup. */ }
  }
  const tool = (id: unknown, title: string) => {
    const key = typeof id === 'string' ? id : title
    if (seen.has(key)) return
    seen.add(key)
    show(title, key)
  }
  const receive = (event: any) => {
    if (config.cli === 'codex') {
      const item = event.item
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') answer = item.text.slice(-12000)
      if (['item.started', 'item.updated', 'item.completed'].includes(event.type) && item) {
        if (item.type === 'command_execution') tool(item.id, typeof item.command === 'string' ? item.command : '执行命令')
        else if (item.type === 'file_change') tool(item.id, `修改文件 ${Array.isArray(item.changes) ? item.changes.map((change: any) => change.path ?? '').join(', ') : ''}`)
        else if (item.type === 'mcp_tool_call') tool(item.id, `${item.server ?? 'MCP'}/${item.tool ?? '工具调用'}`)
        else if (item.type === 'web_search') tool(item.id, `搜索 ${item.query ?? ''}`)
      }
      if (event.type === 'turn.completed') completed = true
      if (event.type === 'turn.failed') reportedError = event.error?.message ?? `${label} 任务失败`
      if (event.type === 'error' && typeof event.message === 'string') diagnosticError = event.message
    } else {
      if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) if (block.type === 'tool_use') tool(block.id, `${block.name ?? '工具调用'}${typeof block.input?.command === 'string' ? ` ${block.input.command}` : typeof block.input?.file_path === 'string' ? ` ${block.input.file_path}` : ''}`)
      }
      if (event.type === 'result') {
        completed = true
        if (typeof event.result === 'string') answer = event.result.slice(-12000)
        if (event.is_error || (event.subtype && event.subtype !== 'success')) reportedError = answer || (Array.isArray(event.errors) ? event.errors.join('\n') : `${label} 任务失败：${event.subtype ?? '未知原因'}`)
      }
    }
  }
  child.stdin.on('error', failed)
  child.stdout.on('error', failed)
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('error', failed)
  const reading = (async () => {
    for await (const line of lines) {
      let event: unknown
      try { event = JSON.parse(line) } catch { continue }
      if (event && typeof event === 'object') receive(event)
    }
  })()
  try {
    child.stdin.end(`${taskPrompt(task)}\n`)
    const [{ exitCode }] = await Promise.all([child.done, reading])
    signal.throwIfAborted()
    if (streamError) throw streamError
    if (exitCode !== 0 || !completed || reportedError) {
      const detail = reportedError || diagnosticError || child.collected.stderr?.readFrom(0).text.trim().slice(-2000)
      throw new Error(`${label} ${exitCode !== 0 ? `退出码 ${exitCode}` : '未正常完成'}${detail ? `：${detail}` : ''}`)
    }
    return answer
  } finally {
    lines.close()
    await reading.catch(() => undefined)
  }
}
