import { runAcp } from './acp.ts'
import { nativeAgentApproval, type AgentApproval } from '../agent-approval.ts'
import { runJsonStream, streamArgv } from './json-stream.ts'
import { AGENT_CLI_LABELS, approveFullAccess, clearAgentProgress, showAgentProgress, stopChild, type AgentChild, type AgentConfig } from './shared.ts'

export { AGENT_CLI_LABELS, currentAgentProgress } from './shared.ts'

export async function runAgentCli(agent: any, callId: string, cwd: string, task: string, config: AgentConfig, signal: AbortSignal, approve: AgentApproval = nativeAgentApproval): Promise<string> {
  await approveFullAccess(agent, callId, cwd, config.cli, signal, approve)
  const label = AGENT_CLI_LABELS[config.cli]
  const subprocess = agent.ctx.get('subprocess')
  if (!subprocess) throw new Error('宿主没有可用的子进程服务')
  let executable: string
  try { executable = await subprocess.resolveExecutable(config.cli, undefined, signal) }
  catch {
    signal.throwIfAborted()
    throw new Error(`未检测到 ${label} CLI，请先安装并登录，或在员工设置里换一个外部 Agent。`)
  }
  signal.throwIfAborted()
  const acp = config.cli === 'kimi' || config.cli === 'opencode'
  const args = acp ? [...(config.cli === 'kimi' && config.model ? ['-m', config.model] : []), 'acp'] : streamArgv(config, cwd)
  const controller = new AbortController()
  const runSignal = AbortSignal.any([signal, controller.signal])
  const child = subprocess.spawn({ argv: [executable, ...args], cwd, signal: runSignal, graceMs: 3000, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16000 } } }) as AgentChild
  // Attach immediately, before a failed stream can reject process completion.
  void child.done.catch(() => undefined)
  try {
    if (!child.stdin || !child.stdout) throw new Error(`${label} 子进程没有可用的输入输出流`)
    const show = (title: string, id?: string) => showAgentProgress(agent.session.id, callId, title, id)
    show(`等待 ${label} 执行任务`)
    const run = { agent, callId, cwd, task, config, signal: runSignal, child, show, approve }
    return await (acp ? runAcp(run) : runJsonStream(run))
  } finally {
    controller.abort()
    try { await stopChild(child, label) }
    finally { clearAgentProgress(agent.session.id, callId) }
  }
}
