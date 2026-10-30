import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lstat, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

const prefix = 'yolo-kimi-'

function contains(root: string, target: string): boolean {
  const tail = relative(root, target)
  return tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)
}

export async function privateTemp(agent: any, exec: ToolRunContext, cwd: string): Promise<string> {
  if (process.platform !== 'win32') return realpath(tmpdir())
  const tools = agent.ctx.get('tools')
  const result = await tools.execute({
    callId: `${exec.callId}:temp` as typeof exec.callId, rootCallId: exec.rootCallId, parent: exec.token, name: 'pwsh', agent, signal: exec.signal,
    arguments: { command: '[Console]::Write($env:TEMP)', description: '准备开发环境', workdir: cwd, timeoutMs: 10000 },
  })
  if (result.isError) throw new Error('无法准备开发任务的临时目录')
  const output = result.value as { kind?: string; exitCode?: number; stdout?: { text?: string } }
  if (output.kind !== 'foreground' || output.exitCode !== 0 || !output.stdout?.text) throw new Error('无法准备开发任务的临时目录')
  const parent = await realpath(output.stdout.text.trim()), root = await realpath(tmpdir())
  if (!contains(root, parent)) throw new Error('开发任务的临时目录无效')
  return parent
}

export async function removeKimiHome(home: string): Promise<void> {
  const root = await realpath(tmpdir())
  const parent = await realpath(dirname(home))
  const info = await lstat(home)
  if (!contains(root, parent) || !basename(home).startsWith(prefix) || !info.isDirectory() || info.isSymbolicLink()) throw new Error('Kimi 临时目录无效，无法清理')
  await rm(home, { recursive: true, force: true, maxRetries: 3 })
}

/** Links reuse existing settings without copying credentials. */
export async function createKimiHome(parent: string): Promise<string> {
  const original = resolve(process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code'))
  const home = await mkdtemp(join(parent, prefix))
  try {
    await writeFile(join(home, '.gitignore'), '*\n', 'utf8')
    for (const name of ['config.toml', 'AGENTS.md', 'mcp.json', 'credentials', 'skills', 'plugins']) {
      const source = join(original, name)
      let info
      try { info = await stat(source) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const type = info.isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'
      await symlink(source, join(home, name), type)
    }
    return home
  } catch (error) {
    await removeKimiHome(home)
    throw error
  }
}
