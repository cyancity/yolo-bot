// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
// lib/client.js 是 dsh __ModuleLoader__ 打包产物，node 下不可执行；测试直接
// 消费真实 src 实现（tests/vendor/ 内的上游单文件副本），事件窗口语义与宿主运行完全一致。
import { MutableSessionEventSource } from './vendor/session-events.ts'
import type { ISessions, SessionReference, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkforceSource, visibleReplyCounts } from '../src/client/workforce-source.ts'
import type { WorkforceApi, HostChannel, HostChannelGroup } from '../src/client/workforce-api.ts'
import type { Employee, Thread, WorkforceFile, WorkforceMessage, WorkforceSession } from '../src/client/workforce-types.ts'

/**
 * 原生回复增量桥验收：用真实 MutableSessionEventSource 驱动 WorkforceLiveReplies
 * 的订阅路径（replace/append/settleAssistant 的同步 notify 即真实 dsh 语义），
 * ISessions 只留 retain/list/refresh 窄口，不 mock 流式内容本身。
 */

const writer: Employee = {
  id: 'writer', name: '文案员', title: '写作', persona: '', skills: [], isLeader: false,
}
const leader: Employee = {
  id: 'leader', name: '负责人', title: '派发', persona: '', skills: [], isLeader: true,
}

const dmThread: Thread = {
  id: 'dm-writer', kind: 'dm', title: '私信', employeeId: 'writer',
  status: 'running', updatedAt: '2026-10-11T00:00:00Z',
}
const channelThread: Thread = {
  id: 'channel-work', kind: 'channel', channelId: 'work', title: '工作',
  status: 'idle', updatedAt: '2026-10-11T00:00:00Z',
}
const taskThread: Thread = {
  id: 'task-1', kind: 'task', channelId: 'work', taskId: 'task-1', title: '写稿',
  status: 'running', updatedAt: '2026-10-11T00:00:01Z',
}

const SESSION_A = 'session-a' as SessionId
const SESSION_B = 'session-b' as SessionId

function dmSessions(): WorkforceSession[] {
  return [{ sessionId: SESSION_A, employeeId: 'writer' }]
}
function taskSessions(): WorkforceSession[] {
  return [
    { sessionId: SESSION_A, employeeId: 'leader' },
    { sessionId: SESSION_B, employeeId: 'writer', parentSessionId: SESSION_A },
  ]
}

interface FakeBinding {
  readonly eventSource: MutableSessionEventSource
  readonly reference: SessionReference
}

/**
 * Narrow ISessions：retain 为每个 target 建真实 eventSource；
 * list.getSnapshot().byId 含全部已知普通会话（不含子会话，子会话走
 * refreshProjections → projectionsBySession[parent].values.subagentCatalog）。
 */
function fakeSessions(options?: {
  catalog?: readonly { id: string; mode: 'one-shot' | 'continuable' | 'unknown' }[]
  /** 在桥订阅前装饰真实 eventSource（如临时 batch 包装），模拟传输层漏一次通知。 */
  decorateEventSource?: (eventSource: MutableSessionEventSource) => void
}) {
  const bindings = new Map<string, FakeBinding>()
  const retained: SessionId[] = []
  const released: SessionId[] = []
  const byId: Record<string, unknown> = { [SESSION_A]: {}, [SESSION_B]: {} }
  const projectionsBySession: Record<string, { values: { subagentCatalog?: unknown } }> = {
    [SESSION_A]: { values: { subagentCatalog: options?.catalog ?? [{ id: SESSION_B, mode: 'continuable' }] } },
  }
  const sessions = {
    list: { getSnapshot: () => ({ ids: Object.keys(byId), byId, phase: 'ready', projectionsBySession }) },
    searchResultLimit: 20,
    refresh: vi.fn(async () => {}),
    refreshProjections: vi.fn(async () => {}),
    retain: vi.fn((target: SessionTarget): SessionReference => {
      const id = typeof target === 'string' ? target : target.childSessionId
      const eventSource = new MutableSessionEventSource()
      options?.decorateEventSource?.(eventSource)
      const sessionFace = {
        getSnapshot: () => ({ openState: 'open' }),
        projections: { faceOf: () => ({ getSnapshot: () => undefined }) },
      }
      const binding = { sessionId: id as SessionId, session: sessionFace, eventSource, ctx: undefined }
      const reference: SessionReference = {
        sessionId: id as SessionId,
        binding: binding as never,
        ready: Promise.resolve(binding as never),
        release: vi.fn(() => { released.push(id as SessionId) }),
        [Symbol.dispose]: () => {},
      }
      bindings.set(id, { eventSource, reference })
      retained.push(id as SessionId)
      return reference
    }),
    retainInfo: () => { throw new Error('unused') },
    create: async () => { throw new Error('unused') },
    subagentAddress: () => undefined,
    search: async () => { throw new Error('unused') },
    binding: (id: SessionId) => bindings.get(id)?.reference.binding,
    using: async () => { throw new Error('unused') },
  } as unknown as ISessions
  return { sessions, bindings, retained, released }
}

function apiFixture(options: {
  threads: Thread[]
  sessionsByThread?: Record<string, WorkforceSession[] | undefined>
  messagesByThread?: Record<string, WorkforceMessage[]>
  employees?: Employee[]
  channels?: HostChannel[]
}) {
  const sessionsByThread = options.sessionsByThread ?? {}
  const messagesByThread = options.messagesByThread ?? {}
  return {
    employees: vi.fn(async () => options.employees ?? [leader, writer]),
    channels: vi.fn(async () => options.channels ?? []),
    channelsWithGroups: vi.fn(async (): Promise<{ channels: HostChannel[]; groups: HostChannelGroup[] }> => ({ channels: options.channels ?? [], groups: [] })),
    threads: vi.fn(async () => options.threads),
    tasks: vi.fn(async () => []),
    models: vi.fn(async () => ({
      providers: [{ id: 'fixture', displayName: 'Fixture', kind: 'apikey' as const, configured: true, models: [{ id: 'model' }] }],
      defaultModel: { provider: 'fixture', model: 'model' },
    })),
    threadMessages: vi.fn(async (threadId: string): Promise<{ messages: WorkforceMessage[]; cursor: string; thread: Thread; hasMore: boolean; sessions?: WorkforceSession[]; files?: WorkforceFile[] }> => ({
      messages: messagesByThread[threadId] ?? [],
      cursor: '1',
      thread: options.threads.find(t => t.id === threadId) ?? options.threads[0]!,
      hasMore: false,
      ...(sessionsByThread[threadId] ? { sessions: sessionsByThread[threadId] } : {}),
    })),
    patchThread: vi.fn(async (id: string, patch: { pinned?: boolean }) => ({
      thread: { ...options.threads.find(t => t.id === id)!, ...patch },
    })),
    patchChannel: vi.fn(async (id: string, patch: { name?: string }) => ({
      channel: { ...(options.channels ?? []).find(c => c.id === id)!, ...patch },
    })),
  }
}

const releases: (() => void)[] = []
afterEach(() => { for (const release of releases.splice(0)) release() })

function observe(api: ReturnType<typeof apiFixture>, sessions: ISessions) {
  const source = new WorkforceSource(api as unknown as WorkforceApi, 60_000, undefined, sessions)
  const listener = vi.fn()
  releases.push(source.subscribe(listener))
  return { source, listener }
}

async function ready(source: WorkforceSource) {
  await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
}

/** 等 live.open() 的异步 retain/订阅链完成。 */
async function settled() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

let seq = 0
/** 固定 seq 的真实序号事件：历史/重放必须用比新事件更小的 seq，不能靠 helper 递增。 */
const evAt = (seq: number, type: string, data: Record<string, unknown>, time = 1000) =>
  ({ type: 'event' as const, event: { type, seq, time, data } as never })
const ev = (type: string, data: Record<string, unknown>, time = 1000) =>
  evAt(++seq, type, data, time)
const live = (attemptId: string, turn: number, step: number, chunk: Record<string, unknown>, time = 1000) =>
  ({ type: 'transient' as const, event: { type: 'assistant/live-chunk', seq: ++seq, time, data: { attemptId, turn, step, chunk } } as never })
const delta = (attemptId: string, turn: number, step: number, text: string, index = 0, time?: number) =>
  live(attemptId, turn, step, { type: 'text-delta', index, text }, time)
const reasoning = (attemptId: string, turn: number, step: number, text: string, index = 0) =>
  live(attemptId, turn, step, { type: 'reasoning-delta', index, text })
/** 本步正常结束且无工具调用：短正文从这里开始放行为 running 草稿（此前先攒着，防止工具前的过程说明漏出）。 */
const stop = (attemptId: string, turn: number, step: number, time?: number) =>
  live(attemptId, turn, step, { type: 'finish', reason: { kind: 'stop' } }, time)
const assistantMessageAt = (seq: number, turn: number, step: number, texts: string[], time = 2000, extra?: Record<string, unknown>) =>
  evAt(seq, 'assistant/message', {
    turn, step,
    message: {
      id: `m-${turn}-${step}`, role: 'assistant', time,
      source: { kind: 'model', provider: 'native', model: 'model' },
      content: texts.map(text => ({ type: 'text', text })),
      ...(extra ?? {}),
    },
    stream: [],
  }, time)
const assistantMessage = (turn: number, step: number, texts: string[], time = 2000, extra?: Record<string, unknown>) =>
  assistantMessageAt(++seq, turn, step, texts, time, extra)
const agentRows = (source: WorkforceSource, threadId: string) =>
  source.getSnapshot().messages[threadId]?.list.filter(m => m.role === 'agent') ?? []

describe('原生回复增量桥', () => {
  it('baseline 里的落盘行不重放为 live 行；baseline 后的 transient 照常叠加', async () => {
    const { sessions, bindings } = fakeSessions()
    const api = apiFixture({ threads: [dmThread], sessionsByThread: { [dmThread.id]: dmSessions() } })
    const { source } = observe(api, sessions)
    source.setFocusedThread(dmThread.id)
    await ready(source)
    await settled()

    const es = bindings.get(SESSION_A)!.eventSource
    // 首张 baseline：持久 assistant/message（seq 冻结水位）+ 仍在流的 transient。
    es.replace([
      ev('turn/start', { turn: 1 }, 900),
      assistantMessage(1, 0, ['已完成的历史回复'], 950),
      live('att-1', 2, 0, { type: 'text-delta', index: 0, text: '正在输出' }, 990),
      stop('att-1', 2, 0, 991),
    ], false)

    await vi.waitFor(() => {
      const list = agentRows(source, dmThread.id)
      // baseline 里的持久行不得以任何 id 叠进来（live: 或 session:seq 都不行）：
      // 唯一可见行必须就是那条 transient 草稿。
      expect(list).toHaveLength(1)
      expect(list[0]!.id.startsWith('live:')).toBe(true)
      expect(list[0]!.text).toBe('正在输出')
    })
    // 无新事件时连续读快照是同引用（useSyncExternalStore 不额外重绘）。
    expect(source.getSnapshot()).toBe(source.getSnapshot())
  })

  it('多个 text-delta 累计成一条 running 草稿；reasoning-delta 不产生空泡', async () => {
    const { sessions, bindings } = fakeSessions()
    const api = apiFixture({ threads: [dmThread], sessionsByThread: { [dmThread.id]: dmSessions() } })
    const { source } = observe(api, sessions)
    source.setFocusedThread(dmThread.id)
    await ready(source)
    await settled()

    const es = bindings.get(SESSION_A)!.eventSource
    es.replace([ev('turn/start', { turn: 1 }, 900)], false)
    // 先只到 reasoning：没有正文，不应出现 running 气泡。
    es.append(reasoning('att-1', 1, 0, '思考中'))
    await settled()
    expect(agentRows(source, dmThread.id).filter(m => m.id.startsWith('live:'))).toHaveLength(0)

    es.append(delta('att-1', 1, 0, '第一段', 0, 1001))
    es.append(delta('att-1', 1, 0, '第二段', 0, 1002))
    es.append(reasoning('att-1', 1, 0, '继续思考'))
    es.append(stop('att-1', 1, 0, 1003))
    await vi.waitFor(() => {
      const rows = agentRows(source, dmThread.id).filter(m => m.id.startsWith('live:'))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.running).toBe(true)
      expect(rows[0]!.text).toBe('第一段第二段')
    })
  })

  it('真实成功顺序 durable append→step/end→settle 无 entry：全程只有一条回复，轮询同 streamKey 交接', async () => {
    const { sessions, bindings } = fakeSessions()
    const durable: WorkforceMessage = {
      id: 'srv-9', threadId: dmThread.id, ts: new Date(2000).toISOString(),
      role: 'agent', senderId: 'writer', senderName: '文案员',
      text: '第一段第二段', streamKey: `${SESSION_A}:1:0`,
    }
    const api = apiFixture({
      threads: [dmThread],
      sessionsByThread: { [dmThread.id]: dmSessions() },
    })
    const { source } = observe(api, sessions)
    source.setFocusedThread(dmThread.id)
    await ready(source)
    await settled()

    const es = bindings.get(SESSION_A)!.eventSource
    es.replace([ev('turn/start', { turn: 1 }, 900)], false)
    es.append(delta('att-1', 1, 0, '第一段', 0, 1001))
    es.append(delta('att-1', 1, 0, '第二段', 0, 1002))
    es.append(stop('att-1', 1, 0, 1002))
    await vi.waitFor(() => expect(agentRows(source, dmThread.id).filter(m => m.id.startsWith('live:'))).toHaveLength(1))

    // 原生正常成功顺序：先 append durable assistant/message，再 step/end，
    // 最后 settleAssistant(attemptId) 无 entry 收尾；每个阶段只有真实 id 成稿。
    const durableEvent = assistantMessage(1, 0, ['第一段第二段'], 2000)
    const durableSeq = (durableEvent.event as { seq: number }).seq
    es.append(durableEvent)
    await vi.waitFor(() => {
      const rows = agentRows(source, dmThread.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.id).not.toMatch(/^live:/)
      expect(rows[0]!.id).toBe(`${SESSION_A}:${durableSeq}`)
      expect(rows[0]!.running).toBe(false)
      expect(rows[0]!.streamKey).toBe(`${SESSION_A}:1:0`)
    })
    es.append(ev('step/end', { turn: 1, step: 0 }, 2001))
    await settled()
    const afterStepEnd = agentRows(source, dmThread.id)
    expect(afterStepEnd).toHaveLength(1)
    expect(afterStepEnd[0]!.text).toBe('第一段第二段')
    es.settleAssistant('att-1' as never)
    await vi.waitFor(() => {
      const rows = agentRows(source, dmThread.id)
      // 无 entry 结算不撤已落盘正文（attempt 已在 append 时清）。
      expect(rows).toHaveLength(1)
      expect(rows[0]!.id).toBe(`${SESSION_A}:${durableSeq}`)
      expect(rows[0]!.running).toBe(false)
    })

    // 轮询带回同 streamKey 持久行：本地行删除，快照只有一份。
    api.threadMessages.mockResolvedValueOnce({
      messages: [durable], cursor: '2',
      thread: dmThread, hasMore: false, sessions: dmSessions(),
    })
    source.refresh()
    await vi.waitFor(() => {
      const rows = agentRows(source, dmThread.id)
      expect(rows.filter(m => m.streamKey === `${SESSION_A}:1:0`)).toHaveLength(1)
      expect(rows.find(m => m.streamKey === `${SESSION_A}:1:0`)?.id).toBe('srv-9')
    })
    expect(source.getSnapshot()).toBe(source.getSnapshot())
  })

  it('失败 attempt（settle 无 entry / assistant/attempt）撤草稿并通知订阅者', async () => {
    const { sessions, bindings } = fakeSessions()
    const api = apiFixture({ threads: [dmThread], sessionsByThread: { [dmThread.id]: dmSessions() } })
    const { source, listener } = observe(api, sessions)
    source.setFocusedThread(dmThread.id)
    await ready(source)
    await settled()

    const es = bindings.get(SESSION_A)!.eventSource
    es.replace([ev('turn/start', { turn: 1 }, 900)], false)
    es.append(delta('att-fail', 1, 0, '半截回复', 0, 1001))
    es.append(stop('att-fail', 1, 0, 1001))
    await vi.waitFor(() => expect(agentRows(source, dmThread.id).filter(m => m.id.startsWith('live:'))).toHaveLength(1))

    listener.mockClear()
    es.settleAssistant('att-fail' as never)
    await vi.waitFor(() => {
      expect(agentRows(source, dmThread.id).filter(m => m.id.startsWith('live:'))).toHaveLength(0)
      // 草稿从有到无也要广播，否则 UI 残留半截回复。
      expect(listener).toHaveBeenCalled()
    })

    // llm/retry 后新 attempt 重计时旧草稿清空；assistant/attempt durable 同样撤行。
    es.append(delta('att-r1', 1, 1, '旧半截', 0, 1003))
    es.append(stop('att-r1', 1, 1, 1003))
    await vi.waitFor(() => expect(agentRows(source, dmThread.id).filter(m => m.id.startsWith('live:')).length).toBe(1))
    es.append(ev('assistant/attempt', { turn: 1, step: 1, stream: [] }, 1004))
    await vi.waitFor(() => expect(agentRows(source, dmThread.id).filter(m => m.id.startsWith('live:'))).toHaveLength(0))
  })

  it('turn/end 撤同 turn 未结算的 running 草稿（停止/中断不残留）', async () => {
    const { sessions, bindings } = fakeSessions()
    const api = apiFixture({ threads: [dmThread], sessionsByThread: { [dmThread.id]: dmSessions() } })
    const { source } = observe(api, sessions)
    source.setFocusedThread(dmThread.id)
    await ready(source)
    await settled()

    const es = bindings.get(SESSION_A)!.eventSource
    es.replace([ev('turn/start', { turn: 3 }, 900)], false)
    es.append(delta('att-stop', 3, 0, '被打断的正文', 0, 1001))
    es.append(stop('att-stop', 3, 0, 1001))
    await vi.waitFor(() => expect(agentRows(source, dmThread.id).filter(m => m.id.startsWith('live:'))).toHaveLength(1))

    es.append(ev('turn/end', { turn: 3, reason: { kind: 'aborted' } }, 1002))
    await vi.waitFor(() => expect(agentRows(source, dmThread.id).filter(m => m.id.startsWith('live:'))).toHaveLength(0))
  })

  it('tool-call 增量与同位 durable tool/call 把该 streamKey 行折叠为 intermediate', async () => {
    const { sessions, bindings } = fakeSessions()
    const api = apiFixture({ threads: [dmThread], sessionsByThread: { [dmThread.id]: dmSessions() } })
    const { source } = observe(api, sessions)
    source.setFocusedThread(dmThread.id)
    await ready(source)
    await settled()

    const es = bindings.get(SESSION_A)!.eventSource
    es.replace([ev('turn/start', { turn: 1 }, 900)], false)
    es.append(delta('att-t', 1, 0, '先保存文件', 0, 1001))
    es.append(live('att-t', 1, 0, { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'wb_save_deliverable', argumentsDelta: '{}' }, 1002))
    await vi.waitFor(() => {
      const row = agentRows(source, dmThread.id).find(m => m.id.startsWith('live:'))
      expect(row?.intermediate).toBe(true)
    })
    es.settleAssistant('att-t' as never, assistantMessage(1, 0, ['先保存文件'], 2000))
    es.append(ev('tool/call', { turn: 1, step: 0, callId: 'call-1', name: 'wb_save_deliverable', arguments: '{}' }, 2001))
    await vi.waitFor(() => {
      const row = agentRows(source, dmThread.id).find(m => m.streamKey === `${SESSION_A}:1:0`)
      expect(row?.intermediate).toBe(true)
      expect(row?.running).not.toBe(true)
    })
  })

  it('focus 切换退订旧会话并撤草稿；新会话订阅生效', async () => {
    const dmB: Thread = { ...dmThread, id: 'dm-leader', employeeId: 'leader', status: 'running', updatedAt: '2026-10-11T00:00:02Z' }
    const { sessions, bindings, retained, released } = fakeSessions()
    const api = apiFixture({
      threads: [dmThread, dmB],
      sessionsByThread: {
        [dmThread.id]: dmSessions(),
        [dmB.id]: [{ sessionId: SESSION_B, employeeId: 'leader' }],
      },
    })
    const { source } = observe(api, sessions)
    source.setFocusedThread(dmThread.id)
    await ready(source)
    await settled()

    bindings.get(SESSION_A)!.eventSource.replace([
      ev('turn/start', { turn: 1 }, 900),
      delta('att-a', 1, 0, 'A 的草稿', 0, 1001),
      stop('att-a', 1, 0, 1001),
    ], false)
    await vi.waitFor(() => expect(agentRows(source, dmThread.id).filter(m => m.id.startsWith('live:')).length).toBe(1))
    expect(retained).toContain(SESSION_A)

    // 切走前先把另一条 attempt 结算完：settled 行移交 detached，订阅消失后 HTTP
    // 接手前仍呈现在原线程，不丢一条刚完成的回复。
    const esA = bindings.get(SESSION_A)!.eventSource
    esA.append(delta('att-settled', 1, 1, '已完成的回复', 0, 1002))
    esA.settleAssistant('att-settled' as never, assistantMessage(1, 1, ['已完成的回复'], 2000))
    await vi.waitFor(() => {
      const row = agentRows(source, dmThread.id).find(m => m.streamKey === `${SESSION_A}:1:1`)
      expect(row?.running).not.toBe(true)
    })

    source.setFocusedThread(dmB.id)
    await settled()
    // A 退订：release 被调、A 的 running 草稿撤；settled 行仍在（detached 交接）。
    expect(released).toContain(SESSION_A)
    expect(agentRows(source, dmThread.id).filter(m => m.running === true)).toHaveLength(0)
    expect(agentRows(source, dmThread.id).some(m => m.streamKey === `${SESSION_A}:1:1` && m.text === '已完成的回复')).toBe(true)
    await vi.waitFor(() => expect(retained).toContain(SESSION_B))

    // A 线程 HTTP 接手同 streamKey：detached 本地份删除，只留持久行。
    const durable: WorkforceMessage = {
      id: 'srv-settled', threadId: dmThread.id, ts: new Date(2000).toISOString(),
      role: 'agent', senderId: 'writer', senderName: '文案员',
      text: '已完成的回复', streamKey: `${SESSION_A}:1:1`,
    }
    api.threadMessages.mockImplementation(async (threadId: string) => ({
      messages: threadId === dmThread.id ? [durable] : [], cursor: '2',
      thread: [dmThread, dmB].find(t => t.id === threadId)!,
      hasMore: false,
      sessions: threadId === dmThread.id ? dmSessions() : [{ sessionId: SESSION_B, employeeId: 'leader' }],
    }))
    source.setFocusedThread(dmThread.id)
    await vi.waitFor(() => {
      const rows = agentRows(source, dmThread.id).filter(m => m.streamKey === `${SESSION_A}:1:1`)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.id).toBe('srv-settled')
    })
  })

  it('全部 listener 卸载后 release 订阅且不再 retain；新组件可重新订阅', async () => {
    const { sessions, bindings, released } = fakeSessions()
    const api = apiFixture({ threads: [dmThread], sessionsByThread: { [dmThread.id]: dmSessions() } })
    const source = new WorkforceSource(api as unknown as WorkforceApi, 60_000, undefined, sessions)
    const unsub = source.subscribe(() => {})
    source.setFocusedThread(dmThread.id)
    await ready(source)
    await settled()
    expect(bindings.has(SESSION_A)).toBe(true)
    const firstReference = bindings.get(SESSION_A)!.reference

    unsub()
    expect(firstReference.release).toHaveBeenCalledTimes(1)
    expect(released).toContain(SESSION_A)
    // 卸载后旧 eventSource 再推事件不应出现在快照。
    bindings.get(SESSION_A)!.eventSource.append(delta('att-late', 9, 0, '迟到的增量'))
    await settled()
    expect(agentRows(source, dmThread.id)).toHaveLength(0)

    // 重订：必须真的 retain 出新参考（旧 reference 只释放一次），且新 eventSource 的
    // 增量能进入快照——只断言 release 未二次调用不能证明订阅恢复。
    releases.push(source.subscribe(() => {}))
    source.setFocusedThread(dmThread.id)
    await vi.waitFor(() => expect(sessions.retain).toHaveBeenCalledTimes(2))
    const secondReference = bindings.get(SESSION_A)!.reference
    expect(secondReference).not.toBe(firstReference)
    expect(firstReference.release).toHaveBeenCalledTimes(1)
    const secondSource = bindings.get(SESSION_A)!.eventSource
    expect(secondSource).not.toBe(undefined)
    secondSource.append(delta('att-back', 1, 0, '重订后的增量', 0, 1200))
    secondSource.append(stop('att-back', 1, 0, 1200))
    await vi.waitFor(() => {
      const row = agentRows(source, dmThread.id).find(m => m.id.startsWith('live:'))
      expect(row?.text).toBe('重订后的增量')
    })
    // 无新事件时连续读快照同引用。
    expect(source.getSnapshot()).toBe(source.getSnapshot())
  })

  it('listener 清空时 settled detached 全清：不再残留已交接行', async () => {
    const { sessions, bindings } = fakeSessions()
    const api = apiFixture({ threads: [dmThread], sessionsByThread: { [dmThread.id]: dmSessions() } })
    const source = new WorkforceSource(api as unknown as WorkforceApi, 60_000, undefined, sessions)
    const unsub = source.subscribe(() => {})
    source.setFocusedThread(dmThread.id)
    await ready(source)
    await settled()

    // 结算一条留在 detached 的行，然后卸载全部 listener。
    const es = bindings.get(SESSION_A)!.eventSource
    es.replace([ev('turn/start', { turn: 1 }, 900)], false)
    es.append(delta('att-x', 1, 0, '交接中的正文', 0, 1001))
    es.append(assistantMessage(1, 0, ['交接中的正文'], 2000))
    await vi.waitFor(() => expect(agentRows(source, dmThread.id).some(m => m.text === '交接中的正文')).toBe(true))
    unsub()
    await settled()
    // clear 会连 detached 一并清掉：卸载后不得残留任何本地行。
    expect(agentRows(source, dmThread.id)).toHaveLength(0)
  })

  it('native settle 后 HTTP 滞后再 replace 不丢已显示正文', async () => {
    const { sessions, bindings } = fakeSessions()
    const api = apiFixture({ threads: [dmThread], sessionsByThread: { [dmThread.id]: dmSessions() } })
    const { source } = observe(api, sessions)
    source.setFocusedThread(dmThread.id)
    await ready(source)
    await settled()

    const es = bindings.get(SESSION_A)!.eventSource
    es.replace([ev('turn/start', { turn: 1 }, 900)], false)
    es.append(delta('att-1', 1, 0, '完整正文', 0, 1001))
    es.settleAssistant('att-1' as never, assistantMessage(1, 0, ['完整正文'], 2000))
    await vi.waitFor(() => {
      const row = agentRows(source, dmThread.id).find(m => m.streamKey === `${SESSION_A}:1:0`)
      expect(row?.running).not.toBe(true)
      expect(row?.text).toBe('完整正文')
    })

    // 轮询还没带回持久行，连接层重连 replace 窗口（baseline 水位不含新行）。
    es.replace([ev('turn/start', { turn: 1 }, 900), assistantMessage(1, 0, ['完整正文'], 2000)], false)
    await settled()
    const rows = agentRows(source, dmThread.id).filter(m => m.streamKey === `${SESSION_A}:1:0`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text).toBe('完整正文')
  })

  it('prepend 更早历史是重建而非新 baseline：settled 行保留，历史不重放，水位不抬', async () => {
    const { sessions, bindings } = fakeSessions()
    const api = apiFixture({ threads: [dmThread], sessionsByThread: { [dmThread.id]: dmSessions() } })
    const { source } = observe(api, sessions)
    source.setFocusedThread(dmThread.id)
    await ready(source)
    await settled()

    const es = bindings.get(SESSION_A)!.eventSource
    // 真实历史序：baseline 用水位前的固定小 seq，后续新行用更大 seq。
    const baselineStart = evAt(10, 'turn/start', { turn: 1 }, 900)
    const baselineMessage = assistantMessageAt(11, 1, 0, ['基线回复'], 950)
    es.replace([baselineStart, baselineMessage], false)
    await settled()
    // 产生一条 settled 待 HTTP 接手的行（真实更高 seq）。
    es.append(delta('att-p', 1, 1, '待接手正文', 0, 1001))
    const settledMessage = assistantMessageAt(40, 1, 1, ['待接手正文'], 2000)
    es.append(settledMessage)
    await vi.waitFor(() => {
      const row = agentRows(source, dmThread.id).find(m => m.streamKey === `${SESSION_A}:1:1`)
      expect(row?.running).not.toBe(true)
      expect(row?.id).toBe(`${SESSION_A}:40`)
    })

    // prepend 更早历史：必须是比 baseline 更小的旧 seq，且用同一 event 对象重放
    // （连接层挪窗口不重造事件）。一条 settled 行不得消失，更早历史不得叠成新行。
    const olderHistory = assistantMessageAt(5, 0, 0, ['更早历史'], 500)
    es.prepend([olderHistory], true)
    await settled()
    const rows = agentRows(source, dmThread.id)
    expect(rows.some(m => m.text === '待接手正文')).toBe(true)
    expect(rows.filter(m => m.id.startsWith('live:'))).toHaveLength(0)
    expect(rows.some(m => m.id === `${SESSION_A}:5`)).toBe(false)
  })

  it('Window revision 跳变（漏一次订阅通知）后重建：settled 不丢、transient 重新 baseline', async () => {
    // 传输层偶发漏通知：把 subscribe 的通知在窗口内暂扣一次再放行，
    // 桥看到的 revision 从 N 跳到 N+2，必须按重建处理而不是丢行。
    let installed: MutableSessionEventSource | undefined
    let suppressed = false
    const held: (() => void)[] = []
    const { sessions, bindings } = fakeSessions({
      decorateEventSource: (eventSource) => {
        installed = eventSource
        const original = eventSource.subscribe.bind(eventSource)
        eventSource.subscribe = (listener: () => void) => {
          const wrapped = (): void => {
            if (suppressed) { held.push(listener); return }
            listener()
          }
          return original(wrapped)
        }
      },
    })
    const api = apiFixture({ threads: [dmThread], sessionsByThread: { [dmThread.id]: dmSessions() } })
    const { source } = observe(api, sessions)
    source.setFocusedThread(dmThread.id)
    await ready(source)
    await settled()
    expect(installed).toBeDefined()
    const es = bindings.get(SESSION_A)!.eventSource

    es.replace([evAt(10, 'turn/start', { turn: 1 }, 900)], false)
    es.append(delta('att-g', 1, 0, '已结算正文', 0, 1001))
    const settledMessage = assistantMessageAt(40, 1, 0, ['已结算正文'], 2000)
    es.append(settledMessage)
    await vi.waitFor(() => expect(agentRows(source, dmThread.id).some(m => m.id === `${SESSION_A}:40`)).toBe(true))

    // 暂扣通知，制造两次窗口变更。
    suppressed = true
    es.append(assistantMessageAt(41, 1, 1, ['漏帧期间的正文'], 2100))
    es.append(delta('att-g2', 2, 0, '漏帧后草稿', 0, 2200))
    es.append(stop('att-g2', 2, 0, 2200))

    // 恢复：先放行被扣的通知，桥立即看到完整窗口（revision 跳变 +2）。
    suppressed = false
    for (const listener of held.splice(0)) listener()
    await vi.waitFor(() => {
      const rows = agentRows(source, dmThread.id)
      // 保持初始水位：漏帧期间窗口新增的 durable 行必须恢复出现（唯一、非 running），
      // 已结算行不丢——这一条删了 gap 检测也能绿的部分只是 transient。
      const missed = rows.filter(m => m.id === `${SESSION_A}:41`)
      expect(missed).toHaveLength(1)
      expect(missed[0]!.text).toBe('漏帧期间的正文')
      expect(missed[0]!.running).toBe(false)
      expect(rows.some(m => m.id === `${SESSION_A}:40`)).toBe(true)
      expect(rows.filter(m => m.id.startsWith('live:'))).toHaveLength(1)
      expect(rows.filter(m => m.id.startsWith('live:'))[0]!.text).toBe('漏帧后草稿')
    })
    // 恢复后 append 正常走增量路径（revision 跳变只发生在放行后第一张变更）。
    es.append(assistantMessageAt(42, 2, 1, ['恢复后正文'], 2300))
    await vi.waitFor(() => {
      const rows = agentRows(source, dmThread.id)
      expect(rows.some(m => m.id === `${SESSION_A}:42` && m.text === '恢复后正文')).toBe(true)
    })
  })

  it('metadata 变 idle（非 focus 切换）退订后，settled 行 detached 仍保留到 HTTP 接手', async () => {
    let current: Thread = dmThread
    const { sessions, bindings, released } = fakeSessions()
    const durable: WorkforceMessage = {
      id: 'srv-detach', threadId: dmThread.id, ts: new Date(2000).toISOString(),
      role: 'agent', senderId: 'writer', senderName: '文案员',
      text: '已完成正文', streamKey: `${SESSION_A}:1:0`,
    }
    let serveDurable = false
    const api = apiFixture({ threads: [dmThread], sessionsByThread: { [dmThread.id]: dmSessions() } })
    api.threads.mockImplementation(async () => [current])
    api.threadMessages.mockImplementation(async () => ({
      messages: serveDurable ? [durable] : [], cursor: '1', thread: current, hasMore: false, sessions: dmSessions(),
    }))
    const { source } = observe(api, sessions)
    source.setFocusedThread(dmThread.id)
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    await settled()
    const es = bindings.get(SESSION_A)!.eventSource
    es.replace([ev('turn/start', { turn: 1 }, 900)], false)
    es.append(delta('att-d', 1, 0, '已完成正文', 0, 1001))
    es.append(assistantMessage(1, 0, ['已完成正文'], 2000))
    await vi.waitFor(() => expect(agentRows(source, dmThread.id).some(m => m.streamKey === `${SESSION_A}:1:0`)).toBe(true))

    // metadata 变 idle：publish→syncLive 退订（非用户切走），settled 行转 detached。
    current = { ...dmThread, status: 'idle', updatedAt: '2026-10-11T00:02:00Z' }
    source.refresh()
    await vi.waitFor(() => expect(source.getSnapshot().threads.find(t => t.id === dmThread.id)?.status).toBe('idle'))
    await settled()
    // 退订必须真实发生（released 含 SESSION_A），否则残留 settled 行可能只是订阅仍在。
    expect(released).toContain(SESSION_A)
    const detachedRow = agentRows(source, dmThread.id).find(m => m.streamKey === `${SESSION_A}:1:0`)
    expect(detachedRow?.text).toBe('已完成正文')

    // HTTP 带回持久行：detached 本地份删除，只留持久。
    serveDurable = true
    source.refresh()
    await vi.waitFor(() => {
      const rows = agentRows(source, dmThread.id).filter(m => m.streamKey === `${SESSION_A}:1:0`)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.id).toBe('srv-detach')
    })
  })

  it('metadata idle 退订后同轮变 running 且消息页失败：用缓存 sessions 立即 retain，不等下一轮成功', async () => {
    let current: Thread = dmThread
    const { sessions, bindings, retained } = fakeSessions()
    const api = apiFixture({ threads: [dmThread], sessionsByThread: { [dmThread.id]: dmSessions() } })
    api.threads.mockImplementation(async () => [current])
    const { source } = observe(api, sessions)
    source.setFocusedThread(dmThread.id)
    await ready(source)
    await settled()
    expect(retained.filter(id => id === SESSION_A)).toHaveLength(1)

    // 第一轮 running 出现草稿，随后 metadata 变 idle：publish 的 syncLive 退订，
    // 但 threadSessions 缓存保留。
    bindings.get(SESSION_A)!.eventSource.append(delta('att-c', 1, 0, '第一段', 0, 1100))
    bindings.get(SESSION_A)!.eventSource.append(stop('att-c', 1, 0, 1100))
    await vi.waitFor(() => expect(agentRows(source, dmThread.id).some(m => m.text === '第一段')).toBe(true))
    current = { ...dmThread, status: 'idle', updatedAt: '2026-10-11T00:03:00Z' }
    source.refresh()
    await vi.waitFor(() => expect(source.getSnapshot().threads.find(t => t.id === dmThread.id)?.status).toBe('idle'))
    await settled()

    // 同轮 metadata 变回 running，消息页失败：subscription 必须由 publish 的 syncLive
    // 用缓存 sessions 立即重建（第二次 retain），新流的增量仍可见。
    current = { ...dmThread, status: 'running', updatedAt: '2026-10-11T00:04:00Z' }
    api.threadMessages.mockRejectedValue(new Error('消息连接中断'))
    source.refresh()
    await vi.waitFor(() => expect(retained.filter(id => id === SESSION_A)).toHaveLength(2))
    await settled()
    // 重订后是新 eventSource/新窗口：草稿从这条流的增量重建（不残留旧态）。
    bindings.get(SESSION_A)!.eventSource.append(delta('att-c2', 2, 0, '第二段', 0, 1101))
    bindings.get(SESSION_A)!.eventSource.append(stop('att-c2', 2, 0, 1101))
    await vi.waitFor(() => expect(agentRows(source, dmThread.id).some(m => m.text === '第二段')).toBe(true))
    expect(source.getSnapshot()).toBe(source.getSnapshot())
  })

  it('写操作立即使 getSnapshot 反映新 channel 字段，不等下一轮轮询', async () => {
    const channel: HostChannel = { id: 'ch-1', name: '旧名', unread: true }
    const { sessions } = fakeSessions()
    const api = apiFixture({ threads: [dmThread], channels: [channel], sessionsByThread: { [dmThread.id]: dmSessions() } })
    const { source } = observe(api, sessions)
    await ready(source)

    expect(source.getSnapshot().channels.find(c => c.id === 'ch-1')?.name).toBe('旧名')
    await source.renameChannel('ch-1', '新名')
    expect(source.getSnapshot().channels.find(c => c.id === 'ch-1')?.name).toBe('新名')
  })

  it('metadata running 变动即时开订：消息页首次失败不阻断，下页带回 sessions 仍建立订阅', async () => {
    const idle: Thread = { ...dmThread, status: 'idle' }
    let current: Thread = idle
    const { sessions, bindings, retained } = fakeSessions()
    const api = apiFixture({
      threads: [dmThread],
      sessionsByThread: { [dmThread.id]: dmSessions() },
    })
    api.threads.mockImplementation(async () => [current])
    let failMessages = true
    api.threadMessages.mockImplementation(async () => {
      if (failMessages) throw new Error('消息连接中断')
      return { messages: [], cursor: '1', thread: current, hasMore: false, sessions: dmSessions() }
    })
    const { source } = observe(api, sessions)
    source.setFocusedThread(dmThread.id)
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    // 首轮 idle：running 线程才开订；idle 不 retain。
    expect(retained).toHaveLength(0)

    // 元数据先变 running，同轮消息页失败：不订但线程进入可见集合。
    current = { ...idle, status: 'running', updatedAt: '2026-10-11T00:01:00Z' }
    source.refresh()
    await vi.waitFor(() => expect(api.threadMessages).toHaveBeenCalled())
    expect(retained).toHaveLength(0)

    // 下一轮消息页带回 sessions：无需重新聚焦即建立订阅。
    failMessages = false
    source.refresh()
    await vi.waitFor(() => expect(retained).toContain(SESSION_A))
    await settled()

    bindings.get(SESSION_A)!.eventSource.replace([
      ev('turn/start', { turn: 1 }, 900),
      delta('att-m', 1, 0, '恢复后的增量', 0, 1001),
      stop('att-m', 1, 0, 1001),
    ], false)
    await vi.waitFor(() => {
      const row = agentRows(source, dmThread.id).find(m => m.id.startsWith('live:'))
      expect(row?.text).toBe('恢复后的增量')
    })
  })

  it('频道聚焦订 root 与 running task 的子会话：child 走显式父地址 retain', async () => {
    const { sessions, bindings, retained } = fakeSessions()
    const retains: unknown[] = []
    const original = sessions.retain.bind(sessions)
    ;(sessions as { retain: unknown }).retain = (target: unknown, opts: unknown) => {
      retains.push(target)
      return (original as (t: never, o: never) => SessionReference)(target as never, opts as never)
    }
    const api = apiFixture({
      threads: [channelThread, taskThread],
      sessionsByThread: { [taskThread.id]: taskSessions() },
    })
    const { source } = observe(api, sessions)
    source.setFocusedThread(channelThread.id)
    await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
    await vi.waitFor(() => expect(retained).toContain(SESSION_B))
    await settled()

    // root 按 SessionId 直订；child 按 {parentSessionId, childSessionId, mode} 显式父地址订。
    const childTarget = retains.find(t => typeof t === 'object' && t !== null) as { parentSessionId?: string; childSessionId?: string; mode?: string } | undefined
    expect(childTarget?.parentSessionId).toBe(SESSION_A)
    expect(childTarget?.childSessionId).toBe(SESSION_B)
    expect(childTarget?.mode).toBe('continuable')

    // child 的 transient 也映射到该 task 线程、senderId 为 child 员工。
    bindings.get(SESSION_B)!.eventSource.replace([
      ev('turn/start', { turn: 1 }, 900),
      delta('att-c', 1, 0, '子会话正文', 0, 1001),
      stop('att-c', 1, 0, 1001),
    ], false)
    await vi.waitFor(() => {
      const row = agentRows(source, taskThread.id).find(m => m.id.startsWith('live:'))
      expect(row?.text).toBe('子会话正文')
      expect(row?.senderId).toBe('writer')
      // 落进 task 页要带 taskId 供成果归集。
      expect(row?.taskId).toBe('task-1')
    })
  })
})

describe('回复计数与文件历史透传', () => {
  const base = { threadId: dmThread.id, ts: '2026-10-11T00:00:00Z', role: 'agent', senderId: 'writer', senderName: '文案员', text: '回答' } as const
  const human = (id: string, threadId: string): WorkforceMessage => ({ id, threadId, ts: '2026-10-11T00:00:00Z', role: 'user', senderId: 'user', senderName: '你', text: '问题' })
  const reply = (over: Partial<WorkforceMessage> & { id: string }): WorkforceMessage => ({ ...base, ...over })

  it('count 归属 replyTo 父行：排除 tool/intermediate/tip/卡片/空文本，跨线程锚不计数，streamKey 去重', () => {
    const messages: WorkforceMessage[] = [
      human('h1', dmThread.id), human('h2', channelThread.id),
      reply({ id: 'r1', replyTo: 'h1' }),
      reply({ id: 'r2', replyTo: 'h1' }),
      reply({ id: 'r3', replyTo: 'h1', intermediate: true }),
      reply({ id: 'r4', replyTo: 'h1', tool: { name: 'wb_x', status: 'done' } }),
      reply({ id: 'r5', replyTo: 'h1', tip: true }),
      reply({ id: 'r6', replyTo: 'h1', question: { requestId: 'ask-r6', items: [] } }),
      reply({ id: 'r7', replyTo: 'h1', approval: { requestId: 'ask-r7', toolName: 'shell.run' } }),
      reply({ id: 'r8', replyTo: 'h1', text: '   ' }),
      reply({ id: 'r9', replyTo: 'h2' }),
      reply({ id: 'r10', replyTo: 'h1', streamKey: `${SESSION_A}:1:0` }),
      reply({ id: 'r11', replyTo: 'h1', streamKey: `${SESSION_A}:1:0` }),
    ]
    const counts = visibleReplyCounts(messages)
    // r1/r2 两条独立回复 + r10/r11 同 streamKey（草稿与落盘正文）只计一次 → h1 共 3
    expect(counts.get('h1')).toBe(3)
    expect(counts.has('h2')).toBe(false)
    expect(counts.size).toBe(1)
  })

  it('files 全量文件历史随消息页透传进快照；宿主缺省时不覆盖既有值（与 usage 同口径）', async () => {
    const { sessions } = fakeSessions()
    const api = apiFixture({ threads: [dmThread], sessionsByThread: { [dmThread.id]: dmSessions() } })
    const file = {
      id: `d|task-1|稿.txt|1`, name: '稿.txt', path: '稿.txt', mime: 'text/plain',
      createdAt: '2026-10-11T00:00:00Z', employeeId: 'writer', source: 'deliverable' as const,
    }
    api.threadMessages.mockResolvedValue({ messages: [], cursor: '1', thread: dmThread, hasMore: false, sessions: dmSessions(), files: [file] })
    const { source } = observe(api, sessions)
    source.setFocusedThread(dmThread.id)
    await ready(source)
    expect(source.getSnapshot().messages[dmThread.id]?.files).toEqual([file])
    // 下一页宿主缺 files（分页/重试）：不覆盖已知值，也不造空数组
    api.threadMessages.mockResolvedValue({ messages: [], cursor: '2', thread: dmThread, hasMore: false, sessions: dmSessions() })
    source.refresh()
    await vi.waitFor(() => expect(api.threadMessages.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(source.getSnapshot().messages[dmThread.id]?.files).toEqual([file])
  })
})
