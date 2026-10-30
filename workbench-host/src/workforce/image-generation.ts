import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { toolValue, renderToolJson } from '../tool-output.ts'
import { requiredText } from './store.ts'
import type { WorkforceRuntime } from './runtime.ts'
import { WorkforceError, type WorkforceImageProvider } from './types.ts'

export const IMAGE_TOOL = 'wb_generate_image'
export const DEFAULT_IMAGE_KEY_REF = 'IMAGE_API_KEY'
export const DEFAULT_IMAGE_PROVIDER: WorkforceImageProvider = { kind: 'codex', model: 'gpt-6-luna' }
const KEY_REF = /^[A-Za-z_][A-Za-z0-9_]*$/
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const IMAGE_TIMEOUT_MS = 10 * 60_000
const bad = (message: string) => new WorkforceError('bad_request', message)

/** Denied-tool list for one employee: the image tool is hidden unless the employee has it enabled. */
export function withImageDenied(denied: readonly string[], employee: { imageGeneration?: boolean }): readonly string[] {
  return employee.imageGeneration ? denied : [...denied, IMAGE_TOOL]
}

/** `null` clears the provider. */
export function parseImageProvider(input: unknown): WorkforceImageProvider | undefined {
  if (input === null) return undefined
  const value = (input ?? {}) as Record<string, unknown>
  if (value.kind === 'codex') {
    const model = String(value.model ?? '').trim()
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(model)) throw bad('Codex 模型名无效')
    return { kind: 'codex', model }
  }
  if (value.kind === 'openai') {
    const baseUrl = String(value.baseUrl ?? '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\/\S+$/.test(baseUrl)) throw bad('接口地址必须以 http:// 或 https:// 开头')
    const model = String(value.model ?? '').trim()
    if (!model || model.length > 200) throw bad('请填写生图模型')
    const keyRef = String(value.keyRef ?? DEFAULT_IMAGE_KEY_REF).trim()
    if (!KEY_REF.test(keyRef)) throw bad('Key 名只能包含字母、数字和下划线，且不能以数字开头')
    return { kind: 'openai', baseUrl, model, keyRef }
  }
  if (value.kind === 'command') {
    const command = String(value.command ?? '').trim()
    if (!command) throw bad('请填写命令')
    const args = value.args
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw bad('参数必须是字符串列表')
    if (!args.some(arg => arg.includes('{prompt}')) || !args.some(arg => arg.includes('{outDir}'))) throw bad('参数中需要包含 {prompt} 和 {outDir}')
    const env = value.env ?? {}
    if (typeof env !== 'object' || Array.isArray(env) || Object.entries(env).some(([name, item]) => !KEY_REF.test(name) || typeof item !== 'string')) throw bad('环境变量格式应为 KEY=VALUE')
    return { kind: 'command', command, args: args as string[], ...(Object.keys(env).length ? { env: env as Record<string, string> } : {}) }
  }
  throw bad('生图服务类型无效')
}

export interface Subprocess {
  resolveExecutable(command: string, env: Record<string, string> | undefined, signal: AbortSignal): Promise<string>
  spawn(spec: Record<string, unknown>): { stdin?: Writable; stdout?: Readable; done: Promise<{ exitCode: number | null }>; collected: { stdout?: { readFrom(offset: number): { text: string } }; stderr?: { readFrom(offset: number): { text: string } } } }
}

interface CodexStatus { installed: boolean; loggedIn: boolean }
const codexStatusCache = new WeakMap<Subprocess, { expires: number; status: CodexStatus }>()

/** `refresh` skips the 30-second cache, for an explicit re-check after the user installs or signs in. */
export async function detectCodex(subprocess: Subprocess | undefined, signal: AbortSignal, refresh = false): Promise<CodexStatus> {
  signal.throwIfAborted()
  if (!subprocess) return { installed: false, loggedIn: false }
  const cached = codexStatusCache.get(subprocess)
  if (!refresh && cached && cached.expires > Date.now()) return cached.status
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  const status = { installed: false, loggedIn: false }
  try {
    const executable = await subprocess.resolveExecutable('codex', undefined, deadline)
    status.installed = true
    const child = subprocess.spawn({ argv: [executable, 'login', 'status'], cwd: tmpdir(), signal: deadline, graceMs: 3000, stdio: { stdin: 'ignore', stdout: { maxBytes: 16000 }, stderr: { maxBytes: 16000 } } })
    const { exitCode } = await child.done
    const output = `${child.collected.stdout?.readFrom(0).text ?? ''}\n${child.collected.stderr?.readFrom(0).text ?? ''}`
    status.loggedIn = !deadline.aborted && exitCode === 0 && /logged in/i.test(output)
  } catch { /* Missing CLI, failed status checks and detection timeouts are reported as unavailable. */ }
  signal.throwIfAborted()
  codexStatusCache.set(subprocess, { expires: Date.now() + 30_000, status })
  return status
}

function imageExtension(bytes: Buffer): string {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') return '.png'
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp'
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return '.gif'
  throw new Error('生图服务返回的文件不是支持的图片格式')
}

async function fromCodex(provider: Extract<WorkforceImageProvider, { kind: 'codex' }>, subprocess: Subprocess, prompt: string, size: string | undefined, outDir: string, signal: AbortSignal): Promise<string[]> {
  const status = await detectCodex(subprocess, signal)
  if (!status.installed) throw new Error('未检测到 Codex CLI。安装并登录 Codex（需要 ChatGPT 订阅）后即可生图；没有订阅可在员工页「生图服务」改用第三方接口。')
  if (!status.loggedIn) throw new Error('Codex 未登录，请在终端运行 codex login 后重试，或在员工页「生图服务」改用第三方接口。')
  const executable = await subprocess.resolveExecutable('codex', undefined, signal)
  const controller = new AbortController()
  const child = subprocess.spawn({ argv: [executable, 'exec', '--json', '-m', provider.model, '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', outDir, '-'], cwd: outDir, signal: AbortSignal.any([signal, controller.signal]), graceMs: 3000, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16000 } } })
  let streamError: Error | undefined
  const failed = (error: Error) => { streamError = error; controller.abort(error) }
  if (!child.stdin || !child.stdout) {
    controller.abort()
    await child.done.catch(() => undefined)
    throw new Error('Codex 子进程没有可用的输入输出流')
  }
  child.stdin.on('error', failed)
  child.stdout.on('error', failed)
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('error', failed)
  let threadId: string | undefined
  const receive = async () => {
    for await (const line of lines) {
      try {
        const event = JSON.parse(line) as { type?: string; thread_id?: unknown }
        if (event.type === 'thread.started' && typeof event.thread_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(event.thread_id)) threadId = event.thread_id
      } catch { /* Ignore non-protocol output. */ }
    }
  }
  const reading = receive()
  try {
    child.stdin.end(`只调用一次图像生成工具生成一张图片。不要运行命令，不要读写文件。生成后只回复「完成」。${size ? `\n画幅要求：${size}。` : ''}\n\n原始描述：\n${prompt}\n`)
    const [{ exitCode }] = await Promise.all([child.done, reading])
    signal.throwIfAborted()
    if (exitCode !== 0) {
      const output = child.collected.stderr?.readFrom(0).text.trim().slice(-2000)
      throw new Error(`Codex 生图退出码 ${exitCode}${output ? `：${output}` : ''}`)
    }
    if (streamError) throw streamError
  } finally {
    controller.abort()
    lines.close()
    await Promise.allSettled([child.done, reading])
  }
  const noImage = () => new Error('Codex 没有生成图片，可能当前账号或模型不支持生图')
  if (!threadId) throw noImage()
  const generatedDir = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'generated_images', threadId)
  const entries = await readdir(generatedDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const files = await Promise.all(entries.filter(entry => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())).map(async entry => {
    const path = join(generatedDir, entry.name)
    return { path, mtime: (await stat(path)).mtimeMs }
  }))
  const newest = files.sort((a, b) => b.mtime - a.mtime)[0]
  if (!newest) throw noImage()
  const bytes = await readFile(newest.path, { signal })
  const target = join(outDir, `image-1${imageExtension(bytes)}`)
  await writeFile(target, bytes, { signal })
  return [target]
}

async function fromOpenAi(provider: Extract<WorkforceImageProvider, { kind: 'openai' }>, key: string, prompt: string, size: string | undefined, outDir: string, signal: AbortSignal): Promise<string[]> {
  const response = await fetch(`${provider.baseUrl}/images/generations`, {
    method: 'POST', signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: provider.model, prompt, n: 1, ...(size ? { size } : {}) }),
  })
  const body = await response.json().catch(() => undefined) as { data?: unknown[]; images?: unknown[]; error?: { message?: string } } | undefined
  // Keep the provider's reason but never echo the key back into the conversation.
  if (!response.ok) throw new Error(`生图服务返回 ${response.status}${body?.error?.message ? `：${String(body.error.message).replaceAll(key, '***').slice(0, 500)}` : ''}`)
  // SiliconFlow-style responses use `images`; OpenAI-style use `data`.
  const items = body?.data ?? body?.images ?? []
  if (!Array.isArray(items)) throw new Error('生图服务返回的图片列表无效')
  const files: string[] = []
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== 'object') throw new Error('生图服务返回的图片条目无效')
    const entry = item as { b64_json?: unknown; url?: unknown }
    let bytes: Buffer
    if (typeof entry.b64_json === 'string') bytes = Buffer.from(entry.b64_json, 'base64')
    else if (typeof entry.url === 'string') {
      const image = await fetch(entry.url, { signal })
      if (!image.ok) throw new Error(`下载生成的图片失败：${image.status}`)
      bytes = Buffer.from(await image.arrayBuffer())
    } else continue
    signal.throwIfAborted()
    const extension = imageExtension(bytes)
    const file = join(outDir, `image-${index + 1}${extension}`)
    await writeFile(file, bytes, { signal })
    files.push(file)
  }
  return files
}

/** The command is user-configured; the model only fills {prompt} as one argv element, never through a shell. */
async function fromCommand(provider: Extract<WorkforceImageProvider, { kind: 'command' }>, subprocess: Subprocess, prompt: string, outDir: string, signal: AbortSignal): Promise<string[]> {
  const executable = await subprocess.resolveExecutable(provider.command, provider.env, signal)
  // cmd.exe would re-parse a model-written prompt, so batch files are refused.
  if (/\.(?:cmd|bat)$/i.test(executable)) throw new Error('生图命令不能是 .cmd 或 .bat，请填写可执行程序，例如 node')
  const argv = [executable, ...provider.args.map(arg => arg.replace(/\{prompt\}|\{outDir\}/g, token => token === '{prompt}' ? prompt : outDir))]
  const child = subprocess.spawn({ argv, cwd: outDir, ...(provider.env ? { env: provider.env } : {}), signal, graceMs: 3000, stdio: { stdin: 'ignore', stdout: { maxBytes: 16000 }, stderr: { maxBytes: 16000 } } })
  const { exitCode } = await child.done
  signal.throwIfAborted()
  if (exitCode !== 0) {
    const output = `${child.collected.stderr?.readFrom(0).text ?? ''}\n${child.collected.stdout?.readFrom(0).text ?? ''}`.trim()
    throw new Error(`生图命令退出码 ${exitCode}${output ? `：${output.slice(-2000)}` : ''}`)
  }
  const files = (await readdir(outDir, { withFileTypes: true })).filter(entry => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())).map(entry => join(outDir, entry.name)).sort()
  for (const file of files) imageExtension(await readFile(file, { signal }))
  return files
}

export function registerImageTool(runtime: WorkforceRuntime, ctx: { tools: { register(tool: unknown): unknown } }): void {
  ctx.tools.register(defineTool({
    name: IMAGE_TOOL,
    description: '用宿主配置的生图服务生成一张图片，保存在当前工作目录 images/ 下并返回绝对路径。prompt 写清用途、画面主体、构图、风格、比例和需要出现的文字。生成后用 present 呈报文件。',
    parameters: {
      prompt: { type: 'string', required: true, description: '完整的画面描述，最多 4000 字' },
      size: { type: 'string', description: '可选尺寸，如 1024x1024、1024x1536' },
    },
    output: { schema: { type: 'object' as const, additionalProperties: true }, render: renderToolJson },
    async execute(args, exec: ToolRunContext) {
      const agent = exec.agent as any
      if (!agent) throw new WorkforceError('bad_request', '当前工具调用没有员工会话')
      const sessionId = agent.session.id
      const { employeeId } = await runtime.address(sessionId)
      const state = await runtime.store.read()
      if (!state.employees.find(item => item.id === employeeId)?.imageGeneration) throw new WorkforceError('bad_request', '当前员工未开启生图能力')
      const provider = state.imageProvider ?? DEFAULT_IMAGE_PROVIDER
      const prompt = requiredText(args.prompt, 4000)
      const size = typeof args.size === 'string' && /^\d{2,5}x\d{2,5}$/.test(args.size) ? args.size : undefined
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)])
      signal.throwIfAborted()
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
      let generate: (outDir: string) => Promise<string[]>
      if (provider.kind === 'openai') {
        const key = (await (agent.ctx.get('credentials') as { resolve(ref: string): Promise<{ value: string } | undefined> } | undefined)?.resolve(provider.keyRef).catch(() => undefined))?.value
        if (!key) throw new WorkforceError('unavailable', `生图服务的 Key（${provider.keyRef}）未配置`)
        generate = outDir => fromOpenAi(provider, key, prompt, size, outDir, signal)
      } else {
        const subprocess = agent.ctx.get('subprocess') as Subprocess | undefined
        if (!subprocess) throw new WorkforceError('unavailable', '宿主没有可用的子进程服务')
        generate = outDir => provider.kind === 'codex' ? fromCodex(provider, subprocess, prompt, size, outDir, signal) : fromCommand(provider, subprocess, prompt, outDir, signal)
      }
      // Generators run in a short scratch directory: Windows cannot spawn with a cwd beyond MAX_PATH,
      // and employee workspaces under a long data root exceed it.
      const scratch = await mkdtemp(join(tmpdir(), 'wb-image-'))
      try {
        const generated = await generate(scratch)
        signal.throwIfAborted()
        if (generated.length === 0) throw new Error('生图服务没有返回图片')
        // Non-recursive mkdir fails on collision; mkdtemp is avoided here because it ignores Windows long paths.
        const imageDir = join(await runtime.toolDirectory(sessionId), 'images')
        await mkdir(imageDir, { recursive: true })
        const outDir = join(imageDir, `${stamp}-${randomBytes(4).toString('hex')}`)
        await mkdir(outDir)
        const images: string[] = []
        for (const file of generated) {
          const target = join(outDir, basename(file))
          await copyFile(file, target)
          images.push(target)
        }
        return toolValue({ images })
      } finally {
        await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
      }
    },
  }))
}
