/** Core interface zoom and persisted preferences. */
import { describe, expect, it } from 'vitest'
import { createPrefsStore, autoZoom, effectiveViewport, effectiveZoom, normalizeZoom } from '../src/client/prefs.ts'

function stubLocalStorage(): Map<string, string> {
  const backing = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value) },
    removeItem: (key: string) => { backing.delete(key) },
    clear: () => { backing.clear() },
  } })
  return backing
}
describe('createPrefsStore', () => {
  it('boots defaults when no persisted value exists', () => {
    stubLocalStorage()
    expect(createPrefsStore().getSnapshot()).toEqual({ zoom: 'auto' })
  })
  it('persists writes back through the same storage key', async () => {
    const backing = stubLocalStorage()
    const prefs = createPrefsStore()
    await prefs.patch({ zoom: 1.25 })
    expect(JSON.parse(backing.get('workbench.prefs.v1') ?? '')).toEqual({ zoom: 1.25 })
  })
})
describe('interface zoom', () => {
  it('auto zoom = viewport / 2560 in 1/8 steps, clamped to [1, 2]', () => {
    expect(autoZoom(1280)).toBe(0.99)
    expect(autoZoom(1920)).toBe(0.99)
    expect(autoZoom(2048)).toBe(0.99)
    expect(autoZoom(2560)).toBe(0.99)
    expect(autoZoom(3200)).toBe(1.238)
    expect(autoZoom(3840)).toBe(1.485)
    expect(autoZoom(8000)).toBe(1.98)
    expect(autoZoom(undefined)).toBe(0.99)
  })
  it('a fixed preference wins over the viewport', () => {
    expect(effectiveZoom('auto', 3840)).toBe(1.485)
    expect(effectiveZoom(1.25, 3840)).toBe(1.25)
    expect(effectiveZoom(1, 3840)).toBe(1)
  })
  it('effective viewport is the raw width divided by the zoom', () => {
    expect(effectiveViewport('auto', 3840)).toBeCloseTo(2585.86, 1)
    expect(effectiveViewport(1.5, 3000)).toBe(2000)
    expect(effectiveViewport('auto', undefined)).toBeUndefined()
  })
  it('normalizes unknown persisted values to auto', () => {
    expect(normalizeZoom(1.25)).toBe(1.25)
    expect(normalizeZoom(3)).toBe('auto')
    expect(normalizeZoom('1.25')).toBe('auto')
    expect(normalizeZoom(undefined)).toBe('auto')
  })
})
