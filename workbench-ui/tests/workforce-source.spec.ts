import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkforceSource, visibleReplyCounts } from '../src/client/workforce-source.ts'
import { WorkforceApi, type HostChannel, type HostChannelGroup } from '../src/client/workforce-api.ts'
import type { Thread, WorkforceMessage } from '../src/client/workforce-types.ts'

const thread: Thread = { id: 'task-thread', kind: 'task', channelId: 'general', title: '写稿', status: 'running', updatedAt: '2026-10-09T00:00:00Z' }
const message: WorkforceMessage = { id: 'call-1', threadId: thread.id, ts: thread.updatedAt, role: 'agent', senderId: 'writer', senderName: '文案员', text: '', tool: { name: 'wb_save_deliverable', status: 'running' } }
const releases: (() => void)[] = []
afterEach(() => { for (const release of releases.splice(0)) release() })
function observe(api: WorkforceApi) {
  const source = new WorkforceSource(api, 60_000)
  releases.push(source.subscribe(() => {}))
  return source
}
function fixture() {
  return {
    employees: vi.fn(async () => []), channels: vi.fn(async () => []),
    channelsWithGroups: vi.fn(async (): Promise<{ channels: HostChannel[]; groups: HostChannelGroup[] }> => ({ channels: [], groups: [] })),
    threads: vi.fn(async () => [thread]), tasks: vi.fn(async () => []),
    models: vi.fn(async () => ({ providers: [{ id: 'fixture', displayName: 'Fixture', kind: 'apikey' as const, configured: true, models: [{ id: 'model' }] }], defaultModel: { provider: 'fixture', model: 'model' } })),
    threadMessages: vi.fn(async () => ({ messages: [message], cursor: '1', thread })),
  }
}

/** Exercise the real HTTP client; fixtures model the host's bounded history and receipts. */
function httpApi(state: Pick<WorkforceApi, 'employees' | 'channelsWithGroups' | 'threads' | 'tasks'>, messages: (url: URL, init?: RequestInit) => unknown | Promise<unknown>): WorkforceApi {
  return new WorkforceApi(async (input, init) => {
    const url = new URL(input, 'http://localhost')
    let data: unknown
    if (url.pathname.endsWith('/messages')) data = await messages(url, init)
    else if (url.pathname.endsWith('/models')) data = await fixture().models()
    else if (url.pathname.endsWith('/employees')) data = { employees: await state.employees() }
    else if (url.pathname.endsWith('/channels')) data = await state.channelsWithGroups()
    else if (url.pathname.endsWith('/threads')) data = { threads: await state.threads() }
    else if (url.pathname.endsWith('/tasks')) data = { tasks: await state.tasks() }
    else throw new Error(`Unexpected request ${url.pathname}`)
    return Response.json({ ok: true, data })
  })
}

describe('数字员工消息轮询', () => {
  it('最新 30 条首屏与更早历史合并，轮询替换工具结果且不丢历史或重开边界', async () => {
    const state = fixture()
    const history = Array.from({ length: 201 }, (_, index): WorkforceMessage => ({
      ...message, id: `call-${index}`, ts: new Date(Date.UTC(2026, 9, 9, 0, 0, index)).toISOString(),
    }))
    const api = httpApi(state, url => {
      const before = url.searchParams.get('before')
      const end = before === null ? history.length : history.findIndex(item => item.id === before)
      const start = Math.max(0, end - Number(url.searchParams.get('limit') ?? 200))
      return { messages: history.slice(start, end), cursor: '201', thread, hasMore: start > 0 }
    })
    const source = observe(api)
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    expect(source.getSnapshot().messages[thread.id]?.list.map(item => item.id)).toEqual(history.slice(171).map(item => item.id))
    await source.loadEarlierMessages(thread.id)
    history[200] = { ...history[200]!, text: '已保存文案.txt', tool: { name: 'wb_save_deliverable', status: 'done' } }
    source.refresh()
    await vi.waitFor(() => expect(source.getSnapshot().messages[thread.id]?.list.at(-1)?.tool?.status).toBe('done'))
    expect(source.getSnapshot().messages[thread.id]?.list.map(item => item.id)).toEqual(history.map(item => item.id))
    expect(source.getSnapshot().messages[thread.id]?.list.at(-1)?.text).toBe('已保存文案.txt')
    expect(source.getSnapshot().messages[thread.id]?.hasMore).toBe(false)
  })

  it('消息页带回 thread.usage 存入消息页状态；加载更早与无 usage 的轮询不清掉已知值', async () => {
    const state = fixture()
    const usage = { inputTokens: 26626, outputTokens: 731 }
    const withUsage: Thread = { ...thread, usage }
    const history = Array.from({ length: 201 }, (_, index): WorkforceMessage => ({
      ...message, id: `call-${index}`, ts: new Date(Date.UTC(2026, 9, 9, 0, 0, index)).toISOString(),
    }))
    let first = true
    const api = httpApi(state, url => {
      const before = url.searchParams.get('before')
      const end = before === null ? history.length : history.findIndex(item => item.id === before)
      const start = Math.max(0, end - Number(url.searchParams.get('limit') ?? 200))
      const pageThread = before === null && first ? (first = false, withUsage) : thread
      return { messages: history.slice(start, end), cursor: '201', thread: pageThread, hasMore: start > 0 }
    })
    const source = observe(api)
    await vi.waitFor(() => expect(source.getSnapshot().messages[thread.id]?.usage).toEqual(usage))
    await source.loadEarlierMessages(thread.id)
    expect(source.getSnapshot().messages[thread.id]?.usage).toEqual(usage)
    source.refresh()
    await vi.waitFor(() => expect(source.getSnapshot().messages[thread.id]?.hasMore).toBe(false))
    expect(source.getSnapshot().messages[thread.id]?.usage).toEqual(usage)
  })

  it('单线程拉取失败保留已有消息并呈现错误，下次成功清除错误', async () => {
    const api = fixture(), source = observe(api as unknown as WorkforceApi)
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    api.threadMessages.mockRejectedValueOnce(new Error('消息连接中断'))
    source.refresh()
    await vi.waitFor(() => expect(source.getSnapshot().messages[thread.id]?.error).toBe('消息连接中断'))
    expect(source.getSnapshot().messages[thread.id]?.list).toEqual([message])
    source.refresh()
    await vi.waitFor(() => expect(source.getSnapshot().messages[thread.id]?.error).toBeUndefined())
    expect(source.getSnapshot().messages[thread.id]?.list).toEqual([message])
  })

  it('工作区轮询失败保留快照和错误，恢复后继续可用', async () => {
    const api = fixture(), source = observe(api as unknown as WorkforceApi)
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    api.threads.mockRejectedValueOnce(new Error('网络断开'))
    source.refresh()
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('error'))
    expect(source.getSnapshot().error).toBe('网络断开')
    expect(source.getSnapshot().messages[thread.id]?.list).toEqual([message])
    source.refresh()
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    expect(source.getSnapshot().error).toBeUndefined()
  })

  it('首屏只加载聚焦频道与 running；tasks 先进入快照，不等慢消息', async () => {
    const channel: Thread = { ...thread, id: 'channel-work', kind: 'channel', channelId: 'work', status: 'idle' }
    const visible: Thread = { ...thread, id: 'visible', channelId: 'work', status: 'idle' }
    const unopened: Thread = { ...thread, id: 'unopened-general', status: 'idle' }
    const dm: Thread = { id: 'unopened-dm', kind: 'dm', title: '未打开私信', updatedAt: thread.updatedAt, status: 'idle' }
    const state = fixture()
    state.threads.mockResolvedValue([channel, visible, unopened, dm, thread])
    const requested: string[] = []
    const { promise: slow, resolve: finish } = Promise.withResolvers<void>()
    const task = { id: 'task-1', threadId: thread.id, channelId: 'general', assigneeId: 'writer', delegatorId: 'leader', title: '写稿', prompt: '写', status: 'running' as const, deliverables: [] }
    const api = httpApi({ ...state, tasks: async () => [task] }, async url => {
      const id = url.pathname.split('/').at(-2)!
      requested.push(id)
      await slow
      return { messages: [{ ...message, id: `reply-${id}`, threadId: id, text: id }], cursor: '1', thread: [channel, visible, thread].find(item => item.id === id)! }
    })
    const source = new WorkforceSource(api, 60_000)
    source.setFocusedThread('work')
    releases.push(source.subscribe(() => {}))
    await vi.waitFor(() => expect(source.getSnapshot().tasks.map(item => item.id)).toEqual(['task-1']))
    expect(source.getSnapshot().messages[unopened.id]).toBeUndefined()
    await vi.waitFor(() => expect(requested.sort()).toEqual([channel.id, visible.id, thread.id].sort()))
    finish()
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    expect(source.getSnapshot().messages[visible.id]?.list[0]?.text).toBe(visible.id)
    expect(source.getSnapshot().messages[dm.id]).toBeUndefined()
  })

  it('已加载的非聚焦消息不反复刷新；元数据变更与新线程只刷新一次并合并回复', async () => {
    const channel: Thread = { ...thread, id: 'channel-work', kind: 'channel', channelId: 'work', status: 'idle' }
    const visible: Thread = { ...thread, id: 'visible', channelId: 'work', status: 'idle' }
    const unseen: Thread = { id: 'unseen', kind: 'dm', title: '未打开私信', updatedAt: thread.updatedAt, status: 'idle' }
    let threads = [channel, visible, unseen]
    const state = { ...fixture(), threads: async () => threads }
    const reads: string[] = []
    const source = new WorkforceSource(httpApi(state, url => {
      const id = url.pathname.split('/').at(-2)!
      reads.push(id)
      const current = threads.find(item => item.id === id)!
      return { messages: [{ ...message, id: `reply-${current.updatedAt}`, threadId: id, text: current.updatedAt }], thread: current, cursor: '1' }
    }), 60_000)
    source.setFocusedThread('work')
    releases.push(source.subscribe(() => {}))
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    reads.length = 0
    source.refresh()
    await vi.waitFor(() => expect(reads).toEqual([channel.id]))
    const changed = { ...visible, updatedAt: '2026-10-10T00:00:00Z' }
    const arrived = { ...unseen, id: 'arrived' }
    threads = [channel, changed, unseen, arrived]
    reads.length = 0
    source.refresh()
    await vi.waitFor(() => expect(source.getSnapshot().messages[visible.id]?.list.map(item => item.text)).toEqual([visible.updatedAt, changed.updatedAt]))
    expect(reads.sort()).toEqual([channel.id, visible.id, arrived.id].sort())
    expect(source.getSnapshot().messages[unseen.id]).toBeUndefined()
    reads.length = 0
    source.refresh()
    await vi.waitFor(() => expect(reads).toEqual([channel.id]))
  })

  it('切换聚焦立即加载未打开私信并刷新缓存，切回保留完整历史', async () => {
    const first: Thread = { id: 'first', kind: 'dm', title: '私信', updatedAt: thread.updatedAt, status: 'idle' }
    const second: Thread = { ...first, id: 'second' }
    const state = { ...fixture(), threads: async () => [first, second] }
    let revision = 1
    const reads: string[] = []
    const source = new WorkforceSource(httpApi(state, url => {
      const id = url.pathname.split('/').at(-2)!
      reads.push(id)
      return { messages: [{ ...message, id: `reply-${revision}`, threadId: id, text: `${id}-${revision}` }], thread: id === first.id ? first : second, cursor: `${revision}` }
    }), 60_000)
    source.setFocusedThread(first.id)
    releases.push(source.subscribe(() => {}))
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    expect(source.getSnapshot().messages[second.id]).toBeUndefined()
    source.setFocusedThread(second.id)
    await vi.waitFor(() => expect(source.getSnapshot().messages[second.id]?.list[0]?.text).toBe('second-1'))
    revision = 2
    source.setFocusedThread(first.id)
    await vi.waitFor(() => expect(source.getSnapshot().messages[first.id]?.list.map(item => item.text)).toEqual(['first-1', 'first-2']))
    expect(reads).toEqual([first.id, second.id, first.id])
  })

  it('后台元数据变化拉取失败保留旧回复，下轮重试且稳定后停止刷新', async () => {
    const idle: Thread = { ...thread, status: 'idle' }
    let current = idle
    let fail = false
    const reads: string[] = []
    const source = observe(httpApi({ ...fixture(), threads: async () => [current] }, () => {
      reads.push(current.updatedAt)
      if (fail) throw new Error('临时断开')
      return { messages: [{ ...message, text: current.updatedAt }], thread: current, cursor: '1' }
    }))
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    expect(reads).toEqual([])
    current = { ...idle, updatedAt: '2026-10-10T00:00:00Z' }
    fail = true
    source.refresh()
    await vi.waitFor(() => expect(source.getSnapshot().messages[idle.id]?.error).toBe('临时断开'))
    fail = false
    source.refresh()
    await vi.waitFor(() => expect(source.getSnapshot().messages[idle.id]?.list[0]?.text).toBe(current.updatedAt))
    source.refresh()
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    expect(reads).toEqual([current.updatedAt, current.updatedAt])
  })

  it('聚焦和轮询复用在途页；写操作前启动的页不能提前摘除 waiting', async () => {
    const idle: Thread = { ...thread, status: 'idle' }
    const state = fixture()
    state.threads.mockResolvedValue([idle])
    const page = { messages: [{ ...message, tool: undefined, text: '旧回复' }], thread: idle, cursor: '1', activity: [{ employeeId: 'writer', state: 'thinking' as const }] }
    const { promise: slow, resolve: finish } = Promise.withResolvers<typeof page>()
    const threadMessages = vi.fn(async () => page)
    threadMessages.mockImplementationOnce(() => slow)
    const api = { ...state, threadMessages, answerAsk: vi.fn(async () => ({ answered: true })) }
    const source = observe(api as unknown as WorkforceApi)
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    source.setFocusedThread(idle.id)
    await source.answerAsk(idle.id, 'ask-1', { answers: [] }, 'writer')
    await vi.waitFor(() => expect(api.threads).toHaveBeenCalledTimes(2))
    expect(threadMessages).toHaveBeenCalledTimes(1)
    finish(page)
    await vi.waitFor(() => expect(source.getSnapshot().messages[idle.id]?.list[0]?.text).toBe('旧回复'))
    expect(source.getPendingReplies().map(({ threadId, employeeId }) => ({ threadId, employeeId }))).toEqual([{ threadId: idle.id, employeeId: 'writer' }])
    source.refresh()
    await vi.waitFor(() => expect(source.getPendingReplies()).toEqual([]))
    expect(threadMessages).toHaveBeenCalledTimes(2)
  })
})

describe('发送乐观上屏', () => {
  const assigned = () => ({
    ...fixture(),
    tasks: vi.fn(async () => [{
      id: 'task-1', threadId: thread.id, channelId: 'general', assigneeId: 'leader', delegatorId: 'leader',
      title: '写稿', prompt: '写', status: 'running', deliverables: [], createdAt: '2026-10-09', updatedAt: '2026-10-09',
    }]),
    sendMessage: vi.fn(),
  })
  const sent = (id: string): { message: WorkforceMessage; thread: Thread } => ({
    message: { id, threadId: thread.id, ts: '2026-10-09T00:00:01Z', role: 'user', senderId: 'human', senderName: '你', text: '你好' },
    thread,
  })
  const list = (source: WorkforceSource) => source.getSnapshot().messages[thread.id]?.list ?? []

  it('发送中立即可见；确认与轮询合并不重复，收到回复后清除等待态', async () => {
    const api = assigned()
    const source = observe(api as unknown as WorkforceApi)
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    // send 成功后会自带一轮轮询：下一轮消息页带回服务端确认行与员工回复
    api.threadMessages.mockResolvedValue({ messages: [
      { id: 'srv-1', threadId: thread.id, ts: '2026-10-09T00:00:01Z', role: 'user', senderId: 'human', senderName: '你', text: '你好' },
      { id: 'a-1', threadId: thread.id, ts: '2026-10-09T00:00:03Z', role: 'agent', senderId: 'leader', senderName: '负责人', text: '收到' },
    ], cursor: '2', thread })
    let resolveSend!: (value: ReturnType<typeof sent>) => void
    api.sendMessage.mockImplementationOnce(() => new Promise(resolve => { resolveSend = resolve }))
    const sending = source.send(thread.id, '你好')
    // HTTP 未完成前乐观行已上屏
    await vi.waitFor(() => expect(list(source).some(item => item.id.startsWith('local:') && item.delivery === 'sending')).toBe(true))
    resolveSend(sent('srv-1'))
    await sending
    await vi.waitFor(() => expect(list(source).some(item => item.id === 'a-1')).toBe(true))
    // 服务端确认行与员工回复合并后：'你好' 只有一条，且等待态已清除
    expect(list(source).filter(item => item.text === '你好')).toHaveLength(1)
    const confirmed = list(source).find(item => item.text === '你好')!
    expect(confirmed.id).toBe('srv-1')
    expect(confirmed.delivery).toBeUndefined()
  })

  it('发送失败留失败态并可重试；相同文本的发送走重试不重复行', async () => {
    const api = assigned()
    const source = observe(api as unknown as WorkforceApi)
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    api.sendMessage.mockRejectedValueOnce(new Error('模型不可用'))
    await expect(source.send(thread.id, '你好')).rejects.toThrow('模型不可用')
    const failed = list(source).find(item => item.delivery === 'failed')!
    expect(failed.deliveryError).toBe('模型不可用')
    // 相同文本+目标再发送 = 重试同一请求
    api.sendMessage.mockResolvedValueOnce(sent('srv-2'))
    await source.send(thread.id, '你好')
    expect(api.sendMessage).toHaveBeenCalledTimes(2)
    expect(list(source).filter(item => item.text === '你好')).toHaveLength(1)
    expect(list(source)[list(source).length - 1]?.id).toBe('srv-2')
  })
})

describe('多收件人与频道聚焦', () => {
  it('多收件人丢回执后重试只交付原消息；新发送独立，DM 只等待本员工', async () => {
    const state = fixture()
    const records: WorkforceMessage[] = []
    const receipts = new Map<string, WorkforceMessage>()
    const dm: Thread = { id: 'dm-1', kind: 'dm', employeeId: 'writer', title: '文案员', status: 'idle', updatedAt: '2026-10-09' }
    let loseReply = true
    const source = observe(httpApi(state, (url, init) => {
      const id = decodeURIComponent(url.pathname.split('/').at(-2)!)
      const currentThread = id === dm.id ? dm : thread
      if (init?.method !== 'POST') return { messages: records.filter(item => item.threadId === id), cursor: String(records.length), thread: currentThread, hasMore: false }
      const body = JSON.parse(String(init.body)) as { text: string; requestId?: string }
      let delivered = body.requestId === undefined ? undefined : receipts.get(body.requestId)
      if (!delivered) {
        delivered = { id: `srv-${records.length + 1}`, threadId: id, ts: new Date().toISOString(), role: 'user', senderId: 'human', senderName: '你', text: body.text }
        records.push(delivered)
        if (body.requestId !== undefined) receipts.set(body.requestId, delivered)
      }
      if (loseReply) { loseReply = false; throw new Error('回执连接中断') }
      return { message: delivered, thread: currentThread }
    }))
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    await expect(source.send(thread.id, '@a @b 一起', ['analyst', 'writer', 'analyst'])).rejects.toThrow('回执连接中断')
    const failed = source.getSnapshot().messages[thread.id]?.list.find(item => item.delivery === 'failed')!
    expect(failed.recipientIds).toEqual(['analyst', 'writer'])
    await source.retryMessage(failed.clientId!)
    expect(records.map(item => item.id)).toEqual(['srv-1'])
    expect(source.getSnapshot().messages[thread.id]?.list.filter(item => item.role === 'user').map(item => item.id)).toEqual(['srv-1'])
    expect(source.getSnapshot().messages[thread.id]?.list.find(item => item.id === 'srv-1')?.recipientIds).toEqual(['analyst', 'writer'])
    await source.send(thread.id, '第二条独立发送', ['writer'])
    expect(records.map(item => item.text)).toEqual(['@a @b 一起', '第二条独立发送'])
    state.threads.mockResolvedValue([thread, dm])
    await vi.waitFor(() => { source.refresh(); expect(source.getSnapshot().threads.some(item => item.id === dm.id)).toBe(true) })
    await source.send(dm.id, '@分析员 催稿', ['analyst'])
    expect(source.getSnapshot().messages[dm.id]?.list.find(item => item.id === 'srv-3')?.recipientIds).toEqual(['writer'])
  })

  it('聚焦频道刷新最新消息并可加载历史；其他线程不混入频道，分组以宿主为准', async () => {
    const state = fixture()
    const chan: Thread = { id: 'channel-general', kind: 'channel', channelId: 'general', title: '任务大厅', status: 'idle', updatedAt: '2026-10-09' }
    state.threads.mockResolvedValue([chan, thread])
    state.channelsWithGroups.mockResolvedValue({ channels: [], groups: [{ id: 'g1', name: '项目', sort: 0, createdAt: '2026-10-09' }] })
    let history: WorkforceMessage[] = []
    const source = observe(httpApi(state, url => {
      const id = decodeURIComponent(url.pathname.split('/').at(-2)!)
      const before = url.searchParams.get('before')
      const end = before === null ? history.length : history.findIndex(item => item.id === before)
      const start = Math.max(0, end - Number(url.searchParams.get('limit') ?? 200))
      return { messages: id === chan.id ? history.slice(start, end) : [], cursor: String(history.length), thread: id === chan.id ? chan : thread, hasMore: id === chan.id && start > 0 }
    }))
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    expect(source.getChannelGroups()).toEqual([{ id: 'g1', name: '项目', sort: 0, createdAt: '2026-10-09' }])
    history = Array.from({ length: 201 }, (_, index) => ({ ...message, id: `channel-${index}`, threadId: chan.id, ts: new Date(Date.UTC(2026, 9, 9, 0, 0, index)).toISOString() }))
    source.setFocusedThread('general')
    await vi.waitFor(() => expect(source.getSnapshot().messages[chan.id]?.list.map(item => item.id)).toEqual(history.slice(171).map(item => item.id)))
    await source.loadEarlierMessages(chan.id)
    expect(source.getSnapshot().messages[chan.id]?.list.map(item => item.id)).toEqual(history.map(item => item.id))
    expect(source.getSnapshot().messages[thread.id]?.list).toEqual([])
  })
})

describe('回复计数', () => {
  it('count 归属 replyTo 父用户行：工具、过程文字、系统行与用户消息不计；无锚/跨线程锚不计，streamKey 去重', () => {
    const base = { ts: 't', senderId: 'a', senderName: 'a' }
    const counts = visibleReplyCounts([
      { ...base, id: '1', threadId: 't', role: 'user', text: '派任务' },
      { ...base, id: '2', threadId: 't', role: 'agent', text: '收到', replyTo: '1' },
      { ...base, id: '3', threadId: 't', role: 'agent', text: '', tool: { name: 'wb_x', status: 'done' }, replyTo: '1' },
      { ...base, id: '4', threadId: 't', role: 'agent', text: '过程说明', intermediate: true, replyTo: '1' },
      { ...base, id: '5', threadId: 't', role: 'system', text: '执行停止', replyTo: '1' },
      { ...base, id: '6', threadId: 't', role: 'agent', text: '完成汇总', replyTo: '1' },
      // 无 replyTo 的可见回复不进计数（新口径只认 @你 引用，不按线程总数）
      { ...base, id: '7', threadId: 't', role: 'agent', text: '无锚回复' },
      // 锚是别的线程的用户行：跨线程引用不计数
      { ...base, id: '8', threadId: 't2', role: 'agent', text: '别的线程', replyTo: '1' },
      // 同 streamKey（流式草稿与落盘正文）只计一次
      { ...base, id: '9', threadId: 't', role: 'agent', text: '去重甲', replyTo: '1', streamKey: 's1' },
      { ...base, id: '10', threadId: 't', role: 'agent', text: '去重乙', replyTo: '1', streamKey: 's1' },
    ])
    expect(counts.get('1')).toBe(3)
    expect(counts.size).toBe(1)
  })
})
