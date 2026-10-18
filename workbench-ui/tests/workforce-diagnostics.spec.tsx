// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkforceDiagnosticsDialog } from '../src/client/workforce-diagnostics.tsx'
import { bindWorkforceFileSession } from '../src/client/workforce-attachments.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); bindWorkforceFileSession(undefined) })
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) HTMLDialogElement.prototype.showModal = function () { this.open = true }
  if (!HTMLDialogElement.prototype.close) HTMLDialogElement.prototype.close = function () { this.open = false }
})

const respond = (data: unknown) => Promise.resolve({ ok: true, json: async () => ({ ok: true, data }) } as Response)

describe('诊断导出预览', () => {
  it('附加任务对话的预览里能看到消息 tool 字段（name/status）', async () => {
    const report = {
      generatedAt: '2026-10-09T00:00:00Z',
      conversation: { taskId: 't-1', threadId: 'th-1', messages: [{ id: 'm1', ts: '2026-10-09', role: 'agent', senderId: 'leader', text: '调用失败', tool: { name: 'shell.run', status: 'error' } }] },
      errors: [],
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => respond(url.includes('taskId=t-1') ? report : { generatedAt: '2026-10-09T00:00:00Z', errors: [] })))
    render(<WorkforceDiagnosticsDialog onClose={() => {}} tasks={[{ id: 't-1', title: '失败任务' }]} />)
    const textarea = await screen.findByLabelText('JSON 预览') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toContain('generatedAt'))
    expect(textarea.value).not.toContain('shell.run')
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(textarea.value).toContain('"tool"'))
    expect(textarea.value).toContain('"name": "shell.run"')
    expect(textarea.value).toContain('"status": "error"')
    // 说明文案写明覆盖范围与工具信息
    expect(screen.getByText(/附加的对话取所选任务最近 50 条消息，含工具名与状态、不含工具参数/)).toBeTruthy()
  })

  it('没有任务时不显示点不动的开关，只说明原因，默认诊断照常生成', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => respond(url.endsWith('/tasks') ? { tasks: [] } : { generatedAt: '2026-10-09T00:00:00Z', errors: [] })))
    render(<WorkforceDiagnosticsDialog onClose={() => {}} tasks={[]} />)
    const textarea = await screen.findByLabelText('JSON 预览') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toContain('generatedAt'))
    expect(await screen.findByText('还没有任务，所以暂时不能附上任务对话；默认诊断照常可以保存。')).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('传入列表为空（快照未加载完）时自己读任务列表，读到就能附上对话', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => respond(url.endsWith('/tasks') ? { tasks: [{ id: 't-9', title: '刚跑完的任务' }] } : { generatedAt: '2026-10-09T00:00:00Z', errors: [] })))
    render(<WorkforceDiagnosticsDialog onClose={() => {}} tasks={[]} />)
    expect(screen.getByText('正在读取任务列表…')).toBeTruthy()
    const toggle = await screen.findByRole('switch')
    expect(screen.queryByText('正在读取任务列表…')).toBeNull()
    expect(screen.queryByText(/还没有任务/)).toBeNull()
    fireEvent.click(toggle)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
    expect((await screen.findByRole('option', { name: '刚跑完的任务' }))).toBeTruthy()
  })

  it('默认预览不含对话正文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ generatedAt: '2026-10-09T00:00:00Z', errors: [], counts: { tasks: {} } })))
    render(<WorkforceDiagnosticsDialog onClose={() => {}} tasks={[{ id: 't-1', title: '失败任务' }]} />)
    const textarea = await screen.findByLabelText('JSON 预览') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toContain('generatedAt'))
    expect(textarea.value).not.toContain('conversation')
  })

  it('有 fileSession：「保存到本机」走 export（同 taskId 参数）并可资源管理器定位', async () => {
    const openWorkspacePath = vi.fn(async (_request: { path: string; action?: 'reveal' }) => ({ ok: true }))
    bindWorkforceFileSession({ canOpenWorkspacePath: async () => ({ ok: true, value: true }), openWorkspacePath })
    const path = 'D:\\root\\workforce\\diagnostics\\workbench-diagnostics-2026-10-09.json'
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => respond(
      init?.method === 'POST' ? { path } : url.includes('taskId=t-1') ? { generatedAt: 'x', conversation: { taskId: 't-1', messages: [] }, errors: [] } : { generatedAt: 'x', errors: [] },
    )))
    render(<WorkforceDiagnosticsDialog onClose={() => {}} tasks={[{ id: 't-1', title: '失败任务' }] } />)
    const save = await screen.findByRole('button', { name: '保存到本机' }) as HTMLButtonElement
    expect(screen.queryByRole('button', { name: '下载诊断文件' })).toBeNull()
    await waitFor(() => expect(save.disabled).toBe(false))
    // 附上任务对话 → export 带同 taskId（与预览同参）
    fireEvent.click(screen.getByRole('switch'))
    const textarea = await screen.findByLabelText('JSON 预览') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toContain('conversation'))
    fireEvent.click(save)
    await waitFor(() => expect(screen.getByLabelText('已保存到本机')).toBeTruthy())
    expect((screen.getByLabelText('已保存到本机') as HTMLTextAreaElement).value).toBe(path)
    const exportCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find((call: any[]) => call[1]?.method === 'POST')!
    expect(exportCall[0]).toBe('/wb/api/workforce/diagnostics/export')
    expect(JSON.parse(exportCall[1].body as string)).toEqual({ taskId: 't-1' })
    fireEvent.click(screen.getByRole('button', { name: '在资源管理器中显示' }))
    await waitFor(() => expect(openWorkspacePath).toHaveBeenCalledWith({ path, action: 'reveal' }))
  })

  it('无 fileSession：保留 Blob 下载按钮', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ generatedAt: 'x', errors: [] })))
    render(<WorkforceDiagnosticsDialog onClose={() => {}} tasks={[{ id: 't-1', title: '失败任务' }] } />)
    expect(await screen.findByRole('button', { name: '下载诊断文件' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存到本机' })).toBeNull()
  })
})
