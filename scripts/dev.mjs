import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
let port = 3099
function invalidArgument(message) {
  console.error(message)
  process.exit(1)
}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help' || args[i] === '-h') {
    console.log('用法：pnpm dev [--port 3099]\n独立浏览器开发版，数据保存在 tmp/dev-web，按 Ctrl+C 停止。')
    process.exit(0)
  }
  if (args[i] === '--port' && args[i + 1]) port = Number(args[++i])
  else invalidArgument('未知参数。使用 pnpm dev --help 查看用法。')
}
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) invalidArgument('端口必须是 1 到 65535 的整数。')

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const state = path.join(repo, 'tmp', 'dev-web')
const runtime = path.join(state, 'runtime')
const runtimeVersion = '0.2.0-rc.2'
const home = path.join(state, 'home')
const profile = path.join(home, 'profiles', 'web')
const descriptor = {
  repo, home, profile,
  root: path.join(state, 'data', 'workbench'),
  sessions: path.join(state, 'data', 'sessions'),
  host: '127.0.0.1', port,
  supervisorPid: process.pid,
  children: [],
}
const descriptorPath = path.join(state, 'instance.json')
const accessPath = path.join(state, 'access.json')
const lockPath = path.join(state, 'launcher.lock')
const cli = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const tsdown = fileURLToPath(import.meta.resolve('tsdown/run'))
const nativeHome = path.resolve(process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh'))
const nativeAgents = path.resolve(process.env.DSH_AGENTS_HOME?.trim() || path.join(homedir(), '.agents'))
const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_AGENTS_HOME: path.join(home, 'agents'),
  DSH_TELEMETRY_DISABLED: '1',
  NO_COLOR: '1',
}
const children = new Set()
let stopping = false
let ownsLock = false
let log
let descriptorWrites = Promise.resolve()

function redact(value) {
  return String(value)
    .replace(/([?&]token=)[^\s"'<>]+/gi, '$1[redacted]')
    .replace(/(\b(?:authorization|api[_-]?key|access[_-]?token)\s*[:=]\s*)(?:Bearer\s+)?[^\s,}"']+/gi, '$1[redacted]')
}

function saveDescriptor() {
  descriptorWrites = descriptorWrites.then(() => writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`))
  return descriptorWrites
}

function start(label, script, arguments_, cwd = repo, onLine) {
  if (stopping) throw new Error('开发实例正在停止。')
  const child = spawn(process.execPath, ['--expose-internals', script, ...arguments_], {
    cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  const record = { label, pid: child.pid }
  descriptor.children.push(record)
  void saveDescriptor().catch(fail)
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = ''
    stream.on('data', chunk => {
      buffer += chunk.toString()
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end + 1)
        buffer = buffer.slice(end + 1)
        log.write(`[${label}] ${redact(line)}`)
        onLine?.(line)
      }
    })
    stream.on('end', () => { if (buffer) log.write(`[${label}] ${redact(buffer)}\n`) })
  }
  child.once('close', () => {
    children.delete(child)
    descriptor.children = descriptor.children.filter(item => item !== record)
    void saveDescriptor().catch(fail)
  })
  return child
}

function completed(child, label) {
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error(`${label}无法启动。`)))
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${label}退出，状态码 ${code}。`)))
  })
}

async function run(label, script, arguments_, cwd) {
  await completed(start(label, script, arguments_, cwd), label)
}

async function ensureFreePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error(`端口 ${port} 已被占用，请使用 --port 指定其他端口。`)))
    server.listen({ host: descriptor.host, port, exclusive: true }, resolve)
  })
  await new Promise(resolve => server.close(resolve))
}

async function acquireLock() {
  try {
    const previous = JSON.parse(await readFile(lockPath, 'utf8'))
    try {
      process.kill(previous.pid, 0)
      throw new Error('这个工作树的开发实例已在运行。')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    await rm(lockPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await writeFile(lockPath, JSON.stringify({ pid: process.pid }), { flag: 'wx' })
  ownsLock = true
}

async function ensureRuntime() {
  const installedManifest = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  try {
    const installed = JSON.parse(await readFile(installedManifest, 'utf8'))
    if (installed.version === runtimeVersion && existsSync(cli)) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const pnpm = process.env.npm_execpath
  if (!pnpm || !process.env.npm_config_user_agent?.startsWith('pnpm/') || !existsSync(pnpm)) {
    throw new Error('首次准备开发运行时，请使用 pnpm dev 启动。')
  }
  await mkdir(runtime, { recursive: true })
  await writeFile(path.join(runtime, 'package.json'), `${JSON.stringify({
    name: 'yolo-bot-development-runtime', private: true, type: 'module',
    dependencies: { '@deepseek-ai/dsh': runtimeVersion },
  }, null, 2)}\n`)
  await run('runtime-install', pnpm, ['install', '--ignore-workspace'], runtime)
  const installed = JSON.parse(await readFile(installedManifest, 'utf8'))
  if (installed.version !== runtimeVersion || !existsSync(cli)) throw new Error('开发运行时版本不匹配。')
}

async function prepareProfile() {
  const fresh = !existsSync(path.join(profile, 'package.json'))
  if (fresh) {
    await run('profile', cli, ['--profile', 'web', '--dump-default-config'])
    const customPatch = process.env.YOLO_BOT_DEV_PROFILE_PATCH?.trim()
    if (customPatch) {
      const resolvedPatch = path.resolve(customPatch)
      if (!existsSync(resolvedPatch)) {
        throw new Error(`YOLO_BOT_DEV_PROFILE_PATCH 指定的文件不存在：${customPatch}`)
      }
      await copyFile(resolvedPatch, path.join(profile, 'cordis.patch.yml'))
    }
  }
  const overlay = [
    { id: 'workbench', config: { root: descriptor.root } },
    { id: 'session-persistence-jsonl', config: { root: descriptor.sessions } },
    { id: 'skill-filesystem', config: { dshHome: home, agentsHome: env.DSH_AGENTS_HOME } },
    { insert: [{ id: 'skill-filesystem-user-host', name: '@deepseek-ai/dsh-skill-filesystem', config: {
      providerName: 'user-host', includeDefaultRoots: false,
      customSkillDirs: [path.join(nativeHome, 'skills'), path.join(nativeAgents, 'skills')],
    } }] },
    { id: 'hmr', config: {
      base: pathToFileURL(`${repo}${path.sep}`).href,
      root: ['workbench-host/lib'], debounce: 500,
    } },
  ]
  const overlayPath = path.join(state, 'development.patch.yml')
  await writeFile(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`)
  return overlayPath
}

async function linkPlugins() {
  const packages = [
    ['@cyancity/yolo-bot', 'workbench-host'],
    ['@cyancity/yolo-bot-ui', 'workbench-ui'],
  ]
  let linked = true
  const manifest = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8'))
  for (const [name, directory] of packages) {
    const target = path.join(repo, directory)
    const installed = path.join(profile, 'node_modules', ...name.split('/'))
    try {
      if (await realpath(installed) !== await realpath(target) || !manifest.dsh?.profile?.bundles?.includes(name)) linked = false
    } catch { linked = false }
  }
  if (!linked) await run('link', cli, ['plugin', '--profile', 'web', 'add', ...packages.map(([, directory]) => `link:${path.join(repo, directory)}`)])
  for (const [name, directory] of packages) {
    if (await realpath(path.join(profile, 'node_modules', ...name.split('/'))) !== await realpath(path.join(repo, directory))) {
      throw new Error(`开发插件 ${name} 没有链接到本工作树。`)
    }
  }
}

async function restrictAccessFile() {
  if (process.platform !== 'win32') return chmod(accessPath, 0o600)
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME
  if (!account) throw new Error('无法确认登录入口文件的本机访问权限。')
  const child = spawn('icacls', [accessPath, '/inheritance:r', '/grant:r', `${account}:F`], { windowsHide: true, stdio: 'ignore' })
  await completed(child, '登录入口权限设置')
}

async function stop(code = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  await Promise.all([...children].map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('close', resolve)
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', () => { child.kill(); resolve() })
    } else child.kill('SIGTERM')
  })))
  if (ownsLock) {
    await saveDescriptor()
    await rm(lockPath, { force: true })
  }
  log?.end()
}

function fail(error) {
  console.error(redact(error.message))
  if (log) console.error('详细诊断保存在 tmp/dev-web/dev.log。')
  void stop(1).catch(() => { process.exitCode = 1 })
}

process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
process.on('message', message => { if (message?.type === 'dev-stop') void stop() })

try {
  await ensureFreePort()
  await mkdir(state, { recursive: true })
  await acquireLock()
  log = createWriteStream(path.join(state, 'dev.log'), { flags: 'a' })
  log.write(`\n[launcher] ${new Date().toISOString()}\n`)
  await rm(accessPath, { force: true })
  await mkdir(descriptor.root, { recursive: true })
  await mkdir(descriptor.sessions, { recursive: true })
  await ensureRuntime()
  const overlay = await prepareProfile()
  for (const directory of ['workbench-host', 'workbench-ui']) await run(`build-${directory}`, tsdown, ['--no-clean'], path.join(repo, directory))
  await linkPlugins()
  for (const directory of ['workbench-host', 'workbench-ui']) {
    const watcher = start(`watch-${directory}`, tsdown, ['--watch', '--no-clean'], path.join(repo, directory))
    watcher.once('error', () => fail(new Error(`${directory}监听进程无法启动。`)))
    watcher.once('close', () => { if (!stopping) fail(new Error(`${directory}监听进程已退出。`)) })
  }
  let announced = false
  const server = start('dsh', cli, ['--profile', 'web', '--patch', overlay, '--no-open', '--host', descriptor.host, '--port', String(port)], repo, line => {
    const entryUrl = line.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)?.[0]
    if (!entryUrl || new URL(entryUrl).port !== String(port) || announced) return
    announced = true
    void (async () => {
      await writeFile(accessPath, `${JSON.stringify({ origin: `http://${descriptor.host}:${port}`, entryUrl }, null, 2)}\n`, { mode: 0o600 })
      await restrictAccessFile()
      await saveDescriptor()
      console.log(`http://${descriptor.host}:${port}`)
      process.send?.({ type: 'dev-ready', origin: `http://${descriptor.host}:${port}`, accessPath })
    })().catch(fail)
  })
  server.once('error', () => fail(new Error('开发版 DSH 无法启动。')))
  server.once('close', code => { if (!stopping) fail(new Error(`开发版 DSH 已退出，状态码 ${code}。`)) })
} catch (error) {
  fail(error)
}
