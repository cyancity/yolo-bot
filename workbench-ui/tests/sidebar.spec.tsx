// @vitest-environment jsdom
/** Generic sidebar navigation, settings and collapsed rail presentation. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SidebarBody, type SidebarBodyProps } from '../src/client/sidebar.tsx'
import { S } from '../src/client/strings.ts'

afterEach(cleanup)

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

function props(overrides: Partial<SidebarBodyProps> = {}): SidebarBodyProps {
  return {
    collapsed: false,
    view: { kind: 'home' },
    workbenchActive: true,
    chatActive: false,
    brandMark: '标',
    brandName: S.brand,
    settings: <button type="button">设置</button>,
    onNavigate: vi.fn(),
    onChat: vi.fn(),
    onToggle: vi.fn(),
    ...overrides,
  }
}

describe('SidebarBody wide mode', () => {
  it('renders the core home navigation label', () => {
    render(<SidebarBody {...props()} />)
    expect(screen.getByRole('button', { name: S.nav.today })).toBeDefined()
  })

  it('nav picks route through onNavigate and 回到对话 through onChat', () => {
    const p = props()
    render(<SidebarBody {...p} />)
    fireEvent.click(screen.getByRole('button', { name: S.nav.today }))
    expect(p.onNavigate).toHaveBeenCalledWith({ kind: 'home' })
    fireEvent.click(screen.getByRole('button', { name: S.nav.chat }))
    expect(p.onChat).toHaveBeenCalled()
  })

  it('不再渲染重复的界面缩放', () => {
    render(<SidebarBody {...props()} />)
    expect(screen.queryByLabelText(S.nav.zoom)).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('marks the active nav item for the current view', () => {
    render(<SidebarBody {...props({ view: { kind: 'home' } })} />)
    const works = screen.getByRole('button', { name: S.nav.today })
    expect(works.getAttribute('aria-current')).toBe('page')
  })

  it('keeps the settings slot content mounted', () => {
    render(<SidebarBody {...props()} />)
    expect(screen.getByRole('button', { name: '设置' })).toBeDefined()
  })

  it('brand-row icon collapses the column and carries no visible footer text', () => {
    const p = props()
    render(<SidebarBody {...p} />)
    const toggle = screen.getByRole('button', { name: S.nav.collapse })
    fireEvent.click(toggle)
    expect(p.onToggle).toHaveBeenCalled()
    // 底部不再保留可见的收起文字行。
    expect(screen.queryByText(S.nav.collapse)).toBeNull()
  })
})


describe('SidebarBody collapsed rail', () => {
  it('hides labels, shows icon buttons and the brand-row expand icon', () => {
    const p = props({ collapsed: true })
    render(<SidebarBody {...p} />)
    expect(screen.queryByText(S.nav.today)).toBeNull() // label hidden; glyph + title remain
    expect(screen.getByRole('button', { name: S.nav.today })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: S.nav.expand }))
    expect(p.onToggle).toHaveBeenCalled()
  })
})
