/**
 * 会话事件持久缓存：跨进程重启跳过冷读（zstd 解码 + JSONL 解析 + 重放校验）。
 * 键为 sessionPersistence.stat 的 revision token（jsonl 后端由文件 stat 事实构成，
 * 跨启动稳定）；eventCount 有则双确认。只认 prepared 源回写，live 会话由调用方
 * 绕过；损坏文件即删按 miss 重读。文件落在 <root>/workforce/cache/sessions/。
 */
import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 缓存文件数量上限（超过按 mtime 做 LRU 剔除）。 */
const MAX_CACHE_FILES = 300
/** 缓存总字节大小上限（512MB，超过按 mtime 做 LRU 剔除）。 */
const MAX_CACHE_BYTES = 512 * 1024 * 1024
/** 写入临时文件过期时间（10 分钟，清理未正常完成的 *.tmp 残留）。 */
const TMP_EXPIRATION_MS = 10 * 60 * 1000

/** 缓存文件结构；version 不符即视为损坏。 */
interface CacheFile {
  readonly version: 1
  readonly revision: string
  readonly eventCount?: number
  readonly events: readonly any[]
}

/** stat 提供的轻量指纹（SessionPersistenceSnapshot 的相关子集）。 */
export interface EventCacheSnapshot {
  readonly revision: string
  readonly eventCount?: number
}

export class SessionEventCache {
  private readonly directory: string
  /** 进行中的写入会话集合，用于合并同一 sessionId 的并发写入。 */
  private readonly writingSessions = new Set<string>()
  /** 限制检查防重入标记，避免并发 store/sweep 时重复扫描目录。 */
  private isEnforcingLimits = false

  constructor(workforceDirectory: string) {
    this.directory = join(workforceDirectory, 'cache', 'sessions')
  }

  /** 命中（revision 相等且 eventCount 双确认）返回事件数组；解析/结构损坏即删按 miss；占用类系统错误按 miss 不删。 */
  async events(sessionId: string, snapshot: EventCacheSnapshot): Promise<readonly any[] | undefined> {
    if (!isSessionId(sessionId)) return undefined
    const file = join(this.directory, `${sessionId}.json`)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      // 读文件失败（ENOENT 未生成、EBUSY/EPERM/EACCES 占用等系统错误）一律按 miss 处理，绝不误删物理文件
      return undefined
    }

    let parsed: CacheFile
    try {
      parsed = JSON.parse(raw) as CacheFile
    } catch {
      // JSON 解析失败属于物理损坏，清理坏文件
      await rm(file, { force: true }).catch(() => {})
      return undefined
    }

    if (parsed.version !== 1 || typeof parsed.revision !== 'string' || !Array.isArray(parsed.events)) {
      // 结构不符属于损坏文件，清理
      await rm(file, { force: true }).catch(() => {})
      return undefined
    }

    if (parsed.revision !== snapshot.revision) return undefined
    // 宿主 stat() 实际不返回 eventCount（dsh-session-persistence-jsonl），双确认分支是死代码；保留字段以备上游兼容
    if (parsed.eventCount !== undefined && snapshot.eventCount !== undefined && parsed.eventCount !== snapshot.eventCount) return undefined
    return parsed.events
  }

  /** 原子回写（临时文件 + rename，同 state.json 惯例）；同一 sessionId 并发写入合并丢弃；失败静默——缓存只是加速器。 */
  async store(sessionId: string, snapshot: EventCacheSnapshot, events: readonly any[]): Promise<void> {
    if (!isSessionId(sessionId)) return
    // 进行中的写入未完成时直接丢弃后来的写入。
    // 理由：prepared 缓存数据由冷读静态日志生成，同一会话的并发写入数据完全一致；丢弃后续并发重复写入
    // 可避免惊群读取时的重复序列化与磁盘写入放大；即使偶发写入失败，下次冷读 miss 时仍会再次触发回写。
    if (this.writingSessions.has(sessionId)) return
    this.writingSessions.add(sessionId)

    try {
      await mkdir(this.directory, { recursive: true })
      const body: CacheFile = { version: 1, revision: snapshot.revision, ...(snapshot.eventCount !== undefined ? { eventCount: snapshot.eventCount } : {}), events }
      const temporary = join(this.directory, `${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, JSON.stringify(body))
        await rename(temporary, join(this.directory, `${sessionId}.json`))
      } catch {
        await rm(temporary, { force: true }).catch(() => {})
      }
      await this.enforceLimits()
    } finally {
      this.writingSessions.delete(sessionId)
    }
  }

  /** 启动清扫：清理超过 10 分钟的 *.tmp 残留、删除不属于任何 binding 的孤儿缓存文件，并按 LRU 维持总量配额。 */
  async sweep(referenced: ReadonlySet<string>): Promise<void> {
    let entries: Dirent[]
    try { entries = await readdir(this.directory, { withFileTypes: true }) } catch { return }
    const now = Date.now()
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const name = entry.name
      if (name.endsWith('.tmp')) {
        const tmpPath = join(this.directory, name)
        try {
          const fileStat = await stat(tmpPath)
          if (now - fileStat.mtimeMs > TMP_EXPIRATION_MS) {
            await rm(tmpPath, { force: true }).catch(() => {})
          }
        } catch {}
      } else if (name.endsWith('.json')) {
        const sessionId = name.slice(0, -'.json'.length)
        if (isSessionId(sessionId) && !referenced.has(sessionId)) {
          await rm(join(this.directory, name), { force: true }).catch(() => {})
        }
      }
    }
    await this.enforceLimits()
  }

  /** 总量上限 LRU 清理：超过 300 个文件或 512MB 时按 mtime 删除最旧的缓存文件（只删缓存，不影响原生会话）。 */
  private async enforceLimits(): Promise<void> {
    if (this.isEnforcingLimits) return
    this.isEnforcingLimits = true
    try {
      let entries: Dirent[]
      try { entries = await readdir(this.directory, { withFileTypes: true }) } catch { return }

      const files: { path: string; size: number; mtimeMs: number }[] = []
      let totalBytes = 0

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const sessionId = entry.name.slice(0, -'.json'.length)
        if (!isSessionId(sessionId)) continue
        const filePath = join(this.directory, entry.name)
        try {
          const fileStat = await stat(filePath)
          files.push({ path: filePath, size: fileStat.size, mtimeMs: fileStat.mtimeMs })
          totalBytes += fileStat.size
        } catch {}
      }

      if (files.length <= MAX_CACHE_FILES && totalBytes <= MAX_CACHE_BYTES) return

      // 按修改时间升序排列，优先剔除最旧的缓存文件
      files.sort((a, b) => a.mtimeMs - b.mtimeMs)

      let remainingFiles = files.length
      for (const file of files) {
        if (remainingFiles <= MAX_CACHE_FILES && totalBytes <= MAX_CACHE_BYTES) break
        try {
          await rm(file.path, { force: true })
          totalBytes -= file.size
          remainingFiles -= 1
        } catch {}
      }
    } finally {
      this.isEnforcingLimits = false
    }
  }
}

/** 文件名只认 uuid 形态的 sessionId（hex 与连字符），杜绝路径拼接意外。 */
function isSessionId(value: string): boolean {
  return /^[0-9a-f-]{8,64}$/i.test(value)
}
