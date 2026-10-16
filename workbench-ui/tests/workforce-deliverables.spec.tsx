// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DeliverableChips } from '../src/client/workforce-deliverables.tsx'
import type { Employee, Task, TaskDeliverable } from '../src/client/workforce-types.ts'
import type { WorkforceSource } from '../src/client/workforce-source.ts'

afterEach(cleanup)

describe('DeliverableChips 成果卡片 (MDPREV3)', () => {
  const employees: Employee[] = [
    { id: 'writer', name: '文案员', title: '文案策划', persona: '', skills: [], isLeader: false },
  ]
  const source = { refresh: vi.fn() } as unknown as WorkforceSource

  const deliverable: TaskDeliverable = {
    name: '方案.md',
    url: '/wb/api/workforce/tasks/task-1/deliverables/%E6%96%B9%E6%A1%88.md',
    publishedVersion: 2,
    versions: [
      { version: 1, authorId: 'writer', createdAt: '2026-10-11T10:00:00Z', charCount: 300, sha256: 'sha1' },
      { version: 2, authorId: 'writer', createdAt: '2026-10-11T11:00:00Z', charCount: 500, sha256: 'sha2' },
    ],
  }

  const task: Task = {
    id: 'task-1',
    channelId: 'general',
    threadId: 'thread-1',
    assigneeId: 'writer',
    delegatorId: null,
    title: '写文案',
    prompt: '请写方案',
    status: 'done',
    deliverables: [deliverable],
    createdAt: '2026-10-11T09:00:00Z',
    updatedAt: '2026-10-11T11:00:00Z',
  }

  it('头部重构：点击标题打开预览，vN pill 表达已发布态，操作区为 [文件夹|⋯] 组且收敛下载', () => {
    render(<DeliverableChips task={task} employees={employees} source={source} />)

    // 头部有文件名、vN pill（含对勾表示已发布）、作者 pill
    const titleBtn = screen.getByRole('button', { name: '方案.md' })
    expect(titleBtn).toBeTruthy()
    expect(screen.getByText(/✓ v2/)).toBeTruthy()
    expect(screen.getByText('文案员')).toBeTruthy()

    // 移除独立的「最终版」pill 与「N 个版本 ▸」与「下载」外链
    expect(screen.queryByText('最终版')).toBeNull()
    expect(screen.queryByRole('button', { name: /2 个版本/ })).toBeNull()
    expect(screen.queryByRole('link', { name: '下载' })).toBeNull()

    // [文件夹 | ⋯] 组
    const folderBtn = screen.getByRole('button', { name: /在资源管理器中显示/ })
    const menuBtn = screen.getByRole('button', { name: /更多操作 方案\.md/ })
    expect(folderBtn).toBeTruthy()
    expect(menuBtn).toBeTruthy()

    // 打开 ⋯ 菜单，下载移入菜单中
    fireEvent.click(menuBtn)
    expect(screen.getByText('下载')).toBeTruthy()

    // 点击标题唤起预览弹窗
    fireEvent.click(titleBtn)
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog?.getAttribute('aria-label')).toBe('方案.md')

    // 关闭弹窗
    const closeBtn = document.querySelector('button[aria-label="关闭文件预览"]')
    expect(closeBtn).toBeTruthy()
    fireEvent.click(closeBtn!)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('vN pill 包含三条杠可展开版本列表，底部三条杠折叠行可收起，行内文案统一为「打开」', () => {
    render(<DeliverableChips task={task} employees={employees} source={source} />)

    // 点击 vN pill 展开版本列表
    const versionPill = screen.getByRole('button', { name: /版本 v2/ })
    expect(versionPill.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(versionPill)
    expect(versionPill.getAttribute('aria-expanded')).toBe('true')

    // 不应存在文案为「预览」的按钮
    expect(screen.queryByRole('button', { name: '预览' })).toBeNull()

    // 展开列表中版本行各有一个「打开」按钮
    const openBtns = screen.getAllByRole('button', { name: '打开' })
    expect(openBtns).toHaveLength(2)

    // 点击 v1 版本行的「打开」按钮唤起 v1 预览
    fireEvent.click(openBtns[0]!)
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog?.getAttribute('aria-label')).toBe('方案.md v1')

    // 关闭预览弹窗
    const closePreviewBtn = document.querySelector('button[aria-label="关闭文件预览"]')
    fireEvent.click(closePreviewBtn!)

    // 列表底部有三条杠折叠行，点击可收起列表
    const collapseRow = screen.getByRole('button', { name: '收起版本列表' })
    expect(collapseRow).toBeTruthy()
    fireEvent.click(collapseRow)
    expect(screen.queryByRole('button', { name: '收起版本列表' })).toBeNull()
  })
})
