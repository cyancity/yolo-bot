// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppHeaderProvider, PageHeader, PageShell, SubNav, Select } from '../src/client/ui/index.tsx'
import { Thumbnail } from '../src/client/ui/media.tsx'
afterEach(cleanup)
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
it('shares one AppHeader, updates title and controls, and docks subnav outside scroll', () => {
  const back = vi.fn()
  const tree = (title: string) => <AppHeaderProvider><PageShell key={title} header={<PageHeader title={title} crumb="返回" onCrumb={back} status="待确认" meta={<select aria-label="档案"><option>通用</option></select>} subtitle="正文说明" />} subnav={<SubNav label="阶段" items={[{ key: 'brief', label: '策划', state: 'current' }]} />}><p>正文</p></PageShell></AppHeaderProvider>
  const { container, rerender } = render(tree('作品 A'))
  expect(container.querySelectorAll('[data-app-header]')).toHaveLength(1)
  expect(screen.getByText('作品 A').closest('[data-app-header]')).toBeTruthy()
  expect(screen.getByRole('list').closest('[data-app-header]')).toBeTruthy()
  expect(screen.getByText('正文').closest('[data-app-header]')).toBeNull()
  expect(screen.getAllByText('正文说明').some(node => !node.closest('[data-app-header]'))).toBe(true)
  // 首页 quickfix：页头不再承载「新建作品」，创建只在首页创作卡。
  expect(screen.queryByText('新建作品')).toBeNull()
  fireEvent.click(screen.getByText('返回')); expect(back).toHaveBeenCalledOnce()
  const instance = container.querySelector('[data-app-header]')
  rerender(tree('作品 B'))
  expect(container.querySelector('[data-app-header]')).toBe(instance)
  expect(screen.queryByText('作品 A')).toBeNull()
  expect(container.querySelectorAll('[data-app-header]')).toHaveLength(1)
})
it('lazy loads a cover, falls back on error, and retries when URL changes', () => {
  const { container, rerender } = render(<Thumbnail src="/a.png" label="图片" />)
  expect(screen.getByRole('img').getAttribute('loading')).toBe('lazy')
  fireEvent.error(screen.getByRole('img'))
  expect(screen.queryByRole('img')).toBeNull()
  expect(container.querySelector('[data-thumbnail-fallback] svg')).toBeTruthy()
  rerender(<Thumbnail src="/b.png" label="图片" />)
  expect(screen.getByRole('img').getAttribute('src')).toBe('/b.png')
})
it('missing cover uses a media fallback', () => {
  const { container } = render(<><Thumbnail label="图片" /><Thumbnail label="文件" icon="video" /></>)
  expect(container.querySelectorAll('[data-thumbnail-fallback]')).toHaveLength(2)
  expect(container.querySelectorAll('svg')).toHaveLength(2)
})

it('Select keeps labels, native change and disabled behavior', () => {
  const change = vi.fn()
  const { rerender } = render(<Select aria-label="统一档案" defaultValue="a" onChange={change}><option value="a">档案 A</option><option value="b">档案 B</option></Select>)
  fireEvent.keyDown(screen.getByRole('combobox', { name: '统一档案' }), { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('option', { name: '档案 B' }))
  expect(change).toHaveBeenCalledOnce()
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('b')
  rerender(<Select aria-label="统一档案" disabled><option>档案</option></Select>)
  expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true)
})

it('image-only cards show no invented placeholder for absent or broken images', () => {
  const { container, rerender } = render(<Thumbnail hideOnError label="待确认作品" />)
  expect(container.querySelector('svg, img')).toBeNull()
  rerender(<Thumbnail hideOnError src="/missing.png" label="待确认作品" />)
  fireEvent.error(screen.getByRole('img'))
  expect(container.querySelector('svg, img')).toBeNull()
})
