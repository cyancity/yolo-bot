// @vitest-environment jsdom
/**
 * 数字员工消息流展示：👀/✅ 表情回应、@你 引用、
 * 正在输入指示、工具与过程消息默认隐藏且开启后按 turn 折叠成一行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WorkforceMain } from '../src/client/workforce.tsx'
import { setWorkforcePrefs } from '../src/client/workforce-prefs.ts'
import type { WorkforceSource } from '../src/client/workforce-source.ts'
import type { Employee, WorkforceActivity, WorkforceMessage, WorkforceSnapshot } from '../src/client/workforce-types.ts'

const analyst: Employee = { id: 'analyst', name: '分析员', title: '材料分析', persona: '', skills: [], isLeader: false }
const backing = new Map<string, string>()

beforeEach(() => {
  backing.clear()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value) },
  } })
  setWorkforcePrefs({ style: 'discord', showSteps: false })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const msg = (partial: Partial<WorkforceMessage> & { id: string }): WorkforceMessage => ({
  threadId: 'dm-1', ts: '2026-10-09T00:00:00Z', role: 'agent', senderId: 'analyst', senderName: '分析员', text: '', ...partial,
})
const dmSnapshot = (list: WorkforceMessage[], activity?: WorkforceActivity[]): WorkforceSnapshot => ({
  phase: 'ready', employees: [analyst], channels: [], tasks: [], error: undefined,
  threads: [{ id: 'dm-1', kind: 'dm', employeeId: 'analyst', title: '分析员', status: 'idle', updatedAt: '2026-10-09T00:00:00Z' }],
  messages: { 'dm-1': { list, cursor: undefined, status: 'idle', ...(activity ? { activity } : {}) } },
})
const renderMain = (snapshot: WorkforceSnapshot) => render(<WorkforceMain source={{ getPendingReplies: () => [], setFocusedThread: () => {}, skillDrafts: async () => [] } as unknown as WorkforceSource} snapshot={snapshot}
  surface={{ kind: 'dm', threadId: 'dm-1', employeeId: 'analyst' }}
  onDm={() => {}} openThreadId={undefined} onCloseThread={() => {}} onOpenThread={() => {}} enableMaterial={false} onNavigation={() => {}} />)

describe('数字员工消息展示', () => {
  it('人类消息渲染表情回应，员工首条回复渲染 @你 与 40 字引用', () => {
    renderMain(dmSnapshot([
      msg({ id: 'h1', role: 'user', senderId: 'user', senderName: '你', text: '请分析这条链接的文案和节奏', reactions: [{ emoji: '✅', employeeId: 'analyst' }] }),
      msg({ id: 'h2', role: 'user', senderId: 'user', senderName: '你', text: '一二三四五六七八九十'.repeat(5), reactions: [{ emoji: '👀', employeeId: 'analyst' }] }),
      msg({ id: 'a1', text: '分析结果如下', replyTo: 'h1' }),
      msg({ id: 'a2', text: '追加答复', replyTo: 'h2' }),
    ]))
    expect(screen.getByTitle('分析员 ✅')).toBeTruthy()
    expect(screen.getByTitle('分析员 👀')).toBeTruthy()
    expect(screen.getByText('引用：请分析这条链接的文案和节奏')).toBeTruthy()
    expect(screen.getByText(`引用：${'一二三四五六七八九十'.repeat(4)}…`)).toBeTruthy()
    // 回复对象按用户资料显示名渲染（缺省 '用户'）
    expect(screen.getAllByText('@用户')).toHaveLength(2)
  })

  it('activity 驱动骨架气泡状态文案，对应头像进入 working', () => {
    const { container, rerender } = renderMain(dmSnapshot([msg({ id: 'a1', text: '先一句' })], [{ employeeId: 'analyst', state: 'typing' }]))
    const skeleton = container.querySelector('[data-skeleton="true"]')!
    expect(skeleton.textContent).toContain('分析员')
    // 输入中只用头像动效占位，状态文案改由无障碍名称播报。
    expect(skeleton.getAttribute('aria-label')).toBe('正在输入…')
    expect(skeleton.querySelector('[data-state="working"]')).toBeTruthy()
    rerender(<WorkforceMain source={{ getPendingReplies: () => [], setFocusedThread: () => {}, skillDrafts: async () => [] } as unknown as WorkforceSource} snapshot={dmSnapshot([msg({ id: 'a1', text: '先一句' })], [{ employeeId: 'analyst', state: 'tool', tool: 'read' }])}
      surface={{ kind: 'dm', threadId: 'dm-1', employeeId: 'analyst' }}
      onDm={() => {}} openThreadId={undefined} onCloseThread={() => {}} onOpenThread={() => {}} enableMaterial={false} onNavigation={() => {}} />)
    expect(container.querySelector('[data-skeleton="true"]')!.textContent).toContain('正在使用 read…')
  })

  it('失败工具默认不显示，过程只在开启执行步骤后折叠成一组', () => {
    renderMain(dmSnapshot([
      msg({ id: 'h1', role: 'user', senderId: 'user', senderName: '你', text: '干活' }),
      msg({ id: 's1', tool: { name: 'wb_read_material', status: 'done' }, turnId: 'sess:1' }),
      msg({ id: 's2', text: '中间说明', intermediate: true, turnId: 'sess:1' }),
      msg({ id: 's3', text: '文件权限不足', tool: { name: 'wb_save_deliverable', status: 'error' }, turnId: 'sess:1' }),
      msg({ id: 'a1', text: '最终答复', replyTo: 'h1' }),
    ]))
    expect(screen.getByText('最终答复')).toBeTruthy()
    expect(screen.queryByText('中间说明')).toBeNull()
    expect(screen.queryByText(/wb_read_material/)).toBeNull()
    expect(screen.queryByText(/执行步骤失败/)).toBeNull()
    expect(screen.queryByText(/wb_save_deliverable/)).toBeNull()
    expect(screen.queryByText('文件权限不足')).toBeNull()
    // 开启「显示执行步骤」后：同一 turn 的工具与过程说明折叠成一组，含失败工具
    fireEvent.click(screen.getByRole('button', { name: '聊天设置' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '偏好设置' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /显示执行步骤/ }))
    act(() => {})
    const steps = screen.getByText('执行了 3 步')
    fireEvent.click(steps)
    expect(screen.getByText(/wb_read_material/)).toBeTruthy()
    expect(screen.getByText(/wb_save_deliverable/)).toBeTruthy()
    expect(screen.getByText('文件权限不足')).toBeTruthy()
    expect(screen.getByText('中间说明')).toBeTruthy()
  })

  it('web_search 工具消息渲染披露块：showSteps 关闭也显示，开启后不进步骤折叠', async () => {
    const search = { name: 'web_search', status: 'done' as const, searchQuery: '文档趋势', searchSources: [{ title: '公开搜索', url: 'https://search.example.test/search/' }] }
    renderMain(dmSnapshot([
      msg({ id: 'h1', role: 'user', senderId: 'user', senderName: '你', text: '查一下' }),
      msg({ id: 's1', tool: { name: 'wb_read_material', status: 'done' }, turnId: 'sess:1' }),
      msg({ id: 's2', tool: search, turnId: 'sess:1' }),
      msg({ id: 's3', tool: { name: 'wb_save_deliverable', status: 'done' }, turnId: 'sess:1' }),
      msg({ id: 'a1', text: '查完了', replyTo: 'h1' }),
    ]))
    // showSteps 关闭：披露块仍在流中（懒加载组件异步落地），其他工具不露面
    expect(await screen.findByRole('button', { name: '已搜索 1 个站点' })).toBeTruthy()
    expect(document.querySelector('[data-websearch]')).not.toBeNull()
    expect(screen.queryByText(/wb_read_material/)).toBeNull()
    // 开启执行步骤：web_search 由披露块承担，steps 只剩另外两步
    fireEvent.click(screen.getByRole('button', { name: '聊天设置' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '偏好设置' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /显示执行步骤/ }))
    act(() => {})
    const steps = screen.getByText('执行了 2 步')
    fireEvent.click(steps)
    expect(screen.getByText(/wb_read_material/)).toBeTruthy()
    expect(screen.getByText(/wb_save_deliverable/)).toBeTruthy()
    expect(screen.queryByText(/web_search/)).toBeNull()
  })


  it('role=system 提醒不占气泡位：折叠条挂在前条消息下，点开展开详情', () => {
    const { container } = renderMain(dmSnapshot([
      msg({ id: 'h1', role: 'user', senderId: 'user', senderName: '你', text: '干活' }),
      msg({ id: 'a1', text: '阶段性结论' }),
      msg({ id: 'n1', role: 'system', text: '已中断 · 回复可继续', turnId: 'dm-1:1' }),
      msg({ id: 'n2', role: 'system', text: '执行停止：error', error: '执行停止：error' }),
    ]))
    const notices = container.querySelectorAll('[data-kind]')
    expect(notices.length).toBeGreaterThanOrEqual(2)
    // info 提醒一行折叠；展开后详情区出现
    const line = screen.getByText('已中断 · 回复可继续').closest('button')!
    expect(line.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(line)
    expect(line.getAttribute('aria-expanded')).toBe('true')
    // 错误行标 error kind，文案经 formatErrorReason 归一化
    const errorNotice = container.querySelector('[data-kind="error"]')!
    expect(errorNotice.textContent).toContain('执行失败：error')
  })
})
