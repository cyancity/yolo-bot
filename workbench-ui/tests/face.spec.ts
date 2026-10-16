/** Core facade scale writes through shared preferences. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createWorkbenchFace } from '../src/client/face.ts'
import { createPrefsStore } from '../src/client/prefs.ts'

describe('createWorkbenchFace', () => {
  it('setZoom persists a valid factor', async () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => backing.get(key) ?? null, setItem: (key: string, value: string) => { backing.set(key, value) } })
    try {
      const prefs = createPrefsStore()
      const face = createWorkbenchFace({ get: () => undefined, sessions: {}, layout: {}, uiWorkspace: {} } as unknown as Context, { prefs })
      await face.setZoom(1.25)
      expect(prefs.getSnapshot().zoom).toBe(1.25)
      await face.setZoom(7)
      expect(prefs.getSnapshot().zoom).toBe('auto')
    } finally { vi.unstubAllGlobals() }
  })
})
