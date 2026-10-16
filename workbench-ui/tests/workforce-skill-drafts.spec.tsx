// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkforceSkillDraftsDialog } from '../src/client/workforce-skill-drafts.tsx'
import { WorkforceApi } from '../src/client/workforce-api.ts'
import type { Employee, WorkforceSkillDraft } from '../src/client/workforce-types.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) HTMLDialogElement.prototype.showModal = function () { this.open = true }
  if (!HTMLDialogElement.prototype.close) HTMLDialogElement.prototype.close = function () { this.open = false }
})

const respond = (data: unknown) => Promise.resolve({ ok: true, json: async () => ({ ok: true, data }) } as Response)

const draft: WorkforceSkillDraft = {
  id: 'd-1', taskId: 't-1', slug: 'user-workflow-report-check', title: '周报核查流程',
  description: '把周报数据核查整理成固定步骤', body: '# 流程\n1. 抓数据\n2. 核查',
  status: 'drafted', findings: [], createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z',
}

const employees: readonly Employee[] = [
  { id: 'e-1', name: '文案员', title: '文案', persona: '', skills: [], isLeader: false },
  { id: 'e-2', name: '分析员', title: '分析', persona: '', skills: [], isLeader: false },
]

function apiWith(handler: (url: string, init?: RequestInit) => unknown): WorkforceApi {
  return new WorkforceApi(vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(handler(String(input), init))) as typeof fetch)
}

async function openEditor(api: WorkforceApi, list: readonly WorkforceSkillDraft[]): Promise<void> {
  render(<WorkforceSkillDraftsDialog employees={employees} tasks={[{ id: 't-1', title: '核查任务' } as never]} api={api} onClose={() => {}} />)
  fireEvent.click(await screen.findByText(list[0]!.title === '' ? list[0]!.slug : list[0]!.title))
  await screen.findByText('安装并绑定员工')
}

describe('技能草稿审核框', () => {
  it('有 block 检查时安装按钮禁用并说明原因', async () => {
    const blocked: WorkforceSkillDraft = { ...draft, findings: [{ level: 'block', message: '正文疑似包含 API 密钥', excerpt: 'sk-abc' }, { level: 'warn', message: '出现「忽略规则」表述' }] }
    const api = apiWith(_url => _url.includes('/skill-drafts') ? { drafts: [blocked] } : {})
    await openEditor(api, [blocked])
    const install = screen.getByRole('button', { name: '安装' }) as HTMLButtonElement
    expect(install.disabled).toBe(true)
    expect(screen.getByText('存在阻止项，修正或退回后才能安装')).toBeTruthy()
    expect(screen.getByText('正文疑似包含 API 密钥')).toBeTruthy()
    expect(screen.getByText('sk-abc')).toBeTruthy()
    expect(screen.getByText('出现「忽略规则」表述')).toBeTruthy()
  })

  it('退回必须填意见：空意见不出请求并提示', async () => {
    const calls: string[] = []
    const api = apiWith((url, init) => { calls.push(`${init?.method ?? 'GET'} ${url}`); return { drafts: [draft] } })
    await openEditor(api, [draft])
    fireEvent.click(screen.getByRole('button', { name: '退回负责人整理' }))
    fireEvent.click(screen.getByRole('button', { name: '退回' }))
    expect(await screen.findByText('退回必须填意见')).toBeTruthy()
    expect(calls.every(call => !call.includes('/return'))).toBe(true)
  })

  it('勾选员工随安装提交：POST body 带 employeeIds，默认不勾', async () => {
    const bodies: unknown[] = []
    const installed: WorkforceSkillDraft = { ...draft, status: 'installed', installedAt: '2026-10-10T01:00:00Z' }
    let current: WorkforceSkillDraft = draft
    const api = apiWith((url, init) => {
      if (url.includes('/install')) { bodies.push(JSON.parse(String(init?.body))); current = installed; return { draft: installed, path: 'skills/user-workflow-report-check/SKILL.md' } }
      return { drafts: [current] }
    })
    await openEditor(api, [draft])
    // 默认不勾：直接安装应提交空 employeeIds
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.every(box => !box.checked)).toBe(true)
    fireEvent.click(boxes[1]!)
    const install = screen.getByRole('button', { name: '安装' }) as HTMLButtonElement
    expect(install.disabled).toBe(false)
    fireEvent.click(install)
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toEqual({ employeeIds: ['e-2'] })
    // 安装后显示位置与已绑定员工
    expect((await screen.findByText(/已安装位置/)).textContent).toContain('skills/user-workflow-report-check/SKILL.md')
    expect((await screen.findByText(/已绑定员工/)).textContent).toContain('分析员')
  })

  it('编辑按草稿暂存：改 slug 后保存只 PATCH 变化字段；未保存关闭要确认', async () => {
    const patches: unknown[] = []
    const api = apiWith((_url, init) => {
      if (init?.method === 'PATCH') { patches.push(JSON.parse(String(init.body))); return { draft: { ...draft, title: '新标题' } } }
      return { drafts: [draft] }
    })
    const onClose = vi.fn()
    render(<WorkforceSkillDraftsDialog employees={employees} tasks={[]} api={api} onClose={onClose} />)
    fireEvent.click(await screen.findByText('周报核查流程'))
    const titleInput = await screen.findByLabelText('标题') as HTMLInputElement
    fireEvent.change(titleInput, { target: { value: '新标题' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(patches.length).toBe(1))
    expect(patches[0]).toEqual({ title: '新标题' })
    // 再改一处不保存 → Esc/关闭走同一 tryClose，弹确认而不是直接关
    fireEvent.change(await screen.findByLabelText('标题'), { target: { value: '又不保存' } })
    fireEvent.click(screen.getByRole('button', { name: '关闭技能审核' }))
    expect(await screen.findByText('有未保存的修改')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '丢弃修改并关闭' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('已安装且在用户根：显示停用按钮，确认后调用一次并显示 movedTo', async () => {
    const installed: WorkforceSkillDraft = { ...draft, status: 'installed', installedAt: '2026-10-10T01:00:00Z' }
    const calls: string[] = []
    let disabled = false
    const api = apiWith((url, init) => {
      if (url.includes('/user-skills') && init?.method === 'POST') { calls.push(`POST ${url}`); disabled = true; return { name: installed.slug, movedTo: 'workforce/skills-disabled/user-workflow-report-check' } }
      if (url.includes('/user-skills')) return { skills: disabled ? [] : [{ name: installed.slug, description: '', origin: 'workflow' }] }
      return { drafts: [installed] }
    })
    render(<WorkforceSkillDraftsDialog employees={employees} tasks={[]} api={api} onClose={() => {}} />)
    fireEvent.click(await screen.findByText('周报核查流程'))
    const disable = await screen.findByRole('button', { name: '停用技能' })
    fireEvent.click(disable)
    expect(await screen.findByText(/停用后员工不再加载/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }))
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0]).toContain(`/user-skills/${installed.slug}/disable`)
    expect(await screen.findByText(/已停用，文件保留在：workforce\/skills-disabled\/user-workflow-report-check/)).toBeTruthy()
  })

  it('已安装但不在用户根：徽标显示已停用且无停用按钮', async () => {
    const installed: WorkforceSkillDraft = { ...draft, status: 'installed', installedAt: '2026-10-10T01:00:00Z' }
    const calls: string[] = []
    const api = apiWith((url, init) => {
      if (init?.method === 'POST') calls.push(`POST ${url}`)
      if (url.includes('/user-skills')) return { skills: [] }
      return { drafts: [installed] }
    })
    render(<WorkforceSkillDraftsDialog employees={employees} tasks={[]} api={api} onClose={() => {}} />)
    // 列表行徽标也区分已停用
    expect(await screen.findByText('已停用')).toBeTruthy()
    fireEvent.click(screen.getByText('周报核查流程'))
    await screen.findByText('返回列表')
    expect(screen.queryByRole('button', { name: '停用技能' })).toBeNull()
    expect(calls.every(call => !call.includes('/disable'))).toBe(true)
  })

  it('取消停用确认不发出请求', async () => {
    const installed: WorkforceSkillDraft = { ...draft, status: 'installed', installedAt: '2026-10-10T01:00:00Z' }
    const calls: string[] = []
    const api = apiWith((url, init) => {
      if (init?.method === 'POST') calls.push(`POST ${url}`)
      if (url.includes('/user-skills')) return { skills: [{ name: installed.slug, description: '', origin: 'workflow' }] }
      return { drafts: [installed] }
    })
    render(<WorkforceSkillDraftsDialog employees={employees} tasks={[]} api={api} onClose={() => {}} />)
    fireEvent.click(await screen.findByText('周报核查流程'))
    fireEvent.click(await screen.findByRole('button', { name: '停用技能' }))
    await screen.findByText(/停用后员工不再加载/)
    fireEvent.click(screen.getByText('取消'))
    await waitFor(() => expect(screen.queryByText(/停用后员工不再加载/)).toBeNull())
    expect(calls.every(call => !call.includes('/disable'))).toBe(true)
  })

  it('列表显示来源任务、状态徽标与待审核数', async () => {
    const list: WorkforceSkillDraft[] = [
      draft,
      { ...draft, id: 'd-2', slug: 'user-workflow-b', title: '', status: 'requested' },
      { ...draft, id: 'd-3', slug: 'user-workflow-c', title: '已装流程', status: 'installed' },
    ]
    const api = apiWith(() => ({ drafts: list }))
    render(<WorkforceSkillDraftsDialog employees={employees} tasks={[{ id: 't-1', title: '核查任务' } as never]} api={api} onClose={() => {}} />)
    expect(await screen.findByText('1 条待审核')).toBeTruthy()
    expect(screen.getAllByText('来源任务：核查任务').length).toBe(3)
    expect(screen.getByText('待审核')).toBeTruthy()
    expect(screen.getByText('整理中')).toBeTruthy()
    expect(screen.getByText('已安装')).toBeTruthy()
  })
})
