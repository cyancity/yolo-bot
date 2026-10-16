/**
 * 工作台数字员工的原生回复增量桥：传输、重连、attempt 结算与打开失败重试都由
 * dsh 原生会话层负责。这里叠加两类行——还在流的 running 草稿，以及原生已
 * settle、但 HTTP 消息页还没带回落盘正文的新回复；持久行一旦经轮询到手就按
 * streamKey 删掉叠加份，所以任何回复只会出现一次。
 */
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { AssistantLiveChunkEvent, ISessions, SessionEventLikeEntry, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkforceMessage, WorkforceSession, WorkforceSnapshot } from './workforce-types.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    workbenchReplies: unknown
  }
}

/** 一次流式 attempt 的文本累计；settle 后由同 streamKey 的持久行接手。 */
interface LiveAttempt {
  readonly key: string
  readonly attemptId: AssistantLiveChunkEvent['data']['attemptId']
  readonly turn: number
  readonly step: number
  readonly parts: Map<number, string>
  toolSeen: boolean
  seq: number
  time: number
}

interface LiveSession {
  readonly threadId: string
  readonly owner: WorkforceSession
  reference?: SessionReference | undefined
  unsubscribe?: (() => void) | undefined
  /** 已消费的事件窗修订；undefined 表示还没收到首张 baseline。 */
  revision?: number | undefined
  /** 首张 baseline 的最大持久 seq：baseline 内落盘行交给轮询投影，不重复叠加。 */
  baselineSeq: number
  /** 首张 baseline 是否已真正落地；没落地前不得冻结 baselineSeq。 */
  sawBaseline: boolean
  /** 最近一个 turn/start 的 seq，用于给同 turn 的行打 turnId 分组。 */
  turnSeq?: number | undefined
  /** turn:step → 累计中的 attempt；llm/retry 与结算会重置/删除同位记录。 */
  readonly attempts: Map<string, LiveAttempt>
  /** 当前展示的 running 草稿行；持久行落盘后由 present() 按 streamKey 删走。 */
  readonly rows: Map<string, WorkforceMessage>
}

/** 每个会话最多保留的草稿条数兜底（正常只会有一两条 running）。 */
const MAX_LIVE_ROWS = 24
/** detached settled 行兜底：正常 HTTP 下一轮就接手；页面丢失时不无限累积。 */
const MAX_DETACHED_ROWS = 48

const joinParts = (parts: ReadonlyMap<number, string>): string =>
  [...parts.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n')

interface SubagentCatalogEntry {
  readonly id: string
  readonly mode: 'one-shot' | 'continuable' | 'unknown'
}

export class WorkforceLiveReplies {
  private readonly watching = new Map<string, LiveSession>()
  /** 退订会话遗留的已结算行：HTTP 消息页接手前继续渲染，避免同步边界一闪缺行。 */
  private readonly detached = new Map<string, { threadId: string; row: WorkforceMessage }>()

  constructor(
    private readonly sessions: ISessions,
    private readonly changed: () => void,
  ) {}

  /** 聚焦线程的会话集合变化时调；消失的退订释放，新增的开原生引用。 */
  sync(bindings: ReadonlyMap<string, readonly WorkforceSession[]>): void {
    const wanted = new Map<string, { threadId: string; owner: WorkforceSession }>()
    for (const [threadId, owners] of bindings) {
      for (const owner of owners) {
        if (!wanted.has(owner.sessionId)) wanted.set(owner.sessionId, { threadId, owner })
      }
    }
    for (const [sessionId, live] of this.watching) {
      if (!wanted.has(sessionId)) {
        this.watching.delete(sessionId)
        this.release(live)
      }
    }
    for (const [sessionId, { threadId, owner }] of wanted) {
      if (this.watching.has(sessionId)) continue
      const live: LiveSession = {
        threadId, owner, baselineSeq: -1, sawBaseline: false, attempts: new Map(), rows: new Map(),
      }
      this.watching.set(sessionId, live)
      void this.open(live)
    }
  }

  clear(): void {
    for (const live of this.watching.values()) this.release(live)
    this.watching.clear()
    this.detached.clear()
  }

  private release(live: LiveSession): void {
    live.unsubscribe?.()
    live.unsubscribe = undefined
    live.reference?.release()
    live.reference = undefined
    // running 草稿随订阅消失；已结算行移交 detached，等 HTTP 消息页同 streamKey
    // 接手后由 present 删掉，不会在订阅边界丢一条刚完成的回复。
    for (const [key, row] of live.rows) {
      if (row.running === true) continue
      this.detached.set(key, { threadId: live.threadId, row })
    }
    live.rows.clear()
    // HTTP 接手在 present 里按 streamKey 删除；这里是防泄漏兜底，清最旧。
    if (this.detached.size > MAX_DETACHED_ROWS) {
      const excess = this.detached.size - MAX_DETACHED_ROWS
      for (const key of [...this.detached.keys()].slice(0, excess)) this.detached.delete(key)
    }
  }

  /** 子会话按显式父地址订阅；普通会话 id 必须先出现在 Host catalog 里。 */
  private async open(live: LiveSession): Promise<void> {
    const { owner } = live
    try {
      let mode: 'continuable' | 'one-shot' | 'unknown' = 'continuable'
      if (owner.parentSessionId !== undefined) {
        const parent = owner.parentSessionId as SessionId
        await this.sessions.refreshProjections(parent)
        if (this.watching.get(owner.sessionId) !== live) return
        mode = this.parentCatalogMode(parent, owner.sessionId) ?? 'unknown'
      } else if (this.sessions.list.getSnapshot().byId[owner.sessionId as SessionId] === undefined) {
        await this.sessions.refresh()
        if (this.watching.get(owner.sessionId) !== live) return
      }
      const target = owner.parentSessionId === undefined
        ? owner.sessionId as SessionId
        : { parentSessionId: owner.parentSessionId as SessionId, childSessionId: owner.sessionId as SessionId, mode }
      const reference = this.sessions.retain(target, { source: 'workbenchReplies' })
      if (this.watching.get(owner.sessionId) !== live) { reference.release(); return }
      live.reference = reference
      const update = (): void => {
        if (this.watching.get(owner.sessionId) !== live) return
        const window = reference.binding.eventSource.getSnapshot()
        if (live.revision === window.revision) return
        const change = window.change
        // eventSource 初始快照是 revision0 的空 replace（MutableSessionEventSource 构造），
        // 不能当真实 baseline：durableSeqs 为空时不冻结 sawBaseline/baselineSeq，否则随后
        // 到来的首张真实历史会被当成「新」行整张叠加。只有窗口真的带进持久事件才锁定水位。
        // 之后 replace/prepend/序号跳变都是重建：baselineSeq 不再抬（prepend 更不能把历史
        // 水位挪到当前 durable 尾部），attempts 清掉按新窗重来，但 rows 里已结算、HTTP 还
        // 没确认的正文要留下——否则会一闪而过整条新回复。
        if (!live.sawBaseline || change.kind === 'replace' || change.kind === 'prepend'
          || live.revision === undefined || window.revision !== live.revision + 1) {
          const durableSeqs = window.entries.filter(entry => entry.type === 'event').map(entry => entry.event.seq)
          const firstBaseline = !live.sawBaseline && durableSeqs.length > 0
          if (firstBaseline) {
            live.baselineSeq = Math.max(...durableSeqs)
            live.sawBaseline = true
          }
          // 重建后仍在窗口里的持久 seq（branded，转成普通 number 存 Set 比对）。
          const durableInWindow = new Set<number>(durableSeqs.map(seq => seq as number))
          live.attempts.clear()
          for (const [key, row] of live.rows) {
            // running 草稿一律由新窗的 transient 重建或自然消失；settled 行只在其
            // seq 仍在新窗（会被重新 accept）或已被 HTTP 确认（present 里按 streamKey 删）时才丢。
            if (row.running === true) { live.rows.delete(key); continue }
            const seq = Number(row.id.slice(row.id.lastIndexOf(':') + 1))
            if (Number.isInteger(seq) && durableInWindow.has(seq)) live.rows.delete(key)
          }
          live.turnSeq = undefined
          // 重建只重放 durable 部分恢复已结算行；窗内 transient 前缀是新 attempt 的
          // 起点，attempts/rows 已按上面规则清好，直接 accept 即可。首张 baseline 内的
          // 持久行 seq≤baselineSeq，accept 的 assistant/message 分支天然跳过不重复叠加。
          for (const entry of window.entries) this.accept(live, entry)
        } else if (change.kind === 'settle-assistant') {
          for (const attempt of live.attempts.values()) {
            if (attempt.attemptId === change.attemptId) {
              live.rows.delete(attempt.key)
              live.attempts.delete(`${attempt.turn}:${attempt.step}`)
              break
            }
          }
          if (change.entry) this.accept(live, change.entry)
        } else {
          for (const entry of change.entries) this.accept(live, entry)
        }
        live.revision = window.revision
        this.changed()
      }
      live.unsubscribe = reference.binding.eventSource.subscribe(update)
      update()
      await reference.ready
      if (this.watching.get(owner.sessionId) !== live) return
      if (reference.binding.session.getSnapshot().openState === 'error') throw new Error('原生回复流暂时不可用')
      update()
    } catch {
      // 订阅失败不阻塞正文：轮询仍保留历史与错误呈现；下一轮 sync 重试原生订阅。
      if (this.watching.get(owner.sessionId) === live) {
        this.watching.delete(owner.sessionId)
        this.release(live)
        this.changed()
      }
    }
  }

  private parentCatalogMode(parentId: SessionId, childId: string): SubagentCatalogEntry['mode'] | undefined {
    const fromList = this.sessions.list.getSnapshot().projectionsBySession[parentId]?.values.subagentCatalog as
      readonly SubagentCatalogEntry[] | undefined
    const found = fromList?.find(entry => entry.id === childId)
    if (found !== undefined) return found.mode
    const fromBinding = this.sessions.binding(parentId)?.session.projections.faceOf('subagentCatalog').getSnapshot() as
      readonly SubagentCatalogEntry[] | undefined
    return fromBinding?.find(entry => entry.id === childId)?.mode
  }

  private accept(live: LiveSession, entry: SessionEventLikeEntry): void {
    const sessionId = live.owner.sessionId
    if (entry.type === 'transient') {
      const { attemptId, turn, step, chunk } = entry.event.data
      const slot = `${turn}:${step}`
      const key = `${sessionId}:${turn}:${step}`
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        let attempt = live.attempts.get(slot)
        if (attempt === undefined || attempt.attemptId !== attemptId) {
          attempt = { key, attemptId, turn, step, parts: new Map(), toolSeen: false, seq: entry.event.seq, time: entry.event.time }
          live.attempts.set(slot, attempt)
        }
        // reasoning-delta 只证明 attempt 活着、不进正文（持久投影也只取 text 块）；
        // 没有 text 增量前不生成 running 行，避免空白气泡顶替「正在输入」骨架。
        if (chunk.type === 'text-delta') {
          attempt.parts.set(chunk.index, (attempt.parts.get(chunk.index) ?? '') + chunk.text)
          attempt.seq = entry.event.seq
          attempt.time = entry.event.time
          const text = joinParts(attempt.parts)
          if (text !== '') {
            const previous = live.rows.get(key)
            live.rows.set(key, this.row(live, key, attempt.time, turn, {
              ...(previous === undefined ? {} : previous),
              running: true,
              text,
              ...(attempt.toolSeen ? { intermediate: true } : {}),
            }))
          }
        }
      } else if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')) {
        const attempt = live.attempts.get(slot)
        if (attempt !== undefined) attempt.toolSeen = true
        const row = live.rows.get(key)
        if (row) live.rows.set(key, { ...row, intermediate: true })
      }
      this.trim(live)
      return
    }
    const event = entry.event
    if (event.type === 'turn/start') {
      live.turnSeq = event.seq
      return
    }
    if (event.type === 'llm/retry') {
      // 原生语义：同 turn/step 的 retry 丢弃该 attempt 已积累增量，从空重来。
      const slot = `${event.data.turn}:${event.data.step}`
      live.attempts.delete(slot)
      live.rows.delete(`${sessionId}:${slot}`)
      return
    }
    if (event.type === 'assistant/message' && event.seq > live.baselineSeq) {
      const slot = `${event.data.turn}:${event.data.step}`
      const key = `${sessionId}:${slot}`
      const texts = event.data.message.content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .filter((text): text is string => text !== '')
      const hasTool = event.data.message.content.some(part => part.type === 'tool-call')
      if (texts.length > 0) {
        // 落盘行用真实 seq 作 id：React key 仍走 streamKey 与草稿同一行，
        // 但 id 变成 regen/复制等操作能识别的持久身份。
        live.rows.set(key, {
          ...this.row(live, key, event.time, event.data.turn, {
            running: false,
            text: texts.join('\n'),
            ...(hasTool ? { intermediate: true } : {}),
          }),
          id: `${sessionId}:${event.seq}`,
        })
      } else {
        live.rows.delete(key)
      }
      // 这一步的增量已结算成持久行，attempt 记录不再需要。
      live.attempts.delete(slot)
      this.trim(live)
      return
    }
    if (event.type === 'assistant/attempt' && event.seq > live.baselineSeq) {
      // 没产出 surface message 的失败 attempt：草稿清掉，不留下半截回复。
      const slot = `${event.data.turn}:${event.data.step}`
      live.attempts.delete(slot)
      live.rows.delete(`${sessionId}:${slot}`)
      return
    }
    if (event.type === 'tool/call' && event.seq > live.baselineSeq) {
      const key = `${sessionId}:${event.data.turn}:${event.data.step}`
      const row = live.rows.get(key)
      if (row) live.rows.set(key, { ...row, intermediate: true })
      return
    }
    if (event.type === 'turn/end') {
      live.turnSeq = undefined
      // turn 关闭瞬间，没结算完的 running 草稿一并撤下（停止/失败/中断不残留）。
      for (const [slot, attempt] of live.attempts) {
        if (attempt.turn === event.data.turn) {
          live.attempts.delete(slot)
          const row = live.rows.get(`${sessionId}:${slot}`)
          if (row?.running === true) live.rows.delete(`${sessionId}:${slot}`)
        }
      }
      for (const [key, row] of live.rows) {
        if (key.startsWith(`${sessionId}:${event.data.turn}:`) && row.running === true) live.rows.delete(key)
      }
    }
  }

  private trim(live: LiveSession): void {
    if (live.rows.size <= MAX_LIVE_ROWS) return
    const excess = live.rows.size - MAX_LIVE_ROWS
    for (const key of [...live.rows.keys()].slice(0, excess)) live.rows.delete(key)
  }

  private row(live: LiveSession, key: string, time: number, _turn: number, patch: Partial<WorkforceMessage>): WorkforceMessage {
    return {
      id: `live:${key}`,
      streamKey: key,
      threadId: live.threadId,
      ts: new Date(time).toISOString(),
      role: 'agent',
      senderId: live.owner.employeeId,
      senderName: '',
      text: '',
      ...(live.turnSeq === undefined ? {} : { turnId: `${live.owner.sessionId}:${live.turnSeq}` }),
      ...patch,
    } as WorkforceMessage
  }

  /**
   * 把 live 行叠到轮询快照上：watching 会话的 running 草稿 + 已 settle 待 HTTP 接手的行，
   * 连同退订后移交 detached 的 settled 行；持久页带回同一 streamKey 时本地份删除，
   * 任何回复只出现一次。
   */
  present(snapshot: WorkforceSnapshot): WorkforceSnapshot {
    if (this.watching.size === 0 && this.detached.size === 0) return snapshot
    let messages: Record<string, WorkforceSnapshot['messages'][string]> | undefined
    const apply = (threadId: string, row: WorkforceMessage, key: string, drop: () => void): void => {
      const page = (messages ?? snapshot.messages)[threadId]
      if (!page) return
      if (page.list.some(item => item.streamKey === key)) { drop(); return }
      const taskId = snapshot.threads.find(thread => thread.id === threadId)?.taskId
      messages ??= { ...snapshot.messages }
      messages[threadId] = {
        ...page,
        list: [...page.list, {
          ...row,
          senderName: snapshot.employees.find(item => item.id === row.senderId)?.name ?? '已删除员工',
          ...(taskId !== undefined && row.taskId === undefined ? { taskId } : {}),
        }].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id)),
      }
    }
    for (const live of this.watching.values()) {
      for (const [key, row] of live.rows) {
        apply(live.threadId, row, key, () => { live.rows.delete(key) })
      }
    }
    for (const [key, { threadId, row }] of this.detached) {
      apply(threadId, row, key, () => { this.detached.delete(key) })
    }
    return messages === undefined ? snapshot : { ...snapshot, messages }
  }
}
