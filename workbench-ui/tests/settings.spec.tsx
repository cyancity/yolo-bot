// @vitest-environment jsdom
/** Core workbench interface settings inside the official settings shell. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WorkbenchSettingsSection, type WorkbenchSettingsSectionProps } from '../src/client/settings.tsx'
import { createPrefsStore, type WorkbenchPrefs } from '../src/client/prefs.ts'
import { S } from '../src/client/strings.ts'

afterEach(cleanup)
function props(overrides: Partial<WorkbenchSettingsSectionProps> = {}): WorkbenchSettingsSectionProps {
  const prefs = createPrefsStore()
  const setZoom = vi.fn(async () => {})
  return {
    setZoom,
    usePrefs: <T,>(selector: (value: WorkbenchPrefs) => T): T => selector(prefs.getSnapshot()),
    useStore: <T,>(selector: (value: { view: { kind: 'home' } }) => T): T => selector({ view: { kind: 'home' } }),
    chrome: { activePageId: null, navigate: vi.fn(), openWorkbench: vi.fn() },
    renderSlot: () => null,
    ...overrides,
  } as unknown as WorkbenchSettingsSectionProps
}
it('renders the core interface heading', () => {
  render(<WorkbenchSettingsSection {...props()} />)
  expect(screen.getByText(S.settings.interface)).toBeDefined()
})
it('界面缩放 offers auto plus the fixed scales and reports the pick', () => {
  const setZoom = vi.fn(async () => {})
  const settingsProps = props({ setZoom })
  const { rerender } = render(<WorkbenchSettingsSection {...settingsProps} />)
  const select = screen.getByLabelText(S.nav.zoom) as HTMLSelectElement
  expect(select.value).toBe('auto')
  fireEvent.keyDown(select, { key: 'ArrowDown' })
  expect(screen.getAllByRole('option')).toHaveLength(8)
  fireEvent.click(screen.getByRole('option', { name: '150%' }))
  expect(setZoom).toHaveBeenCalledWith(1.5)
  rerender(<WorkbenchSettingsSection {...settingsProps} usePrefs={selector => selector({ zoom: 1.5 })} />)
  fireEvent.keyDown(select, { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('option', { name: /自动/ }))
  expect(setZoom).toHaveBeenCalledWith('auto')
})
