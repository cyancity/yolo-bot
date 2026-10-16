/**
 * Lightweight client i18n system for YOLO-Bot UI.
 * Supports 'zh' (default) and 'en'.
 * Follows host DSH locale, navigator.language, or user preference in workbench.prefs.v1.
 */
import { useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PrefsSource } from './prefs.ts'
import { normalizeLocale, type LocalePref } from './prefs.ts'

export type Locale = 'zh' | 'en'
export type LocalePreference = LocalePref

let currentPreference: LocalePreference = 'auto'
let detectedHostLocale: Locale | undefined
let memoizedActiveLocale: Locale = 'zh'
const listeners = new Set<() => void>()

function computeActiveLocale(): Locale {
  if (currentPreference === 'zh' || currentPreference === 'en') return currentPreference
  if (detectedHostLocale !== undefined) return detectedHostLocale
  if (typeof document !== 'undefined' && document.documentElement?.lang) {
    const docLang = document.documentElement.lang.toLowerCase()
    if (docLang.startsWith('en')) return 'en'
    if (docLang.startsWith('zh')) return 'zh'
  }
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('en')) {
    return 'en'
  }
  return 'zh'
}

function updateActiveLocale(): void {
  const next = computeActiveLocale()
  if (next !== memoizedActiveLocale) {
    memoizedActiveLocale = next
    for (const listener of [...listeners]) {
      try { listener() } catch (err) { console.error('Locale subscriber failed', err) }
    }
  }
}

export function getLocale(): Locale {
  return memoizedActiveLocale
}

export function setLocalePreference(pref: LocalePreference): void {
  currentPreference = normalizeLocale(pref)
  updateActiveLocale()
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale)
}

interface HostLocaleService {
  getSnapshot?(): { active?: string }
  subscribe?(fn: () => void): () => void
}

/**
 * Initializes locale listeners with host Cordis context and workbench prefs.
 * Observes host locale changes, document.documentElement lang changes, and prefs updates.
 */
export function initLocale(ctx?: ClientContext, prefs?: PrefsSource): () => void {
  const cleanups: (() => void)[] = []

  if (prefs) {
    const initialSnapshot = prefs.getSnapshot()
    currentPreference = normalizeLocale(initialSnapshot.locale)
    const unsubPrefs = prefs.subscribe(() => {
      const nextPref = normalizeLocale(prefs.getSnapshot().locale)
      if (nextPref !== currentPreference) {
        currentPreference = nextPref
        updateActiveLocale()
      }
    })
    cleanups.push(unsubPrefs)
  }

  if (ctx && typeof ctx === 'object') {
    const anyCtx = ctx as unknown as {
      get?(name: string): unknown
      inject?(deps: string[], cb: (scoped: unknown) => void): void
      on?(event: string, fn: (payload: { active?: string }) => void): () => void
    }

    try {
      const initialLocale = anyCtx.get?.('locale') as HostLocaleService | undefined
      const active = initialLocale?.getSnapshot?.()?.active
      if (typeof active === 'string') {
        const mapped = active.toLowerCase().startsWith('en') ? 'en' : 'zh'
        if (mapped !== detectedHostLocale) {
          detectedHostLocale = mapped
        }
      }
    } catch { /* ignore */ }

    try {
      if (typeof anyCtx.inject === 'function') {
        anyCtx.inject(['locale'], (scopedCtx: unknown) => {
          try {
            const scoped = scopedCtx as { locale?: HostLocaleService }
            const localeService = scoped.locale
            const checkSnapshot = () => {
              const active = localeService?.getSnapshot?.()?.active
              if (typeof active === 'string') {
                const mapped = active.toLowerCase().startsWith('en') ? 'en' : 'zh'
                if (mapped !== detectedHostLocale) {
                  detectedHostLocale = mapped
                  updateActiveLocale()
                }
              }
            }
            checkSnapshot()
            if (typeof localeService?.subscribe === 'function') {
              const unsub = localeService.subscribe(checkSnapshot)
              cleanups.push(unsub)
            }
          } catch { /* ignore */ }
        })
      }
    } catch { /* ignore */ }

    try {
      if (typeof anyCtx.on === 'function') {
        const unsub = anyCtx.on('locale/change', (snapshot) => {
          if (snapshot && typeof snapshot.active === 'string') {
            const mapped = snapshot.active.toLowerCase().startsWith('en') ? 'en' : 'zh'
            if (mapped !== detectedHostLocale) {
              detectedHostLocale = mapped
              updateActiveLocale()
            }
          }
        })
        cleanups.push(unsub)
      }
    } catch { /* ignore */ }
  }

  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined' && document.documentElement) {
    const observer = new MutationObserver(() => {
      updateActiveLocale()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    cleanups.push(() => observer.disconnect())
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onLangChange = () => { updateActiveLocale() }
    window.addEventListener('languagechange', onLangChange)
    cleanups.push(() => { window.removeEventListener('languagechange', onLangChange) })
  }

  updateActiveLocale()

  return () => {
    for (const cleanup of cleanups) {
      try { cleanup() } catch { /* ignore */ }
    }
  }
}

/**
 * Creates a reactive proxy that resolves property values based on the currently active locale.
 * Falls back to Chinese on any missing English key.
 */
export function createI18nProxy<T extends object>(zhDict: T, enDict: unknown): T {
  return new Proxy(zhDict, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === '$$typeof') {
        return Reflect.get(target, prop, receiver)
      }
      const zhVal = (target as Record<string | symbol, unknown>)[prop]
      const enVal = (typeof enDict === 'object' && enDict !== null && !Array.isArray(enDict))
        ? (enDict as Record<string | symbol, unknown>)[prop]
        : undefined

      if (typeof zhVal === 'function') {
        return (...args: unknown[]) => {
          if (getLocale() === 'en' && typeof enVal === 'function') {
            return enVal(...args)
          }
          return (zhVal as (...a: unknown[]) => unknown)(...args)
        }
      }

      if (typeof zhVal === 'object' && zhVal !== null && !Array.isArray(zhVal)) {
        return createI18nProxy(zhVal, enVal)
      }

      if (getLocale() === 'en' && enVal !== undefined) {
        return enVal
      }

      return zhVal
    },
    has(target, prop) {
      return Reflect.has(target, prop)
    },
    ownKeys(target) {
      return Reflect.ownKeys(target)
    },
    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop)
    },
  })
}

// Flat key translation dictionary support for t(key, vars?)
const flatDicts: Record<Locale, Record<string, string | ((vars?: Record<string, string | number>) => string)>> = {
  zh: {},
  en: {},
}

export function registerTranslations(locale: Locale, dict: Record<string, string | ((vars?: Record<string, string | number>) => string)>): void {
  Object.assign(flatDicts[locale], dict)
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const loc = getLocale()
  const entry = flatDicts[loc][key] ?? flatDicts.zh[key]
  if (typeof entry === 'function') {
    return entry(vars)
  }
  if (typeof entry === 'string') {
    if (!vars) return entry
    return entry.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
  }
  return key
}
