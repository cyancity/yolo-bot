/** Shared persisted JSON preferences. Only the interface scale is interpreted by core. */
import type { PreferenceFields, PreferenceValue, WorkbenchPreferences } from '../extension.ts'

export type ZoomPref = 'auto' | number
export const ZOOM_CHOICES: readonly number[] = [0.75, 0.875, 1, 1.125, 1.25, 1.5, 1.75]
export const ZOOM_AUTO_BASE = 2560
export const ZOOM_AUTO_MAX = 2
export const SIDEBAR_ZOOM_MAX = 1.5
export type LocalePref = 'auto' | 'zh' | 'en'
export const LOCALE_CHOICES: readonly LocalePref[] = ['auto', 'zh', 'en']
export const LOCALE_FIELD = 'locale'
export interface WorkbenchPrefs {
  readonly zoom: ZoomPref
  readonly locale?: LocalePref
}
/** 侧栏接管开关（偏好字段名）：默认 true；置 false 恢复经典导航。 */
export const SIDEBAR_TAKEOVER_FIELD = 'sidebarTakeover'
export interface PrefsSource extends WorkbenchPreferences {
  getSnapshot(): PreferenceFields & WorkbenchPrefs
}

function viewportWidth(): number | undefined {
  const width = 'innerWidth' in globalThis ? globalThis.innerWidth : undefined
  return typeof width === 'number' && width > 0 ? width : undefined
}
export function autoZoom(viewport: number | undefined = viewportWidth()): number {
  if (viewport === undefined || !Number.isFinite(viewport)) return 1.09
  const raw = Math.min(ZOOM_AUTO_MAX, Math.max(1, viewport / ZOOM_AUTO_BASE))
  return Math.round(Math.floor(raw * 8) / 8 * 1.09 * 1000) / 1000
}
export function effectiveZoom(pref: ZoomPref, viewport?: number): number {
  return pref === 'auto' ? autoZoom(viewport) : pref
}
export function effectiveViewport(pref: ZoomPref, viewport: number | undefined = viewportWidth()): number | undefined {
  return viewport === undefined ? undefined : viewport / effectiveZoom(pref, viewport)
}
export function normalizeZoom(value: unknown): ZoomPref {
  return typeof value === 'number' && ZOOM_CHOICES.includes(value) ? value : 'auto'
}
export function normalizeLocale(value: unknown): LocalePref {
  return value === 'zh' || value === 'en' ? value : 'auto'
}

const PREFS_KEY = 'workbench.prefs.v1'
function copyJson(value: unknown, ancestors = new Set<object>()): PreferenceValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || value === null || ancestors.has(value)) throw new TypeError('Preferences must contain finite JSON values')
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError('Preferences must contain plain JSON objects')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return Object.freeze(Array.from(value, item => copyJson(item, ancestors)))
    const result: Record<string, PreferenceValue> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') throw new TypeError('Invalid preference key')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Preferences must contain JSON fields')
      result[key] = copyJson(descriptor.value, ancestors)
    }
    return Object.freeze(result)
  } finally { ancestors.delete(value) }
}
function copyFields(value: unknown): PreferenceFields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Preferences must be an object')
  return copyJson(value) as PreferenceFields
}

export function createPrefsStore(): PrefsSource {
  let snapshot: PreferenceFields & WorkbenchPrefs = Object.freeze({ zoom: 'auto' })
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(PREFS_KEY)
      if (raw !== null) {
        const stored = copyFields(JSON.parse(raw))
        const next: PreferenceFields & WorkbenchPrefs = {
          ...stored,
          zoom: normalizeZoom(stored.zoom),
          ...('locale' in stored && stored.locale !== undefined ? { locale: normalizeLocale(stored.locale) } : {}),
        }
        snapshot = Object.freeze(next)
      }
    } catch (error) { console.error('Workbench preferences could not be read', error) }
  }
  const listeners = new Set<() => void>()
  let pending = Promise.resolve()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    patch(fields) {
      let copied: PreferenceFields
      try { copied = copyFields(fields) } catch (error) { return Promise.reject(error) }
      const operation = pending.then(() => {
        const next = Object.freeze({ ...snapshot, ...copied }) as PreferenceFields & WorkbenchPrefs
        // Persistence commits before publication. A failed write leaves the old snapshot intact.
        if (typeof localStorage === 'undefined') throw new Error('Preference storage is unavailable')
        localStorage.setItem(PREFS_KEY, JSON.stringify(next))
        snapshot = next
        for (const listener of [...listeners]) {
          try { listener() } catch (error) { console.error('Workbench preference subscriber failed', error) }
        }
      })
      pending = operation.catch(() => {})
      return operation
    },
  }
}
