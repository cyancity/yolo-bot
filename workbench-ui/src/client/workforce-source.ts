/**
 * WorkforceSource：数字员工工作区的单一可观察 store。轮询 threads/tasks 元数据；
 * 消息只加载当前视图，刷新聚焦、运行中或元数据变化的线程。
 * 只在订阅时轮询（ref-count 模式）；send/cancel 等写操作
 * 走 API 后立即 refresh 对应面。UI（sidebar 频道列表 + 主区 + thread 面板）
 * 共享这一个实例。
 */
import type { QuestionCardAnswer } from './workforce-question-card.tsx'
import { WorkbenchApiError } from './transport.ts'
import type { HostChannel, HostChannelGroup, WorkforceApi } from './workforce-api.ts'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { WorkforceModelsSource } from './workforce-models-source.ts'
import { WorkforceLiveReplies } from './workforce-live.ts'
import type { UploadedAttachment } from './workforce-upload.ts'
import type { McpServer, McpServerInput, SendResult, SkillSummary, Task, Thread, ThreadMessages, ThreadStatus, WorkforceActivity, WorkforceMessage, WorkforceSession, WorkforceSkillDraft, WorkforceSnapshot, WorkforceTemplate, WorkforceUserSkill, Employee } from './workforce-types.ts'

const EMPTY_MESSAGES: ThreadMessages = { list: [], cursor: undefined, status: 'idle' }

/** 首屏只取最新一页，更早历史由上滑分页按需补；窗口内渲染成本与首屏绑定。 */
const INITIAL_PAGE_LIMIT = 30

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface OutgoingMessage {
  readonly clientId: string
  readonly requestId: string
  readonly originThreadId: string
  readonly text: string
  readonly employeeIds: readonly string[] | undefined
  readonly recipientIds: readonly string[]
  createdAt: string
  messageId?: string
  state: 'sending' | 'waiting' | 'failed'
}

/** Local continuation waiting for an employee's activity or a new reply. */
export interface PendingReply {
  readonly threadId: string
  readonly employeeId: string
}

interface WaitingReply extends PendingReply {
  readonly baseline: readonly WorkforceMessage[]
  afterPoll: number
}

export class WorkforceSource {
  private current: WorkforceSnapshot = {
    phase: 'loading',
    employees: [],
    channels: [],
    threads: [],
    messages: {},
    tasks: [],
    error: undefined,
  }
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private pulling = false
  private outgoing = new Map<string, OutgoingMessage>()
   private waitingReplies: WaitingReply[] = []
   private pollVersion = 0
  private focusedThreadId: string | undefined = undefined
  private taskPulling = false
  private channelGroups: readonly HostChannelGroup[] = []
  private observedThreads = new Map<string, Thread>()
  private dirtyThreads = new Set<string>()
  private messagePulls = new Map<string, Promise<readonly [string, ThreadMessages, readonly WorkforceSession[] | undefined]>>()
  private messagePolls = new Map<string, number>()
  private readonly liveReplies: WorkforceLiveReplies | undefined
  /** 最近一次向订阅者发布的「poll 快照 + live 叠加」缓存，保证 getSnapshot 引用稳定。 */
  private presented: WorkforceSnapshot | undefined
  /** threadId → 该线程在用的原生会话（含子会话父地址），由消息页带回驱动订阅。 */
  private threadSessions = new Map<string, readonly WorkforceSession[]>()

  getChannelGroups = (): readonly HostChannelGroup[] => this.channelGroups

  /** 频道视图传频道 id；线程列表未到时由首轮元数据解析聚焦目标。 */
  private resolveThreadId(id: string): string | undefined {
    if (this.current.threads.some(item => item.id === id)) return id
    return this.current.threads.find(item => item.kind === 'channel' && item.channelId === id)?.id
  }

  setFocusedThread(threadId: string | undefined): void {
    if (this.focusedThreadId === threadId) return
    this.focusedThreadId = threadId
    const resolved = threadId === undefined ? undefined : this.resolveThreadId(threadId)
    if (resolved) {
      const visible = this.visibleThreads(this.current.threads, resolved)
      const fastIds = fastStreamIds(visible, resolved)
      // 打开只拉聚焦线程 + 频道内最新正文 task；其余线程滑动到顶再按需加载（见 ensureThreadLoaded）。
      const targets = visible.filter(thread => thread.id === resolved || (fastIds.has(thread.id) && this.current.messages[thread.id] === undefined))
      if (targets.length > 0) void this.pullFocusedThreads(targets, fastIds)
    }
    this.syncLive()
  }

  /** 主区合并同频道 task 消息；DM 不加载其他私信，打开 thread 仍保留其频道上下文。 */
  private visibleThreads(threads: readonly Thread[], focusedId: string | undefined): readonly Thread[] {
    const focused = threads.find(thread => thread.id === focusedId)
    return threads.filter(thread => thread.id === focusedId
      || (focused?.channelId !== undefined && thread.kind === 'task' && thread.channelId === focused.channelId))
  }

  /** 两段拉取：请求全部并行发出；能立刻给出正文尾部的线程（聚焦线程 + 频道内最新 task）先到先发，
   *  其余线程随后台补齐。下界在此之后只会上抬，增补都发生在已见尾部上方——装载期不换血，也不整批等最慢线程。 */
  private async pullFocusedThreads(targets: readonly Thread[], fastIds: ReadonlySet<string>): Promise<void> {
    const known = targets.filter(thread => this.current.threads.some(item => item.id === thread.id))
    if (known.length === 0) return
    const poll = ++this.pollVersion
    const fast: Promise<readonly [string, ThreadMessages, readonly WorkforceSession[] | undefined]>[] = []
    const rest: typeof fast = []
    for (const thread of known) {
      ;(fastIds.has(thread.id) ? fast : rest).push(this.fetchThreadEntry(thread, this.current.messages, poll))
    }
    const batches = fast.length > 0 ? [fast, rest] : [rest]
    try {
      for (const batch of batches) {
        if (batch.length === 0) continue
        this.reconcileEntries(await Promise.all(batch), poll)
        if (this.current.phase === 'ready') {
          this.publish({ ...this.current, messages: this.current.messages })
        }
      }
    } catch {
      // 局部批量拉取失败不影响全局快照
    }
  }

  /** 每次向历史方向推进一页；最新页轮询不改变历史边界。 */
  async loadEarlierMessages(threadId: string): Promise<boolean> {
    const before = this.current.messages[threadId]
    if (before === undefined) return this.ensureThreadLoaded(threadId)
    const oldest = before.list.find(message => !message.id.startsWith('local:') && !message.id.startsWith('live:'))
    if (!before?.hasMore || before.loadingEarlier || !oldest) return false
    this.publish({ ...this.current, messages: { ...this.current.messages, [threadId]: { ...before, loadingEarlier: true, earlierError: undefined } } })
    try {
      const page = await this.api.threadMessages(threadId, { limit: 200, before: oldest.id })
      const latest = this.current.messages[threadId]
      if (!latest) return false
      const list = mergeMessages(page.messages, latest.list)
      this.publish({ ...this.current, messages: { ...this.current.messages, [threadId]: { ...latest, list, hasMore: page.hasMore, loadingEarlier: false, earlierError: undefined, usage: page.thread.usage ?? latest.usage } } })
      return list.length > latest.list.length
    } catch (error) {
      const latest = this.current.messages[threadId]
      if (latest) {
        const invalidCursor = error instanceof WorkbenchApiError && error.code === 'bad_request' && error.message === '消息游标无效'
        this.publish({ ...this.current, messages: { ...this.current.messages, [threadId]: {
          ...latest, loadingEarlier: false,
          ...(invalidCursor ? { hasMore: false, earlierError: undefined } : { earlierError: messageOf(error) }),
        } } })
      }
      return false
    }
  }

  /** 按需加载单个线程首屏页：线程面板打开、引用跳转、频道滑动窗口向下扩都走这里；已有完好的页返回 false，错误页重拉。 */
  async ensureThreadLoaded(threadId: string): Promise<boolean> {
    const existing = this.current.messages[threadId]
    if (existing !== undefined && existing.error === undefined) return false
    const thread = this.current.threads.find(item => item.id === threadId)
    if (!thread) return false
    const poll = ++this.pollVersion
    try {
      const entry = await this.fetchThreadEntry(thread, this.current.messages, poll)
      this.reconcileEntries([entry], poll)
      this.publish({ ...this.current, messages: this.current.messages })
      return true
    } catch {
      return false
    }
  }

  private async pullTasks(): Promise<readonly Task[]> {
    if (this.taskPulling) return this.current.tasks
    this.taskPulling = true
    try {
      const tasks = await this.api.tasks()
      // tasks 的首屏可用性不依赖消息页是否完成。
      this.publish({ ...this.current, tasks })
      return tasks
    } catch {
      return this.current.tasks
    } finally {
      this.taskPulling = false
    }
  }

  private fetchThreadEntry(
    thread: Thread,
    previousMessages: Readonly<Record<string, ThreadMessages>>,
    poll: number,
  ): Promise<readonly [string, ThreadMessages, readonly WorkforceSession[] | undefined]> {
    const pending = this.messagePulls.get(thread.id)
    if (pending) return pending
    const operation = this.readThreadEntry(thread, previousMessages, poll).finally(() => {
      this.messagePulls.delete(thread.id)
    })
    this.messagePulls.set(thread.id, operation)
    return operation
  }

  private async readThreadEntry(
    thread: Thread,
    previousMessages: Readonly<Record<string, ThreadMessages>>,
    poll: number,
  ): Promise<readonly [string, ThreadMessages, readonly WorkforceSession[] | undefined]> {
    const before = previousMessages[thread.id] ?? EMPTY_MESSAGES
    try {
      const page = await this.api.threadMessages(thread.id, { limit: INITIAL_PAGE_LIMIT })
      const { error: _error, ...latest } = this.current.messages[thread.id] ?? before
      const incoming = page.messages.map(message => {
        if (message.role !== 'user') return message
        for (const request of this.outgoing.values()) {
          const origin = this.current.threads.find(item => item.id === request.originThreadId)
          const sameThread = request.originThreadId === thread.id
            || (origin?.kind === 'channel' && thread.kind === 'task' && origin.channelId === thread.channelId)
          if (request.messageId === message.id
            || (request.messageId === undefined && sameThread && message.text === request.text && message.ts >= request.createdAt)) {
            request.messageId = message.id
            if (request.state === 'sending') request.state = 'waiting'
            return { ...message, clientId: request.clientId, recipientIds: request.recipientIds, delivery: request.state }
          }
        }
        return message
      })
      const merged = mergeMessages(latest.list, incoming).filter(message => !(
        message.id.startsWith('local:')
        && message.clientId !== undefined
        && this.outgoing.get(message.clientId)?.messageId !== undefined
      )).map(message => {
        if (message.delivery !== 'waiting') return message
        // 多 @ 时每位收件人有各自的回复/activity，全部有动静才摘掉 waiting。
        const recipients = message.recipientIds ?? []
        const started = page.thread.status === 'error' || page.thread.status === 'cancelled'
          || recipients.every(id => page.activity?.some(activity => activity.employeeId === id) === true
            || mergedReply(incoming, message, id)
            || mergedReply(latest.list, message, id))
        if (!started) return message
        if (message.clientId) this.outgoing.delete(message.clientId)
        return { ...message, delivery: undefined }
      })
      const entry: ThreadMessages = {
        ...latest,
        list: merged,
        cursor: page.cursor === '' ? before.cursor : page.cursor,
        status: page.thread.status,
        hasMore: latest.list.some(message => !message.id.startsWith('local:')) ? latest.hasMore ?? page.hasMore : page.hasMore,
        usage: page.thread.usage ?? latest.usage,
        ...(page.activity !== undefined ? { activity: page.activity } : {}),
        // 线程级文件历史随消息页全程带回；宿主缺省时不覆盖既有值。
        ...(page.files !== undefined ? { files: page.files } : {}),
      }
      this.messagePolls.set(thread.id, poll)
      const observed = this.observedThreads.get(thread.id)
      if (observed === undefined || (observed.updatedAt === thread.updatedAt && observed.status === thread.status)) this.dirtyThreads.delete(thread.id)
      return [thread.id, entry, page.sessions] as const
    } catch (error) {
      return [thread.id, { ...(this.current.messages[thread.id] ?? before), status: thread.status, error: messageOf(error) }, undefined] as const
    }
  }

  private reconcileEntries(
    entries: readonly (readonly [string, ThreadMessages, readonly WorkforceSession[] | undefined])[],
    poll: number,
  ): void {
    const sessionsChanged = entries.some(([, , sessions]) => sessions !== undefined)
    for (const [id, , sessions] of entries) {
      if (sessions !== undefined) this.threadSessions.set(id, sessions)
    }
    const messages = { ...this.current.messages, ...Object.fromEntries(entries.map(([id, page]) => [id, page])) }
    const acknowledged = new Set<string>()
    for (const page of Object.values(messages)) {
      for (const message of page.list) if (!message.id.startsWith('local:') && message.clientId) acknowledged.add(message.clientId)
    }
    for (const [id, page] of Object.entries(messages)) {
      const list = mergeMessages(this.current.messages[id]?.list ?? [], page.list)
        // live 桥叠加的草稿行进过 reconcile 会被带回来；轮询重放时它们应由 live 层重算，不落进持久页。
        .filter(message => !message.id.startsWith('live:')).filter(message => !(
        message.id.startsWith('local:') && message.clientId !== undefined
        && (this.outgoing.get(message.clientId)?.messageId !== undefined || acknowledged.has(message.clientId))
      ))
      const latest = this.current.messages[id]
      messages[id] = { ...page, list, hasMore: latest?.list.some(message => !message.id.startsWith('local:')) ? latest.hasMore ?? page.hasMore : page.hasMore, usage: page.usage ?? latest?.usage, loadingEarlier: latest?.loadingEarlier, earlierError: latest?.earlierError }
    }
    if (this.waitingReplies.length > 0) {
      this.waitingReplies = this.waitingReplies.filter(pending => {
        // 单飞复用的旧请求不能以新 poll 编号确认写操作后的续答。
        if (poll <= pending.afterPoll || (this.messagePolls.get(pending.threadId) ?? 0) <= pending.afterPoll) return true
        const page = messages[pending.threadId]
        if (!page || page.error) return true
        if (page.status === 'error' || page.status === 'cancelled') return false
        if (page.activity?.some(activity => activity.employeeId === pending.employeeId)) return false
        return !page.list.some(message => {
          if (message.role !== 'agent' || message.senderId !== pending.employeeId || message.tool !== undefined
            || message.intermediate === true || message.question !== undefined || message.approval !== undefined || message.text.trim() === '') return false
          const before = pending.baseline.find(item => item.id === message.id)
          return before === undefined || before.text !== message.text
        })
      })
    }
    this.current = { ...this.current, messages }
    if (sessionsChanged) this.syncLive()
  }
  readonly models: WorkforceModelsSource
  constructor(
    private readonly api: WorkforceApi,
    private readonly intervalMs = 2000,
    models?: WorkforceModelsSource,
    sessions?: ISessions,
  ) {
    this.models = models ?? new WorkforceModelsSource(api)
    if (sessions !== undefined) this.liveReplies = new WorkforceLiveReplies(sessions, () => { this.republishLive() })
  }

  /** 频道成员名单（与宿主 channelMembers 同口径）：undefined = 未配置全员；[] = 明确配置但全部失效。 */
  private channelMembers(channelId: string | undefined): readonly Employee[] | undefined {
    if (channelId === undefined) return undefined
    const memberIds = (this.current.channels.find(channel => channel.id === channelId) as HostChannel | undefined)?.memberIds
    return memberIds === undefined ? undefined : memberIds
      .map(id => this.current.employees.find(employee => employee.id === id))
      .filter((employee): employee is Employee => employee !== undefined)
  }

  /** 与宿主自动频道路由一致：无 @ 时优先当前运行任务的负责人；频道无任务时落到
   *  群内默认收件人（成员内负责人→首个成员；未配置成员=全局负责人），不回落群外。 */
  private recipients(threadId: string, employeeIds: readonly string[] = []): readonly string[] {
    const thread = this.current.threads.find(item => item.id === threadId)
    if (thread?.kind === 'dm') return thread.employeeId ? [thread.employeeId] : employeeIds
    if (employeeIds.length > 0) return [...new Set(employeeIds)]
    const active = thread?.kind === 'channel' ? this.current.threads
      .filter(item => item.kind === 'task' && item.channelId === thread.channelId && item.status === 'running'
        && !this.current.tasks.some(task => task.threadId === item.id && task.status !== 'running'))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] : undefined
    const task = this.current.tasks.find(item => item.threadId === (active?.id ?? threadId))
    const members = this.channelMembers(thread?.channelId ?? task?.channelId)
    if (members !== undefined && members.length === 0) throw new Error('该群聊成员已全部失效，请重新配置群聊成员')
    const owner = task?.assigneeId ?? (members === undefined
      ? this.current.employees.find(employee => employee.isLeader)?.id
      : (members.find(employee => employee.isLeader) ?? members[0])?.id)
    return owner ? [owner] : []
  }

  private async requireRecipients(employeeIds: readonly string[]): Promise<void> {
    await this.models.require(employeeIds.length > 0
      ? employeeIds.map(id => this.current.employees.find(employee => employee.id === id)) : [undefined])
  }

  /** 订阅者读到的快照：轮询态 + 已缓存的 live 叠加。引用稳定，useSyncExternalStore 不会无限刷新。 */
  getSnapshot = (): WorkforceSnapshot => {
    if (this.liveReplies === undefined) return this.current
    this.presented ??= this.liveReplies.present(this.current)
    return this.presented
  }

  /** live 层通知有草稿变化时：重新叠加当前快照并广播（不触发新的轮询）。 */
  private republishLive(): void {
    if (this.liveReplies === undefined) return
    const before = this.presented ?? this.current
    this.presented = this.liveReplies.present(this.current)
    // 草稿从有到无也要通知：settle/失败/abandonment 撤行不能让旧草稿残留。
    if (this.presented === before) return
    for (const listener of this.listeners) listener()
  }

  /**
   * 只订当前聚焦线程里仍在动的会话：频道根 + 其 running/等待中的 task，或 DM 本身。
   * 已结束的历史 task 不开引用（cold retain 会抢占 writer）；没有 UI 监听者不开 stream。
   */
  private syncLive(): void {
    if (this.liveReplies === undefined || this.listeners.size === 0) return
    const focusedId = this.focusedThreadId === undefined ? undefined
      : this.resolveThreadId(this.focusedThreadId)
    const pendingThreads = new Set(this.waitingReplies.map(reply => reply.threadId))
    for (const request of this.outgoing.values()) {
      if (request.state === 'waiting') pendingThreads.add(request.originThreadId)
    }
    const wanted = new Map<string, WorkforceSession[]>()
    for (const thread of this.visibleThreads(this.current.threads, focusedId)) {
      if (thread.status !== 'running' && !pendingThreads.has(thread.id)) continue
      const sessions = this.threadSessions.get(thread.id)
      if (sessions !== undefined && sessions.length > 0) wanted.set(thread.id, [...sessions])
    }
    this.liveReplies.sync(wanted)
    // 撤掉的订阅可能刚丢掉 running 草稿；重新叠加让过期行立刻消失。
    this.republishLive()
  }

  /** 本地等待续答，不伪装成宿主 activity；与 snapshot 一起通知订阅者。 */
  getPendingReplies(): readonly PendingReply[] {
    // live 草稿已有真实非空正文的员工不再算「等待中」：流式回复本身就是续答。
    const live = this.presented ?? this.current
    return this.waitingReplies.filter(pending => !(
      live.messages[pending.threadId]?.list.some(message =>
        message.role === 'agent' && message.senderId === pending.employeeId
        && message.running === true && message.text.trim() !== '')
    ))
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.timer === undefined) {
      void this.pull()
      this.timer = setInterval(() => { void this.pull() }, this.intervalMs)
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        if (this.timer !== undefined) {
          clearInterval(this.timer)
          this.timer = undefined
        }
        // 组件全部卸载时收掉原生订阅与过期草稿，presented 缓存一并失效。
        this.liveReplies?.clear()
        this.presented = undefined
      }
    }
  }

  refresh(): void {
    void this.pull()
  }

  private publish(next: WorkforceSnapshot): void {
    if (this.current === next) return
    this.current = next
    // 轮询快照变了，presented 叠加缓存必须重算，不能沿用旧 live 草稿。
    this.presented = undefined
    // thread.status / waitingReplies / outgoing.waiting 都经 publish 落地：metadata
    // 变化要立即重算订阅边界（新 running 才开订、变 idle 就退订），不能等下一次聚焦。
    this.syncLive()
    for (const listener of this.listeners) listener()
  }

  /** 立即广播当前快照（写操作就地更新 channels/groups 后调用，不等下一轮轮询）。 */
  private notify(): void {
    // 各写操作直接替换 this.current 后走这里；必须先丢 presented 缓存，
    // 否则 getSnapshot 仍返回叠着旧 live/旧轮询态的对象。
    this.presented = undefined
    // 写操作同样可能改 waiting/状态面，与 publish 同口径同步订阅边界。
    this.syncLive()
    for (const listener of this.listeners) listener()
  }

  /** Overlapping polls fold into one. */
  private async pull(): Promise<void> {
    if (this.pulling) return
    this.pulling = true
    try {
      await this.fetchOnce()
    } finally {
      this.pulling = false
    }
  }

  private async fetchOnce(): Promise<void> {
    const previous = this.current
    const poll = ++this.pollVersion
    try {
      // 1. 后台非阻塞拉取 tasks（不等慢速 tasks 拖住当前主会话）
      void this.pullTasks()

      // 2. 快速拉取 employees/channels/threads 元数据（纯 JSON 读，约 10ms）
      const [employees, channelPack, threads] = await Promise.all([
        this.api.employees(),
        this.api.channelsWithGroups(),
        this.api.threads(),
      ])
      const channels = channelPack.channels
      this.channelGroups = channelPack.groups

      // 首次只加载当前频道所需消息；缓存的非聚焦线程不再每轮拉取。
      // 频道打开是真滑动窗口：只拉能给出尾部正文的线程（fastStreamIds），其余 task 线程
      // 等读者滚到顶/打开面板/引用跳转再按需加载（ensureThreadLoaded），不整频道预热。
      const focusedId = this.focusedThreadId === undefined ? undefined
        : (threads.find(thread => thread.id === this.focusedThreadId)
          ?? threads.find(thread => thread.kind === 'channel' && thread.channelId === this.focusedThreadId))?.id
      const visible = this.visibleThreads(threads, focusedId)
      const fastIds = focusedId === undefined ? new Set<string>() : fastStreamIds(visible, focusedId)
      const observedBefore = this.observedThreads.size > 0
      for (const thread of threads) {
        const before = this.observedThreads.get(thread.id)
        if (observedBefore && (before === undefined || before.updatedAt !== thread.updatedAt || before.status !== thread.status)) {
          this.dirtyThreads.add(thread.id)
        }
      }
      this.observedThreads = new Map(threads.map(thread => [thread.id, thread]))
      const pendingIds = new Set(this.waitingReplies.map(reply => reply.threadId))
      for (const request of this.outgoing.values()) {
        if (request.state === 'waiting') pendingIds.add(request.originThreadId)
      }
      const refreshThreads = threads.filter(thread => thread.id === focusedId || thread.status === 'running'
        || this.dirtyThreads.has(thread.id) || pendingIds.has(thread.id)
        || (fastIds.has(thread.id) && this.current.messages[thread.id] === undefined))

      // 先合入轻量元数据：未读/运行中/新线程不等待历史消息。
      const serverIds = new Set(threads.map(thread => thread.id))
      const previousIds = new Set(previous.threads.map(thread => thread.id))
      const retainedThreads = this.current.threads.filter(thread => !serverIds.has(thread.id) && !previousIds.has(thread.id))
      const resolvedThreads = retainedThreads.length ? [...threads, ...retainedThreads] : threads

      this.publish({
        phase: previous.phase === 'ready' ? 'ready' : 'loading',
        employees,
        channels,
        threads: resolvedThreads,
        messages: this.current.messages,
        tasks: this.current.tasks,
        error: undefined,
      })

      // 两段发布：请求并行发出，先等聚焦面正文尾部（见 fastStreamIds）即转 ready 出内容，
      // 其余线程后台补齐再发一次；与 pullFocusedThreads 同口径，装载期不换血也不整批等最慢线程。
      const fast: Promise<readonly [string, ThreadMessages, readonly WorkforceSession[] | undefined]>[] = []
      const rest: typeof fast = []
      for (const thread of refreshThreads) {
        ;(fastIds.has(thread.id) ? fast : rest).push(this.fetchThreadEntry(thread, previous.messages, poll))
      }
      if (fast.length > 0) {
        this.reconcileEntries(await Promise.all(fast), poll)
      }
      this.publish({ ...this.current, phase: 'ready', error: undefined })
      if (rest.length > 0) {
        this.reconcileEntries(await Promise.all(rest), poll)
        this.publish({ ...this.current })
      }
    } catch (error) {
      this.publish({ ...this.current, phase: 'error', error: messageOf(error) })
    }
  }

  // ------------------------------------------------------------------ writes

  /** 门禁通过才发布乐观消息；HTTP 确认及轮询用 clientId 保持同一行。 */
  async send(threadId: string, text: string, employeeIds?: readonly string[]): Promise<void> {
    const mentioned = [...new Set(employeeIds ?? [])]
    const recipientIds = this.recipients(threadId, mentioned)
    for (const request of this.outgoing.values()) {
      if (request.state === 'failed' && request.originThreadId === threadId
        && request.text === text && request.recipientIds.join() === recipientIds.join()) return this.retryMessage(request.clientId)
    }
    await this.requireRecipients(recipientIds)
    const requestId = crypto.randomUUID()
    const clientId = `local:${requestId}`
    const request: OutgoingMessage = {
      clientId, requestId, originThreadId: threadId, text, employeeIds: mentioned, recipientIds,
      createdAt: new Date().toISOString(), state: 'sending',
    }
    this.outgoing.set(clientId, request)
    this.putOutgoing(request, {
      id: clientId, clientId, threadId, ts: request.createdAt, role: 'user',
      senderId: 'human', senderName: '你', text, delivery: 'sending', recipientIds,
    })
    await this.transmit(request)
  }

  async retryMessage(clientId: string): Promise<void> {
    const request = this.outgoing.get(clientId)
    if (!request || request.state !== 'failed') return
    try {
      await this.requireRecipients(request.recipientIds)
    } catch (error) {
      const message = Object.values(this.current.messages).flatMap(page => page.list).find(item => item.clientId === clientId)
      if (message) this.putOutgoing(request, { ...message, deliveryError: messageOf(error) })
      throw error
    }
    if (request.state !== 'failed') return
    request.state = 'sending'
    request.createdAt = new Date().toISOString()
    delete request.messageId
    const message = Object.values(this.current.messages).flatMap(page => page.list).find(item => item.clientId === clientId)
    if (message) this.putOutgoing(request, { ...message, ts: request.createdAt, delivery: 'sending', deliveryError: undefined })
    await this.transmit(request)
  }

  private async transmit(request: OutgoingMessage): Promise<void> {
    try {
      const result: SendResult = await this.api.sendMessage(request.originThreadId, request.text, request.employeeIds, request.requestId)
      request.messageId = result.message.id
      request.state = 'waiting'
      const page = this.current.messages[result.thread.id] ?? EMPTY_MESSAGES
      const message = { ...result.message, clientId: request.clientId, recipientIds: request.recipientIds }
      const started = !this.outgoing.has(request.clientId)
        || request.recipientIds.every(id => page.activity?.some(activity => activity.employeeId === id) === true || mergedReply(page.list, message, id))
      if (started) this.outgoing.delete(request.clientId)
      this.putOutgoing(request, { ...message, delivery: started ? undefined : 'waiting' }, result.thread)
      this.refresh()
    } catch (error) {
      request.state = 'failed'
      this.outgoing.set(request.clientId, request)
      const message = Object.values(this.current.messages).flatMap(page => page.list).find(item => item.clientId === request.clientId)
      if (message) this.putOutgoing(request, { ...message, delivery: 'failed', deliveryError: messageOf(error) })
      throw error
    }
  }

  private putOutgoing(request: OutgoingMessage, message: WorkforceMessage, thread?: Thread): void {
    const messages = { ...this.current.messages }
    for (const [id, page] of Object.entries(messages)) {
      if (page.list.some(item => item.clientId === request.clientId || item.id === message.id)) {
        messages[id] = { ...page, list: page.list.filter(item => item.clientId !== request.clientId && item.id !== message.id) }
      }
    }
    const page = messages[message.threadId] ?? EMPTY_MESSAGES
    messages[message.threadId] = { ...page, list: mergeMessages(page.list, [message]), status: thread?.status ?? page.status, usage: thread?.usage ?? page.usage }
    const threads = thread
      ? [...this.current.threads.filter(item => item.id !== thread.id), thread]
      : this.current.threads
    this.publish({ ...this.current, messages, threads })
  }

  /** 保留文本材料 API，返回 material id 供消息引用。 */
  async uploadMaterial(name: string, content: string): Promise<{ id: string; name: string; url: string }> {
    const { material } = await this.api.uploadMaterial(name, content)
    return material
  }

  uploadFile(file: File): Promise<UploadedAttachment> {
    return this.api.uploadFile(file)
  }

  private waitForReply(threadId: string, employeeId: string): WaitingReply {
    const pending: WaitingReply = {
      threadId, employeeId, baseline: this.current.messages[threadId]?.list ?? [],
      // A poll begun before the write completed cannot acknowledge its continuation.
      afterPoll: Infinity,
    }
    this.waitingReplies = [...this.waitingReplies.filter(item => item.threadId !== threadId || item.employeeId !== employeeId), pending]
    this.publish({ ...this.current })
    return pending
  }

  private discardPendingReply(pending: WaitingReply): void {
    this.waitingReplies = this.waitingReplies.filter(item => item !== pending)
    this.publish({ ...this.current })
  }

  async regenerateMessage(threadId: string, messageId: string, employeeId: string): Promise<void> {
    await this.requireRecipients([employeeId])
    const pending = this.waitForReply(threadId, employeeId)
    try {
      const result = await this.api.regenerateMessage(threadId, messageId)
      pending.afterPoll = this.pollVersion
      const page = this.current.messages[result.thread.id] ?? EMPTY_MESSAGES
      this.publish({
        ...this.current,
        messages: { ...this.current.messages, [result.thread.id]: { ...page, list: mergeMessages(page.list, [result.message]), status: result.thread.status, usage: result.thread.usage ?? page.usage } },
        threads: [...this.current.threads.filter(thread => thread.id !== result.thread.id), result.thread],
      })
      this.refresh()
    } catch (error) {
      this.discardPendingReply(pending)
      throw error
    }
  }

  async answerAsk(threadId: string, requestId: string, payload: { answers?: QuestionCardAnswer[]; outcome?: 'allowed-once' | 'rejected' }, employeeId: string): Promise<void> {
    await this.requireRecipients([employeeId])
    const pending = this.waitForReply(threadId, employeeId)
    try {
      await this.api.answerAsk(threadId, requestId, payload)
      pending.afterPoll = this.pollVersion
      this.refresh()
    } catch (error) {
      this.discardPendingReply(pending)
      throw error
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.api.cancelTask(taskId)
    this.refresh()
  }

  async ensureDm(employeeId: string): Promise<Thread> {
    const { thread } = await this.api.ensureDm(employeeId)
    this.refresh()
    return thread
  }

  async createEmployee(input: Parameters<WorkforceApi['createEmployee']>[0]): Promise<void> {
    await this.api.createEmployee(input)
    this.refresh()
  }

  async updateEmployee(id: string, patch: Parameters<WorkforceApi['updateEmployee']>[1]): Promise<void> {
    await this.api.updateEmployee(id, patch)
    this.refresh()
  }

  async deleteEmployee(id: string): Promise<void> {
    await this.api.deleteEmployee(id)
    this.refresh()
  }

  // ------------------------------------------------------- skills / MCP / templates

  private skillsCache: Promise<SkillSummary[]> | undefined

  /** Slash-menu catalog; cached for the session, a failure retries next call. */
  listSkills(): Promise<SkillSummary[]> {
    return this.skillsCache ??= this.api.skills().catch(() => {
      this.skillsCache = undefined
      return [] as SkillSummary[]
    })
  }

  mcpServers(): Promise<McpServer[]> {
    return this.api.mcpServers()
  }

  async saveMcpServer(input: McpServerInput, id?: string): Promise<McpServer> {
    const { server } = id === undefined ? await this.api.createMcpServer(input) : await this.api.updateMcpServer(id, input)
    this.refresh()
    return server
  }

  async patchMcpServer(id: string, patch: Partial<McpServerInput>): Promise<void> {
    await this.api.updateMcpServer(id, patch)
    this.refresh()
  }

  async deleteMcpServer(id: string): Promise<void> {
    await this.api.deleteMcpServer(id)
    this.refresh()
  }

  templates(): Promise<WorkforceTemplate[]> {
    return this.api.templates()
  }

  async patchTemplate(id: string, enabled: boolean): Promise<void> {
    await this.api.patchTemplate(id, enabled)
    this.skillsCache = undefined
  }

  async applyTemplate(id: string): Promise<{ created: string[]; skipped: string[] }> {
    const result = await this.api.applyTemplate(id)
    this.refresh()
    return result
  }

  // ------------------------------------------------------------ skill drafts 

  private userSkillsCache: Promise<WorkforceUserSkill[]> | undefined

  /** 草稿列表不轮询：审核框打开时按需拉取。 */
  skillDrafts(): Promise<WorkforceSkillDraft[]> {
    return this.api.skillDrafts()
  }

  /** 任务结束后的「沉淀为技能」：宿主建草稿并请负责人在该任务线程整理。 */
  async requestSkillDraft(taskId: string, note?: string): Promise<WorkforceSkillDraft> {
    const task = this.current.tasks.find(item => item.id === taskId)
    if (!task) throw new Error('来源任务尚未加载，请刷新后重试。')
    await this.requireRecipients(this.recipients(task.threadId))
    const draft = await this.api.requestSkillDraft(taskId, note)
    this.refresh()
    return draft
  }

  updateSkillDraft(id: string, patch: { slug?: string; title?: string; description?: string; body?: string }): Promise<WorkforceSkillDraft> {
    return this.api.updateSkillDraft(id, patch)
  }

  async returnSkillDraft(id: string, note: string): Promise<WorkforceSkillDraft> {
    const existing = (await this.api.skillDrafts()).find(item => item.id === id)
    const task = this.current.tasks.find(item => item.id === existing?.taskId)
    if (!task) throw new Error('草稿来源任务尚未加载，请刷新后重试。')
    await this.requireRecipients(this.recipients(task.threadId))
    const draft = await this.api.returnSkillDraft(id, note)
    this.refresh()
    return draft
  }

  deleteSkillDraft(id: string): Promise<{ deleted: boolean }> {
    return this.api.deleteSkillDraft(id)
  }

  /** 安装/禁用用户技能后调用：清两级 skill 缓存（下次调用重拉目录）。 */
  invalidateSkillCaches(): void {
    this.skillsCache = undefined
    this.userSkillsCache = undefined
  }

  /** 安装后技能目录与员工绑定都变了：清两级 skill 缓存并刷新员工快照。 */
  async installSkillDraft(id: string, employeeIds: readonly string[]): Promise<{ draft: WorkforceSkillDraft; path: string }> {
    const result = await this.api.installSkillDraft(id, employeeIds)
    this.invalidateSkillCaches()
    this.refresh()
    return result
  }

  /** 停用已安装的用户技能：成功后清两级 skill 缓存并刷新员工快照（宿主同步解绑）。 */
  async disableUserSkill(name: string): Promise<{ name: string; movedTo?: string }> {
    const result = await this.api.disableUserSkill(name)
    this.invalidateSkillCaches()
    this.refresh()
    return result
  }

  /** 员工技能选择器的用户根合并项；失败下个调用重试。 */
  userSkills(): Promise<WorkforceUserSkill[]> {
    return this.userSkillsCache ??= this.api.userSkills().catch(() => {
      this.userSkillsCache = undefined
      return [] as WorkforceUserSkill[]
    })
  }

  // ------------------------------------------------------------------ channels & profile

  async createChannel(name: string, groupId?: string | null, extra?: { groupName?: string | undefined; groupChatName?: string | undefined; memberIds?: readonly string[] | undefined }): Promise<HostChannel> {
    const res = await this.api.createChannel({ name, groupId: groupId ?? undefined, groupName: extra?.groupName, groupChatName: extra?.groupChatName, memberIds: extra?.memberIds === undefined ? undefined : [...extra.memberIds] })
    const existing = this.current.channels.filter(c => c.id !== res.channel.id)
    this.current = { ...this.current, channels: [...existing, res.channel] }
    this.notify()
    this.refresh()
    return res.channel
  }

  async renameChannel(id: string, name: string): Promise<HostChannel> {
    // 分组视图显示名是 groupName ?? name：重命名既写正名也清掉可空覆盖，否则界面仍显示旧覆盖名。
    const res = await this.api.patchChannel(id, { name, groupName: null })
    this.current = {
      ...this.current,
      channels: this.current.channels.map(c => (c.id === id ? { ...res.channel, unread: (c as HostChannel).unread } : c)),
    }
    this.notify()
    this.refresh()
    return res.channel
  }

  async patchChannel(id: string, patch: { projectDirectory?: string | null | undefined; name?: string | undefined; groupId?: string | null | undefined; sort?: number | undefined; pinned?: boolean | undefined; groupName?: string | null | undefined; groupChatName?: string | null | undefined; memberIds?: readonly string[] | null | undefined }): Promise<HostChannel> {
    const res = await this.api.patchChannel(id, patch)
    // 以返回的完整 channel 为准：清空字段在响应里是缺省而非保留，unread 是列表投影字段本地补回。
    this.current = {
      ...this.current,
      channels: this.current.channels.map(c => (c.id === id ? { ...res.channel, unread: (c as HostChannel).unread } : c)),
    }
    this.notify()
    this.refresh()
    return res.channel
  }

  async markChannelRead(id: string): Promise<HostChannel> {
    const res = await this.api.markChannelRead(id)
    this.current = {
      ...this.current,
      channels: this.current.channels.map(c => (c.id === id ? { ...res.channel, unread: false } : c)),
    }
    this.notify()
    this.refresh()
    return res.channel
  }

  async deleteChannel(id: string): Promise<void> {
    await this.api.deleteChannel(id)
    this.current = {
      ...this.current,
      channels: this.current.channels.filter(c => c.id !== id),
    }
    this.notify()
    this.refresh()
  }

  async duplicateChannel(id: string): Promise<HostChannel> {
    const res = await this.api.duplicateChannel(id)
    const existing = this.current.channels.filter(c => c.id !== res.channel.id)
    this.current = { ...this.current, channels: [...existing, res.channel] }
    this.notify()
    this.refresh()
    return res.channel
  }

  async createChannelGroup(name: string, sort?: number): Promise<HostChannelGroup> {
    const res = await this.api.createChannelGroup({ name, sort })
    const existing = this.channelGroups.filter(g => g.id !== res.group.id)
    this.channelGroups = [...existing, res.group]
    this.notify()
    this.refresh()
    return res.group
  }

  async patchChannelGroup(id: string, patch: { name?: string | undefined; sort?: number | undefined }): Promise<HostChannelGroup> {
    const res = await this.api.patchChannelGroup(id, patch)
    this.channelGroups = this.channelGroups.map(g => (g.id === id ? { ...g, ...res.group } : g))
    this.notify()
    this.refresh()
    return res.group
  }

  async deleteChannelGroup(id: string): Promise<void> {
    await this.api.deleteChannelGroup(id)
    this.channelGroups = this.channelGroups.filter(g => g.id !== id)
    this.notify()
    this.refresh()
  }

  async patchThread(id: string, patch: { pinned?: boolean | undefined; markRead?: boolean | undefined }): Promise<Thread> {
    const res = await this.api.patchThread(id, patch)
    // 同 channel 口径：取消置顶/read 后响应省略字段，不能靠展开残留旧值。
    this.current = {
      ...this.current,
      threads: this.current.threads.map(t => (t.id === id ? { ...res.thread, ...(patch.markRead === true ? { unread: false } : (t as { unread?: boolean }).unread === undefined ? {} : { unread: (t as { unread?: boolean }).unread }) } : t)),
    }
    this.notify()
    this.refresh()
    return res.thread
  }

  async getProfile(): Promise<{ name: string; avatarUrl?: string | undefined }> {
    const res = await this.api.userProfile()
    return res.profile
  }

  async saveProfile(patch: { name?: string | undefined; avatarUrl?: string | null | undefined }): Promise<void> {
    await this.api.saveUserProfile(patch)
  }

  async uploadMaterialFile(file: File): Promise<UploadedAttachment> {
    return this.api.uploadFile(file)
  }
}

/** 按 ts 再按 id 稳定排序（Host 消息无 seq，id 稳定）。 */
function byTime(a: WorkforceMessage, b: WorkforceMessage): number {
  return a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id)
}

/** 等值合并不换引用：逐字段比对，对象/数组字段按内容等价，全等才沿用旧对象，
 *  让 memo 行在内容不变的轮询里跳过重渲染。 */
function mergeMessage(prev: WorkforceMessage, next: WorkforceMessage): WorkforceMessage {
  const merged = { ...prev, ...next } as WorkforceMessage
  for (const key of Object.keys(merged) as (keyof WorkforceMessage)[]) {
    const before = prev[key]
    const after = merged[key]
    if (before === after) continue
    if (typeof before === 'object' && typeof after === 'object' && before !== null && after !== null
      && JSON.stringify(before) === JSON.stringify(after)) continue
    return merged
  }
  return prev
}

/** 合并去重（同 id 幂等），保持 ts 顺序。 */
function mergeMessages(existing: readonly WorkforceMessage[], incoming: readonly WorkforceMessage[]): WorkforceMessage[] {
  if (incoming.length === 0) return [...existing]
  const byId = new Map(existing.map(m => [m.id, m]))
  for (const message of incoming) {
    const prev = byId.get(message.id)
    byId.set(message.id, prev === undefined ? message : mergeMessage(prev, message))
  }
  return [...byId.values()].sort(byTime)
}

/** 两段发布的首段线程集合：聚焦线程本身 + 其频道内最新正文的 task（按元数据即可判定，不必等消息页）。 */
function fastStreamIds(visible: readonly Thread[], resolvedId: string): ReadonlySet<string> {
  const newest = visible
    .filter(thread => thread.kind === 'task')
    .sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt))[0]
  return new Set([resolvedId, ...(newest !== undefined && newest.id !== resolvedId ? [newest.id] : [])])
}

/** 一个频道主区的合并消息流：该频道全部 task thread 的消息按 ts 排序。 */
/**
 * 频道流 = 频道下各 task thread 已加载消息按时间合并。每个 thread 只拉了最新一页，
 * 还有更早页的 thread 在自己最旧一条之前是空的；直接合并会把老任务的尾巴和新任务
 * 交错成有洞的时间线。所以只展示「连续下界」之后的消息：下界 = 仍有更早页的 task
 * thread 中最旧已加载消息的最晚时间；`earlierThreads` 是卡住下界、应先补页的 thread。
 */
export function channelStream(snapshot: WorkforceSnapshot, channelId: string): { messages: readonly WorkforceMessage[]; threads: readonly Thread[]; earlierThreads: readonly Thread[] } {
  const threads = snapshot.threads
    .filter(thread => thread.channelId === channelId && (thread.kind === 'task'
      || (thread.kind === 'channel' && snapshot.messages[thread.id]?.list.some(message => message.delivery !== undefined))))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  const oldest = new Map<string, string>()
  for (const thread of threads) {
    const page = snapshot.messages[thread.id]
    if (thread.kind !== 'task' || page?.hasMore !== true) continue
    const first = page.list.find(message => !message.id.startsWith('local:') && !message.id.startsWith('live:'))
    if (first !== undefined) oldest.set(thread.id, first.ts)
  }
  const floor = [...oldest.values()].reduce<string | undefined>((max, ts) => max === undefined || ts > max ? ts : max, undefined)
  const messages = threads
    .flatMap(thread => (snapshot.messages[thread.id]?.list ?? [])
      .filter(message => thread.kind !== 'channel' || message.delivery !== undefined)
      .map(message => ({ ...message, threadId: message.threadId ?? thread.id })))
    .filter(message => floor === undefined || message.ts >= floor)
    .sort(byTime)
  const earlierThreads = threads.filter(thread => floor !== undefined && oldest.get(thread.id) === floor)
  return { messages, threads, earlierThreads }
}

/** thread 的消息与状态（未拉到时给空页）。 */
export function threadView(snapshot: WorkforceSnapshot, threadId: string): ThreadMessages {
  return snapshot.messages[threadId] ?? EMPTY_MESSAGES
}

/** thread 的关联任务。 */
export function threadTask(snapshot: WorkforceSnapshot, threadId: string) {
  return snapshot.tasks.find(task => task.threadId === threadId)
}

/** 频道内所有正在工作的员工活动（汇集该频道所有 task thread 的 activity）。 */
export function channelActivities(snapshot: WorkforceSnapshot, channelId: string): readonly WorkforceActivity[] {
  const threads = snapshot.threads.filter(thread => thread.channelId === channelId)
  return threads.flatMap(thread => snapshot.messages[thread.id]?.activity ?? [])
}

export type { ThreadStatus }

/**
 * 按「明确回复了哪条人类消息」计回复数，键是那条父人类消息的 id：只认带 replyTo
 * 且父消息确为同线程 user 行的员工正文。工具步骤、过程文字、提问/审批卡、系统行
 * 不计入；无关联的保守不计，不用同发送者或最近用户消息推断。同一父的多条回复
 * 各算一次；草稿与落盘行共用 streamKey，重复的不重复计数。
 */
export function visibleReplyCounts(messages: readonly WorkforceMessage[]): ReadonlyMap<string, number> {
  const humans = new Map(messages.filter(message => message.role === 'user').map(message => [message.id, message.threadId]))
  const counted = new Set<string>()
  const counts = new Map<string, number>()
  for (const message of messages) {
    if (message.role !== 'agent' || message.replyTo === undefined) continue
    if (message.tool !== undefined || message.intermediate === true || message.tip === true) continue
    if (message.question !== undefined || message.approval !== undefined || message.text.trim() === '') continue
    if (humans.get(message.replyTo) !== message.threadId) continue
    const key = message.streamKey ?? message.id
    if (counted.has(key)) continue
    counted.add(key)
    counts.set(message.replyTo, (counts.get(message.replyTo) ?? 0) + 1)
  }
  return counts
}

/** 组卡摘要用：把 Markdown 正文压成一行纯文本，尽量保留可读信息。 */
export function replyExcerpt(text: string, limit = 160): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [image] ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat === '') return ''
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** 组卡成员字数：只算可见字符，不把代码块算成几百字。 */
export function replyCharCount(text: string): number {
  return text.replace(/\s/g, '').length
}

export interface ReplyGroupMember {
  readonly message: WorkforceMessage
  readonly employeeId: string
  /** 该成员这条回复是否仍在生成/执行（组内状态点与「执行中 N/M」用）。 */
  readonly running: boolean
}

/** 同一句人类消息的多条员工回复（频道 @所有人 时每人各回一条）。 */
export interface ReplyGroup {
  readonly parentId: string
  readonly members: readonly ReplyGroupMember[]
  readonly running: number
  /** 父消息是所在 thread 最新一条人类消息：这一轮还在进行，未开口的收件人以占位成员留在组里。 */
  readonly live: boolean
}

/** 一轮回复达到这么多位员工才合成组卡；两位及以下保持普通气泡。 */
export const REPLY_GROUP_MIN_MEMBERS = 3

/** 人类消息正文是否 @所有人 / @everyone（与输入框展开收件人的口径一致）。 */
export function mentionsEveryone(text: string): boolean {
  return /@(?:所有人|everyone)(?=$|[\s,，。;；:：!！?？()（）])/i.test(text)
}

export interface ReplyGroupOptions {
  /** 员工 id 顺序，组内成员按它排列。 */
  readonly order?: readonly string[] | undefined
  /** 员工显示名，用于未开口收件人的占位成员。 */
  readonly names?: ReadonlyMap<string, string> | undefined
  /** 这一轮的收件人；发出时就已确定，达到人数门槛即从一开始成组。 */
  readonly recipients?: ((parent: WorkforceMessage) => readonly string[] | undefined) | undefined
}

/**
 * 按 replyTo 聚合「同一句人类消息的多条员工回复」：只收可见员工正文
 * （无工具、非过程文字、非提问/审批；空正文只收仍在生成的草稿）。
 * 已结束的员工正文仍然只按 replyTo 归组；没有 replyTo 的 running === true 员工正文
 * 归到同一 thread 里 ts 不晚于它的最近一条人类消息。父消息须是同 thread 的人类行。
 * 收件人或实际开口的员工合计 ≥ REPLY_GROUP_MIN_MEMBERS 位才成组；收件人已知时发出即成组，
 * 本轮未开口的收件人补成占位成员，避免先出一排各自的气泡再收敛成组卡。
 */
export function replyGroups(messages: readonly WorkforceMessage[], options: ReplyGroupOptions = {}): ReadonlyMap<string, ReplyGroup> {
  const humans = new Map<string, WorkforceMessage>()
  const humansByThread = new Map<string, WorkforceMessage[]>()
  for (const message of messages) {
    if (message.role === 'user') {
      humans.set(message.id, message)
      const list = humansByThread.get(message.threadId)
      if (list === undefined) humansByThread.set(message.threadId, [message])
      else list.push(message)
    }
  }
  for (const list of humansByThread.values()) {
    list.sort((a, b) => a.ts.localeCompare(b.ts))
  }
  const grouped = new Map<string, WorkforceMessage[]>()
  const seen = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'agent') continue
    if (message.tool !== undefined || message.intermediate === true || message.tip === true) continue
    if (message.question !== undefined || message.approval !== undefined) continue
    if (message.text.trim() === '' && message.running !== true) continue
    if (isLeaderNoReplyDraft(message)) continue

    let parentId: string | undefined = undefined
    if (message.replyTo !== undefined) {
      const parent = humans.get(message.replyTo)
      if (parent !== undefined && parent.threadId === message.threadId) {
        parentId = parent.id
      }
    } else if (message.running === true) {
      const list = humansByThread.get(message.threadId) ?? []
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]!.ts <= message.ts) {
          parentId = list[i]!.id
          break
        }
      }
    }

    if (parentId === undefined) continue

    const key = message.streamKey ?? message.id
    if (seen.has(key)) continue
    seen.add(key)
    const bucket = grouped.get(parentId)
    if (bucket === undefined) grouped.set(parentId, [message])
    else bucket.push(message)
  }
  const orderMap = options.order !== undefined && options.order.length > 0
    ? new Map(options.order.map((id, index) => [id, index]))
    : undefined
  const result = new Map<string, ReplyGroup>()
  for (const parent of humans.values()) {
    const bucket = grouped.get(parent.id) ?? []
    const recipients = options.recipients?.(parent) ?? []
    const speakers = new Set([...bucket.map(message => message.senderId), ...recipients])
    if (speakers.size < REPLY_GROUP_MIN_MEMBERS) continue
    const thread = humansByThread.get(parent.threadId) ?? []
    const live = thread[thread.length - 1]?.id === parent.id
    const replied = new Set(bucket.map(message => message.senderId))
    // 这一轮谁要回复在发出时就确定了：未开口的收件人先以占位成员进组，开口后由真实正文替换。
    const placeholders: WorkforceMessage[] = live
      ? [...new Set(recipients)].filter(id => !replied.has(id)).map(id => ({
        id: `pending:${parent.id}:${id}`,
        threadId: parent.threadId,
        ts: parent.ts,
        role: 'agent',
        senderId: id,
        senderName: options.names?.get(id) ?? id,
        text: '',
        running: true,
        replyTo: parent.id,
      }))
      : []
    const members = [...bucket, ...placeholders].sort((a, b) => {
      if (orderMap !== undefined) {
        const idxA = orderMap.get(a.senderId) ?? Number.MAX_SAFE_INTEGER
        const idxB = orderMap.get(b.senderId) ?? Number.MAX_SAFE_INTEGER
        if (idxA !== idxB) return idxA - idxB
        const senderCmp = a.senderId.localeCompare(b.senderId)
        if (senderCmp !== 0) return senderCmp
      }
      return a.ts.localeCompare(b.ts)
    }).map(message => ({
      message,
      employeeId: message.senderId,
      running: message.running === true || message.delivery === 'sending',
    }))
    result.set(parent.id, { parentId: parent.id, members, running: members.filter(member => member.running).length, live })
  }
  return result
}

function mergedReply(messages: readonly WorkforceMessage[], user: WorkforceMessage, employeeId: string): boolean {
  return messages.some(message => message.role === 'agent' && message.senderId === employeeId
    && message.ts >= user.ts && (message.text.trim() !== '' || message.tool !== undefined))
}

/** 负责人核对员工结果后无需补充时的约定输出（与 host LEADER_NO_REPLY 一致）。 */
export const LEADER_NO_REPLY = '[无需补充]'

/** 负责人约定的「无需补充」标记或其流式前缀：不作为聊天气泡展示。 */
export function isLeaderNoReplyDraft(message: WorkforceMessage): boolean {
  const text = message.text.trim()
  if (text === LEADER_NO_REPLY) return true
  return message.running === true && text !== '' && LEADER_NO_REPLY.startsWith(text)
}
