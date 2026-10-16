// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { WorkforceApi, type WorkforceModelsState } from '../src/client/workforce-api.ts'
import { WorkforceSource } from '../src/client/workforce-source.ts'
import { WorkforceModelsSource } from '../src/client/workforce-models-source.ts'
import { GlobalModelAccess } from '../src/client/workforce-models.tsx'
import { WorkforceMain } from '../src/client/workforce.tsx'
import { WorkforceSkillDraftsDialog } from '../src/client/workforce-skill-drafts.tsx'
import { Dialog } from '../src/client/ui/index.tsx'
import type { Employee, Task, Thread, WorkforceMessage, WorkforceSkillDraft } from '../src/client/workforce-types.ts'

const leader: Employee = { id: 'leader', name: '负责人', title: '负责人', persona: '', skills: [], isLeader: true }
const writer: Employee = { ...leader, id: 'writer', name: '文案员', isLeader: false, model: 'writer-provider/model' }
const channel: Thread = { id: 'channel-general', kind: 'channel', channelId: 'general', title: '大厅', status: 'idle', updatedAt: '2026-10-11' }
const dm: Thread = { ...channel, id: 'dm-writer', kind: 'dm', employeeId: 'writer' }
const taskThread: Thread = { ...channel, id: 'task-thread', kind: 'task', status: 'idle' }
const task: Task = { id: 'task', threadId: taskThread.id, channelId: 'general', assigneeId: writer.id, delegatorId: leader.id, title: '写稿', prompt: '写稿', status: 'done', deliverables: [], createdAt: '2026-10-11', updatedAt: '2026-10-11' }
const draft: WorkforceSkillDraft = { id: 'draft', taskId: task.id, slug: 'fixture-skill', title: '写稿流程', description: '', body: '# 流程', status: 'drafted', findings: [], createdAt: '2026-10-11', updatedAt: '2026-10-11' }
const backing = new Map<string, string>()
const releases: (() => void)[] = []

beforeEach(() => {
  backing.clear()
  vi.stubGlobal('localStorage', { getItem: (key: string) => backing.get(key) ?? null, setItem: (key: string, value: string) => { backing.set(key, value) } })
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(() => run(performance.now()), 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  if (!HTMLDialogElement.prototype.showModal) HTMLDialogElement.prototype.showModal = function () { this.open = true }
  if (!HTMLDialogElement.prototype.close) HTMLDialogElement.prototype.close = function () { this.open = false }
})
afterEach(() => { cleanup(); for (const release of releases.splice(0)) release(); vi.unstubAllGlobals() })

function modelState(): WorkforceModelsState {
  return { providers: [
    { id: 'leader-provider', displayName: '负责人供应商', kind: 'apikey', configured: true, requiresApiKey: true, writable: true, models: [{ id: 'model' }] },
    { id: 'writer-provider', displayName: '文案供应商', kind: 'apikey', configured: false, requiresApiKey: true, writable: true, models: [{ id: 'model' }] },
  ], defaultModel: { provider: 'leader-provider', model: 'model' } }
}

async function fixture() {
  let state = modelState()
  let metadataFails = false, credentialWriteFails = false, loseReceipt = false
  const writes: { path: string; body: Record<string, unknown> }[] = []
  const history: WorkforceMessage[] = []
  let threads = [channel, dm, taskThread], tasks = [task]
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname.replace('/wb/api/workforce', '')
    if (init?.method && init.method !== 'GET') {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
      writes.push({ path, body })
      if (path.endsWith('/messages')) {
        if (loseReceipt) { loseReceipt = false; throw new Error('回执中断') }
        const thread = threads.find(item => item.id === path.split('/')[2])!
        const message: WorkforceMessage = { id: 'server-message', threadId: thread.id, ts: '2026-10-11T00:00:01Z', role: 'user', senderId: 'human', senderName: '你', text: String(body.text) }
        history.push(message)
        return Response.json({ ok: true, data: { message, thread } })
      }
      if (path === '/models/key') {
        if (credentialWriteFails) return Response.json({ ok: false, error: { code: 'unavailable', message: 'private credential detail' } }, { status: 503 })
        state = { ...state, providers: state.providers.map(item => item.id === body.provider ? { ...item, configured: true } : item) }
        return Response.json({ ok: true, data: { configured: true } })
      }
      return Response.json({ ok: true, data: { draft } })
    }
    if (path === '/models') {
      if (metadataFails) return Response.json({ ok: false, error: { code: 'credentials_unavailable', message: 'private metadata detail' } }, { status: 503 })
      return Response.json({ ok: true, data: state })
    }
    if (path === '/employees') return Response.json({ ok: true, data: { employees: [leader, writer] } })
    if (path === '/channels') return Response.json({ ok: true, data: { channels: [], groups: [] } })
    if (path === '/threads') return Response.json({ ok: true, data: { threads } })
    if (path === '/tasks') return Response.json({ ok: true, data: { tasks } })
    if (path === '/skill-drafts') return Response.json({ ok: true, data: { drafts: [draft] } })
    if (path.endsWith('/messages')) {
      const thread = threads.find(item => item.id === path.split('/')[2])!
      return Response.json({ ok: true, data: { messages: history.filter(item => item.threadId === thread.id), cursor: '1', thread, hasMore: false } })
    }
    throw new Error(`Unexpected fixture route ${path}`)
  })
  const api = new WorkforceApi(transport as typeof fetch)
  const source = new WorkforceSource(api, 60_000)
  releases.push(source.subscribe(() => {}))
  await vi.waitFor(() => expect(source.getSnapshot().phase).toBe('ready'))
  return {
    api, source, writes, transport,
    setState: (next: WorkforceModelsState) => { state = next },
    readyWriter: () => { state = { ...state, providers: state.providers.map(item => item.id === 'writer-provider' ? { ...item, configured: true } : item) } },
    failMetadata: () => { metadataFails = true },
    failCredentialWrite: () => { credentialWriteFails = true },
    loseReceipt: () => { loseReceipt = true },
    runningTask: async () => {
      threads = [channel, dm, { ...taskThread, status: 'running' }]
      tasks = [{ ...task, status: 'running' }]
      source.refresh()
      await vi.waitFor(() => expect(source.getSnapshot().threads.find(item => item.id === taskThread.id)?.status).toBe('running'))
    },
  }
}

describe('实际模型操作前的门禁', () => {
  it.each(['dm', 'task', 'multi-at', 'running-channel'] as const)('%s 按真实员工provider检查，其他供应商有Key不放行且不写乐观态', async route => {
    const f = await fixture()
    if (route === 'running-channel') await f.runningTask()
    const target = route === 'dm' ? dm.id : route === 'task' ? taskThread.id : channel.id
    const recipients = route === 'dm' ? [leader.id] : route === 'multi-at' ? [leader.id, writer.id] : undefined
    const before = f.source.getSnapshot().messages
    await expect(f.source.send(target, '保留原稿', recipients)).rejects.toThrow('文案供应商')
    expect(f.writes).toEqual([])
    expect(f.source.getSnapshot().messages).toBe(before)
    expect(f.source.getPendingReplies()).toEqual([])
    expect(f.source.models.getSnapshot().access?.provider).toBe('writer-provider')
  })

  it('普通频道默认负责人已配置可发送；失败retry门禁保留身份，补Key后仍用原requestId', async () => {
    const f = await fixture()
    await f.source.send(channel.id, '默认负责人')
    expect(f.writes).toHaveLength(1)
    f.readyWriter(); f.loseReceipt()
    await expect(f.source.send(dm.id, '私信原稿')).rejects.toThrow('回执中断')
    const failed = f.source.getSnapshot().messages[dm.id]!.list.find(item => item.delivery === 'failed')!
    const original = f.writes[1]!
    f.setState(modelState())
    await expect(f.source.retryMessage(failed.clientId!)).rejects.toThrow('文案供应商')
    const blocked = f.source.getSnapshot().messages[dm.id]!.list.find(item => item.clientId === failed.clientId)!
    expect(blocked).toMatchObject({ clientId: failed.clientId, text: failed.text, ts: failed.ts, delivery: 'failed', recipientIds: ['writer'] })
    expect(f.writes).toHaveLength(2)
    f.readyWriter(); f.source.models.close()
    await f.source.retryMessage(failed.clientId!)
    expect(f.writes).toHaveLength(3)
    expect(f.writes[2]).toEqual(original)
  })

  it.each(['regenerate', 'answer', 'request-draft', 'return-draft'] as const)('%s 在续跑前检查员工模型，无Key不发业务HTTP或写waiting', async operation => {
    const f = await fixture()
    const before = f.source.getSnapshot().messages
    const run = operation === 'regenerate' ? f.source.regenerateMessage(taskThread.id, 'agent-message', writer.id)
      : operation === 'answer' ? f.source.answerAsk(taskThread.id, 'ask-id', { answers: [] }, writer.id)
      : operation === 'request-draft' ? f.source.requestSkillDraft(task.id, '整理意见')
      : f.source.returnSkillDraft(draft.id, '退回意见')
    await expect(run).rejects.toThrow('文案供应商')
    expect(f.writes).toEqual([])
    expect(f.source.getPendingReplies()).toEqual([])
    expect(f.source.getSnapshot().messages).toBe(before)
  })

  it('native requiresApiKey=false即使configured=false也交宿主尝试，不要求Key', async () => {
    const f = await fixture()
    f.setState({ ...modelState(), providers: modelState().providers.map(item => ({ ...item, requiresApiKey: false, configured: false, writable: false })) })
    await f.source.send(dm.id, '原生认证')
    expect(f.writes).toHaveLength(1)
    expect(f.source.models.getSnapshot().access).toBeUndefined()
  })

  it('missing_model与metadata失败均不发业务请求；失败不使用旧configured快照假成功', async () => {
    const f = await fixture()
    f.setState({ providers: modelState().providers })
    await expect(f.source.send(channel.id, '草稿')).rejects.toThrow('尚未选择')
    expect(f.source.models.getSnapshot().access).toBeDefined()
    f.setState(modelState()); f.source.models.close()
    await f.source.models.refresh()
    f.failMetadata()
    await expect(f.source.send(channel.id, '草稿')).rejects.toThrow('无法读取 DSH')
    expect(f.source.models.getSnapshot().error).toContain('输入已保留')
    expect(f.writes).toEqual([])
    expect(f.source.getPendingReplies()).toEqual([])
  })

  it('员工裸model继承默认provider，显式provider/model无需默认模型或完整目录', async () => {
    const models = new WorkforceModelsSource({ models: async () => modelState() } as WorkforceApi)
    await models.require([{ name: '裸模型员工', model: 'custom-native-model' }])
    expect(models.getSnapshot().access).toBeUndefined()
    const explicit = new WorkforceModelsSource({ models: async () => ({ providers: [{ ...modelState().providers[0]!, models: [] }] }) } as unknown as WorkforceApi)
    await explicit.require([{ name: '指定员工', model: 'leader-provider/custom-native-model' }])
    expect(explicit.getSnapshot().access).toBeUndefined()
  })

  it('models API严格归一新增字段，保留默认选择和旧provider格式，丢弃Key字段', async () => {
    const api = new WorkforceApi(async () => Response.json({ ok: true, data: {
      providers: [
        { provider: 'native', name: '原生', kind: 'apikey', configured: false, requiresApiKey: false, writable: false, keySource: 'native', credentialRef: 'REF', models: ['model'], key: 'fixture-secret' },
        { id: 'bad', requiresApiKey: 'false', writable: 0, keySource: {}, credentialRef: 7, models: null },
      ], currentSelection: { provider: 'native', model: 'model' },
    } }))
    const result = await api.models()
    expect(result.providers[0]).toMatchObject({ id: 'native', displayName: '原生', requiresApiKey: false, writable: false, keySource: 'native', credentialRef: 'REF', models: [{ id: 'model' }] })
    expect(result.providers[1]).toMatchObject({ requiresApiKey: undefined, writable: undefined, keySource: undefined, credentialRef: undefined, models: [] })
    expect(result.defaultModel).toEqual({ provider: 'native', model: 'model' })
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
  })
})

function root(f: Awaited<ReturnType<typeof fixture>>, surface: 'channel' | 'dm') {
  function App({ current }: { current: 'channel' | 'dm' }) {
    const snapshot = useSyncExternalStore(f.source.subscribe, f.source.getSnapshot, f.source.getSnapshot)
    return <>
      <WorkforceMain key={current} source={f.source} snapshot={snapshot} surface={current === 'channel' ? { kind: 'channel', id: 'general' } : { kind: 'dm', threadId: dm.id, employeeId: writer.id }} onDm={() => {}} openThreadId={undefined} onCloseThread={() => {}} onOpenThread={() => {}} onNavigation={() => {}} />
      <GlobalModelAccess source={f.source.models} />
    </>
  }
  const view = render(<App current={surface} />)
  return { ...view, switchTo: (current: 'channel' | 'dm') => view.rerender(<App current={current} />) }
}

describe('全局接入组件与草稿', () => {
  it('无Key浏览频道/DM不弹；发送才打开唯一modal，重复open/切页/关闭保留会话草稿', async () => {
    const f = await fixture(), view = root(f, 'channel')
    const composer = await screen.findByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: '频道草稿' } })
    expect(screen.queryByRole('dialog')).toBeNull()
    view.switchTo('dm')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'DM草稿' } })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    const dialog = await screen.findByRole('dialog')
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(1)
    act(() => f.source.models.open({ provider: 'leader-provider' }))
    expect(screen.getByRole('dialog')).toBe(dialog)
    view.switchTo('channel')
    expect(screen.getByRole('dialog')).toBe(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('频道草稿')
    view.switchTo('dm')
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('DM草稿')
    expect(f.writes).toEqual([])
    expect(backing.get(`workforce.draft.${dm.id}`)).toBe('DM草稿')
  })

  it('Key编辑、清除确认复用同一Dialog；env fallback仍configured时准确说明原生来源', async () => {
    const f = await fixture()
    render(<GlobalModelAccess source={f.source.models} />)
    act(() => f.source.models.open())
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(await screen.findByRole('button', { name: '添加凭据' }))
    expect(screen.getByRole('dialog')).toBe(dialog)
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'fixture-key-input' } })
    act(() => f.source.models.open())
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('fixture-key-input')
    fireEvent.click(screen.getByRole('button', { name: '保存到 DSH' }))
    await screen.findByText(/凭据已保存到 DSH/)
    expect(f.writes).toEqual([{ path: '/models/key', body: { provider: 'writer-provider', key: 'fixture-key-input' } }])
    expect(document.querySelectorAll('dialog')).toHaveLength(1)
    const card = dialog.querySelector('[data-model-provider="writer-provider"]') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: '清除 Key' }))
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(document.querySelector('[data-model-page="clear"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认清除' }))
    await screen.findByText('已移除 DSH 本机保存的 Key；此供应商仍有其他原生凭据来源。')
    expect(f.writes[1]).toEqual({ path: '/models/key', body: { provider: 'writer-provider' } })
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(1)
  })

  it('覆盖业务Dialog时暂时收起，Escape恢复原Dialog和未保存意见', async () => {
    const f = await fixture()
    render(<><Dialog title="业务审核" closeLabel="关闭审核" onClose={() => {}}><textarea aria-label="审核意见" defaultValue="未保存的意见" /></Dialog><GlobalModelAccess source={f.source.models} /></>)
    const business = screen.getByRole('dialog', { name: '业务审核' }) as HTMLDialogElement
    act(() => f.source.models.open())
    const overlay = await screen.findByRole('dialog', { name: '模型接入' })
    expect(business.open).toBe(false)
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(1)
    fireEvent(overlay, new Event('cancel', { bubbles: true, cancelable: true }))
    expect(business.open).toBe(true)
    expect((screen.getByLabelText('审核意见') as HTMLTextAreaElement).value).toBe('未保存的意见')
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(1)
    expect(f.source.models.getSnapshot().access).toBeUndefined()
  })

  it('草稿退回缺Key保留意见，接入覆盖审核框，关闭后回到原审核输入', async () => {
    const f = await fixture()
    render(<><WorkforceSkillDraftsDialog source={f.source} employees={[leader, writer]} tasks={[task]} api={f.api} onClose={() => {}} /><GlobalModelAccess source={f.source.models} /></>)
    fireEvent.click(await screen.findByText(draft.title))
    fireEvent.click(screen.getByRole('button', { name: '退回负责人整理' }))
    const note = await screen.findByRole('textbox', { name: /退回/ })
    fireEvent.change(note, { target: { value: '补充真实步骤' } })
    fireEvent.click(screen.getByRole('button', { name: /^退回$/ }))
    const overlay = await screen.findByRole('dialog', { name: '文案供应商 · DSH 凭据' })
    expect(f.writes).toEqual([])
    fireEvent(overlay, new Event('cancel', { bubbles: true, cancelable: true }))
    expect((await screen.findByRole('textbox', { name: /退回/ }) as HTMLTextAreaElement).value).toBe('补充真实步骤')
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(1)
  })

  it('需Key的注册来源未配置时显示未接入，原生认证来源交由DSH调用', async () => {
    const f = await fixture()
    f.setState({ providers: [
      { id: 'registered-provider', displayName: '注册来源', kind: 'apikey', configured: false, requiresApiKey: true, models: [] },
      { id: 'native', displayName: '原生', kind: 'apikey', configured: false, requiresApiKey: false, models: [] },
    ] })
    render(<GlobalModelAccess source={f.source.models} />)
    act(() => f.source.models.open())
    await screen.findByText('注册来源')
    const card = document.querySelector('[data-model-provider="registered-provider"]') as HTMLElement
    const status = within(card).getByText('未接入')
    expect(status.className).toContain('badgeDim')
    expect(within(card).queryByText('交由 DSH 调用')).toBeNull()
    expect(screen.getByText('交由 DSH 调用')).toBeTruthy()
    await expect(f.source.models.require([{ name: '指定模型员工', model: 'registered-provider/model' }])).rejects.toThrow('凭据')
  })

  it('Key保存API失败保留编辑值并显示安全错误，不显示保存成功', async () => {
    const f = await fixture(); f.failCredentialWrite()
    render(<GlobalModelAccess source={f.source.models} />)
    act(() => f.source.models.open({ provider: 'writer-provider' }))
    const field = await screen.findByLabelText('API Key') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'fixture-unsaved-key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存到 DSH' }))
    expect((await screen.findByRole('alert')).textContent).toContain('凭据保存或状态刷新未完成')
    expect(field.value).toBe('fixture-unsaved-key')
    expect(screen.getByRole('alert').textContent).not.toContain('private credential detail')
    expect(screen.queryByText(/凭据已保存到 DSH/)).toBeNull()
    expect(f.writes).toHaveLength(1)
  })

  it('modal读取metadata失败显示安全错误，不显示测试成功或凭据已保存', async () => {
    const f = await fixture(); f.failMetadata()
    render(<GlobalModelAccess source={f.source.models} />)
    act(() => f.source.models.open())
    expect((await screen.findByRole('alert')).textContent).toContain('无法读取 DSH')
    expect(screen.queryByText(/连接与模型调用成功|已有凭据/)).toBeNull()
    expect(screen.getByRole('alert').textContent).not.toContain('private metadata detail')
    expect(f.writes).toEqual([])
  })
})
