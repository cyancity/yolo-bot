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
  render(<WorkbenchSettingsSection {...props({ setZoom })} />)
  const select = screen.getByLabelText(S.nav.zoom) as HTMLSelectElement
  expect(select.value).toBe('auto')
  expect(select.options.length).toBe(8)
  fireEvent.change(select, { target: { value: '1.5' } })
  expect(setZoom).toHaveBeenCalledWith(1.5)
  fireEvent.change(select, { target: { value: 'auto' } })
  expect(setZoom).toHaveBeenCalledWith('auto')
})
