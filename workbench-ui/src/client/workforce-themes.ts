/**
 * workforce-themes.ts
 * 数字员工工作台主题元数据。**色值不在这里**——实际色表在 ui/ui.module.css
 * 的各主题块，本文件只管 id / 名称 / 深浅 / 出处说明。
 *
 * 出处与适配说明：
 * 色表是「官方 palette + 工作台可访问性适配」，不是逐字官方色表：
 * - Catppuccin（Mocha/Latte）：官方调色板 github.com/catmunch/catppuccin。
 * - Dracula：官方规范 spec.draculatheme.com 与 github.com/dracula-theme/dracula-theme；
 *   hover 用官方 Current Line；链接用官方 Cyan，与主强调 Purple 分角色。
 * - Rosé Pine（Main/Dawn）：官方 rosepinetheme.com/palette/ 与
 *   rosepinetheme.com/create/create-a-theme/；次要文字、边框等为满足 AA 的本地适配值。
 */

export type WorkforceThemeId =
  | 'host'
  | 'catppuccin-mocha'
  | 'catppuccin-latte'
  | 'dracula'
  | 'rose-pine-main'
  | 'rose-pine-dawn'

export interface WorkforceThemeMeta {
  readonly id: WorkforceThemeId
  readonly label: string
  readonly mode: 'auto' | 'dark' | 'light'
  readonly source: string
}

export const WORKFORCE_THEMES: readonly WorkforceThemeMeta[] = [
  {
    id: 'host',
    label: '跟随宿主（默认）',
    mode: 'auto',
    source: 'DSH 宿主默认主题',
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    mode: 'dark',
    source: 'Catppuccin 官方调色板 (Mocha 深色) + 可访问性适配',
  },
  {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    mode: 'light',
    source: 'Catppuccin 官方调色板 (Latte 浅色) + 可访问性适配',
  },
  {
    id: 'dracula',
    label: 'Dracula',
    mode: 'dark',
    source: 'Dracula 官方规范 / VS Code 实现 + 可访问性适配',
  },
  {
    id: 'rose-pine-main',
    label: 'Rosé Pine Main',
    mode: 'dark',
    source: 'Rosé Pine 官方调色板 (Main 深色) + 可访问性适配',
  },
  {
    id: 'rose-pine-dawn',
    label: 'Rosé Pine Dawn',
    mode: 'light',
    source: 'Rosé Pine 官方调色板 (Dawn 浅色) + 可访问性适配',
  },
]

export function isThemeValid(theme: unknown): theme is WorkforceThemeId {
  return typeof theme === 'string' && WORKFORCE_THEMES.some(t => t.id === theme)
}

let hostSchemeMediaQuery: MediaQueryList | undefined
let hostSchemeListener: ((e: MediaQueryListEvent) => void) | undefined
let hostAttrObserver: MutationObserver | undefined
let currentTheme: WorkforceThemeId | undefined

export function resolveThemeScheme(theme: WorkforceThemeId | undefined): 'light' | 'dark' {
  const active = theme && theme !== 'host' ? theme : undefined
  const meta = active ? WORKFORCE_THEMES.find(t => t.id === active) : undefined
  if (meta && meta.mode !== 'auto') {
    return meta.mode
  }
  // host 深浅与 .tokens 同一条开关：body[data-ds-dark-theme] 存在即深色，否则浅色。
  if (typeof document !== 'undefined' && document.body) {
    return document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

function updateScheme(): void {
  if (typeof document === 'undefined') return
  const scheme = resolveThemeScheme(currentTheme)
  document.documentElement.setAttribute('data-wb-scheme', scheme)
  document.body?.setAttribute('data-wb-scheme', scheme)
}

/**
 * 将指定主题应用至 document 根节点及 body 属性上。
 * - 'host' 时移除 data-wb-theme，完全跟随宿主浅/深色；
 * - 其它主题设置 data-wb-theme="<id>"，触发 ui.module.css 中的专属 token。
 * - 增设 data-wb-scheme="light|dark"（documentElement+body）：主题自带 mode；
 *   host 与 .tokens 同一开关 body[data-ds-dark-theme]，MutationObserver 跟随。
 */
export function applyThemeToDocument(theme: WorkforceThemeId | undefined): void {
  if (typeof document === 'undefined') return
  currentTheme = theme
  const activeTheme = theme && theme !== 'host' ? theme : null
  if (activeTheme) {
    document.documentElement.setAttribute('data-wb-theme', activeTheme)
    document.body?.setAttribute('data-wb-theme', activeTheme)
  } else {
    document.documentElement.removeAttribute('data-wb-theme')
    document.body?.removeAttribute('data-wb-theme')
  }

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    if (!hostSchemeMediaQuery) {
      hostSchemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      hostSchemeListener = () => {
        if (!currentTheme || currentTheme === 'host') {
          updateScheme()
        }
      }
      hostSchemeMediaQuery.addEventListener?.('change', hostSchemeListener)
    }
  }

  // 宿主切深浅时重算 data-wb-scheme；本模块不写该属性，不会自触发。
  if (typeof MutationObserver !== 'undefined' && document.body && !hostAttrObserver) {
    hostAttrObserver = new MutationObserver(() => {
      if (!currentTheme || currentTheme === 'host') {
        updateScheme()
      }
    })
    hostAttrObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-ds-dark-theme'],
    })
  }

  updateScheme()

  // Windows 桌面 preload 只在 body 的 style 变化时重算原生窗口按钮底色，换主题后碰一下 style 让它跟上
  document.body?.style.setProperty('--wb-theme-applied', activeTheme ?? 'host')
}
