// @vitest-environment jsdom
/** Layout primitives: PageShell slots, ActionBar portal, SubNav states, Panel/Grid structure. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ActionBar, Banner, Empty, Grid, PageHeader, PageShell, Panel, PanelSection, Stat, SubNav, Tag } from '../src/client/ui/index.tsx'
import { sidebarZoom, zoomStyle } from '../src/client/ui/zoom.ts'

afterEach(cleanup)

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

describe('PageShell + PageHeader', () => {
  it('stacks header, sub-nav, banner and body in one column; title and meta share a row', () => {
    const { container } = render(
      <PageShell
        header={<PageHeader crumb="← 返回" onCrumb={() => {}} title="标题" subtitle="副标题" meta={<span>档案</span>} />}
        subnav={<span data-testid="sub">子导航</span>}
        banner={<Banner>回看中</Banner>}
      >
        <div data-testid="body">正文</div>
      </PageShell>,
    )
    const order = [...container.querySelectorAll('h1, [data-testid="sub"], [role="status"], [data-testid="body"]')].map(el => el.textContent)
    expect(order).toEqual(['标题', '子导航', '回看中', '正文'])
    const row = screen.getByText('标题').parentElement as HTMLElement
    expect(row.textContent).toContain('档案')
    expect(screen.getByText('副标题')).toBeTruthy()
  })

  it('crumb calls back', () => {
    const onCrumb = vi.fn()
    render(<PageShell header={<PageHeader crumb="← 返回" onCrumb={onCrumb} title="t" />}>x</PageShell>)
    fireEvent.click(screen.getByText('← 返回'))
    expect(onCrumb).toHaveBeenCalled()
  })
})

describe('ActionBar', () => {
  it('portals out of the scrolling body into the shell slot', () => {
    const { container } = render(
      <PageShell>
        <ActionBar caption="说明"><button type="button">确认</button></ActionBar>
      </PageShell>,
    )
    const bar = container.querySelector('[data-action-bar]') as HTMLElement
    expect(bar).toBeTruthy()
    expect(bar.textContent).toContain('确认')
    expect(bar.textContent).toContain('说明')
    // not inside the column that scrolls
    expect(container.querySelector('h1')).toBeNull()
    const column = (screen.queryByText('x') ?? container.firstElementChild?.firstElementChild?.firstElementChild) as HTMLElement
    expect(column.contains(bar)).toBe(false)
  })

  it('renders inline without a shell', () => {
    const { container } = render(<ActionBar><button type="button">确认</button></ActionBar>)
    expect(container.querySelector('[data-action-bar]')).toBeTruthy()
  })
})

describe('SubNav', () => {
  const items = [
    { key: 'a', label: 'A', state: 'done' as const },
    { key: 'b', label: 'B', state: 'current' as const },
    { key: 'c', label: 'C', state: 'todo' as const },
  ]

  it('done items are clickable, current is aria-current, todo is disabled', () => {
    const onSelect = vi.fn()
    render(<SubNav label="流程" items={items} onSelect={onSelect} />)
    fireEvent.click(screen.getByText('A'))
    expect(onSelect).toHaveBeenCalledWith('a')
    expect(document.querySelector('[aria-current="step"]')?.getAttribute('data-stage')).toBe('b')
    expect((screen.getByText('C').closest('button') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('B').closest('button')).toBeNull()
  })

  it('without onSelect done items are plain', () => {
    render(<SubNav label="流程" items={items} />)
    expect(screen.getByText('A').closest('button')).toBeNull()
  })
})

describe('Panel / PanelSection / Grid / small parts', () => {
  it('Panel renders title row + sections in one container', () => {
    const { container } = render(
      <Panel title="面板" aside="右侧">
        <PanelSection title="分区一">内容一</PanelSection>
        <PanelSection sub>内容二</PanelSection>
      </Panel>,
    )
    expect(container.querySelectorAll('section')).toHaveLength(1)
    expect(screen.getByText('面板')).toBeTruthy()
    expect(screen.getByText('右侧')).toBeTruthy()
    expect(screen.getByText('分区一')).toBeTruthy()
    expect(screen.getByText('内容二')).toBeTruthy()
  })

  it('Panel without a title renders no head', () => {
    const { container } = render(<Panel>裸面板</Panel>)
    expect(container.querySelector('h3')).toBeNull()
  })

  it('Grid split puts main before aside; cards sets the min width variable', () => {
    const { container } = render(<Grid variant="split" main={<i>主</i>} aside={<i>辅</i>} />)
    expect([...container.querySelectorAll('i')].map(el => el.textContent)).toEqual(['主', '辅'])
    cleanup()
    const cards = render(<Grid variant="cards" minCard={300}><i>卡</i></Grid>).container.firstElementChild as HTMLElement
    expect(cards.style.getPropertyValue('--wb-card-min')).toBe('300px')
  })

  it('Tag, Stat and Empty render their content', () => {
    render(<><Tag tone="ok">好</Tag><Stat label="数" value="3" tone="warn" /><Empty>空</Empty></>)
    expect(screen.getByText('好')).toBeTruthy()
    expect(screen.getByText('数')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText('空')).toBeTruthy()
  })
})

describe('zoom helpers', () => {
  it('zoomStyle adds nothing at 1 and sets zoom + --wb-zoom otherwise', () => {
    expect(zoomStyle(1)).toEqual({})
    expect(zoomStyle(1.25)).toEqual({ zoom: 1.25, '--wb-zoom': 1.25 })
  })

  it('sidebar zoom is capped for the host column and 1 on the rail', () => {
    expect(sidebarZoom(1.875, false)).toBe(1.5)
    expect(sidebarZoom(1.125, false)).toBe(1.125)
    expect(sidebarZoom(1.875, true)).toBe(1)
  })
})
