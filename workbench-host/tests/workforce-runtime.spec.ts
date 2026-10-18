import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkforceStore } from '../src/workforce/store.ts'
import { titleFromPrompt, WorkforceRuntime } from '../src/workforce/runtime.ts'
import { collectWorkforceDiagnostics } from '../src/workforce/diagnostics.ts'
import { operationalRecorder, resetOperationalDiagnostics } from '../src/workforce/operational-diagnostics.ts'
import type { EmployeeToolPolicy, EmployeeWorkspace } from '../src/workforce/employee-tool-contract.ts'

// These existing fixtures exercise native routing and persistence, not a Cordis capability world.
// Capability assembly is exercised against the real host by the flow acceptance runner.
vi.mock('../src/workforce/employee-native-tools.ts', () => ({
  installEmployeeNativeTools: vi.fn(async (_agent: unknown, workspace: EmployeeWorkspace, policy: EmployeeToolPolicy) => ({
    workspace, policy, definitions: new Map(), dispose: async () => {},
  })),
}))

let root: string, store: WorkforceStore, runtime: WorkforceRuntime
let services: Record<string, any>, agents: Map<string, any>, logs: Map<string, any[]>
let headers: Map<string, { id: string; cwd: string }>
const missing = () => Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
const end = (kind = 'completed', time = 2) => [{ type: 'turn/start', seq: 0, time: 1, data: {} }, { type: 'turn/end', seq: 1, time, data: { reason: { kind } } }]
beforeEach(async () => {
  root = await mkdtemp(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, 'tmp') : process.env.TEMP!, 'wf-runtime-'))
  store = new WorkforceStore(root)
  agents = new Map(); logs = new Map(); headers = new Map()
  const make = async (options: any) => {
    const id = options.sessionId ?? options.resumeSessionId
    const header = options.resumeSessionId ? headers.get(id)! : { id, cwd: options.meta.cwd }
    headers.set(id, header)
    const agent: any = { id, options: options.agentOptions, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: { id, header }, ctx: { get: (name: string) => services[name] }, hooks: new Map<string, any[]>() }
    agent.ctx.on = (name: string, fn: any) => agent.hooks.set(name, [...(agent.hooks.get(name) ?? []), fn])
    // Fire one scoped waterfall through the hooks registered by runtime.hookAgent; 'delegated' = every listener called next().
    agent.fire = (name: string, request: any) => { const list = agent.hooks.get(name) ?? []; let index = 0; const run = (): Promise<unknown> => (list[index++]?.(request, run) ?? Promise.resolve('delegated')); return run() }
    agent.followup = vi.fn((message: any) => { agent.status = 'running'; agent.inbox.nextTurn.push(message); logs.set(id, [{ type: 'agent/inbox/spliced', seq: 0, time: 1, data: { inserted: [message] } }, { type: 'turn/start', seq: 1, time: 2, data: {} }]) })
    agent.cancel = vi.fn((cause?: { kind: string }) => { agent.status = 'idle'; agent.inbox.nextTurn = []; agent.inbox.nextStep = []; if (cause?.kind !== 'disposed') logs.set(id, end('aborted')) })
    agents.set(id, agent); if (!logs.has(id)) logs.set(id, [])
    return { agent, dispose: vi.fn(async () => { agents.delete(id) }) }
  }
  services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'native', model: 'model' }) },
    agents: { get: (id: string) => agents.get(id), create: vi.fn(make), resume: vi.fn(make) },
    sessionQuery: { observeSession: vi.fn(async (id: string) => { if (!logs.has(id)) throw missing(); return { header: headers.get(id), events: [...logs.get(id)!], [Symbol.dispose]: () => {} } }) },
    subagents: {
      startActivation: vi.fn(async (spec: { childId: string; delivery: 'parent'; request: { cwd?: string; parent: { session: { header: { cwd: string } } } } }) => { headers.set(spec.childId, { id: spec.childId, cwd: spec.request.cwd ?? spec.request.parent.session.header.cwd }); logs.set(spec.childId, end()); return { childId: spec.childId, messageId: 'initial-child-message', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} } }),
      sendMessage: vi.fn(async () => 'delegated-message'), prompt: vi.fn(async () => ({ messageId: 'human-child-message' })),
      drainChildren: vi.fn(async () => {}), drainDescendants: vi.fn(async () => {}),
    },
  }
  runtime = new WorkforceRuntime(store, name => services[name])
})
afterEach(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })

async function task() {
  const sent = await runtime.send('channel-general', '完成任务')
  const binding = (await store.read()).bindings[sent.thread.id]!
  return { sent, binding, parent: agents.get(binding.rootId) }
}

function asyncGate() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  return { entered, waiting, enter, release }
}

it('频道普通连续追问复用进行中任务与计时窗口，轮询完成后新消息独立建单', async () => {
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    const first = await runtime.send('channel-general', '先完成任务甲', undefined, { requestId: 'channel-sequential-a' })
    const binding = (await store.read()).bindings[first.thread.id]!
    now += 1000
    const followup = await runtime.send('channel-general', '补充要求：简短一些', undefined, { requestId: 'channel-sequential-b' })
    const state = await store.read(), parent = agents.get(binding.rootId)!
    expect(followup.thread.id).toBe(first.thread.id)
    expect(followup.taskId).toBe(first.taskId)
    expect(state.tasks).toHaveLength(1)
    expect(services.agents.create).toHaveBeenCalledTimes(1)
    expect(parent.followup).toHaveBeenCalledTimes(2)
    expect(state.bindings[first.thread.id]!.runStartedAt).toBe(binding.runStartedAt)
    parent.status = 'idle'; parent.inbox.nextTurn = []; parent.inbox.nextStep = []
    logs.set(binding.rootId, end('completed'))
    await runtime.messages(first.thread.id)
    now += 1000
    const next = await runtime.send('channel-general', '开始独立任务乙', undefined, { requestId: 'channel-sequential-c' })
    const settled = await store.read()
    expect(next.thread.id).not.toBe(first.thread.id)
    expect(next.taskId).not.toBe(first.taskId)
    expect(settled.tasks).toHaveLength(2)
    expect(settled.tasks.find(item => item.id === first.taskId)!.status).toBe('done')
    expect(settled.bindings[first.thread.id]!.runStartedAt).toBeUndefined()
    expect(settled.bindings[next.thread.id]!.rootId).not.toBe(binding.rootId)
    expect(settled.bindings[next.thread.id]!.runStartedAt).toBe(now)
    expect(services.agents.create).toHaveBeenCalledTimes(2)
  } finally { clock.mockRestore() }
})

it('同频道不同 requestId 并发只建一个任务/root，两份消息与回执各投递一次', async () => {
  const gate = asyncGate(), create = services.agents.create.getMockImplementation()!
  services.agents.create.mockImplementationOnce(async (options: any) => { gate.enter(); await gate.waiting; return create(options) })
  const sending = Promise.all([
    runtime.send('channel-general', '先完成任务甲', undefined, { requestId: 'channel-parallel-a' }),
    runtime.send('channel-general', '补充要求：简短一些', undefined, { requestId: 'channel-parallel-b' }),
  ])
  try {
    await gate.entered
    expect((await store.read()).tasks).toHaveLength(1)
    expect(services.agents.create).toHaveBeenCalledTimes(1)
  } finally { gate.release() }
  const [first, second] = await sending
  const state = await store.read(), binding = state.bindings[first.thread.id]!, parent = agents.get(binding.rootId)!
  expect(second.thread.id).toBe(first.thread.id)
  expect(second.taskId).toBe(first.taskId)
  expect(second.message.id).not.toBe(first.message.id)
  expect(state.tasks).toHaveLength(1)
  expect(services.agents.create).toHaveBeenCalledTimes(1)
  expect(parent.followup.mock.calls.map(([message]: any[]) => message.id)).toEqual([first.message.id, second.message.id])
  expect(Object.values(binding.humanTexts!)).toEqual([
    { text: '先完成任务甲', batch: first.message.id },
    { text: '补充要求：简短一些', batch: second.message.id },
  ])
  for (const requestId of ['channel-parallel-a', 'channel-parallel-b']) {
    expect(state.sendReceipts[requestId]).toMatchObject({ threadId: first.thread.id, deliveredTo: ['leader'] })
  }
})

it('agent/status 完成投影仍在途时，频道新请求先读最新终态并获得独立计时窗口', async () => {
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now), gate = asyncGate()
  let projection: ReturnType<typeof vi.spyOn> | undefined
  try {
    const { sent, binding, parent } = await task()
    parent.status = 'idle'; parent.inbox.nextTurn = []; parent.inbox.nextStep = []
    logs.set(binding.rootId, end('completed'))
    services.sessionQuery.observeSession.mockImplementationOnce(async (id: string) => {
      const events = structuredClone(logs.get(id)!)
      gate.enter(); await gate.waiting
      return { header: headers.get(id), events, [Symbol.dispose]: () => {} }
    })
    projection = vi.spyOn(runtime, 'messages')
    await parent.fire('agent/status', {})
    await gate.entered
    expect((await store.read()).tasks.find(item => item.id === sent.taskId)!.status).toBe('running')
    now += 2000
    const next = await runtime.send('channel-general', '新任务应从新会话开始', undefined, { requestId: 'channel-status-race' })
    const state = await store.read()
    expect(next.thread.id).not.toBe(sent.thread.id)
    expect(next.taskId).not.toBe(sent.taskId)
    expect(state.tasks).toHaveLength(2)
    expect(state.tasks.find(item => item.id === sent.taskId)!.status).toBe('done')
    expect(state.bindings[sent.thread.id]!.runStartedAt).toBeUndefined()
    expect(state.bindings[next.thread.id]!.rootId).not.toBe(binding.rootId)
    expect(state.bindings[next.thread.id]!.runStartedAt).toBe(now)
    expect(state.bindings[next.thread.id]!.runStartedAt).not.toBe(binding.runStartedAt)
    expect(parent.followup).toHaveBeenCalledTimes(1)
  } finally {
    gate.release()
    await projection?.mock.results[0]?.value
    projection?.mockRestore(); clock.mockRestore()
  }
})

it('频道在途与排队追问不能越过停止，失败后新频道消息和显式线程追问仍可发送', async () => {
  const { sent, binding, parent } = await task()
  const gate = asyncGate(), recentTaskIndex = store.recentTaskIndex.bind(store)
  vi.spyOn(store, 'recentTaskIndex').mockImplementationOnce(async (...args) => { gate.enter(); await gate.waiting; return recentTaskIndex(...args) })
  const pending = runtime.send('channel-general', '已在途的补充要求', undefined, { requestId: 'channel-cancel-inflight' })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  await gate.entered
  const queued = runtime.send('channel-general', '停止前排队的补充要求', undefined, { requestId: 'channel-cancel-queued' })
  const queuedRejected = expect(queued).rejects.toMatchObject({ code: 'cancelled' })
  try { await runtime.cancel(sent.taskId!) } finally { gate.release() }
  await Promise.all([rejected, queuedRejected])
  const cancelled = await store.read()
  expect(cancelled.tasks).toHaveLength(1)
  expect(cancelled.tasks[0]!.status).toBe('cancelled')
  expect((await store.thread(sent.thread.id)).status).toBe('cancelled')
  expect(parent.followup).toHaveBeenCalledTimes(1)
  expect(parent.status).toBe('idle')
  expect(cancelled.bindings[sent.thread.id]!.runStartedAt).toBeUndefined()
  const next = await runtime.send('channel-general', '停止后主动发送的新任务', undefined, { requestId: 'channel-after-cancel' })
  const nextBinding = (await store.read()).bindings[next.thread.id]!
  expect(next.thread.id).not.toBe(sent.thread.id)
  expect(nextBinding.rootId).not.toBe(binding.rootId)
  expect((await store.read()).tasks).toHaveLength(2)
  expect((await store.read()).tasks.find(item => item.id === sent.taskId)!.status).toBe('cancelled')
  const explicit = await runtime.send(sent.thread.id, '停止后主动继续原线程', undefined, { requestId: 'thread-after-cancel' })
  expect(explicit.thread.id).toBe(sent.thread.id)
  expect((await store.read()).bindings[sent.thread.id]!.rootId).toBe(binding.rootId)
  expect((await store.read()).tasks.find(item => item.id === sent.taskId)!.status).toBe('running')
  expect(parent.followup).toHaveBeenCalledTimes(2)
})

it('频道请求第一次读取期间停止，取消前进入的请求不能在返回后另开新任务', async () => {
  const { sent, parent } = await task()
  const gate = asyncGate(), thread = store.thread.bind(store)
  vi.spyOn(store, 'thread').mockImplementationOnce(async id => { gate.enter(); await gate.waiting; return thread(id) })
  const pending = runtime.send('channel-general', '取消前进入的频道追问', undefined, { requestId: 'channel-cancel-first-read' })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  await gate.entered
  try { await runtime.cancel(sent.taskId!) } finally { gate.release() }
  await rejected
  expect((await store.read()).tasks).toHaveLength(1)
  expect((await store.read()).tasks[0]!.status).toBe('cancelled')
  expect(parent.followup).toHaveBeenCalledTimes(1)
})

it('频道普通追问首次读取挂起时停止旧任务，仍投给较新且运行中的独立任务', async () => {
  const first = await runtime.send('channel-general', '@负责人 任务甲', 'leader', { requestId: 'channel-independent-a' })
  const second = await runtime.send('channel-general', '@负责人 任务乙', 'leader', { requestId: 'channel-independent-b' })
  await store.change(state => {
    state.threads.find(item => item.id === first.thread.id)!.updatedAt = '2026-10-11T00:00:00.000Z'
    state.threads.find(item => item.id === second.thread.id)!.updatedAt = '2026-10-11T00:00:01.000Z'
  })
  const before = await store.read(), firstBinding = before.bindings[first.thread.id]!, secondBinding = before.bindings[second.thread.id]!
  expect(before.tasks.filter(item => item.status === 'running')).toHaveLength(2)
  const gate = asyncGate(), thread = store.thread.bind(store)
  vi.spyOn(store, 'thread').mockImplementationOnce(async id => { gate.enter(); await gate.waiting; return thread(id) })
  const pending = runtime.send('channel-general', '继续任务乙：补充核对', undefined, { requestId: 'channel-followup-other-cancel' })
  // 先接住失败结果，防止取消断言外出现未处理拒绝；成功条件仍在下方逐项核对。
  const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  await gate.entered
  try { await runtime.cancel(first.taskId!) } finally { gate.release() }
  const result = await outcome
  expect(result.error).toBeUndefined()
  expect(result.value).toMatchObject({ taskId: second.taskId, thread: { id: second.thread.id } })
  const state = await store.read()
  expect(state.tasks).toHaveLength(2)
  expect(state.tasks.find(item => item.id === first.taskId)!.status).toBe('cancelled')
  expect(state.tasks.find(item => item.id === second.taskId)!.status).toBe('running')
  expect(state.bindings[second.thread.id]!.rootId).toBe(secondBinding.rootId)
  expect(state.bindings[second.thread.id]!.runStartedAt).toBe(secondBinding.runStartedAt)
  expect(agents.get(firstBinding.rootId).followup).toHaveBeenCalledTimes(1)
  expect(agents.get(secondBinding.rootId).followup).toHaveBeenCalledTimes(2)
  expect(state.sendReceipts['channel-followup-other-cancel']).toMatchObject({ threadId: second.thread.id, deliveredTo: ['leader'] })
  expect(services.agents.create).toHaveBeenCalledTimes(2)
})

it('频道普通追问首次读取挂起时停止最新任务，不转投仍运行的旧任务', async () => {
  const older = await runtime.send('channel-general', '@负责人 旧任务乙', 'leader', { requestId: 'channel-older-b' })
  const latest = await runtime.send('channel-general', '@负责人 新任务甲', 'leader', { requestId: 'channel-latest-a' })
  await store.change(state => {
    state.threads.find(item => item.id === older.thread.id)!.updatedAt = '2026-10-11T00:00:00.000Z'
    state.threads.find(item => item.id === latest.thread.id)!.updatedAt = '2026-10-11T00:00:01.000Z'
  })
  const before = await store.read(), olderBinding = before.bindings[older.thread.id]!, latestBinding = before.bindings[latest.thread.id]!
  const gate = asyncGate(), thread = store.thread.bind(store)
  vi.spyOn(store, 'thread').mockImplementationOnce(async id => { gate.enter(); await gate.waiting; return thread(id) })
  const pending = runtime.send('channel-general', '停止前进入的新任务追问', undefined, { requestId: 'channel-latest-cancelled' })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  await gate.entered
  try { await runtime.cancel(latest.taskId!) } finally { gate.release() }
  await rejected
  const state = await store.read()
  expect(state.tasks).toHaveLength(2)
  expect(state.tasks.find(item => item.id === latest.taskId)!.status).toBe('cancelled')
  expect(state.tasks.find(item => item.id === older.taskId)!.status).toBe('running')
  expect(state.bindings[older.thread.id]!.runStartedAt).toBe(olderBinding.runStartedAt)
  expect(agents.get(olderBinding.rootId).followup).toHaveBeenCalledTimes(1)
  expect(agents.get(latestBinding.rootId).followup).toHaveBeenCalledTimes(1)
  expect(services.agents.create).toHaveBeenCalledTimes(2)
})

it('频道追问投影目标挂起期间显式 @ 插入新任务，不改投未经投影的已完成新会话', async () => {
  const { sent, binding, parent } = await task()
  await store.change(state => { state.threads.find(item => item.id === sent.thread.id)!.updatedAt = '2026-10-11T00:00:00.000Z' })
  const gate = asyncGate()
  services.sessionQuery.observeSession.mockImplementationOnce(async (id: string) => {
    const events = structuredClone(logs.get(id)!)
    expect(id).toBe(binding.rootId)
    gate.enter(); await gate.waiting
    return { header: headers.get(id), events, [Symbol.dispose]: () => {} }
  })
  const pending = runtime.send('channel-general', '继续当前任务的补充核对', undefined, { requestId: 'channel-fixed-projection' })
  let inserted!: Awaited<ReturnType<typeof runtime.send>>, insertedRoot!: string, insertedAgent: any
  try {
    await gate.entered
    inserted = await runtime.send('channel-general', '@负责人 独立新任务', 'leader', { requestId: 'channel-inserted-completed' })
    insertedRoot = (await store.read()).bindings[inserted.thread.id]!.rootId
    insertedAgent = agents.get(insertedRoot)!
    insertedAgent.status = 'idle'; insertedAgent.inbox.nextTurn = []; insertedAgent.inbox.nextStep = []
    logs.set(insertedRoot, end('completed'))
    await store.change(state => { state.threads.find(item => item.id === inserted.thread.id)!.updatedAt = '2026-10-11T00:00:01.000Z' })
    // B 原生会话已完成，刻意不触发 status hook 或主动轮询，让持久化候选仍为 running。
    expect((await store.read()).tasks.find(item => item.id === inserted.taskId)!.status).toBe('running')
  } finally { gate.release() }
  const routed = await pending, state = await store.read()
  expect(routed.thread.id).toBe(sent.thread.id)
  expect(routed.taskId).toBe(sent.taskId)
  expect(routed.thread.id).not.toBe(inserted.thread.id)
  expect(state.tasks).toHaveLength(2)
  expect(state.bindings[sent.thread.id]!.rootId).toBe(binding.rootId)
  expect(state.bindings[sent.thread.id]!.runStartedAt).toBe(binding.runStartedAt)
  expect(parent.followup).toHaveBeenCalledTimes(2)
  expect(insertedAgent.followup).toHaveBeenCalledTimes(1)
  expect(insertedAgent.status).toBe('idle')
  expect(insertedAgent.inbox.nextTurn).toEqual([])
  expect(state.sendReceipts['channel-fixed-projection']).toMatchObject({ threadId: sent.thread.id, deliveredTo: ['leader'] })
  expect(services.agents.create).toHaveBeenCalledTimes(2)
})

it('频道显式 @ 创建的独立任务仍在途时，停止旧任务不取消新任务投递', async () => {
  const { sent, binding, parent } = await task()
  const gate = asyncGate(), recentTaskIndex = store.recentTaskIndex.bind(store)
  vi.spyOn(store, 'recentTaskIndex').mockImplementationOnce(async (...args) => { gate.enter(); await gate.waiting; return recentTaskIndex(...args) })
  const pending = runtime.send('channel-general', '@执行员 独立写稿', 'writer', { requestId: 'channel-explicit-independent' })
  try {
    await gate.entered
    expect((await store.read()).tasks).toHaveLength(2)
    await runtime.cancel(sent.taskId!)
  } finally { gate.release() }
  const next = await pending
  const state = await store.read(), nextBinding = state.bindings[next.thread.id]!, direct = agents.get(nextBinding.directChildren!.writer!)!
  expect(next.thread.id).not.toBe(sent.thread.id)
  expect(nextBinding.rootId).not.toBe(binding.rootId)
  expect(state.tasks.find(item => item.id === sent.taskId)!.status).toBe('cancelled')
  expect(state.tasks.find(item => item.id === next.taskId)!.status).toBe('running')
  expect(parent.followup).toHaveBeenCalledTimes(1)
  expect(agents.get(nextBinding.rootId).followup).not.toHaveBeenCalled()
  expect(direct.followup).toHaveBeenCalledTimes(1)
  expect(direct.followup.mock.calls[0][0].content[0].text).toContain('@执行员 独立写稿')
  expect(state.sendReceipts['channel-explicit-independent']!.deliveredTo).toEqual(['writer'])
  expect(services.subagents.startActivation).not.toHaveBeenCalled()
})

it('任务标题跳过材料引用，原始prompt保留供员工读取', async () => {
  const prompt = '已上传材料「材料.txt」 materialId=uuid\n\n请分析产品要求并写文案'
  const sent = await runtime.send('channel-general', prompt)
  expect(sent.thread.title).toBe('请分析产品要求并写文案')
  expect((await store.read()).tasks[0]).toMatchObject({ title: sent.thread.title, prompt })
  expect(titleFromPrompt('已上传材料「材料.txt」')).toBe('材料任务')
})

it('root投递为人类消息，独立cwd；原生open turn不能显示完成', async () => {
  const { sent, binding, parent } = await task()
  expect(services.agents.create.mock.calls[0][0].meta.cwd).toBe(resolve(store.directory, 'workspaces', sent.thread.id, 'scratch', binding.rootId))
  expect(parent.followup.mock.calls[0][0].source.kind).toBe('user')
  parent.status = 'idle'; parent.inbox.nextTurn = []
  expect((await runtime.messages(sent.thread.id)).thread.status).toBe('running')
  expect((await store.read()).tasks[0]?.status).toBe('running')
})

it('G2 新 binding 持久化 scoped-v2，child/direct 业务兄弟叶子的同名文件与材料副本互不覆盖', async () => {
  const { sent, binding, parent } = await task()
  const material = await store.upload('输入.txt', '共享原材料')
  const childId = await runtime.delegate(parent, 'analyst', '分析', new AbortController().signal)
  await runtime.send(sent.thread.id, '@分析员 直接执行', 'analyst')
  const persisted = (await new WorkforceStore(root).read()).bindings[sent.thread.id]!
  expect(persisted.workspaceLayout).toBe('scoped-v2')
  const directId = persisted.directChildren!.analyst!
  expect(directId).not.toBe(childId)
  const sessions = [
    { id: binding.rootId, content: 'ROOT' },
    { id: childId, content: 'CHILD' },
    { id: directId, content: 'DIRECT' },
  ]
  for (const session of sessions) {
    const cwd = (await runtime.workspaceRoot(session.id))!
    expect(cwd).toBe(resolve(store.directory, 'workspaces', sent.thread.id, 'scratch', session.id))
    await writeFile(join(cwd, 'report.md'), session.content)
    const staged = await runtime.readMaterial(session.id, material.id, true)
    expect(staged.staged).toBe(true)
    expect(staged.localPath).toBe(join('inputs', material.id, '输入.txt'))
    await writeFile(join(cwd, staged.localPath!), session.content)
  }
  for (const session of sessions) {
    const cwd = (await runtime.workspaceRoot(session.id))!
    expect(await readFile(join(cwd, 'report.md'), 'utf8')).toBe(session.content)
    const staged = await runtime.readMaterial(session.id, material.id, true)
    expect(staged.reused).toBe(true)
    expect(await readFile(join(cwd, staged.localPath!), 'utf8')).toBe(session.content)
  }
  expect((await store.material(material.id)).content).toBe('共享原材料')
})

it('文件成果从当前root/child/direct业务目录读取：同轮修订同一版本，下一轮用户消息后才递增', async () => {
  const { sent, binding, parent } = await task()
  const childId = await runtime.delegate(parent, 'analyst', '分析', new AbortController().signal)
  await runtime.send(sent.thread.id, '@分析员 直接执行', 'analyst')
  const directId = (await store.read()).bindings[sent.thread.id]!.directChildren!.analyst!
  const sessions = [binding.rootId, childId, directId]
  for (const [index, sessionId] of sessions.entries()) {
    await writeFile(join((await runtime.workspaceRoot(sessionId))!, 'restored.md'), `# 第${index + 1}份\n完整正文😀`)
    const saved = await runtime.saveDeliverable(sessionId, '成果.md', undefined, 'restored.md')
    // 同一轮用户消息内：首存建 v1，后续保存修订 v1（版本号不变，内容以最后一次为准）。
    expect(saved.version).toBe(1)
    expect(saved.revised).toBe(index > 0 ? true : undefined)
    const current = (await store.read()).tasks.find(item => item.threadId === sent.thread.id)!
    expect(await readFile((await store.deliverableFile(current.id, '成果.md', String(saved.version))).path, 'utf8')).toBe(`# 第${index + 1}份\n完整正文😀`)
    expect(current.deliverables[0]!.versions).toHaveLength(1)
    expect(current.deliverables[0]!.versions[0]).toMatchObject({ version: 1, authorId: 'leader', sessionId })
  }
  // 覆盖 cwd 源文件不影响已存版本。
  await writeFile(join(headers.get(binding.rootId)!.cwd, 'restored.md'), '覆盖源文件但不是旧版成果')
  const current = (await store.read()).tasks.find(item => item.threadId === sent.thread.id)!
  expect(await readFile((await store.deliverableFile(current.id, '成果.md', '1')).path, 'utf8')).toBe('# 第3份\n完整正文😀')
  // 下一轮用户消息后，同名保存才生成 v2；旧版不变。
  await runtime.send(sent.thread.id, '第二轮：再改一份', 'analyst')
  const second = await runtime.saveDeliverable(binding.rootId, '成果.md', '# 第二轮定稿\n', undefined)
  expect(second.version).toBe(2)
  expect(second.revised).toBeUndefined()
  expect(await readFile((await store.deliverableFile(current.id, '成果.md', '1')).path, 'utf8')).toBe('# 第3份\n完整正文😀')
  await expect(runtime.saveDeliverable(childId, '成果.md', undefined, `../${binding.rootId}/restored.md`)).rejects.toMatchObject({ code: 'bad_request' })
  await expect(runtime.saveDeliverable(childId, '成果.md', '引用', 'restored.md')).rejects.toThrow('二选一')
  await expect(runtime.saveDeliverable(childId, '成果.md', undefined, undefined)).rejects.toThrow('二选一')
})

it('文件成果使用原生会话当前cwd而非数据根下同尾路径，缺cwd及取消不保存', async () => {
  const { sent, binding } = await task()
  const header = headers.get(binding.rootId)!
  await writeFile(join(header.cwd, 'restored.md'), '旧数据根正文')
  const currentCwd = join(root, 'moved', 'workspaces', sent.thread.id, 'scratch', binding.rootId)
  await mkdir(currentCwd, { recursive: true })
  await writeFile(join(currentCwd, 'restored.md'), '当前原生cwd正文')
  header.cwd = currentCwd
  const saved = await runtime.saveDeliverable(binding.rootId, '成果.md', undefined, 'restored.md')
  const current = (await store.read()).tasks.find(item => item.threadId === sent.thread.id)!
  expect(await readFile((await store.deliverableFile(current.id, '成果.md', String(saved.version))).path, 'utf8')).toBe('当前原生cwd正文')
  const controller = new AbortController()
  controller.abort()
  await expect(runtime.saveDeliverable(binding.rootId, '成果.md', undefined, 'restored.md', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  header.cwd = ''
  await expect(runtime.saveDeliverable(binding.rootId, '成果.md', undefined, 'restored.md')).rejects.toMatchObject({ code: 'unavailable' })
  expect((await store.read()).tasks.find(item => item.id === current.id)!.deliverables[0]!.versions.map(item => item.version)).toEqual([1])
})

it('G2 旧共享 binding 归档重建独立 root/child，已有文件保留在旧目录', async () => {
  const { sent, binding } = await task()
  await runtime.dispose()
  agents.clear()
  const cwd = resolve(store.directory, 'sessions', sent.thread.id)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, '旧文件.txt'), '旧线程原文')
  await store.change(state => { delete state.bindings[sent.thread.id]!.workspaceLayout })
  headers.set(binding.rootId, { id: binding.rootId, cwd })
  logs.set(binding.rootId, end())
  store = new WorkforceStore(root)
  runtime = new WorkforceRuntime(store, name => services[name])
  await runtime.send(sent.thread.id, '继续旧任务')
  const rebuiltBinding = (await store.read()).bindings[sent.thread.id]!
  const parent = agents.get(rebuiltBinding.rootId)!
  const childId = await runtime.delegate(parent, 'analyst', '继续旧派工', new AbortController().signal)
  expect((await store.read()).bindings[sent.thread.id]).toHaveProperty('workspaceLayout', 'scoped-v2')
  expect(parent.session.header.cwd).toBe(resolve(store.directory, 'workspaces', sent.thread.id, 'scratch', rebuiltBinding.rootId))
  expect(headers.get(childId)!.cwd).toBe(parent.session.header.cwd)
  expect(services.agents.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: rebuiltBinding.rootId }))
  expect(await readFile(join(cwd, '旧文件.txt'), 'utf8')).toBe('旧线程原文')
})

it('并发派给同员工只建一个child，人类@续问走直达会话不再回投负责人', async () => {
  const { sent, parent } = await task()
  const signal = new AbortController().signal
  const ids = await Promise.all([runtime.delegate(parent, 'analyst', '分析一', signal), runtime.delegate(parent, 'analyst', '分析二', signal)])
  expect(ids[0]).toBe(ids[1])
  expect(services.subagents.startActivation).toHaveBeenCalledTimes(1)
  expect(services.subagents.sendMessage).toHaveBeenCalledTimes(1)
  await runtime.send(sent.thread.id, '@分析员 补充核对', 'analyst')
  // 用户直达投递不碰 continuable 链路：无 prompt/sendMessage，负责人会话不新增输入
  const binding = (await store.read()).bindings[sent.thread.id]!
  const directId = binding.directChildren!['analyst']!
  expect(directId).not.toBe(ids[0])
  expect(services.subagents.prompt).not.toHaveBeenCalled()
  expect(services.subagents.sendMessage).toHaveBeenCalledTimes(1)
  const direct = agents.get(directId)!
  expect(direct.followup).toHaveBeenCalledTimes(1)
  const humanMessage = direct.followup.mock.calls[0][0]
  expect(humanMessage.source.kind).toBe('user')
  expect(parent.followup).toHaveBeenCalledTimes(1)
  expect((await store.read()).bindings[sent.thread.id]?.humanMessageIds).toContain(humanMessage.id)
})

it('取消释放child而不封闭parent，随后追问可继续；DM不接受其他员工', async () => {
  const { sent, parent } = await task()
  await runtime.delegate(parent, 'analyst', '分析', new AbortController().signal)
  await runtime.cancel(sent.taskId!)
  expect(services.subagents.drainChildren).toHaveBeenCalledTimes(1)
  expect(services.subagents.drainDescendants).not.toHaveBeenCalled()
  expect((await store.read()).tasks[0]?.status).toBe('cancelled')
  await runtime.send(sent.thread.id, '继续核对')
  expect(parent.followup).toHaveBeenCalledTimes(2)
  expect((await store.read()).tasks[0]?.status).toBe('running')
  const dm = await runtime.ensureDm('writer')
  await expect(runtime.send(dm.id, '错发', 'analyst')).rejects.toMatchObject({ code: 'bad_request' })
})

it('重启恢复使用原root，修复封口的interrupted标为可继续而非失败', async () => {
  const { sent, binding } = await task()
  await runtime.dispose(); agents.clear()
  logs.set(binding.rootId, end('interrupted'))
  runtime = new WorkforceRuntime(store, name => services[name])
  await runtime.recover()
  expect(services.agents.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: binding.rootId }))
  expect((await store.read()).tasks[0]?.status).toBe('interrupted')
  const view = await runtime.messages(sent.thread.id)
  expect(view.thread.status).toBe('interrupted')
  expect(view.messages.some(item => item.role === 'system' && item.text === '已中断 · 回复可继续' && item.error === undefined)).toBe(true)
  await runtime.send(sent.thread.id, '继续')
  expect((await store.read()).tasks[0]?.status).toBe('running')
})

it('运行任务重启的aborted/disposed明确失败，新completed解除旧失败', async () => {
  const { sent, binding } = await task()
  await runtime.dispose(); agents.clear()
  const interrupted = end('aborted', 4)
  interrupted[1]!.data = { reason: { kind: 'aborted', cause: { kind: 'disposed' } } } as any
  logs.set(binding.rootId, interrupted)
  runtime = new WorkforceRuntime(store, name => services[name])
  await runtime.recover()
  expect((await store.read()).tasks[0]?.status).toBe('failed')
  expect((await runtime.messages(sent.thread.id)).messages.some(item => item.error?.includes('aborted'))).toBe(true)
  logs.set(binding.rootId, [...interrupted, { type: 'turn/start', seq: 2, time: 5, data: {} }, { type: 'turn/end', seq: 3, time: 6, data: { reason: { kind: 'completed' } } }])
  expect((await runtime.messages(sent.thread.id)).thread.status).toBe('idle')
  expect((await store.read()).tasks[0]?.status).toBe('done')
  expect((await store.read()).tasks[0]?.error).toBeUndefined()
})

it('已有DM空闲后应用更正模型，保留原session与历史', async () => {
  const dm = await runtime.ensureDm('writer')
  await store.saveEmployee({ model: 'invalid' }, 'writer')
  await runtime.send(dm.id, '第一次')
  const binding = (await store.read()).bindings[dm.id]!, previous = agents.get(binding.rootId)
  previous.status = 'idle'; previous.inbox.nextTurn = []; logs.set(binding.rootId, end('error'))
  await store.saveEmployee({ model: '' }, 'writer')
  await runtime.send(dm.id, '更正后继续')
  expect(services.agents.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: binding.rootId, agentOptions: { provider: 'native', model: 'model' } }))
  expect(agents.get(binding.rootId)).not.toBe(previous)
  expect(agents.get(binding.rootId).options.model).toBe('model')
  expect((await store.read()).bindings[dm.id]?.rootId).toBe(binding.rootId)
})

it('旧cancelled消息观察不能覆盖追问后状态', async () => {
  const { sent, binding, parent } = await task()
  await runtime.cancel(sent.taskId!)
  let captured!: () => void, release!: () => void
  const observed = new Promise<void>(resolve => { captured = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  services.sessionQuery.observeSession.mockImplementationOnce(async () => { const events = structuredClone(logs.get(binding.rootId)); captured(); await barrier; return { events, [Symbol.dispose]: () => {} } })
  const stale = runtime.messages(sent.thread.id)
  await observed
  await runtime.send(sent.thread.id, '继续')
  release(); await stale
  expect(parent.followup).toHaveBeenCalledTimes(2)
  expect((await store.read()).tasks[0]?.status).toBe('running')
  expect((await store.thread(sent.thread.id)).status).toBe('running')
})

it('send第一次读取期间取消完成，旧请求仍被代际拦截', async () => {
  const { sent, parent } = await task()
  let captured!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { captured = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  const thread = store.thread.bind(store)
  vi.spyOn(store, 'thread').mockImplementationOnce(async id => { captured(); await barrier; return thread(id) })
  const pending = runtime.send(sent.thread.id, '取消前进入的续问')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  await entered
  await runtime.cancel(sent.taskId!)
  release(); await rejected
  expect(parent.followup).toHaveBeenCalledTimes(1)
  expect((await store.read()).tasks[0]?.status).toBe('cancelled')
})

it('root创建延迟期间取消成功后，旧投递不能followup或重开状态', async () => {
  let captured!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { captured = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  const create = services.agents.create.getMockImplementation()
  services.agents.create.mockImplementationOnce(async (options: any) => { captured(); await barrier; return create(options) })
  const pending = runtime.send('channel-general', '延迟任务')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  await entered
  const task = (await store.read()).tasks[0]!
  await runtime.cancel(task.id)
  release(); await rejected
  const parent = agents.get((await store.read()).bindings[task.threadId]!.rootId)
  expect(parent.followup).not.toHaveBeenCalled()
  expect((await store.read()).tasks[0]?.status).toBe('cancelled')
  await runtime.send(task.threadId, '新的追问')
  expect(parent.followup).toHaveBeenCalledTimes(1)
  expect((await store.read()).tasks[0]?.status).toBe('running')
})

it('取消截断待完成child派工，新追问等待取消收尾后继续', async () => {
  const { sent, parent } = await task()
  let captured!: () => void, release!: () => void, cancellationEntered!: () => void
  const entered = new Promise<void>(resolve => { captured = resolve })
  const aborting = new Promise<void>(resolve => { cancellationEntered = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  let admissionSignal!: AbortSignal
  services.subagents.startActivation.mockImplementationOnce(async (spec: any) => {
    admissionSignal = spec.signal
    captured()
    await barrier
    spec.signal.throwIfAborted()
    return { childId: spec.childId, messageId: 'late-child' }
  })
  const delegated = runtime.delegate(parent, 'analyst', '待派工', new AbortController().signal)
  const rejected = expect(delegated).rejects.toThrow()
  await entered
  admissionSignal.addEventListener('abort', cancellationEntered, { once: true })
  const cancellation = runtime.cancel(sent.taskId!)
  await aborting
  const followup = runtime.send(sent.thread.id, '取消后继续')
  release(); await rejected; await cancellation; await followup
  expect(admissionSignal.aborted).toBe(true)
  expect((await store.read()).bindings[sent.thread.id]?.children.analyst).toBeUndefined()
  expect(parent.followup).toHaveBeenCalledTimes(2)
  expect((await store.read()).tasks[0]?.status).toBe('running')
})

it.each(['error', 'aborted'])('失败child(%s)更正模型后同线程恢复，新child使用新配置并保留旧错误历史', async kind => {
  const { sent, parent, binding } = await task()
  await store.saveEmployee({ model: 'invalid' }, 'analyst')
  const previous = await runtime.delegate(parent, 'analyst', '首次分析', new AbortController().signal)
  logs.set(previous, [
    { type: 'subagent/descriptor', seq: 0, time: 1, data: { version: 3, mode: 'continuable', provider: 'spawn', label: '分析员', agentProvider: 'native', agentModel: 'invalid' } },
    { type: 'turn/start', seq: 1, time: 3, data: {} },
    { type: 'turn/end', seq: 2, time: 4, data: { reason: { kind, error: { message: '错误模型' } } } },
  ])
  parent.status = 'idle'; parent.inbox.nextTurn = []; logs.set(binding.rootId, end('completed', 2))
  await store.saveEmployee({ model: '' }, 'analyst')
  // 失败 child 的重建由负责人下一次派工触发（用户 @ 走直达会话，不重建委派 child）
  await runtime.delegate(parent, 'analyst', '配置修正后继续分析', new AbortController().signal)
  const current = (await store.read()).bindings[sent.thread.id]!
  expect(current.children.analyst).not.toBe(previous)
  expect(current.archivedChildren).toEqual([{ employeeId: 'analyst', sessionId: previous }])
  expect(services.subagents.startActivation.mock.calls[1][0].request.agentOptions).toEqual({ provider: 'native', model: 'model' })
  const view = await runtime.messages(sent.thread.id)
  expect(view.messages.some(item => item.error === '错误模型')).toBe(true)
  expect(view.thread.status).toBe('idle')
  expect((await store.read()).tasks[0]?.status).toBe('done')
  await store.saveEmployee({ model: 'another-model' }, 'analyst')
  // 用户直接 @ 投递到直达顶层会话：委派 child 保持原样，不再有 prompt 续投
  await runtime.send(sent.thread.id, '成功会话继续固定配置', 'analyst')
  expect(services.subagents.startActivation).toHaveBeenCalledTimes(2)
  expect(services.subagents.prompt).not.toHaveBeenCalled()
  expect((await store.read()).bindings[sent.thread.id]!.directChildren!['analyst']).toBeTruthy()
})

it('运行中DM禁止删除员工，删除后历史可读取但不能再发送', async () => {
  const dm = await runtime.ensureDm('writer')
  await runtime.send(dm.id, '保留的私信')
  await expect(store.deleteEmployee('writer')).rejects.toMatchObject({ code: 'conflict' })
  const binding = (await store.read()).bindings[dm.id]!, parent = agents.get(binding.rootId)
  const input = parent.followup.mock.calls[0][0]
  parent.status = 'idle'; parent.inbox.nextTurn = []
  logs.set(binding.rootId, [{ type: 'user/message', seq: 0, time: 1, data: input }, ...end()])
  await runtime.messages(dm.id)
  await store.deleteEmployee('writer')
  expect((await runtime.ensureDm('writer')).id).toBe(dm.id)
  expect((await runtime.messages(dm.id)).messages.some(item => item.text === '保留的私信')).toBe(true)
  await expect(runtime.send(dm.id, '不能投递')).rejects.toMatchObject({ code: 'bad_request' })
  expect(parent.followup).toHaveBeenCalledTimes(1)
})

it('消息整形：👀到✅不随后续turn回退，回复带replyTo，过程文字标intermediate，activity反映实时状态', async () => {
  const dm = await runtime.ensureDm('writer')
  await runtime.send(dm.id, '先看一眼')
  const binding = (await store.read()).bindings[dm.id]!
  const sessionId = binding.rootId, parent = agents.get(sessionId)
  const humanMessage = parent.followup.mock.calls[0][0]
  parent.status = 'idle'; parent.inbox.nextTurn = []
  const assistant = (seq: number, time: number, value: string) => ({ type: 'assistant/message', seq, time, data: { message: { content: [{ type: 'text', text: value }] } } })
  const base = [
    { type: 'user/message', seq: 0, time: 1, data: humanMessage },
    { type: 'turn/start', seq: 1, time: 2, data: {} },
  ]

  // turn 打开未输出：👀 + thinking
  logs.set(sessionId, [...base])
  let view = await runtime.messages(dm.id)
  expect(view.messages.find(item => item.role === 'user')!.reactions).toEqual([{ emoji: '👀', employeeId: 'writer' }])
  expect(view.activity).toEqual([{ employeeId: 'writer', state: 'thinking' }])

  // 有运行中工具：activity=tool 并带工具名
  logs.set(sessionId, [...base, assistant(2, 3, '中间说明'), { type: 'tool/call', seq: 3, time: 4, data: { callId: 'c1', name: 'wb_read_material' } }])
  view = await runtime.messages(dm.id)
  expect(view.activity).toEqual([{ employeeId: 'writer', state: 'tool', tool: 'wb_read_material' }])

  // turn 正常结束：✅、最终答复 replyTo、工具行 turnId
  logs.set(sessionId, [...logs.get(sessionId)!,
    { type: 'tool/result', seq: 4, time: 5, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '材料正文' }] } } },
    assistant(5, 6, '最终答复'),
    { type: 'turn/end', seq: 6, time: 7, data: { reason: { kind: 'completed' } } },
  ])
  view = await runtime.messages(dm.id)
  const human = view.messages.find(item => item.role === 'user')!
  expect(human.reactions).toEqual([{ emoji: '✅', employeeId: 'writer' }])
  const intermediate = view.messages.find(item => item.text === '中间说明')!
  expect(intermediate.intermediate).toBe(true)
  expect(intermediate.replyTo).toBeUndefined()
  const final = view.messages.find(item => item.text === '最终答复')!
  expect(final.replyTo).toBe(human.id)
  expect(final.intermediate).toBeUndefined()
  const tool = view.messages.find(item => item.tool?.name === 'wb_read_material')!
  expect(tool.tool?.status).toBe('done')
  expect(tool.turnId).toBe(`${sessionId}:1`)
  expect(final.turnId).toBe(`${sessionId}:1`)
  expect(view.activity).toEqual([])

  // 新一轮 turn 打开：已有 ✅ 不退回 👀；新状态 thinking
  logs.set(sessionId, [...logs.get(sessionId)!, { type: 'turn/start', seq: 7, time: 8, data: {} }])
  view = await runtime.messages(dm.id)
  expect(view.messages.find(item => item.role === 'user')!.reactions).toEqual([{ emoji: '✅', employeeId: 'writer' }])
  expect(view.activity).toEqual([{ employeeId: 'writer', state: 'thinking' }])

  // 落盘正文 + turn 未结束：仍是 thinking——assistant/message 落盘即该步输出完成，typing 只认进程内流式帧（见下个用例）
  logs.set(sessionId, [...logs.get(sessionId)!,
    { type: 'tool/call', seq: 8, time: 9, data: { callId: 'c2', name: 'web_fetch' } },
    { type: 'tool/result', seq: 9, time: 10, data: { message: { toolCallId: 'c2', content: [{ type: 'text', text: 'ok' }] } } },
    assistant(10, 11, '正在写'),
  ])
  view = await runtime.messages(dm.id)
  expect(view.activity).toEqual([{ employeeId: 'writer', state: 'thinking' }])
  const followup = view.messages.find(item => item.text === '正在写')!
  expect(followup.intermediate).toBeUndefined()
  expect(followup.replyTo).toBeUndefined()
  expect(view.messages.find(item => item.tool?.name === 'web_fetch')!.tool?.status).toBe('done')
})

it('流式帧驱动 typing：正文 text-delta 到达才亮，推理/工具参数增量与 attempt 结束回落思考', async () => {
  const dm = await runtime.ensureDm('writer')
  await runtime.send(dm.id, '写稿')
  const binding = (await store.read()).bindings[dm.id]!
  const sessionId = binding.rootId
  const state = async () => (await runtime.messages(dm.id)).activity.find(item => item.employeeId === 'writer')?.state
  expect(await state()).toBe('thinking')
  runtime.noteAssistantFrame(sessionId, { type: 'start' })
  runtime.noteAssistantFrame(sessionId, { type: 'chunk', chunk: { type: 'reasoning-delta', text: '想' } })
  expect(await state()).toBe('thinking')
  runtime.noteAssistantFrame(sessionId, { type: 'chunk', chunk: { type: 'tool-call-delta' } })
  expect(await state()).toBe('thinking')
  runtime.noteAssistantFrame(sessionId, { type: 'chunk', chunk: { type: 'text-delta', text: '字' } })
  expect(await state()).toBe('typing')
  runtime.noteAssistantFrame(sessionId, { type: 'end' })
  expect(await state()).toBe('thinking')
  runtime.noteAssistantFrame(sessionId, { type: 'chunk', chunk: { type: 'text-delta', text: '字' } })
  runtime.noteAssistantDisposed(sessionId)
  expect(await state()).toBe('thinking')
})

it('DM和cancelled任务读取故障明确报unavailable，不用空历史掩盖', async () => {
  const dm = await runtime.ensureDm('writer')
  expect((await runtime.messages(dm.id)).messages).toEqual([])
  await runtime.send(dm.id, '已有私信')
  const { sent } = await task()
  await runtime.cancel(sent.taskId!)
  services.sessionQuery.observeSession.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
  await expect(runtime.messages(dm.id)).rejects.toMatchObject({ code: 'unavailable', message: '原生会话暂时无法读取，请重试' })
  await expect(runtime.messages(sent.thread.id)).rejects.toMatchObject({ code: 'unavailable' })
  expect((await store.read()).tasks[0]?.status).toBe('cancelled')
})

it('投递落盘窗口内缺失的session按暂无历史跳过，宽限期后仍缺失才报unavailable', async () => {
  const { sent, binding } = await task()
  logs.delete(binding.rootId)
  expect((await runtime.messages(sent.thread.id)).messages).toEqual([])
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000)
  try {
    await expect(runtime.messages(sent.thread.id)).rejects.toMatchObject({ code: 'unavailable' })
  } finally { now.mockRestore() }
})

it('无默认模型不创建任务，native读取失败不报告done', async () => {
  services.agentDefaultModel.currentSelection = () => undefined
  await expect(runtime.send('channel-general', '任务')).rejects.toMatchObject({ code: 'model_unavailable' })
  expect((await store.read()).tasks).toHaveLength(0)
  services.agentDefaultModel.currentSelection = () => ({ provider: 'native', model: 'model' })
  const { sent, parent } = await task()
  parent.status = 'idle'; parent.inbox.nextTurn = []
  services.sessionQuery.observeSession.mockRejectedValue(new Error('storage failure'))
  await expect(runtime.messages(sent.thread.id)).rejects.toMatchObject({ code: 'unavailable' })
  expect((await store.read()).tasks[0]?.status).toBe('running')
})

it('提问卡片截获原生waterfall并路由应答；非工作台会话委托给其他answerer', async () => {
  const { sent, binding, parent } = await task()
  parent.status = 'idle'; parent.inbox.nextTurn = []
  const held = parent.fire('user-questions/request', {
    questions: [{ id: 'q1', question: '选哪种风格？', options: [{ label: '方案A' }, { label: '方案B', description: '更稳重' }] }],
    wait: { callId: 'call-1' },
  })
  const card = (await runtime.messages(sent.thread.id)).messages.find(item => item.question)!
  const question = card.question!
  expect(card.senderId).toBe(binding.ownerId)
  expect(question.items[0]!.options).toHaveLength(2)
  expect(question.callId).toBe('call-1')
  expect(question.answered).toBeUndefined()
  // 非法选项被拒
  await expect(runtime.answerAsk(sent.thread.id, question.requestId, { answers: [{ id: 'q1', selected: ['不存在'] }] })).rejects.toMatchObject({ code: 'bad_request' })
  await runtime.answerAsk(sent.thread.id, question.requestId, { answers: [{ id: 'q1', selected: ['方案B'], custom: '偏稳重' }] })
  await expect(held).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案B'], custom: '偏稳重' }] })
  // 重复提交冲突；卡片留为只读已回答态
  await expect(runtime.answerAsk(sent.thread.id, question.requestId, { answers: [{ id: 'q1', selected: ['方案A'] }] })).rejects.toMatchObject({ code: 'conflict' })
  const done = (await runtime.messages(sent.thread.id)).messages.find(item => item.question)!
  expect(done.question!.answered![0]).toMatchObject({ selected: ['方案B'], custom: '偏稳重' })
  // 非本工作台会话：address() 失败 → next() 委托给后续 answerer（如原生客户端）
  const stray: any = { id: 'stray', session: { id: 'stray' }, hooks: new Map() }
  stray.ctx = { on: (name: string, fn: any) => stray.hooks.set(name, fn) }
  stray.fire = (name: string, request: any) => stray.hooks.get(name)!(request, () => Promise.resolve('delegated'))
  runtime.hookAgent(stray)
  await expect(stray.fire('user-questions/request', { questions: [] })).resolves.toBe('delegated')
  await expect(stray.fire('approval/request', { toolName: 'shell.run' })).resolves.toBe('delegated')
})

it('ASK legacy callId 关联：同C工具上下文取 exec.callId，原生 wait.callId 显式优先，跨 agent 上下文不采信', async () => {
  const { sent, parent } = await task()
  parent.status = 'idle'; parent.inbox.nextTurn = []
  const [execListener] = parent.hooks.get('tools/execute')!
  // 同 C：legacy 请求（原生不带 wait.callId）发生在包住本次 ask_user_question 执行的上下文内 → 关联真实 exec.callId，卡片从一开始就是 cont 身份
  let heldSameC!: Promise<unknown>
  await execListener({ name: 'ask_user_question', agent: parent, callId: 'call-exec-9' }, () => {
    heldSameC = parent.fire('user-questions/request', { agent: parent, questions: [{ id: 'q1', question: '同步哪一期？' }] })
    return Promise.resolve('delegated')
  })
  const sameC = (await runtime.messages(sent.thread.id)).messages.find(item => item.question)!
  expect(sameC.id).toBe('ask-cont-call-exec-9')
  expect(sameC.question!.callId).toBe('call-exec-9')
  expect(sameC.question!.requestId).toBe('cont-call-exec-9')
  // wait 优先：上下文里同时存在 exec.callId，原生显式 wait.callId 仍优先采信，并标 timed 前台等待
  let heldWait!: Promise<unknown>
  await execListener({ name: 'ask_user_question', agent: parent, callId: 'call-exec-2' }, () => {
    heldWait = parent.fire('user-questions/request', { agent: parent, wait: { callId: 'call-wait-2', timed: true }, questions: [{ id: 'q2', question: '用哪版？' }] })
    return Promise.resolve('delegated')
  })
  const waitCard = (await runtime.messages(sent.thread.id)).messages.find(item => item.question?.requestId === 'cont-call-wait-2')!
  expect(waitCard.question!.callId).toBe('call-wait-2')
  // timed 是 wire 上的附加标记（WorkforceQuestion 未声明该字段），按真实渲染形状断言
  expect((waitCard.question as unknown as { timed?: boolean }).timed).toBe(true)
  await runtime.answerAsk(sent.thread.id, 'cont-call-wait-2', { answers: [{ id: 'q2', selected: ['正式'] }] })
  await expect(heldWait).resolves.toEqual({ answers: [{ id: 'q2', selected: ['正式'] }] })
  // 跨 agent 隔离：writer 的请求发生在 leader 的 exec 上下文里——agent 与会话都不同源，不采信 leader 的 callId，身份各自独立
  const dm = await runtime.ensureDm('writer')
  const writerSession = (await store.read()).bindings[dm.id]!.rootId
  headers.set(writerSession, { id: writerSession, cwd: root })
  logs.set(writerSession, end())
  const writer: any = { id: writerSession, session: { id: writerSession }, hooks: new Map(), status: 'idle', inbox: { nextTurn: [], nextStep: [] } }
  writer.ctx = { on: (name: string, fn: any) => writer.hooks.set(name, [...(writer.hooks.get(name) ?? []), fn]) }
  writer.fire = (name: string, request: any) => { const list = writer.hooks.get(name) ?? []; let index = 0; const run = (): Promise<unknown> => (list[index++]?.(request, run) ?? Promise.resolve('delegated')); return run() }
  runtime.hookAgent(writer)
  let heldWriter!: Promise<unknown>
  await execListener({ name: 'ask_user_question', agent: parent, callId: 'call-leak-3' }, () => {
    heldWriter = writer.fire('user-questions/request', { agent: writer, questions: [{ id: 'q3', question: 'writer 独立的问题' }] })
    return Promise.resolve('delegated')
  })
  const writerCard = (await runtime.messages(dm.id)).messages.find(item => item.question)!
  expect(writerCard.question!.callId).toBeUndefined()
  expect(writerCard.id.startsWith('ask-cont-call-leak-3')).toBe(false)
  // 双向隔离：leader 同 C 挂起按自己 cont 身份作答，writer 卡按自身 requestId 独立作答，互不串线
  await runtime.answerAsk(sent.thread.id, 'cont-call-exec-9', { answers: [{ id: 'q1', selected: ['第一期'] }] })
  await expect(heldSameC).resolves.toEqual({ answers: [{ id: 'q1', selected: ['第一期'] }] })
  await runtime.answerAsk(dm.id, writerCard.question!.requestId, { answers: [{ id: 'q3', selected: ['好的'] }] })
  await expect(heldWriter).resolves.toEqual({ answers: [{ id: 'q3', selected: ['好的'] }] })
})

it('冷已答重建：从同session真实call/result恢复answered单卡（C/id/ts/原selected+custom保）；live/投影同C去重；pending/isError/repair/坏JSON/空answers不伪answered', async () => {
  const { sent, binding, parent } = await task()
  parent.status = 'idle'; parent.inbox.nextTurn = []
  const askCallEvent = (callId: string, seq: number, questions: unknown[]) =>
    ({ type: 'tool/call', seq, time: seq, data: { callId, name: 'ask_user_question', turn: seq >= 18 ? 2 : 1, arguments: JSON.stringify({ questions }) } })
  const askResultEvent = (callId: string, seq: number, text: string, extra: Record<string, unknown> = {}) =>
    ({ type: 'tool/result', seq, time: seq, data: { message: { toolCallId: callId, content: [{ type: 'text', text }], ...extra } } })
  const questions = [{ id: 'q1', question: '用哪版？' }, { id: 'q2', question: '先出大纲？' }]
  // 该 legacy 直答样本证据：成功 result 的 answers JSON。isError 只在 repair/stop 形状里出现。
  logs.set(binding.rootId, [
    { type: 'turn/start', seq: 0, time: 0, data: {} },
    askCallEvent('c-old-1', 1, questions),
    askResultEvent('c-old-1', 2, JSON.stringify({ answers: [{ id: 'q1', selected: ['正式', 42, null] }, { id: 'q2', selected: ['草稿'], custom: '先出大纲' }] })),
    askCallEvent('c-proj-2', 3, questions),
    askResultEvent('c-proj-2', 4, JSON.stringify({ answers: [{ id: 'q1', selected: ['投影'] }] })),
    askCallEvent('c-live-3', 5, questions),
    askResultEvent('c-live-3', 6, JSON.stringify({ answers: [{ id: 'q1', selected: ['不应出现'] }] })),
    askCallEvent('c-pending-4', 7, questions),
    askResultEvent('c-pending-4', 8, JSON.stringify({ pending: true })),
    askCallEvent('c-error-5', 9, questions),
    askResultEvent('c-error-5', 10, '用户停止', { isError: true }),
    askCallEvent('c-badjson-7', 11, questions),
    askResultEvent('c-badjson-7', 12, '不是json'),
    askCallEvent('c-empty-8', 13, questions),
    askResultEvent('c-empty-8', 14, JSON.stringify({ answers: [] })),
    askCallEvent('c-nonarray-9', 15, questions),
    askResultEvent('c-nonarray-9', 16, JSON.stringify({ answers: '全选' })),
    { type: 'turn/end', seq: 17, time: 17, data: { turn: 1, reason: { kind: 'completed' } } },
    askCallEvent('c-repair-6', 18, questions),
    { type: 'tool/result', seq: 19, time: 19, data: { message: { toolCallId: 'c-repair-6', isError: true, id: 'interrupted-tool-result-1', content: [{ type: 'text', text: '结果不可达' }] }, error: { code: 'TOOL_OUTCOME_UNKNOWN' } } },
    { type: 'turn/end', seq: 20, time: 20, data: { turn: 2, reason: { kind: 'interrupted' } } },
  ])
  // live 同 C 去重：内存 pendingAsks 仍握着 c-live-3 的前台等待，历史 answered result 不得再造第二张
  const held = parent.fire('user-questions/request', { wait: { callId: 'c-live-3', timed: true }, questions })
  const view = await runtime.messages(sent.thread.id)
  const cards = view.messages.filter(item => item.id.startsWith('ask-cont-'))
  // 冷已答重建：C/id/ts/原答案保真（selected 过滤非字符串、custom 字符串才保留），状态 answered
  const cold = cards.find(item => item.id === 'ask-cont-c-old-1')!
  expect(cold).toBeTruthy()
  expect(cold.question!.requestId).toBe('cont-c-old-1')
  expect(cold.question!.callId).toBe('c-old-1')
  expect(cold.ts).toBe(new Date(1).toISOString())
  expect(cold.text).toBe('用哪版？\n先出大纲？')
  expect(cold.question!.answered).toEqual([{ id: 'q1', selected: ['正式'] }, { id: 'q2', selected: ['草稿'], custom: '先出大纲' }])
  expect(cold.question!.status).toBe('answered')
  // live 同 C 去重：只有内存 active 卡一张，不带历史 answered
  const liveCards = cards.filter(item => item.id === 'ask-cont-c-live-3')
  expect(liveCards).toHaveLength(1)
  expect(liveCards[0]!.question!.status).toBe('active')
  expect(liveCards[0]!.question!.answered).toBeUndefined()
  // 既有投影 settled 同 C 去重：投影卡已渲染，重建循环不再补第二张
  services.sessionProjections = {
    stateOf: () => ({ questions: { active: [], settled: [{ callId: 'c-proj-2', answers: [{ id: 'q1', selected: ['投影'] }] }] } }),
  }
  const viewWithProjection = await runtime.messages(sent.thread.id)
  expect(viewWithProjection.messages.filter(item => item.id === 'ask-cont-c-proj-2')).toHaveLength(1)
  expect(viewWithProjection.messages.find(item => item.id === 'ask-cont-c-proj-2')!.question!.status).toBe('answered')
  // 负例：timeout 的 pending、普通 isError 停止、坏 JSON、空 answers、非数组 answers 都不伪 answered
  for (const ghost of ['c-pending-4', 'c-error-5', 'c-badjson-7', 'c-empty-8', 'c-nonarray-9']) {
    expect(viewWithProjection.messages.some(item => item.id === `ask-cont-${ghost}`)).toBe(false)
    expect(viewWithProjection.messages.some(item => item.id === `ask-${ghost}`)).toBe(false)
  }
  // repair 封存保持原门：重建为 inactive 只读卡（endedAsks 循环），不翻成 answered
  const repairCard = viewWithProjection.messages.find(item => item.id === 'ask-cont-c-repair-6')!
  expect(repairCard).toBeTruthy()
  expect(repairCard.question!.status).toBe('inactive')
  expect(repairCard.question!.answered).toBeUndefined()
  expect(repairCard.question!.requestId).toBe('cont-c-repair-6')
  // 同 C 跨 session 不混：另一会话同 callId 的历史 result 各自归各自会话渲染，答案不串线
  const dm = await runtime.ensureDm('writer')
  const writerSession = (await store.read()).bindings[dm.id]!.rootId
  headers.set(writerSession, { id: writerSession, cwd: root })
  logs.set(writerSession, [
    { type: 'turn/start', seq: 0, time: 0, data: {} },
    askCallEvent('c-old-1', 1, questions),
    askResultEvent('c-old-1', 2, JSON.stringify({ answers: [{ id: 'q1', selected: ['writer版'] }] })),
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const writerView = await runtime.messages(dm.id)
  const writerCold = writerView.messages.find(item => item.id === 'ask-cont-c-old-1')!
  expect(writerCold.question!.answered).toEqual([{ id: 'q1', selected: ['writer版'] }])
  expect(writerCold.question!.status).toBe('answered')
  // leader 会话的原答案不受另一会话同 C result 影响
  expect(cold.question!.answered).toEqual([{ id: 'q1', selected: ['正式'] }, { id: 'q2', selected: ['草稿'], custom: '先出大纲' }])
  // 真实原生证据未动：held 前台等待仍可由真实身份作答（每道题都要有一项答案）
  await runtime.answerAsk(sent.thread.id, 'cont-c-live-3', { answers: [{ id: 'q1', selected: ['正式'] }, { id: 'q2', selected: [] }] })
  await expect(held).resolves.toEqual({ answers: [{ id: 'q1', selected: ['正式'] }, { id: 'q2', selected: [] }] })
})

it('冷迟答重建（native contract）：user/message与spliced迟答JSON按source/payload自洽恢复单卡；dispose后新runtime同store/logs真冷恢复；错source/outcome/kind/tool/C、pending无答案与跨session不造卡', async () => {
  const { sent, binding } = await task()
  const questions = [{ id: 'q1', question: '用哪版？' }]
  const askCallEvent = (callId: string, seq: number) =>
    ({ type: 'tool/call', seq, time: seq, data: { callId, name: 'ask_user_question', turn: 1, arguments: JSON.stringify({ questions }) } })
  const pendingResult = (callId: string, seq: number) =>
    ({ type: 'tool/result', seq, time: seq, data: { message: { toolCallId: callId, content: [{ type: 'text', text: '{"pending":true}' }] } } })
  // timed 迟答原生持久 contract：source={kind:'user-question-reply',callId,outcome:'answered'}，
  // payload JSON {kind:'answer_to_pending_question',tool:'ask_user_question',callId,answers}，callId 自洽
  const lateMessage = (callId: string, sourcePatch: Record<string, unknown> = {}, payloadPatch: Record<string, unknown> = {}) => ({
    source: { kind: 'user-question-reply', callId, outcome: 'answered', ...sourcePatch },
    content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId, questions, answers: [{ id: 'q1', selected: ['正式'], custom: '要快' }], ...payloadPatch }) }],
  })
  logs.set(binding.rootId, [
    { type: 'turn/start', seq: 0, time: 0, data: {} },
    askCallEvent('c-late-ok', 1),
    pendingResult('c-late-ok', 2),
    { type: 'user/message', seq: 3, time: 3, data: lateMessage('c-late-ok') },
    askCallEvent('c-spliced-2', 4),
    pendingResult('c-spliced-2', 5),
    { type: 'agent/inbox/spliced', seq: 6, time: 6, data: { inserted: [lateMessage('c-spliced-2'), lateMessage('c-spliced-2')] } },
    askCallEvent('c-outcome-3', 7),
    pendingResult('c-outcome-3', 8),
    { type: 'user/message', seq: 9, time: 9, data: lateMessage('c-outcome-3', { outcome: 'rejected' }) },
    askCallEvent('c-skind-4', 10),
    pendingResult('c-skind-4', 11),
    { type: 'user/message', seq: 12, time: 12, data: lateMessage('c-skind-4', { kind: 'human-message' }) },
    askCallEvent('c-pkind-5', 13),
    pendingResult('c-pkind-5', 14),
    { type: 'user/message', seq: 15, time: 15, data: lateMessage('c-pkind-5', {}, { kind: 'other_payload' }) },
    askCallEvent('c-tool-6', 16),
    pendingResult('c-tool-6', 17),
    { type: 'user/message', seq: 18, time: 18, data: lateMessage('c-tool-6', {}, { tool: 'wb_other' }) },
    askCallEvent('c-callid-7', 19),
    pendingResult('c-callid-7', 20),
    { type: 'user/message', seq: 21, time: 21, data: lateMessage('c-callid-7', {}, { callId: 'c-elsewhere' }) },
    askCallEvent('c-ansarr-8', 22),
    pendingResult('c-ansarr-8', 23),
    { type: 'user/message', seq: 24, time: 24, data: lateMessage('c-ansarr-8', {}, { answers: '全选' }) },
    askCallEvent('c-pending-9', 25),
    pendingResult('c-pending-9', 26),
    { type: 'turn/end', seq: 27, time: 27, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const view = await runtime.messages(sent.thread.id)
  // 正例：user/message 与 spliced 迟答各恢复单卡；spliced 同 C 重复只一张
  for (const callId of ['c-late-ok', 'c-spliced-2']) {
    const card = view.messages.filter(item => item.id === `ask-cont-${callId}`)
    expect(card).toHaveLength(1)
    expect(card[0]!.question!.requestId).toBe(`cont-${callId}`)
    expect(card[0]!.question!.callId).toBe(callId)
    expect(card[0]!.question!.answered).toEqual([{ id: 'q1', selected: ['正式'], custom: '要快' }])
    expect(card[0]!.question!.status).toBe('answered')
    expect(card[0]!.text).toBe('用哪版？')
  }
  expect(view.messages.find(item => item.id === 'ask-cont-c-late-ok')!.ts).toBe(new Date(1).toISOString())
  // 负例：错 source.kind/outcome、错 payload kind/tool、callId 不自洽、answers 非数组、纯 pending 无迟答 → 不造卡
  for (const ghost of ['c-outcome-3', 'c-skind-4', 'c-pkind-5', 'c-tool-6', 'c-callid-7', 'c-ansarr-8', 'c-pending-9']) {
    expect(view.messages.some(item => item.id === `ask-cont-${ghost}`)).toBe(false)
  }
  // 真 cold：dispose 后重新 instantiate 同 store/logs，纯历史恢复同 C/id/ts/selected/custom
  await runtime.dispose()
  agents.clear()
  runtime = new WorkforceRuntime(store, name => services[name])
  const coldView = await runtime.messages(sent.thread.id)
  const coldLate = coldView.messages.find(item => item.id === 'ask-cont-c-late-ok')!
  expect(coldLate).toBeTruthy()
  expect(coldLate.question!.answered).toEqual([{ id: 'q1', selected: ['正式'], custom: '要快' }])
  expect(coldLate.ts).toBe(new Date(1).toISOString())
  expect(coldLate.question!.status).toBe('answered')
  // 同 C 跨 session 不混：另一会话同 callId 的迟答 JSON 各自归各自会话
  const dm = await runtime.ensureDm('writer')
  const writerSession = (await store.read()).bindings[dm.id]!.rootId
  headers.set(writerSession, { id: writerSession, cwd: root })
  logs.set(writerSession, [
    { type: 'turn/start', seq: 0, time: 0, data: {} },
    askCallEvent('c-late-ok', 1),
    pendingResult('c-late-ok', 2),
    { type: 'user/message', seq: 3, time: 3, data: lateMessage('c-late-ok', {}, { answers: [{ id: 'q1', selected: ['writer版'] }] }) },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const writerView = await runtime.messages(dm.id)
  expect(writerView.messages.find(item => item.id === 'ask-cont-c-late-ok')!.question!.answered).toEqual([{ id: 'q1', selected: ['writer版'] }])
  expect(coldView.messages.find(item => item.id === 'ask-cont-c-late-ok')!.question!.answered).toEqual([{ id: 'q1', selected: ['正式'], custom: '要快' }])
})

it('多选与自由输入校验；前台等待signal取消释放挂起卡片', async () => {
  const { sent, parent } = await task()
  parent.status = 'idle'; parent.inbox.nextTurn = []
  const controller = new AbortController()
  const held = parent.fire('user-questions/request', {
    signal: controller.signal,
    questions: [{ id: 'q1', question: '挑两项', multi_select: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }],
  })
  const card = (await runtime.messages(sent.thread.id)).messages.find(item => item.question)!
  const question = card.question!
  expect(question.items[0]!.multiSelect).toBe(true)
  await runtime.answerAsk(sent.thread.id, question.requestId, { answers: [{ id: 'q1', selected: ['A', 'C'], custom: '再短一点' }] })
  await expect(held).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A', 'C'], custom: '再短一点' }] })
  // 前台等待被原生取消（超时/调用中断）：挂起卡片释放，waterfall 走 abort 路径
  const second = new AbortController()
  const held2 = parent.fire('user-questions/request', { signal: second.signal, questions: [{ id: 'q2', question: '还继续吗？' }] })
  expect((await runtime.messages(sent.thread.id)).messages.filter(item => item.question && !item.question.answered)).toHaveLength(1)
  second.abort()
  await expect(held2).rejects.toBeTruthy()
  expect((await runtime.messages(sent.thread.id)).messages.filter(item => item.question && !item.question.answered)).toHaveLength(0)
})

it('审批卡片允许一次/拒绝；timed续答走原生userQuestions.answer', async () => {
  const { sent, binding, parent } = await task()
  parent.status = 'idle'; parent.inbox.nextTurn = []
  const held = parent.fire('approval/request', { toolName: 'shell.run', reason: '需要写权限' })
  const card = (await runtime.messages(sent.thread.id)).messages.find(item => item.approval)!
  const approval = card.approval!
  expect(approval.toolName).toBe('shell.run')
  expect(approval.reason).toBe('需要写权限')
  await expect(runtime.answerAsk(sent.thread.id, approval.requestId, { outcome: 'always' })).rejects.toMatchObject({ code: 'bad_request' })
  await runtime.answerAsk(sent.thread.id, approval.requestId, { outcome: 'allowed-once' })
  await expect(held).resolves.toBe('allowed-once')
  // timed 超时后的续答题：原生投影 continued，路由走 userQuestions.answer
  services.userQuestions = { answer: vi.fn(() => true) }
  services.sessionProjections = {
    stateOf: () => ({ questions: {
      active: [{ callId: 'tc1', state: 'continued', questions: [{ id: 'q1', question: '用哪版？' }] }],
      settled: [{ callId: 'done1', answers: [{ id: 'q9', selected: ['旧选项'] }] }],
    } }),
  }
  logs.set(binding.rootId, [
    { type: 'turn/start', seq: 1, time: 1, data: {} },
    { type: 'tool/call', seq: 2, time: 2, data: { callId: 'tc1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q1', question: '用哪版？' }] }) } },
    { type: 'tool/result', seq: 3, time: 3, data: { message: { toolCallId: 'tc1', content: [{ type: 'text', text: '{"pending":true}' }] } } },
    { type: 'tool/call', seq: 4, time: 4, data: { callId: 'done1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q9', question: '旧问题' }] }) } },
    { type: 'turn/end', seq: 5, time: 5, data: { reason: { kind: 'completed' } } },
  ])
  const view = await runtime.messages(sent.thread.id)
  const cont = view.messages.find(item => item.question?.requestId === 'cont-tc1')!
  expect(cont.question!.continued).toBe(true)
  const settled = view.messages.find(item => item.question?.requestId === 'cont-done1')!
  expect(settled.question!.answered![0]!.selected).toEqual(['旧选项'])
  expect(settled.question!.items[0]!.question).toBe('旧问题')
  await runtime.answerAsk(sent.thread.id, 'cont-tc1', { answers: [{ id: 'q1', selected: [], custom: '用第二版' }] })
  expect(services.userQuestions.answer).toHaveBeenCalledWith(parent, 'tc1', { answers: [{ id: 'q1', selected: [], custom: '用第二版' }] })
  await expect(runtime.answerAsk(sent.thread.id, 'cont-gone', { answers: [] })).rejects.toMatchObject({ code: 'not_found' })
  await expect(runtime.answerAsk(sent.thread.id, 'missing-id', { answers: [] })).rejects.toMatchObject({ code: 'not_found' })
})

it('重新生成：DM回复以同员工重投原问题并附换一种方式指令；频道与用户消息被拒', async () => {
  const dm = await runtime.ensureDm('leader')
  const binding = (await store.read()).bindings[dm.id]!
  const cwd = resolve(store.directory, 'workspaces', dm.id, 'scratch', binding.rootId)
  headers.set(binding.rootId, { id: binding.rootId, cwd })
  await mkdir(cwd, { recursive: true })
  logs.set(binding.rootId, [
    { type: 'user/message', seq: 1, time: 1, data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '写一个口号' }] } },
    { type: 'turn/start', seq: 2, time: 2, data: {} },
    { type: 'assistant/message', seq: 3, time: 3, data: { message: { content: [{ type: 'text', text: '旧口号' }] } } },
    { type: 'turn/end', seq: 4, time: 4, data: { reason: { kind: 'completed' } } },
  ])
  const list = (await runtime.messages(dm.id)).messages
  const reply = list.find(item => item.role === 'agent' && item.text === '旧口号')!
  expect(reply.replyTo).toBe('u1')
  const resent = vi.spyOn(runtime, 'send')
  await runtime.regenerateMessage(dm.id, reply.id)
  const [threadArg, promptArg, employeeArg] = resent.mock.calls[0]!
  expect(threadArg).toBe(dm.id)
  expect(employeeArg).toBe('leader')
  expect(promptArg).toContain('写一个口号')
  expect(promptArg).toContain('请换一种方式重新回答上一条')
  // 用户消息与未知 id 拒绝；频道主线不可直接再生成
  await expect(runtime.regenerateMessage(dm.id, 'u1')).rejects.toMatchObject({ code: 'bad_request' })
  await expect(runtime.regenerateMessage(dm.id, '不存在')).rejects.toMatchObject({ code: 'bad_request' })
  await expect(runtime.regenerateMessage('channel-general', reply.id)).rejects.toMatchObject({ code: 'bad_request' })
})

it('重新生成子员工回复按用户再@语义投递：followup 进直达会话，不触碰委派child', async () => {
  const { sent, binding, parent } = await task()
  await runtime.delegate(parent, 'analyst', '分析', new AbortController().signal)
  const childId = (await store.read()).bindings[sent.thread.id]!.children['analyst']!
  logs.set(binding.rootId, [
    { type: 'user/message', seq: 1, time: 1, data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '完成任务' }] } },
    { type: 'turn/start', seq: 2, time: 2, data: {} },
    { type: 'turn/end', seq: 3, time: 3, data: { reason: { kind: 'completed' } } },
  ])
  logs.set(childId, [
    { type: 'turn/start', seq: 1, time: 2, data: {} },
    { type: 'assistant/message', seq: 2, time: 3, data: { message: { content: [{ type: 'text', text: '初版分析' }] } } },
    { type: 'turn/end', seq: 3, time: 4, data: { reason: { kind: 'completed' } } },
  ])
  const list = (await runtime.messages(sent.thread.id)).messages
  const reply = list.find(item => item.senderId === 'analyst' && item.text === '初版分析')!
  await runtime.regenerateMessage(sent.thread.id, reply.id)
  // 直达会话投递：不回投负责人、不经 subagents 服务、委派 child 保持原样
  expect(services.subagents.prompt).not.toHaveBeenCalled()
  const directId = (await store.read()).bindings[sent.thread.id]!.directChildren!['analyst']!
  expect(directId).not.toBe(childId)
  const direct = agents.get(directId)!
  const forwarded = JSON.stringify(direct.followup.mock.calls[0]![0].content)
  expect(forwarded).toContain('完成任务')
  expect(forwarded).toContain('请换一种方式重新回答上一条')
  expect(parent.followup).toHaveBeenCalledTimes(1)
})

it('滞留inbox重放：idle+pending清空重入队并唤醒驱动；已取消线程不重放不播报', async () => {
  const functionalInbox = (): any => {
    const inbox: any = { nextTurn: [], nextStep: [] }
    inbox.clear = vi.fn(() => { inbox.nextTurn = []; inbox.nextStep = [] })
    inbox.append = vi.fn((target: string, message: any) => inbox[target === 'next-turn' ? 'nextTurn' : 'nextStep'].push(message))
    return inbox
  }
  const dm = await runtime.ensureDm('leader')
  await runtime.send(dm.id, '你好')
  const binding = (await store.read()).bindings[dm.id]!
  const parent = agents.get(binding.rootId)!
  logs.set(binding.rootId, end('completed'))
  parent.inbox = functionalInbox()
  parent.send = vi.fn((message: any) => {
    const index = parent.inbox.nextTurn.findIndex((item: any) => item.id === message.id)
    if (index >= 0) parent.inbox.nextTurn.splice(index, 1)
  })
  parent.status = 'idle'
  const first = { id: 'stranded-1', role: 'user', content: [{ type: 'text', text: '追问一' }], source: { kind: 'user' } }
  parent.inbox.nextTurn.push(first, { id: 'stranded-2', role: 'user', content: [{ type: 'text', text: '追问二' }], source: { kind: 'user' } })
  // 首轮读取触发重放：首项带唤醒重投，其余保序重入队（驱动按序逐 turn 消费）
  const view = await runtime.messages(dm.id)
  expect(parent.send).toHaveBeenCalledWith(first, 'next-turn', true)
  expect(parent.inbox.nextTurn.map((item: any) => item.id)).toEqual(['stranded-2'])
  expect(view.activity).toEqual([{ employeeId: 'leader', state: 'thinking' }])
  parent.inbox.nextTurn = [] // 模拟驱动已消费完滞留队列
  expect((await runtime.messages(dm.id)).activity).toEqual([])

  // 仅剩 next-step（teardown 期 inject 的 settlement 通知）：以末项 steer 唤醒
  const steerLast = { id: 'steer-2' }
  parent.send.mockClear(); parent.inbox.nextStep.push({ id: 'steer-1' }, steerLast)
  await runtime.messages(dm.id)
  expect(parent.send).toHaveBeenCalledWith(steerLast, 'next-step', true)
  parent.inbox.nextStep = []

  // 已取消线程：滞留队列不重放、activity 不播报
  const sent = await runtime.send('channel-general', '取消我的任务')
  const cancelledBinding = (await store.read()).bindings[sent.thread.id]!
  const cancelledRoot = agents.get(cancelledBinding.rootId)!
  cancelledRoot.inbox = functionalInbox(); cancelledRoot.inbox.nextTurn.push({ id: 'late' })
  cancelledRoot.send = vi.fn(); cancelledRoot.status = 'idle'
  const taskId = (await store.read()).tasks.find(item => item.threadId === sent.thread.id)!.id
  await runtime.cancel(taskId)
  const afterCancel = await runtime.messages(sent.thread.id)
  expect(cancelledRoot.send).not.toHaveBeenCalled()
  expect(afterCancel.activity).toEqual([])
})

it('/tasks增量刷新：idle未变线程不重读会话；running、修订变动与滞留inbox仍重算', async () => {
  const calls = () => services.sessionQuery.observeSession.mock.calls.length
  const { sent, binding, parent } = await task()
  parent.status = 'idle'; parent.inbox.nextTurn = []; parent.inbox.nextStep = []
  logs.set(binding.rootId, end())
  // 首轮重算把派生状态落成 idle
  await runtime.refreshTasks()
  expect((await store.thread(sent.thread.id)).status).toBe('idle')
  const baseline = calls()
  expect(baseline).toBeGreaterThan(0)
  // 其后 idle 且未变的线程整体跳过，不再读会话日志
  await runtime.refreshTasks(); await runtime.refreshTasks()
  expect(calls()).toBe(baseline)
  // running 线程每轮重算：完成只能由 messages() 读会话发现
  await runtime.send(sent.thread.id, '继续追问') // followup 置 running + nextTurn
  await runtime.refreshTasks()
  expect(calls()).toBeGreaterThan(baseline)
  const mid = calls()
  await runtime.refreshTasks()
  expect(calls()).toBeGreaterThan(mid)
  // idle 线程带 live 滞留 inbox（重启/teardown inject）：跳过会丢消息，必须重算并回放
  const inbox: any = { nextTurn: [], nextStep: [] }
  inbox.clear = vi.fn(() => { inbox.nextTurn = []; inbox.nextStep = [] })
  inbox.append = vi.fn((target: string, message: any) => inbox[target === 'next-turn' ? 'nextTurn' : 'nextStep'].push(message))
  parent.inbox = inbox; parent.status = 'idle'; parent.send = vi.fn()
  inbox.nextStep.push({ id: 'stranded-settlement' })
  const beforeStranded = calls()
  await runtime.refreshTasks()
  expect(calls()).toBeGreaterThan(beforeStranded)
  expect(parent.send).toHaveBeenCalledWith({ id: 'stranded-settlement' }, 'next-step', true)
})

it('冷启动任务列表复用持久化终态；未打开的缺失历史不阻塞列表，打开时仍报错', async () => {
  const { sent, binding, parent } = await task()
  parent.status = 'idle'; parent.inbox.nextTurn = []; parent.inbox.nextStep = []
  logs.set(binding.rootId, end())
  await runtime.messages(sent.thread.id)
  const completed = (await store.read()).tasks.find(item => item.threadId === sent.thread.id)!
  expect(completed.status).toBe('done')
  await runtime.dispose()
  agents.clear()
  logs.delete(binding.rootId)
  runtime = new WorkforceRuntime(store, name => services[name])
  await runtime.recover()
  await runtime.refreshTasks()
  expect((await store.read()).tasks.find(item => item.id === completed.id)).toEqual(completed)
  expect((await store.thread(sent.thread.id)).status).toBe('idle')
  await expect(runtime.messages(sent.thread.id)).rejects.toThrow('原生会话暂时无法读取，请重试')
})

it('一条消息@多员工：负责人收到带系统说明的一份，直达员工各建顶层会话收原文', async () => {
  const { sent, parent } = await task()
  // 重复 @ 同一员工按出现位置去重；负责人也在收件人列表里
  const batch = await runtime.send(sent.thread.id, '@负责人 @分析员 @执行员 @分析员 一起评估', ['leader', 'analyst', 'writer', 'analyst'])
  const binding = (await store.read()).bindings[sent.thread.id]!
  // 负责人那份投递附直达名单说明；直达会话是顶层 agent，不经 subagents 链路
  const ownerText = parent.followup.mock.calls.at(-1)![0].content.map((part: any) => part.text).join('\n')
  expect(ownerText).toContain('@负责人 @分析员 @执行员 @分析员 一起评估')
  expect(ownerText).toContain('分析、执行')
  expect(ownerText).toContain('本批对这些员工的派工会被系统拒绝')
  expect(services.subagents.prompt).not.toHaveBeenCalled()
  expect(services.subagents.startActivation).not.toHaveBeenCalled()
  expect(Object.keys(binding.directChildren ?? {}).sort()).toEqual(['analyst', 'writer'])
  for (const employeeId of ['analyst', 'writer']) {
    const direct = agents.get(binding.directChildren![employeeId]!)!
    expect(direct.followup).toHaveBeenCalledTimes(1)
    const content = direct.followup.mock.calls[0][0].content.map((part: any) => part.text).join('\n')
    // 续投线程的直达消息前附「本线程此前记录」前缀（原始任务与最近消息），本条原文仍在末尾
    expect(content).toContain('【本线程此前记录')
    expect(content).toContain('原始任务')
    expect(content.endsWith('@负责人 @分析员 @执行员 @分析员 一起评估')).toBe(true)
    expect(binding.humanMessageIds).toContain(direct.followup.mock.calls[0][0].id)
  }
  // 批内派工守卫：名单按发送批次记录，只锁被直达的员工
  expect(binding.lastDirectBatch?.employeeIds.sort()).toEqual(['analyst', 'writer'])
  // 三个会话的原生消息共用 batch：投影成一个用户气泡，展示存档原文（无系统说明）
  const sendId = batch.message.id
  const batched = Object.values(binding.humanTexts ?? {}).filter(entry => entry.batch === sendId)
  expect(batched).toHaveLength(3)
  parent.status = 'idle'; parent.inbox.nextTurn = []; parent.inbox.nextStep = []
  const view = await runtime.messages(sent.thread.id)
  // 三个会话各持一条原生消息，同批归并：本批只产出一个用户气泡
  const userRows = view.messages.filter(item => item.role === 'user' && item.id === sendId)
  expect(userRows).toHaveLength(1)
  const merged = userRows[0]!
  expect(merged.text).toBe('@负责人 @分析员 @执行员 @分析员 一起评估')
  expect(merged.text).not.toContain('系统说明')
  // 进程重启后同员工再被 @：directChildren 映射在 → resume 原会话而非新建
  const directId = binding.directChildren!.analyst!
  await runtime.dispose(); agents.clear()
  runtime = new WorkforceRuntime(store, name => services[name])
  const creates = services.agents.create.mock.calls.length
  await runtime.send(sent.thread.id, '@分析员 再来一轮', ['analyst'])
  expect(services.agents.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: directId }))
  expect(services.agents.create.mock.calls.length).toBe(creates)
})

it('同批直达员工拒绝负责人重复派工；新一条发送刷新名单后解锁', async () => {
  const { sent, parent } = await task()
  const signal = new AbortController().signal
  await runtime.send(sent.thread.id, '@分析员 先看这个', ['analyst'])
  await expect(runtime.delegate(parent, 'analyst', '把这条转给分析员', signal)).rejects.toMatchObject({ code: 'conflict' })
  // 名单外员工不受影响
  await expect(runtime.delegate(parent, 'writer', '写一版', signal)).resolves.toBeTruthy()
  // 普通追问（无 @）清空批次锁；新批次只锁新名单
  await runtime.send(sent.thread.id, '继续')
  expect((await store.read()).bindings[sent.thread.id]?.lastDirectBatch).toBeUndefined()
  await expect(runtime.delegate(parent, 'analyst', '这次走派工', signal)).resolves.toBeTruthy()
  await runtime.send(sent.thread.id, '@执行员 换你来', ['writer'])
  await expect(runtime.delegate(parent, 'writer', '再派执行员', signal)).rejects.toMatchObject({ code: 'conflict' })
  await expect(runtime.delegate(parent, 'analyst', '分析员仍可派', signal)).resolves.toBeTruthy()
})

it('DM 指定本员工按普通消息投递不建直达会话；旧数据首条用户消息用 task.prompt 还原', async () => {
  const dm = await runtime.ensureDm('writer')
  await runtime.send(dm.id, '继续上一版', ['writer'])
  const dmBinding = (await store.read()).bindings[dm.id]!
  expect(dmBinding.directChildren).toBeUndefined()
  expect(dmBinding.lastDirectBatch).toBeUndefined()
  const dmAgent = agents.get(dmBinding.rootId)!
  expect(dmAgent.followup).toHaveBeenCalledTimes(1)
  expect(dmAgent.followup.mock.calls[0][0].content.map((part: any) => part.text).join('\n')).toBe('继续上一版')
  // 旧数据：首条用户消息投递时被追加过子会话指令且没有 humanTexts 存档 → 用 task.prompt 还原
  const { sent, binding } = await task()
  const seeded = (await store.read()).tasks[0]!
  logs.set(binding.rootId, [
    { type: 'user/message', seq: 0, time: 1, data: { id: 'legacy-first', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `${seeded.prompt}\n\n（子会话指令）完成后请通过 send_message 返回父会话` }] } },
    { type: 'turn/start', seq: 1, time: 2, data: {} },
    { type: 'turn/end', seq: 2, time: 3, data: { reason: { kind: 'completed' } } },
  ])
  const view = await runtime.messages(sent.thread.id)
  const first = view.messages.find(item => item.role === 'user')!
  expect(first.id).toBe('legacy-first')
  expect(first.text).toBe(seeded.prompt)
})

it('wb_publish_deliverable 权限：负责人发任意版本，直达会话只发自己写的，委派子员工一律拒绝', async () => {
  const { sent, parent, binding } = await task()
  const childId = await runtime.delegate(parent, 'analyst', '写分析', new AbortController().signal)
  await runtime.send(sent.thread.id, '@执行员 写稿', ['writer'])
  const directId = (await store.read()).bindings[sent.thread.id]!.directChildren!.writer!
  // 两个作者各存一版：v1 来自分析员的委派会话，v2 来自执行员的直达会话
  await store.deliverable(sent.thread.id, '稿.txt', '分析稿', { employeeId: 'analyst', sessionId: childId })
  await store.deliverable(sent.thread.id, '稿.txt', '文案稿', { employeeId: 'writer', sessionId: directId })
  // 负责人派出去的 continuable 子员工一律拒绝，提示交给负责人发布
  await expect(runtime.publishDeliverable(childId, '稿.txt', 1)).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('请交给负责人发布') })
  // 直达会话不能发别人写的版本，只能发自己的；返回链接固定到该版本
  await expect(runtime.publishDeliverable(directId, '稿.txt', 1)).rejects.toMatchObject({ code: 'bad_request' })
  const mine = await runtime.publishDeliverable(directId, '稿.txt', 2)
  expect(mine).toMatchObject({ name: '稿.txt', version: 2, published: true, publishedBy: 'writer' })
  expect(mine.url).toContain('?v=2')
  // 负责人可发任意版本；version 缺省取最新
  const latest = await runtime.publishDeliverable(binding.rootId, '稿.txt')
  expect(latest.version).toBe(2)
  const first = await runtime.publishDeliverable(binding.rootId, '稿.txt', 1)
  expect(first.version).toBe(1)
  const item = (await store.read()).tasks[0]!.deliverables[0]!
  expect(item.publishedVersion).toBe(1)
  expect(item.publishedBy).toBe('leader')
  // 不存在的会话/成果/版本走明确错误码
  await expect(runtime.publishDeliverable('ghost-session', '稿.txt')).rejects.toMatchObject({ code: 'bad_request' })
  await expect(runtime.publishDeliverable(binding.rootId, '无此稿.txt')).rejects.toMatchObject({ code: 'not_found' })
  await expect(runtime.publishDeliverable(binding.rootId, '稿.txt', 9)).rejects.toMatchObject({ code: 'not_found' })
  await expect(runtime.publishDeliverable(binding.rootId, '稿.txt', 'v1')).rejects.toMatchObject({ code: 'bad_request' })
})

it('频道新任务首投附最近任务索引（只含已发布成果、不含当前任务），追问不再注入', async () => {
  await store.change(state => {
    state.tasks.push({ id: 't-old', threadId: 'thread-t-old', channelId: 'general', assigneeId: 'leader', delegatorId: 'leader', title: '旧任务', prompt: '旧任务', status: 'done', deliverables: [{ name: '旧稿.txt', url: 'x' } as any], createdAt: '2026-10-08', updatedAt: '2026-10-08' })
    state.tasks.push({ id: 't-draft', threadId: 'thread-t-draft', channelId: 'general', assigneeId: 'leader', delegatorId: 'leader', title: '草稿任务', prompt: '', status: 'done', deliverables: [], createdAt: '2026-10-07', updatedAt: '2026-10-07' })
  })
  await store.deliverable('thread-t-draft', '未发布.txt', '草稿')
  const sent = await runtime.send('channel-general', '开始新任务')
  const binding = (await store.read()).bindings[sent.thread.id]!
  const parent = agents.get(binding.rootId)!
  const first = parent.followup.mock.calls[0][0].content.map((part: any) => part.text).join('\n')
  expect(first).toContain('开始新任务')
  expect(first).toContain('本频道最近 5 个任务')
  expect(first).toContain('t-old')
  expect(first).toContain('旧稿.txt')
  expect(first).toContain('t-draft')
  expect(first).not.toContain('未发布.txt')
  expect(first).not.toContain(sent.taskId!)
  // 索引只进投递给模型的正文：用户原文存档与 task.prompt 保持原文
  expect(Object.values(binding.humanTexts ?? {}).map((item: any) => item.text)).toEqual(['开始新任务'])
  expect((await store.read()).tasks.find(task => task.id === sent.taskId)!.prompt).toBe('开始新任务')
  // task 线程追问不重复注入
  await runtime.send(sent.thread.id, '继续')
  expect(parent.followup.mock.calls[1][0].content.map((part: any) => part.text).join('\n')).toBe('继续')
  // DM 投递也不附索引
  const dm = await runtime.ensureDm('writer')
  await runtime.send(dm.id, '私信问候')
  const dmAgent = agents.get((await store.read()).bindings[dm.id]!.rootId)!
  expect(dmAgent.followup.mock.calls[0][0].content.map((part: any) => part.text).join('\n')).toBe('私信问候')
})

it('wb_remember/wb_forget 权限与作用域：负责人/直达/私信可写，子员工拒绝；employeeId 只能指定员工记忆且他人仅限负责人', async () => {
  const { sent, parent, binding } = await task()
  const childId = await runtime.delegate(parent, 'analyst', '分析', new AbortController().signal)
  await runtime.send(sent.thread.id, '@执行员 写稿', ['writer'])
  const directId = (await store.read()).bindings[sent.thread.id]!.directChildren!.writer!
  const dm = await runtime.ensureDm('analyst')
  await runtime.send(dm.id, '打招呼')
  const dmRoot = (await store.read()).bindings[dm.id]!.rootId
  // 负责人 root：三个作用域都可写；channel 自动取当前线程频道；source 记录写入者与消息出处
  const g = await runtime.remember(binding.rootId, 'global', '全局偏好条款')
  expect(g).toMatchObject({ remembered: true, memory: { scope: 'global', text: '全局偏好条款' } })
  const c = await runtime.remember(binding.rootId, 'channel', '频道规则条款')
  expect(c.memory).toMatchObject({ scope: 'channel', scopeId: 'general', source: { by: 'leader', threadId: sent.thread.id } })
  expect(c.memory.source.messageId).toBe((await store.read()).bindings[sent.thread.id]!.humanMessageIds!.at(-1))
  const forWriter = await runtime.remember(binding.rootId, 'employee', '给执行员的交代', 'writer')
  expect(forWriter.memory).toMatchObject({ scope: 'employee', scopeId: 'writer', source: { by: 'leader' } })
  const forAnalyst = await runtime.remember(binding.rootId, 'employee', '给分析员的交代', 'analyst')
  // 直达会话：可写本频道与自身员工记忆；不能替他人写、非员工记忆不能带 employeeId、作用域校验
  expect((await runtime.remember(directId, 'channel', '直达写入的规则')).memory.scopeId).toBe('general')
  expect((await runtime.remember(directId, 'employee', '自己的交代')).memory).toMatchObject({ scopeId: 'writer', source: { by: 'writer' } })
  await expect(runtime.remember(directId, 'employee', '替他人写', 'analyst')).rejects.toMatchObject({ code: 'bad_request' })
  await expect(runtime.remember(directId, 'global', 'x', 'writer')).rejects.toMatchObject({ code: 'bad_request' })
  await expect(runtime.remember(directId, 'bad-scope', 'x')).rejects.toMatchObject({ code: 'bad_request' })
  // 私信会话：可写 global 与自身 employee；channel 无频道归属被拒
  expect((await runtime.remember(dmRoot, 'global', '私信写的全局')).memory.scope).toBe('global')
  expect((await runtime.remember(dmRoot, 'employee', '私信交代')).memory.scopeId).toBe('analyst')
  await expect(runtime.remember(dmRoot, 'channel', '私信不能写频道')).rejects.toMatchObject({ code: 'bad_request' })
  await expect(runtime.remember(dmRoot, 'employee', '替他人写', 'writer')).rejects.toMatchObject({ code: 'bad_request' })
  // 委派子员工一律拒绝；未绑定会话拒绝
  await expect(runtime.remember(childId, 'global', 'x')).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('派工子员工') })
  await expect(runtime.forget(childId, g.memory.id)).rejects.toMatchObject({ code: 'bad_request' })
  await expect(runtime.remember('ghost-session', 'global', 'x')).rejects.toMatchObject({ code: 'bad_request' })
  // wb_forget：同频道可删 channel；他人员工记忆非负责人不可删；负责人任意；global 不 gate
  const otherChannel = await store.saveMemory({ scope: 'channel', scopeId: 'general', text: '另一条频道记忆' })
  expect(await runtime.forget(directId, otherChannel.id)).toMatchObject({ forgotten: true, id: otherChannel.id })
  await expect(runtime.forget(directId, forAnalyst.memory.id)).rejects.toMatchObject({ code: 'bad_request' })
  expect(await runtime.forget(directId, forWriter.memory.id)).toMatchObject({ forgotten: true })
  await expect(runtime.forget(binding.rootId, 'ghost-id')).rejects.toMatchObject({ code: 'not_found' })
  expect(await runtime.forget(dmRoot, g.memory.id)).toMatchObject({ forgotten: true, id: g.memory.id })
  expect(await runtime.forget(binding.rootId, forAnalyst.memory.id)).toMatchObject({ forgotten: true })
})

it('会话创建注入冻结记忆段：任务内改记忆不重建不回写，新任务与新会话生效', async () => {
  const promptCalls: any[] = []
  const makeScope = () => {
    const prompt = { section: vi.fn((section: any) => promptCalls.push(section)), getSectionOrder: vi.fn(() => 0) }
    const tools = { guard: vi.fn(() => () => {}) }
    return { get: (name: string) => name === 'systemPrompt' ? prompt : name === 'tools' ? tools : undefined, on: vi.fn() }
  }
  await store.saveMemory({ scope: 'global', text: '全局条款一' })
  const { sent, binding } = await task()
  // 创建时捕获的真实 setup 回调：workspace-memory 段文本即 binding 里持久化的冻结快照
  const setup = services.agents.create.mock.calls[0][0].setup
  await setup(makeScope(), agents.get(binding.rootId))
  const injected = promptCalls.find(section => section.name === 'deployment:workspace-memory')
  expect(injected.text).toContain('全局条款一')
  expect(injected.text).toBe((await store.read()).bindings[sent.thread.id]!.memorySnapshots![binding.rootId])
  // 任务内新增记忆：不回写本任务冻结快照、不触发 root 重建
  await store.saveMemory({ scope: 'global', text: '中途新增条款' })
  const creates = services.agents.create.mock.calls.length
  await runtime.send(sent.thread.id, '追问')
  expect(services.agents.create.mock.calls.length).toBe(creates)
  expect(await store.frozenMemory(sent.thread.id, 'leader', binding.rootId)).not.toContain('中途新增条款')
  // 新任务线程：先结束进行中的第一个任务，频道下一条无@消息才会开新任务
  await store.change(state => { state.tasks.find(item => item.threadId === sent.thread.id)!.status = 'done'; state.threads.find(item => item.id === sent.thread.id)!.status = 'cancelled' })
  const second = await runtime.send('channel-general', '第二个任务')
  const binding2 = (await store.read()).bindings[second.thread.id]!
  expect(await store.frozenMemory(second.thread.id, 'leader', binding2.rootId)).toContain('中途新增条款')
  // 直达会话同样按员工冻结注入
  await runtime.send(second.thread.id, '@执行员 写稿', ['writer'])
  const directSetup = services.agents.create.mock.calls.at(-1)![0].setup
  promptCalls.length = 0
  const directId = (await store.read()).bindings[second.thread.id]!.directChildren!.writer!
  const directAgent = agents.get(directId)!
  directAgent.ctx = makeScope()
  await directSetup(directAgent.ctx, directAgent)
  const directMemory = promptCalls.find(section => section.name === 'deployment:workspace-memory')
  expect(directMemory.text).toContain('中途新增条款')
})

it('私信记忆变化后下一条用户消息附最新快照且只附一次，频道与他人员工记忆不外泄', async () => {
  const dm = await runtime.ensureDm('writer')
  await runtime.send(dm.id, '第一条')
  const binding = (await store.read()).bindings[dm.id]!
  const agent = agents.get(binding.rootId)!
  expect(agent.followup.mock.calls[0][0].content.map((part: any) => part.text).join('\n')).toBe('第一条')
  // 变化后下一条消息带最新快照：只含 global 与本人的 employee 记忆
  await store.saveMemory({ scope: 'global', text: '用中文回复' })
  await store.saveMemory({ scope: 'channel', scopeId: 'general', text: '频道专属条款' })
  await store.saveMemory({ scope: 'employee', scopeId: 'writer', text: '执行员专属条款' })
  await store.saveMemory({ scope: 'employee', scopeId: 'analyst', text: '分析员专属条款' })
  await runtime.send(dm.id, '第二条')
  const second = agent.followup.mock.calls[1][0].content.map((part: any) => part.text).join('\n')
  expect(second).toContain('第二条')
  expect(second).toContain('最新长期记忆快照')
  expect(second).toContain('用中文回复')
  expect(second).toContain('执行员专属条款')
  expect(second).not.toContain('频道专属条款')
  expect(second).not.toContain('分析员专属条款')
  // 快照已记录：没有再变化时下一条不再附
  await runtime.send(dm.id, '第三条')
  expect(agent.followup.mock.calls[2][0].content.map((part: any) => part.text).join('\n')).toBe('第三条')
  // 永久 DM 记忆变化不重建会话（记忆不进 composition）
  const creates = services.agents.create.mock.calls.length
  await store.saveMemory({ scope: 'global', text: '又一条全局' })
  await runtime.send(dm.id, '第四条')
  expect(services.agents.create.mock.calls.length).toBe(creates)
  expect(agent.followup.mock.calls[3][0].content.map((part: any) => part.text).join('\n')).toContain('又一条全局')
})

it('直达投递附「本线程此前记录」前缀：原始任务、已发布成果与最近消息，工具与过程行不进前缀；全新线程无前缀', async () => {
  const { sent, binding, parent } = await task()
  // 线程既有历史：用户消息、过程文字（中间态）、工具行、最终回复、已发布成果与未发布草稿
  await store.deliverable(sent.thread.id, '稿.txt', '正文')
  await store.deliverable(sent.thread.id, '草稿.txt', '未发布')
  await store.publishDeliverable(sent.taskId!, '稿.txt', 1, 'user')
  logs.set(binding.rootId, [
    { type: 'user/message', seq: 0, time: 1, data: parent.followup.mock.calls[0][0] },
    { type: 'turn/start', seq: 1, time: 2, data: {} },
    { type: 'assistant/message', seq: 2, time: 3, data: { message: { content: [{ type: 'text', text: '中间过程文字' }] } } },
    { type: 'tool/call', seq: 3, time: 4, data: { callId: 'c1', name: 'wb_secret_tool' } },
    { type: 'tool/result', seq: 4, time: 5, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '工具输出' }] } } },
    { type: 'assistant/message', seq: 5, time: 6, data: { message: { content: [{ type: 'text', text: '负责人前一条回复' }] } } },
    { type: 'turn/end', seq: 6, time: 7, data: { reason: { kind: 'completed' } } },
  ])
  await runtime.send(sent.thread.id, '@执行员 改稿', ['writer'])
  const directId = (await store.read()).bindings[sent.thread.id]!.directChildren!.writer!
  const content = agents.get(directId)!.followup.mock.calls[0][0].content.map((part: any) => part.text).join('\n')
  // 前缀段：本线程记录标记、原始任务、已发布成果（未发布草稿不进）、最近消息
  expect(content).toContain('【本线程此前记录')
  expect(content).toContain('原始任务')
  expect(content).toContain('完成任务')
  expect(content).toContain('稿.txt v1')
  expect(content).not.toContain('草稿.txt')
  expect(content).toContain('负责人前一条回复')
  // 工具行与中间过程文字不进前缀；本条原文仍在末尾
  expect(content).not.toContain('wb_secret_tool')
  expect(content).not.toContain('中间过程文字')
  expect(content.endsWith('@执行员 改稿')).toBe(true)
  expect(content.length).toBeLessThanOrEqual(3000 + '@执行员 改稿'.length)
  // 全新任务线程首投带 @：没有此前消息，不附前缀
  const fresh = await runtime.send('channel-general', '@分析员 新任务', ['analyst'])
  const freshDirectId = (await store.read()).bindings[fresh.thread.id]!.directChildren!.analyst!
  expect(agents.get(freshDirectId)!.followup.mock.calls[0][0].content.map((part: any) => part.text).join('\n')).toBe('@分析员 新任务')
})

it('负责人 pre-step 附直达回复摘要且游标不重复；非 root 会话不注入；工具行与用户行不计', async () => {
  const { sent, binding, parent } = await task()
  await runtime.send(sent.thread.id, '@文案员 写稿', ['writer'])
  const directId = (await store.read()).bindings[sent.thread.id]!.directChildren!.writer!
  // 直达会话两个 turn 各一条 assistant 回复；工具行与转发的用户行不计入摘要
  logs.set(directId, [
    { type: 'user/message', seq: 0, time: 1, data: agents.get(directId)!.followup.mock.calls[0][0] },
    { type: 'turn/start', seq: 1, time: 2, data: {} },
    { type: 'assistant/message', seq: 2, time: 3, data: { message: { content: [{ type: 'text', text: '直达第一版已交付' }] } } },
    { type: 'turn/end', seq: 3, time: 4, data: { reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 4, time: 5, data: {} },
    { type: 'tool/call', seq: 5, time: 6, data: { callId: 'c1', name: 'wb_save_deliverable' } },
    { type: 'tool/result', seq: 6, time: 7, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '已保存' }] } } },
    { type: 'assistant/message', seq: 7, time: 8, data: { message: { content: [{ type: 'text', text: '直达补充说明' }] } } },
    { type: 'turn/end', seq: 8, time: 9, data: { reason: { kind: 'completed' } } },
  ])
  // 追加末环让决策为 enter：runtime 的 listener 在前，摘要前置到决策 messages
  const native = { id: 'native-1', role: 'user', content: [{ type: 'text', text: '原生唤醒' }] }
  parent.ctx.on('agent/pre-step', async (_request: any, _next: any) => ({ kind: 'enter', messages: [native] }))
  const decision: any = await parent.fire('agent/pre-step', { signal: new AbortController().signal })
  expect(decision.kind).toBe('enter')
  expect(decision.messages).toHaveLength(2)
  const summary = decision.messages[0]
  const summaryText = summary.content.map((part: any) => part.text).join('\n')
  expect(summaryText).toContain('本线程直达员工的新回复')
  expect(summaryText).toContain('共 2 条新增回复')
  expect(summaryText).toContain('直达第一版已交付')
  expect(summaryText).toContain('直达补充说明')
  expect(summaryText).not.toContain('wb_save_deliverable')
  expect(summary.source?.kind).toBe('workbench-thread-context')
  expect(decision.messages[1]).toBe(native)
  // 游标推进到已同步序号：再次 pre-step 不再前置摘要
  expect((await store.read()).bindings[sent.thread.id]!.directReplyCursors![directId]).toBe(7)
  const again: any = await parent.fire('agent/pre-step', { signal: new AbortController().signal })
  expect(again.messages).toHaveLength(1)
  expect(again.messages[0]).toBe(native)
  // 非 root 会话（直达员工自己）pre-step 不注入
  const direct = agents.get(directId)!
  direct.ctx.on('agent/pre-step', async (_request: any, _next: any) => ({ kind: 'enter', messages: [] }))
  const directDecision: any = await direct.fire('agent/pre-step', { signal: new AbortController().signal })
  expect(directDecision.messages).toHaveLength(0)
})

it('G1 requestId 幂等：并发同键只算一单，完成后重放直接返回回执，不同摘要判冲突，私信同样生效', async () => {
  // 并发同键同文：single-flight 共享同一 operation，只建一个任务、投递一次
  const [a, b] = await Promise.all([
    runtime.send('channel-general', '并发幂等任务', undefined, { requestId: 'req-dup' }),
    runtime.send('channel-general', '并发幂等任务', undefined, { requestId: 'req-dup' }),
  ])
  expect(b).toBe(a)
  expect((await store.read()).tasks).toHaveLength(1)
  const binding = (await store.read()).bindings[a.thread.id]!
  const parent = agents.get(binding.rootId)!
  expect(parent.followup).toHaveBeenCalledTimes(1)
  // 完成后同键同文：命中持久化回执直接返回，不再投递也不建新任务
  const replay = await runtime.send('channel-general', '并发幂等任务', undefined, { requestId: 'req-dup' })
  expect(replay).toEqual(a)
  expect(parent.followup).toHaveBeenCalledTimes(1)
  expect((await store.read()).tasks).toHaveLength(1)
  // 同键不同文：已落回执与在途单都判 conflict，成功单不受影响
  await expect(runtime.send('channel-general', '换了正文', undefined, { requestId: 'req-dup' })).rejects.toMatchObject({ code: 'conflict' })
  // 新语义：无@频道消息归入进行中任务；先结束第一个任务，第二个 requestId 才会独立建单
  await store.change(state => { state.tasks.find(item => item.id === a.taskId!)!.status = 'done'; state.threads.find(item => item.id === a.thread.id)!.status = 'cancelled' })
  const live = runtime.send('channel-general', '在途任务', undefined, { requestId: 'req-live' })
  await expect(runtime.send('channel-general', '另一个正文', undefined, { requestId: 'req-live' })).rejects.toMatchObject({ code: 'conflict' })
  await live
  expect((await store.read()).tasks).toHaveLength(2)
  // 私信线程同样支持 requestId 幂等
  const dm = await runtime.ensureDm('writer')
  const dmA = await runtime.send(dm.id, '私信任务', undefined, { requestId: 'req-dm' })
  const dmB = await runtime.send(dm.id, '私信任务', undefined, { requestId: 'req-dm' })
  expect(dmB).toEqual(dmA)
  const dmRoot = agents.get((await store.read()).bindings[dm.id]!.rootId)!
  expect(dmRoot.followup).toHaveBeenCalledTimes(1)
  // requestId 形状校验：空白与超长 bad_request
  await expect(runtime.send('channel-general', 'x', undefined, { requestId: ' ' })).rejects.toMatchObject({ code: 'bad_request' })
  await expect(runtime.send('channel-general', 'x', undefined, { requestId: 'r'.repeat(121) })).rejects.toMatchObject({ code: 'bad_request' })
})

it('G1 部分投递补投：只补缺失收件人，已入原生会话的消息按 id 判重不重投', async () => {
  const realMake = services.agents.create.getMockImplementation()!
  let creates = 0
  services.agents.create.mockImplementation(async (options: any) => {
    creates += 1
    if (creates === 2) throw new Error('模拟直达会话创建中断')
    return realMake(options)
  })
  await expect(runtime.send('channel-general', '@负责人 @分析员 @文案员 一起评估', ['leader', 'analyst', 'writer'], { requestId: 'req-partial' }))
    .rejects.toThrow('模拟直达会话创建中断')
  // 中断点：任务与回执已落库，负责人已投递，两个直达未记
  const first = (await store.read()).sendReceipts['req-partial']!
  expect(first.deliveredTo).toEqual(['leader'])
  const binding = (await store.read()).bindings[first.threadId]!
  const parent = agents.get(binding.rootId)!
  expect(parent.followup).toHaveBeenCalledTimes(1)
  // 同键重试：负责人不重投，分析员/文案员补建直达会话并投递，结果沿用回执
  services.agents.create.mockImplementation(realMake)
  const retried = await runtime.send('channel-general', '@负责人 @分析员 @文案员 一起评估', ['leader', 'analyst', 'writer'], { requestId: 'req-partial' })
  expect(retried).toEqual(first.result)
  expect(parent.followup).toHaveBeenCalledTimes(1)
  const after = (await store.read()).bindings[first.threadId]!
  for (const employeeId of ['analyst', 'writer']) expect(agents.get(after.directChildren![employeeId]!)!.followup).toHaveBeenCalledTimes(1)
  expect((await store.read()).sendReceipts['req-partial']!.deliveredTo.sort()).toEqual(['analyst', 'leader', 'writer'])
  // 抹掉 writer 的 deliveredTo 标记再重试：原生会话里已有该消息 → 判重补记不重投
  await store.change(state => { const receipt = state.sendReceipts['req-partial']!; receipt.deliveredTo = receipt.deliveredTo.filter(item => item !== 'writer') })
  const writerAgent = agents.get(after.directChildren!.writer!)!
  const again = await runtime.send('channel-general', '@负责人 @分析员 @文案员 一起评估', ['leader', 'analyst', 'writer'], { requestId: 'req-partial' })
  expect(again).toEqual(first.result)
  expect(writerAgent.followup).toHaveBeenCalledTimes(1)
  expect((await store.read()).sendReceipts['req-partial']!.deliveredTo).toContain('writer')
})

it('G1 发送回执：24h 前回执按不存在重新投递，存储上限 500 条淘汰最旧', async () => {
  const sent = await runtime.send('channel-general', '过期前任务', undefined, { requestId: 'req-old' })
  // 回执超过 24h：同键同文按首次发送处理，新建任务与回执
  await store.change(state => { state.sendReceipts['req-old']!.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })
  // 新语义：先结束进行中的第一个任务，过期重投才会按新任务处理
  await store.change(state => { state.tasks.find(item => item.threadId === sent.thread.id)!.status = 'done'; state.threads.find(item => item.id === sent.thread.id)!.status = 'cancelled' })
  const resent = await runtime.send('channel-general', '过期前任务', undefined, { requestId: 'req-old' })
  expect(resent.thread.id).not.toBe(sent.thread.id)
  expect((await store.read()).tasks).toHaveLength(2)
  expect(Date.parse((await store.read()).sendReceipts['req-old']!.createdAt)).toBeGreaterThan(Date.now() - 60_000)
  // 500 条上限：本次写入保留最新 499 条已有回执，最旧被淘汰
  await store.change(state => {
    state.sendReceipts = {}
    for (let index = 0; index < 500; index += 1)
      state.sendReceipts[`seed-${index}`] = { threadId: 'seed', digest: 'd', deliveredTo: [], createdAt: new Date(Date.now() - index * 1000).toISOString(), result: {} as any }
  })
  await runtime.send('channel-general', '触发淘汰', undefined, { requestId: 'req-new' })
  const persisted = await new WorkforceStore(root).read()
  expect(Object.keys(persisted.sendReceipts)).toHaveLength(500)
  expect(persisted.sendReceipts['req-new']).toBeTruthy()
  expect(persisted.sendReceipts['seed-0']).toBeTruthy()
  expect(persisted.sendReceipts['seed-499']).toBeUndefined()
})

it('G3 messagePage：默认末尾 200、limit 封顶 500、before 排他、未知游标与非法 limit 报 bad_request', async () => {
  const dm = await runtime.ensureDm('writer')
  await runtime.send(dm.id, '第一条')
  const binding = (await store.read()).bindings[dm.id]!
  const events: any[] = [{ type: 'user/message', seq: 0, time: 1, data: agents.get(binding.rootId)!.followup.mock.calls[0][0] }]
  for (let index = 1; index <= 520; index += 1) {
    const seq = index * 3 - 2
    events.push(
      { type: 'turn/start', seq, time: seq, data: {} },
      { type: 'assistant/message', seq: seq + 1, time: seq + 1, data: { message: { content: [{ type: 'text', text: `回复${index}` }] } } },
      { type: 'turn/end', seq: seq + 2, time: seq + 2, data: { reason: { kind: 'completed' } } },
    )
  }
  logs.set(binding.rootId, events)
  // 默认 200 取末尾 + hasMore；limit 封顶 500；字符串数字 limit 生效
  const page = await runtime.messagePage(dm.id)
  expect(page.messages).toHaveLength(200)
  expect(page.hasMore).toBe(true)
  expect(page.messages.at(-1)!.text).toBe('回复520')
  const capped = await runtime.messagePage(dm.id, { limit: 999 })
  expect(capped.messages).toHaveLength(500)
  expect(capped.hasMore).toBe(true)
  expect((await runtime.messagePage(dm.id, { limit: 500 })).messages).toHaveLength(500)
  expect((await runtime.messagePage(dm.id, { limit: '50' })).messages).toHaveLength(50)
  // before 排他：游标本条不进页，页尾是游标前一条
  const last = page.messages.at(-1)!
  const beforeLast = await runtime.messagePage(dm.id, { limit: 50, before: last.id })
  expect(beforeLast.messages.some(item => item.id === last.id)).toBe(false)
  expect(beforeLast.messages.at(-1)!.id).toBe(page.messages.at(-2)!.id)
  expect(beforeLast.hasMore).toBe(true)
  // before 指到首条 → 空页；未知游标与非法 limit → bad_request；ghost 线程 → not_found
  const firstMessageId = (await runtime.messages(dm.id)).messages[0]!.id
  const empty = await runtime.messagePage(dm.id, { before: firstMessageId })
  expect(empty.messages).toEqual([])
  expect(empty.hasMore).toBe(false)
  await expect(runtime.messagePage(dm.id, { before: 'ghost' })).rejects.toMatchObject({ code: 'bad_request' })
  for (const bad of [0, -1, 1.5, 'abc', true]) await expect(runtime.messagePage(dm.id, { limit: bad })).rejects.toMatchObject({ code: 'bad_request' })
  await expect(runtime.messagePage('ghost-thread')).rejects.toMatchObject({ code: 'not_found' })
})

it('G2 兼容：旧共享布局归档重建；独立布局数据根搬迁尾部一致可用、不一致报 unavailable', async () => {
  // 旧共享布局保留历史；继续任务创建独立 root，不复用共享执行世界。
  const { sent, binding } = await task()
  await store.change(state => { delete state.bindings[sent.thread.id]!.workspaceLayout })
  await runtime.dispose(); agents.clear()
  headers.set(binding.rootId, { id: binding.rootId, cwd: 'D:\\moved-old\\sessions\\' + sent.thread.id })
  logs.set(binding.rootId, end())
  store = new WorkforceStore(root)
  runtime = new WorkforceRuntime(store, name => services[name])
  const oldSend = await runtime.send(sent.thread.id, '旧线程继续')
  expect(oldSend.thread.id).toBe(sent.thread.id)
  const rebuiltBinding = (await store.read()).bindings[sent.thread.id]!
  expect(services.agents.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: rebuiltBinding.rootId }))
  const rebuilt = agents.get(rebuiltBinding.rootId)!.followup.mock.calls.at(-1)![0].content.map((part: { text: string }) => part.text).join('\n')
  expect(rebuilt).toContain('旧线程继续')
  expect(rebuiltBinding.workspaceLayout).toBe('scoped-v2')
  // session-v1：header.cwd 数据根换了但 workspaces/<thread>/scratch/<session> 尾部一致 → 可用；先结束上一任务，下一条无@消息才开新任务
  await store.change(state => { for (const task of state.tasks) task.status = 'done'; for (const thread of state.threads) if (thread.kind === 'task') thread.status = 'cancelled' })
  const second = await runtime.send('channel-general', '新任务')
  const binding2 = (await store.read()).bindings[second.thread.id]!
  const file = join(resolve(store.directory, 'workspaces', second.thread.id, 'scratch', binding2.rootId), '保留.txt')
  await writeFile(file, '搬迁前的文件')
  await runtime.dispose(); agents.clear()
  headers.set(binding2.rootId, { id: binding2.rootId, cwd: 'D:\\moved-root\\workspaces\\' + second.thread.id + '\\scratch\\' + binding2.rootId })
  logs.set(binding2.rootId, end())
  store = new WorkforceStore(root)
  runtime = new WorkforceRuntime(store, name => services[name])
  await runtime.send(second.thread.id, '搬迁后继续')
  expect(services.agents.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: binding2.rootId }))
  expect(await readFile(file, 'utf8')).toBe('搬迁前的文件')
  // session-v1 尾部不一致：会话数据不属于本线程 → unavailable（路由层 503）；同样先结束上一任务
  await store.change(state => { for (const task of state.tasks) task.status = 'done'; for (const thread of state.threads) if (thread.kind === 'task') thread.status = 'cancelled' })
  const third = await runtime.send('channel-general', '第三个任务')
  const binding3 = (await store.read()).bindings[third.thread.id]!
  await runtime.dispose(); agents.clear()
  headers.set(binding3.rootId, { id: binding3.rootId, cwd: 'D:\\moved-root\\other\\scratch\\' + binding3.rootId })
  logs.set(binding3.rootId, end())
  store = new WorkforceStore(root)
  runtime = new WorkforceRuntime(store, name => services[name])
  await expect(runtime.send(third.thread.id, '不一致')).rejects.toMatchObject({ code: 'unavailable' })
})

it('B3 collectWorkforceDiagnostics：对话段遮蔽密钥与家目录，state 损坏仍返回诊断信封', async () => {
  const { sent, binding } = await task()
  logs.set(binding.rootId, [
    { type: 'user/message', seq: 0, time: 1, data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `我的 key 是 sk-TEST-9999 别外传，文件在 ${homedir()}\\docs` }] } },
    { type: 'turn/start', seq: 1, time: 2, data: {} },
    { type: 'assistant/message', seq: 2, time: 3, data: { message: { content: [{ type: 'text', text: '调用凭证 Authorization: Bearer abcdef123' }] } } },
    { type: 'tool/call', seq: 3, time: 4, data: { callId: 'c1', name: 'shell.run', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', seq: 4, time: 5, data: { message: { toolCallId: 'c1', isError: true, content: [{ type: 'text', text: '拒绝执行' }] } } },
    { type: 'assistant/message', seq: 5, time: 6, data: { message: { content: [{ type: 'text', text: '已恢复' }] } } },
    { type: 'turn/end', seq: 6, time: 7, data: { reason: { kind: 'completed' } } },
  ])
  const report = await collectWorkforceDiagnostics(runtime, sent.taskId!)
  expect(report.conversation?.taskId).toBe(sent.taskId)
  expect(report.conversation?.messages.length).toBeGreaterThan(0)
  const blob = JSON.stringify(report)
  expect(blob).not.toContain('TEST-9999')
  expect(blob).not.toContain('abcdef123')
  expect(blob).toContain('[已遮蔽]')
  for (const message of report.conversation!.messages) expect(message.text).not.toContain(homedir())
  // 工具行附 name/status（无参数正文），支撑排障定位到哪一步挂了
  const toolRow = report.conversation!.messages.find(item => item.tool)
  expect(toolRow?.tool).toEqual({ name: 'shell.run', status: 'error' })
  expect(toolRow!.text).toBe('拒绝执行')
  // 无 taskId：不附对话，基本段齐全
  const bare = await collectWorkforceDiagnostics(runtime)
  expect(bare.conversation).toBeUndefined()
  expect(bare.counts?.employees).toBe(3)
  expect(bare.employeeModels.every(item => item.id)).toBe(true)
  // state.json 损坏：store 载入即失败 → counts:null + errors.state，信封照常返回
  const brokenRoot = await mkdtemp(join(process.env.TEMP!, 'wf-diag-'))
  try {
    await mkdir(join(brokenRoot, 'workforce'), { recursive: true })
    await writeFile(join(brokenRoot, 'workforce', 'state.json'), '{ broken json')
    const broken = await collectWorkforceDiagnostics(new WorkforceRuntime(new WorkforceStore(brokenRoot), () => undefined))
    expect(broken.counts).toBeNull()
    expect(broken.errors.some(item => item.section === 'state' && item.message.includes('SyntaxError'))).toBe(true)
    expect(broken.environment.workbenchVersion).toBeTruthy()
    expect(broken.privacy).toContain('默认不包含对话')
  } finally { await rm(brokenRoot, { recursive: true, force: true }) }
})

it('批准卡带原生 displayReason 与同 callId 真实调用参数（脱敏限长），取不到详情则缺省', async () => {
  const { sent, binding, parent } = await task()
  parent.status = 'idle'; parent.inbox.nextTurn = []
  const cardOf = async (match: (approval: any) => boolean) => (await runtime.messages(sent.thread.id)).messages.map(item => item.approval).find(item => item && match(item))!
  // 同 session 同 callId 的 tool/call 参数 → 卡片 detail 脱敏呈现
  logs.get(binding.rootId)!.push({ type: 'tool/call', seq: 2, time: 3, data: { callId: 'ap-1', name: 'shell.run', arguments: JSON.stringify({ command: 'rm -rf build && echo sk-FAKE-777 done' }) } })
  const held = parent.fire('approval/request', { toolName: 'shell.run', callId: 'ap-1', reason: '需要清理产物', displayReason: 'shell.run 需要在工作区外执行' })
  const approval = (await cardOf(item => item.callId === 'ap-1'))!
  expect(approval.displayReason).toBe('shell.run 需要在工作区外执行')
  expect(approval.reason).toBe('需要清理产物')
  expect(approval.detail).toBeTruthy()
  expect(approval.detail!.text).not.toContain('FAKE-777')
  expect(approval.detail!.text).toContain('[已遮蔽]')
  expect(approval.detail!.text).toContain('rm -rf build')
  expect(approval.detail!.truncated).toBe(false)
  // 无 callId → detail 缺省（不用模型理由代替）；displayReason 未提供则不带
  const held2 = parent.fire('approval/request', { toolName: 'shell.run', reason: '第二次' })
  const second = (await cardOf(item => item.reason === '第二次'))!
  expect(second.detail).toBeUndefined()
  expect(second.displayReason).toBeUndefined()
  // callId 无匹配 tool/call → detail 同样缺省
  // 原生 escalation 的 displayReason 是 { en, zh } 本地化对象：取中文，模式名换成通俗说法
  const held3 = parent.fire('approval/request', { toolName: 'fs.write', callId: 'ap-ghost', displayReason: { en: 'Allow this operation', zh: '允许本次操作使用 danger-full-access 权限：写报告' } })
  const third = (await cardOf(item => item.callId === 'ap-ghost'))!
  expect(third.detail).toBeUndefined()
  expect(third.displayReason).toBe('允许本次操作使用 完全访问本机（含工作区外） 权限：写报告')
  // 超长参数 → 截断并标记
  logs.get(binding.rootId)!.push({ type: 'tool/call', seq: 3, time: 4, data: { callId: 'ap-2', name: 'shell.run', arguments: JSON.stringify({ script: 'x'.repeat(3000) }) } })
  const held4 = parent.fire('approval/request', { toolName: 'shell.run', callId: 'ap-2' })
  const fourth = (await cardOf(item => item.callId === 'ap-2'))!
  expect(fourth.detail!.truncated).toBe(true)
  expect(fourth.detail!.text).toHaveLength(2000)
  // 回答后卡片保持只读，displayReason/detail 仍留
  await runtime.answerAsk(sent.thread.id, approval.requestId, { outcome: 'allowed-once' })
  await expect(held).resolves.toBe('allowed-once')
  const answered = (await cardOf(item => item.requestId === approval.requestId))!
  expect(answered.answered).toBe('allowed-once')
  expect(answered.detail).toBeTruthy()
  await runtime.answerAsk(sent.thread.id, second.requestId, { outcome: 'rejected' })
  await expect(held2).resolves.toBe('rejected')
  await runtime.answerAsk(sent.thread.id, third.requestId, { outcome: 'rejected' })
  await expect(held3).resolves.toBe('rejected')
  await runtime.answerAsk(sent.thread.id, fourth.requestId, { outcome: 'rejected' })
  await expect(held4).resolves.toBe('rejected')
})

it('STOP-JOBS：取消任务清本线程 root/子/直达会话名下运行中的后台 job；已结束与其他线程不动；jobs 缺失不阻塞', async () => {
  const { sent, binding, parent } = await task()
  // 直达会话 + 委派子员工会话，凑齐三类名下会话（委派换 writer：直达刚 @ 过的员工同批不能再派）
  await runtime.send(sent.thread.id, '@分析员 直接执行', 'analyst')
  const directId = (await store.read()).bindings[sent.thread.id]!.directChildren!.analyst!
  const childId = await runtime.delegate(parent, 'writer', '写稿', new AbortController().signal)
  // 新语义：先结束第一个任务，'另一个任务'才会开出独立任务线程
  await store.change(state => { state.tasks.find(item => item.threadId === sent.thread.id)!.status = 'done'; state.threads.find(item => item.id === sent.thread.id)!.status = 'cancelled' })
  const other = await runtime.send('channel-general', '另一个任务')
  const otherRoot = (await store.read()).bindings[other.thread.id]!.rootId
  const jobList = [
    { id: 'j-root', owner: binding.rootId, status: 'running' },
    { id: 'j-child', owner: childId, status: 'stopping' },
    { id: 'j-direct', owner: directId, status: 'running' },
    { id: 'j-done', owner: binding.rootId, status: 'completed' },
    { id: 'j-other', owner: otherRoot, status: 'running' },
  ]
  const killed: string[] = []
  services.jobs = {
    list: vi.fn((owner: string) => jobList.filter(job => job.owner === owner)),
    kill: vi.fn((id: string, owner: string, reason: string) => { killed.push(`${id}:${reason}`) }),
  }
  await expect(runtime.cancel(sent.taskId!)).resolves.toMatchObject({ cancelled: true })
  // 只杀本线程三个会话名下的 running/stopping；completed 与其他线程的不动
  expect(killed.sort()).toEqual(['j-child:任务已停止', 'j-direct:任务已停止', 'j-root:任务已停止'])
  // TEL-H 观察前后各列一次：同一名单、不重不漏
  expect([...new Set(services.jobs.list.mock.calls.map((call: [string]) => call[0]))].sort()).toEqual([binding.rootId, childId, directId].sort())
  // jobs 服务缺失：取消照常成功
  delete services.jobs
  const second = await runtime.send('channel-general', '第三个任务')
  await expect(runtime.cancel(second.taskId!)).resolves.toMatchObject({ cancelled: true })
})

it('TEL-H：operational 只有类别与计数——任务正文/文件名/模型名/MCP名/工具参数/skill名/各类id不外泄，usage 缺失为 null', async () => {
  resetOperationalDiagnostics()
  const sent = await runtime.send('channel-general', '哨兵正文-SENTINEL-BODY')
  const binding = (await store.read()).bindings[sent.thread.id]!
  await runtime.saveDeliverable(binding.rootId, 'sentinel-file-name.md', '哨兵成果正文', undefined)
  await store.change(state => {
    state.employees.find(item => item.id === 'leader')!.model = 'sentinel-provider-zz/sentinel-model-zz'
    state.employees.find(item => item.id === 'leader')!.skills = ['sentinel-skill-zz', 'sentinel-skill-other']
    state.mcpServers.push({ id: 'mcp1', serverName: 'sentinel-mcp-zz', label: 'L', transport: 'stdio', enabled: true, createdAt: 't', updatedAt: 't' })
  })
  logs.set(binding.rootId, [
    { type: 'turn/start', seq: 0, time: 1, data: {} },
    { type: 'tool/call', seq: 1, time: 2, data: { callId: 'c1', name: 'wb_read_material', arguments: '{"materialId":"SENTINEL-TOOL-ARG-zz"}' } },
    { type: 'tool/result', seq: 2, time: 3, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'SENTINEL-RESULT-zz' }] } } },
    { type: 'tool/call', seq: 3, time: 4, data: { callId: 'c2', name: 'skill', arguments: '{"name":"sentinel-skill-zz"}' } },
    { type: 'tool/result', seq: 4, time: 5, data: { message: { toolCallId: 'c2', isError: true, content: [] } } },
    { type: 'tool/call', seq: 5, time: 6, data: { callId: 'c3', name: 'skill', arguments: 'broken-json' } },
    { type: 'tool/call', seq: 6, time: 7, data: { callId: 'c4', name: 'mcp__sentinel-mcp-zz__tool' } },
    { type: 'turn/end', seq: 7, time: 8, data: { reason: { kind: 'completed' } } },
  ])
  const operational = (await collectWorkforceDiagnostics(runtime)).operational
  const json = JSON.stringify(operational)
  for (const sentinel of ['哨兵正文-SENTINEL-BODY', '哨兵成果正文', 'sentinel-file-name.md', 'sentinel-provider-zz', 'sentinel-model-zz', 'sentinel-mcp-zz', 'SENTINEL-TOOL-ARG-zz', 'SENTINEL-RESULT-zz', 'sentinel-skill-zz', 'sentinel-skill-other', binding.rootId, sent.thread.id, sent.taskId!])
    expect(json).not.toContain(sentinel)
  const row = operational.threads.find(item => item.status === 'running')!
  expect(row.usage).toBeNull()
  expect(row.tools).toEqual(expect.arrayContaining([
    { toolClass: 'read_material', done: 1, error: 0, running: 0 },
    { toolClass: 'skill', done: 0, error: 1, running: 1 },
    { toolClass: 'other_mcp', done: 0, error: 0, running: 1 },
  ]))
  expect(row.skills).toEqual({ assigned: 2, matched: 0, failed: 1, notObserved: 1, parseUnknown: 1, coverage: 'observed_window' })
  // 已保存未标最终版：finalVersions 只数标了最终版的成果
  expect(row.artifacts).toEqual({ files: 1, finalVersions: 0 })
  expect(operational.snapshot!.models).toEqual(expect.arrayContaining([{ providerClass: 'apikey', modelClass: 'other', count: 1 }]))
  expect(operational.snapshot!.mcp).toMatchObject({ enabled: 1, unknown: 1 })
})

it('TEL-H：stops 记录取消观察——jobs 缺失记 unavailable 且取消照常成功；run-limit 记 run_limit', async () => {
  resetOperationalDiagnostics()
  const { sent } = await task()
  await expect(runtime.cancel(sent.taskId!)).resolves.toMatchObject({ cancelled: true })
  let operational = (await collectWorkforceDiagnostics(runtime)).operational
  expect(operational.stops).toHaveLength(1)
  expect(operational.stops[0]).toMatchObject({ reason: 'user', phase: 'cancel_settled', jobsService: 'unavailable', before: null, after: null, killErrors: null, sessionsChecked: 0, sessionsTotal: 1, coverage: 'unavailable' })

  const second = await runtime.send('channel-general', '第二个任务')
  const secondBinding = (await store.read()).bindings[second.thread.id]!
  let jobList = [{ id: 'j1', owner: secondBinding.rootId, status: 'running' }]
  services.jobs = { list: (owner: string) => jobList.filter(job => job.owner === owner), kill: (id: string) => { jobList = jobList.filter(job => job.id !== id) } }
  await expect(runtime.cancel(second.taskId!)).resolves.toMatchObject({ cancelled: true })
  operational = (await collectWorkforceDiagnostics(runtime)).operational
  expect(operational.stops.at(-1)).toMatchObject({ reason: 'user', phase: 'cancel_settled', jobsService: 'available', before: { running: 1, stopping: 0 }, after: { running: 0, stopping: 0 }, killErrors: 0, sessionsChecked: 1, sessionsTotal: 1 })

  const third = await runtime.send('channel-general', '第三个任务')
  await store.change(state => { state.bindings[third.thread.id]!.runStartedAt = 1234 })
  await expect(runtime.cancel(third.taskId!, 'run-limit', 1234)).resolves.toMatchObject({ cancelled: true })
  operational = (await collectWorkforceDiagnostics(runtime)).operational
  expect(operational.stops.at(-1)).toMatchObject({ reason: 'run_limit', phase: 'cancel_settled', jobsService: 'available' })
  expect(JSON.stringify(operational.stops)).not.toContain('j1')
  expect(JSON.stringify(operational.stops)).not.toContain(secondBinding.rootId)
  await runtime.dispose()
  expect((await collectWorkforceDiagnostics(runtime)).operational.stops.length).toBe(3)
})

it('TEL-H：approvals 只在兑现时记录——allowed-once/rejected/cancelled，不含理由与 callId', async () => {
  resetOperationalDiagnostics()
  const { sent, parent } = await task()
  parent.status = 'idle'; parent.inbox.nextTurn = []
  const held = parent.fire('approval/request', { toolName: 'shell.run', reason: '哨兵理由-SENTINEL-REASON' })
  const card = (await runtime.messages(sent.thread.id)).messages.find(item => item.approval)!
  await runtime.answerAsk(sent.thread.id, card.approval!.requestId, { outcome: 'allowed-once' })
  await expect(held).resolves.toBe('allowed-once')
  const held2 = parent.fire('approval/request', { toolName: 'wb_read_material' })
  const card2 = (await runtime.messages(sent.thread.id)).messages.filter(item => item.approval && !item.approval.answered).at(-1)!
  await runtime.answerAsk(sent.thread.id, card2.approval!.requestId, { outcome: 'rejected' })
  await expect(held2).resolves.toBe('rejected')
  const controller = new AbortController()
  const held3 = parent.fire('approval/request', { toolName: 'wb_publish_deliverable', signal: controller.signal })
  // 等卡片入 pendingAsks 再 abort——release 走 entry.resolve('cancelled') 同一条兑现路径。
  await expect.poll(async () => (await runtime.messages(sent.thread.id)).messages.filter(item => item.approval && !item.approval.answered).length).toBe(1)
  controller.abort()
  await expect(held3).resolves.toBe('cancelled')
  const operational = (await collectWorkforceDiagnostics(runtime)).operational
  expect(operational.approvals.map(item => item.outcome)).toEqual(['allowed_once', 'rejected', 'cancelled'])
  expect(operational.approvals[0]).toMatchObject({ toolClass: 'shell' })
  expect(operational.approvals[1]).toMatchObject({ toolClass: 'read_material' })
  for (const item of operational.approvals) expect(item.waitSec).toBeGreaterThanOrEqual(0)
  const json = JSON.stringify(operational.approvals)
  expect(json).not.toContain('哨兵理由')
  expect(json).not.toContain('shell.run')
  expect(json).not.toContain('callId')
})

it('DIAG-ASSIGNED：负责人根会话无事件时其技能不计入 assigned，notObserved 相应减少', async () => {
  resetOperationalDiagnostics()
  const { sent, binding } = await task()
  await runtime.send(sent.thread.id, '@分析员 直接执行', 'analyst')
  const directId = (await store.read()).bindings[sent.thread.id]!.directChildren!.analyst!
  const analyst = (await store.read()).employees.find(item => item.id === 'analyst')!
  // 直达任务只跑员工会话：负责人根会话存在但没有事件
  logs.set(binding.rootId, [])
  logs.set(directId, end())
  const row = (await collectWorkforceDiagnostics(runtime)).operational.threads[0]!
  expect(row.skills.assigned).toBe(analyst.skills.length)
  expect(row.skills.notObserved).toBe(analyst.skills.length)
  expect(row.skills.coverage).toBe('observed_window')
  // 根会话只有建会话的元数据事件（真实直达任务的形态）也不算运行过
  logs.set(binding.rootId, [{ type: 'session/meta', data: {} }])
  expect((await collectWorkforceDiagnostics(runtime)).operational.threads[0]!.skills.assigned).toBe(analyst.skills.length)
  // 根会话事件读不到：assigned 同样不含负责人技能，coverage 按现有规则记 partial
  logs.delete(binding.rootId)
  const again = (await collectWorkforceDiagnostics(runtime)).operational.threads[0]!
  expect(again.skills.assigned).toBe(analyst.skills.length)
  expect(again.skills.coverage).toBe('partial')
})

it('TEL-H：三个进程内环各封顶 20 条，溢出记 partial', async () => {
  resetOperationalDiagnostics()
  for (let index = 0; index < 25; index++) operationalRecorder.recordModelCheck({ outcome: 'failed', errorCategory: 'quota', providerClass: 'apikey', modelClass: 'other', elapsedSec: 1 })
  for (let index = 0; index < 22; index++) operationalRecorder.recordStop({ reason: 'user', phase: 'cancel_settled', elapsedSec: 0, turnState: 'unknown', jobsService: 'unavailable', before: null, after: null, killErrors: null, sessionsChecked: 0, sessionsTotal: 0, coverage: 'unavailable' })
  for (let index = 0; index < 21; index++) operationalRecorder.recordApproval({ toolClass: 'shell', outcome: 'rejected', waitSec: 0 })
  const operational = (await collectWorkforceDiagnostics(runtime)).operational
  expect(operational.modelChecks).toHaveLength(20)
  expect(operational.stops).toHaveLength(20)
  expect(operational.approvals).toHaveLength(20)
  expect(operational.coverage).toBe('partial')
})

it('消息页 sessions 只发布 Workforce 持有的活句柄：root/direct 需 handles 与注册同一实例，child 需 live，归档与 cold 不发', async () => {
  const { sent, binding, parent } = await task()
  const view1 = await runtime.messages(sent.thread.id)
  // 初始只有 root（handles 登记的 agent 与 agents 注册的是同一实例）。
  expect(view1.sessions).toEqual([{ sessionId: binding.rootId, employeeId: 'leader' }])

  // continuable child：delegate 在途但 agents 未登记 handle——cold，不发布。
  const childId = await runtime.delegate(parent, 'analyst', '分析', new AbortController().signal)
  expect((await runtime.messages(sent.thread.id)).sessions.find(item => item.sessionId === childId)).toBeUndefined()

  // child 有了 live handle（agents 注册）：带 parentSessionId 发布。
  agents.set(childId, { id: childId, status: 'running', cancel: vi.fn(), whenIdle: vi.fn(async () => {}), inbox: { nextTurn: [], nextStep: [] }, session: { id: childId, header: headers.get(childId) } })
  const view2 = await runtime.messages(sent.thread.id)
  expect(view2.sessions).toContainEqual({ sessionId: childId, employeeId: 'analyst', parentSessionId: binding.rootId })

  // direct child：send @ 建档即建 handle+agent——无 parentSessionId 发布。
  await runtime.send(sent.thread.id, '@分析员 直接执行', 'analyst')
  const directId = (await store.read()).bindings[sent.thread.id]!.directChildren!.analyst!
  const view3 = await runtime.messages(sent.thread.id)
  expect(view3.sessions).toContainEqual({ sessionId: directId, employeeId: 'analyst' })
  expect(view3.sessions.find(item => item.sessionId === directId)?.parentSessionId).toBeUndefined()

  // 归档：更正模型后再 send 直达，旧 direct 会话进入 archivedChildren——不发布。
  await store.saveEmployee({ model: 'another-model' }, 'analyst')
  await runtime.send(sent.thread.id, '@分析员 换配置再执行', 'analyst')
  const archived = (await store.read()).bindings[sent.thread.id]!.archivedChildren!.find(item => item.sessionId === directId)
  expect(archived).toBeTruthy()
  const view4 = await runtime.messages(sent.thread.id)
  expect(view4.sessions.find(item => item.sessionId === directId)).toBeUndefined()
  // 新 direct 照旧发布（无 parentSessionId）。
  const newDirect = (await store.read()).bindings[sent.thread.id]!.directChildren!.analyst!
  expect(newDirect).not.toBe(directId)
  expect(view4.sessions).toContainEqual({ sessionId: newDirect, employeeId: 'analyst' })

  // stale handle：agents 注册的不是 handles 登记的实例（重启/重建后旧句柄残留）不发布。
  const stale = { id: newDirect, status: 'idle', cancel: vi.fn(), whenIdle: vi.fn(async () => {}), inbox: { nextTurn: [], nextStep: [] }, session: { id: newDirect, header: headers.get(newDirect) } }
  agents.set(newDirect, stale)
  expect((await runtime.messages(sent.thread.id)).sessions.find(item => item.sessionId === newDirect)).toBeUndefined()
})

it('DM 消息页 sessions 只含 root；assistant/message 行带真实 turn:step streamKey', async () => {
  const dm = await runtime.ensureDm('writer')
  await runtime.send(dm.id, '先看一眼')
  const binding = (await store.read()).bindings[dm.id]!
  const parent = agents.get(binding.rootId)
  parent.status = 'idle'; parent.inbox.nextTurn = []; parent.inbox.nextStep = []
  logs.set(binding.rootId, [
    { type: 'turn/start', seq: 0, time: 1, data: {} },
    { type: 'assistant/message', seq: 1, time: 2, data: { turn: 4, step: 2, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '第一段回复' }] }, stream: [] } },
    { type: 'assistant/message', seq: 2, time: 3, data: { turn: 4, step: 3, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '过程' }, { type: 'tool-call', id: 'c1', name: 'wb_save', arguments: '{}' }] }, stream: [] } },
    { type: 'tool/call', seq: 3, time: 4, data: { turn: 4, step: 3, callId: 'c1', name: 'wb_save', arguments: '{}' } },
    { type: 'turn/end', seq: 4, time: 5, data: { reason: { kind: 'completed' } } },
  ])
  const view = await runtime.messages(dm.id)
  expect(view.sessions).toEqual([{ sessionId: binding.rootId, employeeId: 'writer' }])
  const texts = view.messages.filter(item => item.role === 'agent' && item.text !== '')
  expect(texts.map(item => item.streamKey)).toEqual([`${binding.rootId}:4:2`, `${binding.rootId}:4:3`])
  // tool 中间步也带 streamKey 并标 intermediate。
  expect(texts[1]!.intermediate).toBe(true)
})

it('闸门：thread 先 running 但 handles 尚未登记时不发布 root；登记后才发布', async () => {
  const gate = asyncGate(), create = services.agents.create.getMockImplementation()!
  services.agents.create.mockImplementationOnce(async (options: any) => { gate.enter(); await gate.waiting; return create(options) })
  const sending = runtime.send('channel-general', '闸门任务')
  await gate.entered
  // 窗口内：线程已 running、binding 已落盘，但 openRoot 仍停在 agents.create——无 handles 登记。
  const state = await store.read()
  const running = state.threads.find(item => item.status === 'running')!
  const during = await runtime.messages(running.id)
  expect(during.thread.status).toBe('running')
  // 旧 root 尚未登记不能发布给 UI 订阅（retain cold 会抢占 writer）。
  expect(during.sessions).toEqual([])

  gate.release()
  await sending
  const after = await runtime.messages(running.id)
  const binding = (await store.read()).bindings[running.id]!
  expect(after.sessions).toEqual([{ sessionId: binding.rootId, employeeId: 'leader' }])
})

it('闸门：delegate 未 resolve 且 child 无 registry active 不发布；registry 登记后才发布', async () => {
  const { sent, parent, binding } = await task()
  const gate = asyncGate(), start = services.subagents.startActivation.getMockImplementation()!
  services.subagents.startActivation.mockImplementationOnce(async (spec: any) => {
    gate.enter(); await gate.waiting
    return start(spec)
  })
  const delegating = runtime.delegate(parent, 'analyst', '闸门派工', new AbortController().signal)
  await gate.entered
  // 窗口内：child 映射已写、log 可读，但 agents registry 无该 child，delegate 未 resolve。
  const childId = (await store.read()).bindings[sent.thread.id]!.children.analyst!
  logs.set(childId, end())
  const during = await runtime.messages(sent.thread.id)
  expect(during.sessions.find(item => item.sessionId === childId)).toBeUndefined()

  gate.release()
  await delegating
  // registry 登记 live child 后才发布，并带显式父地址。
  agents.set(childId, { id: childId, status: 'running', cancel: vi.fn(), whenIdle: vi.fn(async () => {}), inbox: { nextTurn: [], nextStep: [] }, session: { id: childId, header: headers.get(childId) } })
  const after = await runtime.messages(sent.thread.id)
  expect(after.sessions).toContainEqual({ sessionId: childId, employeeId: 'analyst', parentSessionId: binding.rootId })
})

it('提问身份同callId贯穿：前台卡用cont-<callId>提交直命中同一挂起；停止封存跨重启拒迟到（含cont身份）；预检读取失败明确unavailable且不root', async () => {
  const { sent, parent } = await task()
  parent.status = 'idle'; parent.inbox.nextTurn = []
  const held = parent.fire('user-questions/request', {
    questions: [{ id: 'q1', question: '选哪种？', options: [{ label: 'A' }, { label: 'B' }] }],
    wait: { callId: 'call-9' },
  })
  const card = (await runtime.messages(sent.thread.id)).messages.find(item => item.question)!
  // 前台条目用 cont-<callId> 身份提交：反查到同一挂起条目直接兑现，不 not_found、不产生第二张卡
  await runtime.answerAsk(sent.thread.id, 'cont-call-9', { answers: [{ id: 'q1', selected: ['B'] }] })
  await expect(held).resolves.toEqual({ answers: [{ id: 'q1', selected: ['B'] }] })
  expect((await runtime.messages(sent.thread.id)).messages.filter(item => item.question)).toHaveLength(1)
  // 显式停止封存：pending 卡随取消释放，cont-<callId> 迟到提交按持久 stoppedAsks 拒绝
  const stopSignal = new AbortController()
  const held2 = parent.fire('user-questions/request', {
    signal: stopSignal.signal,
    questions: [{ id: 'q2', question: '还继续吗？', options: [{ label: '做' }, { label: '停' }] }],
    wait: { callId: 'call-10' },
  })
  await runtime.cancel(sent.taskId!)
  stopSignal.abort() // 原生停止中止前台等待 signal；随后挂起卡进 stoppedAsks 封存
  await expect(held2).rejects.toBeTruthy()
  expect((await runtime.messages(sent.thread.id)).messages.filter(item => item.question)).toHaveLength(2)
  await expect(runtime.answerAsk(sent.thread.id, 'cont-call-10', { answers: [{ id: 'q2', selected: ['做'] }] })).rejects.toMatchObject({ code: 'conflict' })
  // 冷封存：同 store 重启后（pendingAsks 已空）仍由 stoppedAsks 命中拒绝
  await runtime.dispose(); agents.clear()
  runtime = new WorkforceRuntime(store, name => services[name])
  await expect(runtime.answerAsk(sent.thread.id, 'cont-call-10', { answers: [{ id: 'q2', selected: ['做'] }] })).rejects.toMatchObject({ code: 'conflict' })
  // 预检不可得（日志读不到）：明确 unavailable，且全程不 create/resume——迟到提交不把冷会话恢复成 writer
  const creates = services.agents.create.mock.calls.length, resumes = services.agents.resume.mock.calls.length
  services.sessionQuery.observeSession.mockRejectedValueOnce(new Error('storage failure'))
  await expect(runtime.answerAsk(sent.thread.id, 'cont-no-such-call', { answers: [] })).rejects.toMatchObject({ code: 'unavailable' })
  expect(services.agents.create.mock.calls.length).toBe(creates)
  expect(services.agents.resume.mock.calls.length).toBe(resumes)
})

it('线程文件历史：write/str_replace_editor 成功写盘才成行（view/失败/未完成/非文件工具排除），脚本不入历史，安装包只给location，身份不可跨线程', async () => {
  const { sent, binding, parent } = await task()
  const cwd = headers.get(binding.rootId)!.cwd
  for (const [name, content] of [['方案.md', '# 正文'], ['笔记.md', '笔记'], ['deploy.sh', 'echo hi'], ['setup.exe', 'MZ']] as const) {
    await writeFile(join(cwd, name), content)
  }
  const call = (seq: number, callId: string, name: string, args: Record<string, unknown>) => ({ type: 'tool/call', seq, time: seq, data: { callId, name, arguments: JSON.stringify(args) } })
  const result = (seq: number, callId: string, failed = false) => ({ type: 'tool/result', seq, time: seq, data: { message: { toolCallId: callId, ...(failed ? { isError: true } : {}), content: [{ type: 'text', text: failed ? 'failed' : 'ok' }] } } })
  logs.set(binding.rootId, [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    call(1, 'w1', 'write', { file_path: '方案.md' }), result(2, 'w1'),
    call(3, 'v1', 'view', { file_path: '方案.md' }), result(4, 'v1'),
    call(5, 'f1', 'write', { file_path: '方案.md' }), result(6, 'f1', true),
    call(7, 'p1', 'write', { file_path: '方案.md' }),
    call(8, 's1', 'write', { file_path: 'deploy.sh' }), result(9, 's1'),
    call(10, 'c1', 'str_replace_editor', { command: 'create', path: '笔记.md' }), result(11, 'c1'),
    call(12, 'e1', 'write', { file_path: 'setup.exe' }), result(13, 'e1'),
    call(14, 'x1', 'shell.run', { command: 'cp 方案.md 别处.md' }), result(15, 'x1'),
    { type: 'turn/end', seq: 16, time: 17, data: { reason: { kind: 'completed' } } },
  ])
  const toolRows = (await runtime.threadFiles(sent.thread.id)).filter(item => item.source === 'tool')
  // 只有成功且真实写盘的文件变更调用成行；view/失败/无结果/脚本/非文件工具都不造行
  expect(toolRows.map(item => item.id)).toEqual([`t|${binding.rootId}|w1`, `t|${binding.rootId}|c1`, `t|${binding.rootId}|e1`])
  const text = toolRows.find(item => item.id.endsWith('|w1'))!
  expect(text).toMatchObject({ name: '方案.md', sizeBytes: Buffer.byteLength('# 正文'), source: 'tool' })
  expect(typeof text.url).toBe('string')
  const exe = toolRows.find(item => item.id.endsWith('|e1'))!
  expect(exe.url).toBeUndefined()
  expect(exe.locationUrl).toBeTruthy()
  expect((await runtime.fileEntry(sent.thread.id, exe.id)).installer).toBe(true)
  expect((await runtime.fileEntry(sent.thread.id, text.id)).installer).toBe(false)
  // 身份绑定：fileId 必须解析回归属线程的会话事件；换线程/换会话一律 not_found，不给任意路径读取
  parent.status = 'idle'; parent.inbox.nextTurn = []; parent.inbox.nextStep = []
  await runtime.messages(sent.thread.id)
  const other = await runtime.send('channel-general', '另一单')
  await expect(runtime.fileEntry(other.thread.id, text.id)).rejects.toMatchObject({ code: 'not_found' })
  await expect(runtime.fileEntry(sent.thread.id, `t|ghost-session|w1`)).rejects.toMatchObject({ code: 'not_found' })
  await expect(runtime.fileEntry(sent.thread.id, 't|no-such-format')).rejects.toMatchObject({ code: 'not_found' })
})

it('成果二进制按原字节保存（sha256/sizeBytes 按原字节，charCount 缺省），文件历史逐真实版本成行，fileEntry 父归属不跨线程', async () => {
  const { sent, binding, parent } = await task()
  const childId = await runtime.delegate(parent, 'analyst', '画图', new AbortController().signal)
  const cwd = (await runtime.workspaceRoot(childId))!
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe])
  await writeFile(join(cwd, '图.png'), png)
  const saved = await runtime.saveDeliverable(childId, '图.png', undefined, '图.png')
  expect(saved.sha256).toBe(createHash('sha256').update(png).digest('hex'))
  expect(saved.sizeBytes).toBe(png.length)
  expect(saved.charCount).toBe(0)
  const taskId = (await store.read()).tasks.find(item => item.threadId === sent.thread.id)!.id
  expect(await readFile((await store.deliverableFile(taskId, '图.png', String(saved.version))).path)).toEqual(png)
  // 新一轮用户消息后才递增；两个真实版本在文件历史各成一行
  await runtime.send(sent.thread.id, '第二轮：再出一张')
  await runtime.saveDeliverable(childId, '图.png', undefined, '图.png')
  const versions = (await runtime.threadFiles(sent.thread.id)).filter(item => item.source === 'deliverable').map(item => item.version)
  expect(versions).toEqual([1, 2])
  // 父归属：d| 身份必须命中本线程的任务，他线程任务 id 一律 not_found
  parent.status = 'idle'; parent.inbox.nextTurn = []; parent.inbox.nextStep = []
  logs.set(binding.rootId, end())
  await runtime.messages(sent.thread.id)
  const other = await runtime.send('channel-general', '另一单')
  await expect(runtime.fileEntry(sent.thread.id, `d|${other.taskId}|图.png|1`)).rejects.toMatchObject({ code: 'not_found' })
  expect(await runtime.fileEntry(sent.thread.id, `d|${taskId}|图.png|1`)).toMatchObject({ name: '图.png', installer: false })
})

it('群聊成员名单 []/null 语义分明、无效成员过滤、可空显示字段 undefined 保持 null 清除；DM lastMessageAt 补扫失败不置位可重试、扫空也置位', async () => {
  const channel = await store.saveChannel({ name: '群聊A', memberIds: ['writer', 'ghost', 'writer'] })
  expect(channel.memberIds).toEqual(['writer'])
  expect((await store.saveChannel({ memberIds: [] }, channel.id)).memberIds).toEqual([])
  expect((await store.saveChannel({ memberIds: null }, channel.id)).memberIds).toBeUndefined()
  expect((await store.saveChannel({}, channel.id)).memberIds).toBeUndefined()
  expect((await store.saveChannel({ groupChatName: '小分队' }, channel.id)).groupChatName).toBe('小分队')
  expect((await store.saveChannel({ groupChatName: null }, channel.id)).groupChatName).toBeUndefined()
  expect((await store.saveChannel({ groupChatName: '' }, channel.id)).groupChatName).toBeUndefined()
  expect((await store.saveChannel({}, channel.id)).name).toBe('群聊A')
  // 补扫：任一会话读取失败整条跳过，不置位留待下轮重试；成功后（含真实正文）落时间并置位
  const dm = await runtime.ensureDm('writer')
  await runtime.send(dm.id, '私信正文')
  const binding = (await store.read()).bindings[dm.id]!
  const human = agents.get(binding.rootId)!.followup.mock.calls[0][0]
  logs.set(binding.rootId, [{ type: 'user/message', seq: 0, time: 1, data: human }, ...end()])
  await store.change(state => { const thread = state.threads.find(item => item.id === dm.id)!; delete thread.lastMessageAt; delete thread.lastMessageScanned })
  services.sessionQuery.observeSession.mockRejectedValueOnce(new Error('locked'))
  await runtime.backfillDmLastMessage(await store.read())
  expect((await store.read()).threads.find(item => item.id === dm.id)!.lastMessageScanned).toBeUndefined()
  await runtime.backfillDmLastMessage(await store.read())
  const scanned = (await store.read()).threads.find(item => item.id === dm.id)!
  expect(scanned.lastMessageScanned).toBe(true)
  expect(scanned.lastMessageAt).toBeTruthy()
  // 已置位不再补扫：会话再坏也不动既有值
  services.sessionQuery.observeSession.mockRejectedValue(new Error('gone'))
  await runtime.backfillDmLastMessage(await store.read())
  expect((await store.read()).threads.find(item => item.id === dm.id)!.lastMessageAt).toBe(scanned.lastMessageAt)
  // 无 binding 的 DM：正常空扫也置位，避免每轮列表重读会话
  const orphan = await runtime.ensureDm('analyst')
  await store.change(state => { delete state.bindings[orphan.id]; const thread = state.threads.find(item => item.id === orphan.id)!; delete thread.lastMessageAt; delete thread.lastMessageScanned })
  await runtime.backfillDmLastMessage(await store.read())
  const orphanAfter = (await store.read()).threads.find(item => item.id === orphan.id)!
  expect(orphanAfter.lastMessageScanned).toBe(true)
  expect(orphanAfter.lastMessageAt).toBeUndefined()
})
