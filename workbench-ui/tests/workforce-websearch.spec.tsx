// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WorkforceWebSearch, faviconColor, faviconLetter, searchRingFill, sourceHost, threadHasWebSearch } from '../src/client/workforce-websearch.tsx'
import type { SearchSource } from '../src/client/workforce-types.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const sources: readonly SearchSource[] = [
  { title: '公开搜索', url: 'https://search.example.test/search/', snippet: '一条真实摘要，第二行也会被截断。' },
  { title: '文档', url: 'https://docs.example.test/search/1/1' },
]

describe('联网搜索披露', () => {
  it('进行中是 shimmer 文案，展开是空槽骨架', () => {
    render(<WorkforceWebSearch status="running" query="文档 PLlOJeulQ_w" />)
    const pill = screen.getByRole('button', { name: '正在搜索 文档 PLlOJeulQ_w' })
    expect(pill.getAttribute('aria-expanded')).toBe('false')
    expect(searchRingFill('running', 0, 0)).toBe(0)
    expect(Number(document.querySelector('[data-fill]')?.getAttribute('data-fill'))).toBeLessThan(0.05)
    fireEvent.click(pill)
    expect(pill.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[data-websearch-skeleton]')).not.toBeNull()
    expect(screen.getByText('搜索：文档 PLlOJeulQ_w')).toBeTruthy()
    fireEvent.click(pill)
    expect(pill.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-websearch-skeleton]')).toBeNull()
  })

  it('完成态展示来源数；来源区是堆叠球组，点球堆展开导轨列表', () => {
    const { container } = render(<WorkforceWebSearch status="done" query="docs · 文档" sources={sources} />)
    expect(screen.getByRole('button', { name: '已搜索 2 个站点' })).toBeTruthy()
    expect(document.querySelector('[data-fill]')?.getAttribute('data-fill')).toBe('1.000')
    fireEvent.click(screen.getByRole('button', { name: '已搜索 2 个站点' }))
    // 展开后见堆叠球组按钮，无链接、无裸 URL 文本
    const stack = screen.getByRole('button', { name: '2 个来源，点击展开' })
    expect(stack.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('link')).toBeNull()
    // 球组用真实站点 favicon（s2 服务）；加载失败回退字母球，不保证无 img
    const faviconImgs = container.querySelectorAll('img')
    faviconImgs.forEach(img => expect(img.getAttribute('src')).toContain('google.com/s2/favicons'))
    // 点球堆沿导轨展开来源行：favicon+标题+域名+snippet，行是可点开链接
    fireEvent.click(stack)
    const link = screen.getByRole('link', { name: /公开搜索/ })
    expect(link.getAttribute('href')).toBe('https://search.example.test/search/')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(screen.getByText('一条真实摘要，第二行也会被截断。')).toBeTruthy()
    expect(screen.getByText('search.example.test')).toBeTruthy()
    expect(screen.getByRole('link', { name: /文档/ })).toBeTruthy()
    expect(screen.getByText('docs.example.test')).toBeTruthy()
    expect(sourceHost(sources[0]!.url)).toBe('search.example.test')
    expect(faviconLetter('search.example.test')).toBe('S')
    expect(faviconColor('search.example.test')).toBe(faviconColor('search.example.test'))
    // 再点球堆收起整列
    fireEvent.click(stack)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('出错时 pill 为红态，展开不编造来源', () => {
    render(<WorkforceWebSearch status="error" query="失败的查询" />)
    const root = document.querySelector('[data-websearch]')
    expect(root?.getAttribute('data-status')).toBe('error')
    fireEvent.click(screen.getByRole('button', { name: '搜索没有完成' }))
    expect(screen.getByText('没有返回来源')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    expect(document.querySelector('[data-fill]')?.getAttribute('data-fill')).toBe('0.120')
  })

  it('没有 web_search 的线程不需要挂载，直接渲染即出披露', async () => {
    expect(threadHasWebSearch([{ tool: { name: 'read' } }, {}])).toBe(false)
    expect(threadHasWebSearch([{ tool: { name: 'web_search' } }])).toBe(true)
    expect(searchRingFill('done', 0, 0)).toBe(1)
    expect(searchRingFill('running', 0, 8)).toBe(0.92)
    // 插件平台 web loader 只有单 chunk 模块表：不做网络分包，「按需」由 hasWebSearch 条件挂载承担。
    render(<WorkforceWebSearch status="done" sources={[{ title: '一号', url: 'https://a.example/x' }]} />)
    expect(await screen.findByRole('button', { name: '已搜索 1 个站点' })).toBeTruthy()
  })

  it('reduced-motion 下仍能展开', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false },
    }))
    render(<WorkforceWebSearch status="running" query="慢查询" sources={sources} />)
    expect(document.querySelector('[data-websearch]')?.getAttribute('data-motion')).toBe('reduce')
    fireEvent.click(screen.getByRole('button', { name: '正在搜索 慢查询' }))
    // 堆叠球组在 reduced-motion 下仍可展开来源列表；running 尾部保留 thinking 骨架
    fireEvent.click(screen.getByRole('button', { name: '2 个来源，点击展开' }))
    expect(screen.getByRole('link', { name: /公开搜索/ })).toBeTruthy()
    expect(document.querySelector('[data-websearch-skeleton]')).not.toBeNull()
  })
})
