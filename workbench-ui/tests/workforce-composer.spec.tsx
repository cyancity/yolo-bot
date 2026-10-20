// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkforceMain } from '../src/client/workforce.tsx'
import { WorkforceComposer } from '../src/client/workforce-composer.tsx'
import type { WorkforceSource } from '../src/client/workforce-source.ts'
import type { WorkforceSnapshot } from '../src/client/workforce-types.ts'
import { WorkforceMessageText } from '../src/client/workforce-message-text.tsx'
import type { Employee } from '../src/client/workforce-types.ts'

const employee: Employee = { id: 'writer', name: '文案员', title: '写稿', persona: '', skills: [], isLeader: false }
const backing = new Map<string, string>()
beforeEach(() => {
  backing.clear()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value) },
  } })
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(() => run(performance.now()), 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const input = () => screen.getByRole('textbox') as HTMLTextAreaElement

function composer(key: string, send = vi.fn(async (_text: string, _employeeIds: readonly string[]) => {})) {
  return render(<WorkforceComposer key={key} draftKey={key} employees={[employee]} onSend={send} onUploadMaterial={undefined} />)
}

describe('已删除员工历史', () => {
  it('使用原 DM 名称展示历史，移除发送输入框', () => {
    const snapshot: WorkforceSnapshot = {
      phase: 'ready', employees: [], channels: [], tasks: [], error: undefined,
      threads: [{ id: 'old-dm', kind: 'dm', employeeId: 'deleted', title: '原文案员', status: 'idle', updatedAt: '2026-10-09T00:00:00Z' }],
      messages: { 'old-dm': { list: [{ id: 'old-message', threadId: 'old-dm', ts: '2026-10-09T00:00:00Z', role: 'agent', senderId: 'deleted', senderName: '原文案员', text: '之前的交付' }], cursor: undefined, status: 'idle' } },
    }
    render(<WorkforceMain source={{ getPendingReplies: () => [], setFocusedThread: () => {} } as unknown as WorkforceSource} snapshot={snapshot} surface={{ kind: 'dm', threadId: 'old-dm', employeeId: 'deleted' }} onDm={() => {}} openThreadId={undefined} onCloseThread={() => {}} onOpenThread={() => {}} enableMaterial={true} onNavigation={() => {}} />)
    expect(screen.getByRole('heading', { name: '原文案员' })).toBeTruthy()
    expect(screen.getByText('之前的交付')).toBeTruthy()
    expect(screen.getByText('已删除员工 · 历史只读')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /^发送$/ })).toBeNull()
  })
})

describe('数字员工消息格式', () => {
  it('渲染基础Markdown和真实成果卡片，拒绝脚本链接并将HTML当文字', () => {
    render(<WorkforceMessageText text={'## 汇总\n**已保存** [文案.txt](/wb/api/workforce/tasks/task-1/deliverables/file.txt)\n[外部](https://example.com) [危险](javascript:alert(1))\n<img src=x onerror=alert(1)>'} employees={[]} onDm={() => {}} />)
    expect(screen.getByText('已保存').tagName).toBe('STRONG')
    // 成果链接渲染为附件卡片（文件名取自 URL）：可预览文本主动作「预览」，下载收进 ⋯ 菜单
    const card = document.querySelector('[data-attachment-kind="file"]')
    expect(card).toBeTruthy()
    expect(screen.getByText('file.txt')).toBeTruthy()
    expect(screen.getByRole('button', { name: '预览 file.txt' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: '下载' })).toBeNull()
    expect(screen.getByRole('button', { name: '更多操作 file.txt' })).toBeTruthy()
    // 真点菜单「下载」：最终目的地仍是成果原字节路由 download=1
    const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: '更多操作 file.txt' }))
    fireEvent.click(screen.getByText('下载'))
    expect(downloadClick).toHaveBeenCalledTimes(1)
    const anchor = downloadClick.mock.contexts[0] as HTMLAnchorElement
    expect(anchor.getAttribute('href')).toBe('/wb/api/workforce/tasks/task-1/deliverables/file.txt?download=1')
    expect(anchor.getAttribute('download')).toBe('file.txt')
    expect(anchor.getAttribute('rel')).toContain('noopener')
    downloadClick.mockRestore()
    expect(screen.getByRole('link', { name: '外部' }).getAttribute('rel')).toContain('noopener')
    expect(screen.queryByRole('link', { name: '危险' })).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('._messageText_1793c9, [class*="messageText"]')?.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})

describe('数字员工输入框', () => {
  it('@ 候选确认后真正传员工 id，发送成功清空草稿', async () => {
    const send = vi.fn(async () => {})
    composer('thread-1', send)
    fireEvent.change(input(), { target: { value: '@文', selectionStart: 2 } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(input().value).toBe('@文案员 ')
    expect(send).not.toHaveBeenCalled()
    fireEvent.change(input(), { target: { value: input().value + '写稿' } })
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    await waitFor(() => expect(send).toHaveBeenCalledWith('@文案员 写稿', ['writer']))
    await waitFor(() => expect(input().value).toBe(''))
  })

  it('中文输入法确认和 Shift+Enter 不发送；普通 Enter 才提交', async () => {
    const send = vi.fn(async () => {})
    composer('dm-1', send)
    fireEvent.change(input(), { target: { value: '中文任务' } })
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true })
    expect(send).not.toHaveBeenCalled()
    fireEvent.keyDown(input(), { key: 'Enter' })
    await waitFor(() => expect(send).toHaveBeenCalledWith('中文任务', []))
  })

  it('发送失败保留文本和员工路由，重试成功后清空', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('模型不可用')).mockResolvedValue(undefined)
    composer('thread-1', send)
    fireEvent.change(input(), { target: { value: '@文案员，继续写稿' } })
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    await screen.findByRole('alert')
    expect(input().value).toBe('@文案员，继续写稿')
    expect(backing.get('workforce.draft.thread-1')).toBe('@文案员，继续写稿')
    fireEvent.click(screen.getByRole('button', { name: '重试发送' }))
    await waitFor(() => expect(input().value).toBe(''))
    expect(send).toHaveBeenNthCalledWith(1, '@文案员，继续写稿', ['writer'])
    expect(send).toHaveBeenNthCalledWith(2, '@文案员，继续写稿', ['writer'])
  })

  it('等待发送返回时的新草稿和 @ 候选保留，不被上一条成功清空', async () => {
    let complete!: () => void
    const send = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve })).mockResolvedValue(undefined)
    composer('thread-1', send)
    fireEvent.change(input(), { target: { value: '第一条任务' } })
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    fireEvent.change(input(), { target: { value: '@文', selectionStart: 2 } })
    expect(screen.getByRole('option')).toBeTruthy()
    await act(async () => { complete() })
    expect(input().value).toBe('@文')
    expect(screen.getByRole('option')).toBeTruthy()
    expect(backing.get('workforce.draft.thread-1')).toBe('@文')
    fireEvent.keyDown(input(), { key: 'Enter' })
    fireEvent.change(input(), { target: { value: input().value + '第二条任务' } })
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    await waitFor(() => expect(send).toHaveBeenNthCalledWith(2, '@文案员 第二条任务', ['writer']))
  })

  it('一条消息@多员工按出现顺序去重收集收件人；名字后紧跟非边界字符不误判', async () => {
    const send = vi.fn(async () => {})
    const analyst: Employee = { id: 'analyst', name: '分析员', title: '分析', persona: '', skills: [], isLeader: false }
    const analystB: Employee = { id: 'analyst-b', name: '分析员乙', title: '分析', persona: '', skills: [], isLeader: false }
    render(<WorkforceComposer draftKey="multi-at" employees={[employee, analyst, analystB]} onSend={send} onUploadMaterial={undefined} />)
    fireEvent.change(input(), { target: { value: '@分析员 先看，@文案员 和 @分析员 复核' } })
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    await waitFor(() => expect(send).toHaveBeenCalledWith('@分析员 先看，@文案员 和 @分析员 复核', ['analyst', 'writer']))
    // 前缀名陷阱：@分析员乙 不能误判成 @分析员
    fireEvent.change(input(), { target: { value: '@分析员乙 单独处理' } })
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    await waitFor(() => expect(send).toHaveBeenCalledWith('@分析员乙 单独处理', ['analyst-b']))
    // @ 后紧跟英文字母这类非边界字符：不算提及
    fireEvent.change(input(), { target: { value: '@分析员abc' } })
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    await waitFor(() => expect(send).toHaveBeenCalledWith('@分析员abc', []))
  })

  it('任务 thread 与 DM 草稿分别恢复，不串输入', () => {
    const task = composer('task-thread')
    fireEvent.change(input(), { target: { value: '任务追问草稿' } })
    task.unmount()
    const dm = composer('dm-thread')
    expect(input().value).toBe('')
    fireEvent.change(input(), { target: { value: '私信草稿' } })
    dm.unmount()
    const restoredTask = composer('task-thread')
    expect(input().value).toBe('任务追问草稿')
    restoredTask.unmount()
    composer('dm-thread')
    expect(input().value).toBe('私信草稿')
  })
})
