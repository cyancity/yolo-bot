import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import manifest from '../../package.json' with { type: 'json' }
import { WorkforceError } from './types.ts'
import { safeName, type WorkforceStore } from './store.ts'
import type { WorkbenchInfo } from '../extension.ts'
import { checkedSkillDirectory } from './skill-drafts.ts'

/** Only the instance's JSONL session backend is accepted; never a renderer-selected path or a credential service. */
interface BackupSessionPersistence {
  name: string
  config: { root: string }
  flush(): Promise<void>
}

async function harnessVersion(): Promise<string | null> {
  const require = createRequire(import.meta.url)
  for (const specifier of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-web-app/package.json']) {
    try { return JSON.parse(await readFile(require.resolve(specifier), 'utf8')).version ?? null } catch { /* Source package exports may omit package.json. */ }
  }
  let directory: string
  try { directory = dirname(require.resolve('@deepseek-ai/dsh-tools')) } catch { return null }
  for (let depth = 0; depth < 10; depth++) {
    try {
      const value = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (value.name === '@deepseek-ai/dsh-root' || value.name === '@deepseek-ai/dsh') return typeof value.version === 'string' ? value.version : null
    } catch { /* Skip unrelated parents. */ }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

const within = (root: string, path: string) => {
  const part = relative(root, path)
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const harnessMetadata = harnessVersion()

/** Holds the unified maintenance gate and store barrier through the entire copy. */
export async function createWorkforceBackup(store: WorkforceStore, source: unknown, userSkillsRoot?: string, lifecycle?: Pick<WorkbenchInfo, 'enterMaintenance'>) {
  const persistence = source as BackupSessionPersistence | undefined
  if (persistence?.name !== 'session-persistence-jsonl' || typeof persistence.config?.root !== 'string' || typeof persistence.flush !== 'function') {
    throw new WorkforceError('unavailable', '原生会话备份服务不可用，未创建备份，请稍后重试')
  }
  const gate = await lifecycle?.enterMaintenance()
  if (gate && !gate.ok) throw new WorkforceError('conflict', '工作台或扩展仍有进行中的工作，请结束后再备份')
  try {
  const version = await harnessMetadata
  return await store.snapshot(async state => {
    const dataRoot = resolve(dirname(store.directory)), sessionRoot = resolve(persistence.config.root)
    const backupRoot = join(dataRoot, 'backups')
    // An ancestor would copy credential/profile data and recurse through our own destination.
    if (within(sessionRoot, dataRoot) || within(backupRoot, sessionRoot)) throw new WorkforceError('unavailable', '原生会话目录与工作台备份目录重叠，无法安全备份')
    await persistence.flush()
    let sessionsExist = true
    for (const root of [dataRoot, sessionRoot]) {
      let info
      try { info = await lstat(root) }
      catch (error) {
        if (root !== sessionRoot || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        sessionsExist = false
        continue
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkforceError('unavailable', '备份源必须是独立数据目录，不能是链接')
    }
    try { await mkdir(backupRoot) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    if ((await lstat(backupRoot)).isSymbolicLink() || await realpath(backupRoot) !== join(await realpath(dataRoot), 'backups')) {
      throw new WorkforceError('unavailable', '备份目录不能链接到其他位置')
    }
    const generatedAt = new Date().toISOString()
    const directory = join(backupRoot, generatedAt.replace(/[:.]/g, '-'))
    await mkdir(directory)
    try {
      let fileCount = 0, totalBytes = 0
      const copyTree = async (source: string, destination: string, excludeBackups = false): Promise<void> => {
        const info = await lstat(source)
        if (info.isSymbolicLink()) throw new WorkforceError('unavailable', '数据中含链接，备份已中止；请移除链接后重试')
        if (info.isDirectory()) {
          await mkdir(destination)
          for (const entry of await readdir(source)) {
            if (excludeBackups && entry === 'backups') continue
            await copyTree(join(source, entry), join(destination, entry))
          }
        } else if (info.isFile()) {
          await copyFile(source, destination)
          fileCount++
          totalBytes += (await stat(destination)).size
        } else throw new WorkforceError('unavailable', '数据中含不支持的文件类型，备份已中止')
      }
      await copyTree(dataRoot, join(directory, 'workbench'), true)
      if (sessionsExist) await copyTree(sessionRoot, join(directory, 'native-sessions'))
      else await mkdir(join(directory, 'native-sessions'))
      // Reviewed drafts and CRUD-installed user skills may live outside the data root.
      const workflowSkills: string[] = []
      const installedNames = [...new Set([...state.installedSkills.map(item => item.slug), ...Object.keys(state.userSkillHashes ?? {})])]
      if (userSkillsRoot !== undefined && installedNames.length) {
        await mkdir(join(directory, 'workflow-skills'))
        for (const name of installedNames) {
          let skillDirectory: string
          try { skillDirectory = await checkedSkillDirectory(userSkillsRoot, safeName(name)) }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
            throw error
          }
          await copyTree(skillDirectory, join(directory, 'workflow-skills', name))
          workflowSkills.push(name)
        }
      }
      const deliverableVersions = []
      for (const task of state.tasks) for (const item of task.deliverables) {
        const taskId = safeName(task.id), name = safeName(item.name)
        for (const entry of item.versions?.length ? item.versions : [{ version: 1, sha256: undefined }]) {
          const path = join('workbench', 'workforce', 'deliverables', taskId, name, ...(item.versions?.length ? [`v${entry.version}${extname(name)}`] : []))
          const digest = await sha256(join(directory, path))
          deliverableVersions.push({ taskId, name, version: entry.version, path: path.split(sep).join('/'), sha256: digest, ...(entry.sha256 ? { recordedSha256: entry.sha256, matchesRecorded: digest === entry.sha256 } : {}) })
        }
      }
      const report = {
        generatedAt, appVersion: manifest.version, harnessVersion: version, schemaVersion: state.schemaVersion,
        sources: { dataRoot, sessionRoot }, layout: { workbench: 'workbench', nativeSessions: 'native-sessions', ...(workflowSkills.length ? { workflowSkills: 'workflow-skills' } : {}) },
        fileCount, totalBytes, countsExcludeManifest: true, deliverableVersions, ...(workflowSkills.length ? { workflowSkills } : {}),
        consistency: lifecycle ? '已持有工作台与全部扩展的维护门，确认在途任务、工具与写入均已归静；原生会话已 flush，复制期间保持 store 写屏障。' : '已等待工作台变更落盘，并在复制期间阻止后续 store.change；原生会话已 flush，但执行中的模型与 shell 未暂停。建议任务结束后备份。',
        privacy: '不复制 dsh 凭据库、账户配置或运行入口令牌；备份包含原始对话、材料、成果与 scratch，可能含你输入的敏感内容，请勿公开。',
      }
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
      return { directory }
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  })
  } finally { if (gate?.ok) gate.release() }
}

