// @vitest-environment jsdom
/**
 * 频道导航排序契约：任务大厅固定最顶且不属于任何分组（宿主数据带 groupId/pinned 也忽略）、
 * 置顶频道独立区、未分组排在各分组前、组内按宿主 sort 排、分组按组 sort 排。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { WorkforceChannels } from '../src/client/workforce-channels.tsx'
import type { HostChannel, HostChannelGroup } from '../src/client/workforce-api.ts'

const backing = new Map<string, string>()
beforeEach(() => {
  backing.clear()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value) },
    removeItem: (key: string) => { backing.delete(key) },
  } })
})
afterEach(() => cleanup())

const channel = (partial: Partial<HostChannel> & { id: string; name: string }): HostChannel => ({
  sort: 0, createdAt: '2026-10-09', ...partial,
})

/** 渲染后按容器全文出现的先后位置排序频道/区标题，验证视觉顺序。 */
const orderOf = (container: HTMLElement, ...labels: string[]) => {
  const text = container.textContent ?? ''
  return labels.map(label => text.indexOf(label))
}

describe('频道分组排序', () => {
  it('任务大厅固定最顶且忽略其 groupId/pinned；置顶区、未分组区、分组依次排布', () => {
    const groups: HostChannelGroup[] = [
      { id: 'g-b', name: '乙组', sort: 1, createdAt: '2026-10-09' },
      { id: 'g-a', name: '甲组', sort: 0, createdAt: '2026-10-09' },
    ]
    const channels: HostChannel[] = [
      // 宿主异常数据：任务大厅带 groupId —— 仍只渲染一次，独立成块不进分组
      channel({ id: 'general', name: '任务大厅', groupId: 'g-a' }),
      channel({ id: 'c-un', name: '散落频道' }),
      channel({ id: 'c-pin', name: '钉住的频道', pinned: true }),
      channel({ id: 'c-b2', name: '乙组二频道', groupId: 'g-b', sort: 1 }),
      channel({ id: 'c-b1', name: '乙组一频道', groupId: 'g-b', sort: 0 }),
      channel({ id: 'c-a1', name: '甲组频道', groupId: 'g-a' }),
    ]
    const { container } = render(<WorkforceChannels channels={channels} groups={groups} onSelectChannel={() => {}} />)
    // 任务大厅整树只出现一次（不在置顶区/分组内重复渲染）
    expect(container.textContent!.split('任务大厅').length - 1).toBe(1)
    // 视觉序：任务大厅 → 置顶区 → 未分组区 → 甲组 → 乙组；组内按 sort
    const order = orderOf(container,
      '任务大厅', '📌 置顶频道', '钉住的频道', '未分组', '散落频道', '甲组', '甲组频道', '乙组', '乙组一频道', '乙组二频道')
    expect(order.every(pos => pos >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    // 无未读频道时不渲染未读徽标
    expect(container.querySelector('[title="有未读消息"]')).toBeNull()
  })

  // 宿主侧 saveChannel 不挡 general 的 pinned，
  // UI 菜单虽隐藏置顶操作，但带病数据会让「任务大厅」在顶块与📌区重复渲染。
  it('宿主给任务大厅打上 pinned 时不应重复渲染', () => {
    const { container } = render(<WorkforceChannels
      channels={[channel({ id: 'general', name: '任务大厅', pinned: true })]}
      groups={[]} onSelectChannel={() => {}} />)
    expect(container.textContent!.split('任务大厅').length - 1).toBe(1)
  })

  it('宿主分组为空时无分组区，未读徽标透出宿主 unread', () => {
    const { container } = render(<WorkforceChannels
      channels={[channel({ id: 'general', name: '任务大厅' }), channel({ id: 'c1', name: '自由频道', unread: true })]}
      groups={[]} onSelectChannel={() => {}} />)
    expect(container.textContent).toContain('任务大厅')
    expect(container.textContent).toContain('未分组')
    expect(container.textContent).toContain('自由频道')
    // 未读徽标落在该频道按钮里
    const dot = container.querySelector('[title="有未读消息"]')!
    expect(dot.closest('button')?.textContent).toContain('自由频道')
  })
})
