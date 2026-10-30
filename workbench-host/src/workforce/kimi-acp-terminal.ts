import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export class KimiTerminals {
  private readonly running = new Map<string, any>()
  private readonly pending = new Set<Promise<unknown>>()
  private closing = false
  constructor(private readonly subprocess: any, private readonly sandbox: any, private readonly policy: any, private readonly root: string, private readonly signal: AbortSignal) {}

  async request(method: string, params: any): Promise<unknown> {
    if (this.closing || this.signal.aborted) throw new Error('任务已停止')
    const request = this.handle(method, params)
    this.pending.add(request)
    try { return await request } finally { this.pending.delete(request) }
  }

  private async handle(method: string, params: any): Promise<unknown> {
    if (method === 'terminal/create') {
      if (typeof params.command !== 'string' || !Array.isArray(params.args ?? []) || (params.args ?? []).some((arg: unknown) => typeof arg !== 'string')) throw new Error('无效的命令参数')
      if (!Array.isArray(params.env ?? [])) throw new Error('命令环境变量无效')
      const env: Record<string, string> = {}
      for (const item of params.env ?? []) {
        if (typeof item.name !== 'string' || typeof item.value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name) || /^(?:LD_|DYLD_|NODE_OPTIONS$|DSH_)/i.test(item.name)) throw new Error('命令环境变量无效')
        env[item.name] = item.value
      }
      const dir = await realpath(resolve(this.root, params.cwd ?? '.'))
      const tail = relative(this.root, dir)
      if (tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw new Error('命令工作目录必须位于项目内')
      const executable = await this.subprocess.resolveExecutable(params.command, undefined, this.signal)
      const wrapped = await this.sandbox.confine([executable, ...(params.args ?? [])], this.policy, this.signal)
      if (this.closing || this.signal.aborted) throw new Error('任务已停止')
      const limit = Math.min(Math.max(Number(params.outputByteLimit) || 65536, 1024), 262144)
      const child = this.subprocess.spawn({ argv: wrapped.argv, cwd: dir, env, signal: this.signal, graceMs: 3000, stdio: { stdin: 'ignore', stdout: { maxBytes: limit }, stderr: { maxBytes: limit } } })
      const terminalId = randomUUID()
      const terminal: { child: any; exitStatus?: { exitCode: number | null; signal: string | null } } = { child }; this.running.set(terminalId, terminal)
      void child.done.then((outcome: any) => { terminal.exitStatus = { exitCode: outcome.exitCode, signal: outcome.signal } }, () => undefined)
      return { terminalId }
    }
    const terminal = this.running.get(params.terminalId)
    if (!terminal) throw new Error('命令不存在或已经释放')
    const { child } = terminal
    if (method === 'terminal/output') {
      const out = child.collected.stdout?.readFrom(0), err = child.collected.stderr?.readFrom(0)
      const exitStatus = terminal.exitStatus
      return { output: `${out?.text ?? ''}${err?.text ?? ''}`, truncated: Boolean(out?.lossy || err?.lossy), ...(exitStatus ? { exitStatus } : {}) }
    }
    if (method === 'terminal/wait_for_exit') {
      const outcome = await child.done
      terminal.exitStatus = { exitCode: outcome.exitCode, signal: outcome.signal }
      return terminal.exitStatus
    }
    if (method === 'terminal/kill' || method === 'terminal/release') {
      child.terminate()
      if (method === 'terminal/release') {
        if (!await child.waitForExit(AbortSignal.timeout(10000))) throw new Error('命令未完全停止')
        this.running.delete(params.terminalId)
      }
      return {}
    }
    throw new Error(`不支持的方法：${method}`)
  }

  close(): void { this.closing = true }

  async dispose(): Promise<boolean> {
    this.close()
    for (const terminal of this.running.values()) { try { terminal.child.terminate() } catch { /* Still verify every process. */ } }
    const pendingStopped = await Promise.race([
      Promise.allSettled([...this.pending]).then(() => true),
      new Promise<boolean>(resolve => { const timer = setTimeout(() => resolve(false), 10000); timer.unref() }),
    ])
    const processes = [...this.running.values()].map(terminal => terminal.child)
    for (const child of processes) { try { child.terminate() } catch { /* Still verify every process. */ } }
    const settled = await Promise.allSettled(processes.map(child => child.waitForExit(AbortSignal.timeout(10000))))
    return pendingStopped && settled.every(item => item.status === 'fulfilled' && item.value === true)
  }
}
