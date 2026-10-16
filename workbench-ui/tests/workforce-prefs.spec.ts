// @vitest-environment jsdom
/**
 * 数字员工显示偏好（workforce-prefs.ts）：localStorage 读写、非法值归一化、
 * 写入失败时内存态仍生效且通知订阅者。模块在 import 时读一次存储，
 * 每个用例用 vi.resetModules + 重新 import 获得干净的缓存。
 * V2：style/scheme 独立维度；V1 chatLayout/theme 迁移见 migrateWorkforcePrefs。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const KEY = 'workforce.preferences'
const DEFAULTS = { style: 'discord', scheme: 'system', showSteps: false, avatarStyle: 'terminal', typingEffect: 'hash', showTokenStats: true }
let backing: Map<string, string>
let storage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void; clear: () => void }

function stubLocalStorage() {
  backing = new Map()
  storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value) },
    removeItem: (key: string) => { backing.delete(key) },
    clear: () => { backing.clear() },
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
}

async function fresh() {
  vi.resetModules()
  return await import('../src/client/workforce-prefs.ts')
}

beforeEach(() => { stubLocalStorage() })

describe('数字员工显示偏好', () => {
  it('无存储时用默认 discord + system + 不显示步骤 + 终端屏头像', async () => {
    const prefs = await fresh()
    expect(prefs.getWorkforcePrefs()).toEqual(DEFAULTS)
  })

  it('读取已存偏好；非法与缺省字段归一化（V1 chatLayout/theme 迁移）', async () => {
    backing.set(KEY, JSON.stringify({ chatLayout: 'wechat', showSteps: true }))
    expect((await fresh()).getWorkforcePrefs()).toEqual({ ...DEFAULTS, style: 'wechat', showSteps: true })
    backing.set(KEY, JSON.stringify({ chatLayout: 'bogus', showSteps: 'yes' }))
    expect((await fresh()).getWorkforcePrefs()).toEqual(DEFAULTS)
    backing.set(KEY, JSON.stringify({ chatLayout: 'wechat' }))
    expect((await fresh()).getWorkforcePrefs()).toEqual({ ...DEFAULTS, style: 'wechat' })
    // 具名主题迁移为 scheme：深色三件套 → dark，浅色两件套 → light，host/缺失 → system
    backing.set(KEY, JSON.stringify({ chatLayout: 'slack', theme: 'dracula' }))
    expect((await fresh()).getWorkforcePrefs().scheme).toBe('dark')
    backing.set(KEY, JSON.stringify({ theme: 'catppuccin-latte' }))
    expect((await fresh()).getWorkforcePrefs().scheme).toBe('light')
    backing.set(KEY, JSON.stringify({ theme: 'host' }))
    expect((await fresh()).getWorkforcePrefs().scheme).toBe('system')
    // V2 直写 style/scheme
    backing.set(KEY, JSON.stringify({ style: 'wechat', scheme: 'light' }))
    expect((await fresh()).getWorkforcePrefs()).toEqual({ ...DEFAULTS, style: 'wechat', scheme: 'light' })
    backing.set(KEY, JSON.stringify({ style: 'bogus', scheme: 'bogus' }))
    expect((await fresh()).getWorkforcePrefs()).toEqual(DEFAULTS)
    // 头像风格：只有显式 circle 才是圆形，缺省与非法值都归一化为终端屏
    backing.set(KEY, JSON.stringify({ avatarStyle: 'bogus' }))
    expect((await fresh()).getWorkforcePrefs().avatarStyle).toBe('terminal')
    backing.set(KEY, JSON.stringify({ avatarStyle: 'circle' }))
    expect((await fresh()).getWorkforcePrefs().avatarStyle).toBe('circle')
    backing.set(KEY, JSON.stringify({ avatarStyle: 'terminal' }))
    expect((await fresh()).getWorkforcePrefs().avatarStyle).toBe('terminal')
    backing.set(KEY, JSON.stringify({ typingEffect: 'cli' }))
    expect((await fresh()).getWorkforcePrefs().typingEffect).toBe('cli')
    backing.set(KEY, JSON.stringify({ typingEffect: 'binary' }))
    expect((await fresh()).getWorkforcePrefs().typingEffect).toBe('binary')
    backing.set(KEY, JSON.stringify({ typingEffect: 'bogus' }))
    expect((await fresh()).getWorkforcePrefs().typingEffect).toBe('hash')
    // V2 不再存 sidebarMode / bubbleRadius：风格即结构，圆角由 token 定
    backing.set(KEY, JSON.stringify({ sidebarMode: 'chat', bubbleRadius: 25, style: 'wechat' }))
    expect((await fresh()).getWorkforcePrefs()).toEqual({ ...DEFAULTS, style: 'wechat' })
  })

  it('存储损坏或读取抛错时回退默认，不抛异常', async () => {
    backing.set(KEY, '{不是 json')
    expect((await fresh()).getWorkforcePrefs()).toEqual(DEFAULTS)
    storage.getItem = () => { throw new Error('denied') }
    expect((await fresh()).getWorkforcePrefs()).toEqual(DEFAULTS)
  })

  it('写入持久化并通知订阅者；无变化不通知不写', async () => {
    const prefs = await fresh()
    const listener = vi.fn()
    prefs.subscribeWorkforcePrefs(listener)
    prefs.setWorkforcePrefs({ style: 'wechat' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(JSON.parse(backing.get(KEY) ?? '')).toEqual({ ...DEFAULTS, style: 'wechat' })
    prefs.setWorkforcePrefs({ style: 'wechat' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(prefs.getWorkforcePrefs().style).toBe('wechat')
    prefs.setWorkforcePrefs({ scheme: 'dark' })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(prefs.getWorkforcePrefs().scheme).toBe('dark')
    prefs.setWorkforcePrefs({ scheme: 'bogus' as never })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(prefs.getWorkforcePrefs().scheme).toBe('dark')
  })

  it('localStorage 写失败时内存态仍生效并通知', async () => {
    const prefs = await fresh()
    storage.setItem = () => { throw new Error('quota') }
    const listener = vi.fn()
    prefs.subscribeWorkforcePrefs(listener)
    expect(() => prefs.setWorkforcePrefs({ showSteps: true })).not.toThrow()
    expect(prefs.getWorkforcePrefs().showSteps).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
