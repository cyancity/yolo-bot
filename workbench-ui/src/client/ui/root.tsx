/**
 * WorkbenchSurface：插件挂载根的 token 壳与浮层容器。
 * 每个独立插件根（主面板/侧栏/设置区块）渲染它；data-wb-style/data-wb-scheme
 * 只作用在本根子树，与宿主主题互不染色。菜单/Tooltip/Toast portal 进本根
 * overlayRoot，不落到 document.body。
 */
import { createContext, useContext, useState, type HTMLAttributes, type ReactNode } from 'react'
import { useResolvedScheme, useWorkforcePrefs, type ResolvedScheme, type WorkforceStyle } from '../workforce-prefs.ts'
import { useLocale, type Locale } from '../i18n.ts'
import tokens from './tokens.module.css'

export const tokenRootClass: string = tokens.root ?? ''
/** portal 到 body 的浮层重建 token 环境的类名（无布局 reset）。 */
export const tokenScopeClass: string = tokens.scope ?? ''

/** 供直接写 DOM/portal 的调用方取当前 style/scheme 快照（attrs 展开用）。 */
export function useTokenScopeAttrs(): { className: string; 'data-wb-style': WorkforceStyle; 'data-wb-scheme': ResolvedScheme; style: { colorScheme: ResolvedScheme } } {
  const { style, resolvedScheme } = useSurfaceSnapshot()
  return { className: tokenScopeClass, 'data-wb-style': style, 'data-wb-scheme': resolvedScheme, style: { colorScheme: resolvedScheme } }
}

/** 当前根的浮层容器元素；菜单/Tooltip/Toast 经 useOverlayTarget 取它做 portal。 */
export const OverlayRootContext = createContext<HTMLElement | null>(null)

export function useOverlayTarget(): HTMLElement | null {
  return useContext(OverlayRootContext)
}

export interface SurfaceSnapshot {
  readonly style: WorkforceStyle
  readonly resolvedScheme: ResolvedScheme
  readonly locale: Locale
}

export function useSurfaceSnapshot(): SurfaceSnapshot {
  const [prefs] = useWorkforcePrefs()
  const resolvedScheme = useResolvedScheme(prefs.scheme)
  const locale = useLocale()
  return { style: prefs.style, resolvedScheme, locale }
}

export interface WorkbenchSurfaceProps extends HTMLAttributes<HTMLElement> {
  readonly children?: ReactNode
}

/** 带 token 与 overlay 容器的插件根；页面根在外层另加语义/布局类名。 */
export function WorkbenchSurface({ children, className, style: inlineStyle, ...rest }: WorkbenchSurfaceProps) {
  const { style, resolvedScheme, locale } = useSurfaceSnapshot()
  const [overlayRoot, setOverlayRoot] = useState<HTMLElement | null>(null)
  return (
    <section
      {...rest}
      className={`${tokens.root} ${className ?? ''}`}
      data-wb-root
      data-wb-style={style}
      data-wb-scheme={resolvedScheme}
      data-wb-locale={locale}
      lang={locale === 'zh' ? 'zh-CN' : 'en'}
      style={{ colorScheme: resolvedScheme, ...inlineStyle }}
    >
      <OverlayRootContext.Provider value={overlayRoot}>
        {children}
      </OverlayRootContext.Provider>
      <div ref={setOverlayRoot} className={tokens.overlayRoot} />
    </section>
  )
}
