/** Each plugin mount owns its Lobe theme and overlay scope. */
import { createContext, useContext, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import ThemeProvider from '@lobehub/ui/es/ThemeProvider'
import antdOverride from '@lobehub/ui/es/ThemeProvider/GlobalStyle/antdOverride'
import { createStyles, useTheme, type Theme } from 'antd-style'
import { readableColor } from 'polished'
import { useResolvedScheme, useWorkforcePrefs, type ResolvedScheme, type WorkforceStyle } from '../workforce-prefs.ts'
import tokens from './tokens.module.css'
import { useLocale, type Locale } from '../i18n.ts'
import { ConfigProvider } from 'antd'
import enUS from 'antd/locale/en_US'
import zhCN from 'antd/locale/zh_CN'

export const tokenRootClass: string = tokens.root ?? ''
export const tokenScopeClass: string = tokens.scope ?? ''

type TokenStyle = CSSProperties & Record<`--wb-${string}`, string | number>

/** Legacy CSS names are aliases of the installed Lobe theme, never a second palette. */
function themeAliases(theme: Theme): TokenStyle {
  const px = (value: number) => `${value}px`
  return {
    '--wb-font-family': theme.fontFamily,
    '--wb-font-mono': theme.fontFamilyCode,
    '--wb-weight-regular': 'normal',
    '--wb-weight-medium': theme.fontWeightStrong,
    '--wb-weight-semibold': theme.fontWeightStrong,
    '--wb-type-caption-size': px(theme.fontSizeSM),
    '--wb-type-caption-weight': 'normal',
    '--wb-type-caption-leading': theme.lineHeightSM,
    '--wb-type-compact-size': px(theme.fontSize),
    '--wb-type-compact-weight': 'normal',
    '--wb-type-compact-leading': theme.lineHeight,
    '--wb-type-label-size': px(theme.fontSize),
    '--wb-type-label-weight': 'normal',
    '--wb-type-label-leading': theme.lineHeight,
    '--wb-type-body-size': px(theme.fontSize),
    '--wb-type-body-weight': 'normal',
    '--wb-type-body-leading': theme.lineHeight,
    '--wb-type-strong-size': px(theme.fontSize),
    '--wb-type-strong-weight': theme.fontWeightStrong,
    '--wb-type-strong-leading': theme.lineHeight,
    '--wb-type-section-size': px(theme.fontSizeLG),
    '--wb-type-section-weight': theme.fontWeightStrong,
    '--wb-type-section-leading': theme.lineHeightLG,
    '--wb-type-title-size': px(theme.fontSizeXL),
    '--wb-type-title-weight': theme.fontWeightStrong,
    '--wb-type-title-leading': theme.lineHeightHeading4,
    '--wb-type-code-size': px(theme.fontSize),
    '--wb-type-code-weight': 'normal',
    '--wb-type-code-leading': theme.lineHeight,
    '--wb-font-xs': px(theme.fontSizeSM),
    '--wb-radius-badge': px(theme.borderRadiusSM),
    '--wb-radius-control': px(theme.borderRadius),
    '--wb-radius-panel': px(theme.borderRadiusLG),
    '--wb-radius-card': px(theme.borderRadiusLG),
    '--wb-radius-overlay': px(theme.borderRadiusLG),
    '--wb-radius-bubble': px(theme.borderRadiusLG),
    '--wb-bubble-radius': px(theme.borderRadiusLG),
    '--wb-control-height-sm': px(theme.controlHeightSM),
    '--wb-control-height-md': px(theme.controlHeight),
    '--wb-control-height-lg': px(theme.controlHeightLG),
    '--wb-border-width': px(theme.lineWidth),
    '--wb-focus-width': px(theme.lineWidthFocus),
    '--wb-bg': theme.colorBgLayout,
    '--wb-rail': theme.colorBgLayout,
    '--wb-nav': theme.colorBgContainer,
    '--wb-surface': theme.colorBgContainer,
    '--wb-surface-sub': theme.colorFillQuaternary,
    '--wb-surface-raised': theme.colorBgElevated,
    '--wb-surface-soft': theme.colorFillTertiary,
    '--wb-fg': theme.colorText,
    '--wb-fg-muted': theme.colorTextSecondary,
    '--wb-fg-placeholder': theme.colorTextPlaceholder,
    '--wb-sub-fg-sm': theme.colorTextSecondary,
    '--wb-line': theme.colorBorderSecondary,
    '--wb-line-soft': theme.colorBorderSecondary,
    '--wb-line-control': theme.colorBorder,
    '--wb-line-strong': theme.colorBorder,
    '--wb-hover': theme.colorFillTertiary,
    '--wb-pressed': theme.colorFill,
    '--wb-selected-bg': theme.colorFillSecondary,
    '--wb-selected-fg': theme.colorText,
    '--wb-accent': theme.colorPrimary,
    '--wb-accent-hover': theme.colorPrimaryHover,
    '--wb-accent-pressed': theme.colorPrimaryActive,
    '--wb-on-accent': readableColor(theme.colorPrimary),
    '--wb-accent-soft': theme.colorPrimaryBg,
    '--wb-accent-fg': theme.colorPrimaryText,
    '--wb-accent-fg-sm': theme.colorPrimaryText,
    '--wb-link': theme.colorLink,
    '--wb-focus': theme.colorPrimaryBorder,
    '--wb-disabled-bg': theme.colorBgContainerDisabled,
    '--wb-disabled-fg': theme.colorTextDisabled,
    '--wb-disabled-line': theme.colorBorder,
    '--wb-success': theme.colorSuccessText,
    '--wb-success-bg': theme.colorSuccessBg,
    '--wb-warning': theme.colorWarningText,
    '--wb-warning-bg': theme.colorWarningBg,
    '--wb-danger': theme.colorErrorText,
    '--wb-danger-bg': theme.colorErrorBg,
    '--wb-danger-soft': theme.colorErrorBg,
    '--wb-danger-solid': theme.colorError,
    '--wb-on-danger': readableColor(theme.colorError),
    '--wb-info': theme.colorInfoText,
    '--wb-info-bg': theme.colorInfoBg,
    '--wb-quote-bg': theme.colorFillTertiary,
    '--wb-quote-line': theme.colorBorder,
    '--wb-bubble-peer': theme.colorBgContainer,
    '--wb-bubble-self': theme.colorFillTertiary,
    '--wb-bubble-self-fg': theme.colorText,
    '--wb-bubble-line': theme.colorBorderSecondary,
    '--wb-unread-bg': theme.colorPrimary,
    '--wb-on-unread': readableColor(theme.colorPrimary),
    '--wb-skeleton-base': theme.colorFillTertiary,
    '--wb-skeleton-highlight': theme.colorFillSecondary,
    '--wb-overlay': theme.colorBgMask,
    '--wb-tooltip-bg': theme.colorText,
    '--wb-tooltip-fg': theme.colorBgLayout,
    '--wb-shadow-popover': theme.boxShadowSecondary,
    '--wb-shadow-dialog': theme.boxShadow,
    '--wb-motion-fast': theme.motionDurationFast,
    '--wb-motion-normal': theme.motionDurationMid,
    '--wb-motion-slow': theme.motionDurationSlow,
    '--wb-motion-ease': theme.motionEaseOut,
  }
}

// The official override contains only component selectors. createStyles scopes
// them to this root; Lobe's document-wide html/body reset stays disabled.
const useNativeStyle = createStyles(({ css, token, stylish, prefixCls }) => ({
  scope: css(antdOverride({ ...token, stylish, prefixCls } as Theme)),
}))

/** Recreate the same native theme for body portals without touching the host. */
export function useTokenScopeAttrs() {
  const { style, resolvedScheme, locale } = useSurfaceSnapshot()
  const theme = useTheme()
  const { styles } = useNativeStyle()
  return {
    className: `${tokenScopeClass} ${styles.scope}`,
    'data-wb-style': style,
    'data-wb-scheme': resolvedScheme,
    'data-wb-locale': locale,
    lang: locale === 'zh' ? 'zh-CN' : 'en',
    style: { ...themeAliases(theme), colorScheme: resolvedScheme },
  }
}

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

function TokenSurface({ children, className, style: inlineStyle, ...rest }: WorkbenchSurfaceProps) {
  const scope = useTokenScopeAttrs()
  const [overlayRoot, setOverlayRoot] = useState<HTMLElement | null>(null)
  return (
    <section
      {...rest}
      {...scope}
      className={`${tokens.root} ${scope.className} ${className ?? ''}`}
      data-wb-root
      style={{ ...scope.style, ...inlineStyle }}
    >
      <OverlayRootContext.Provider value={overlayRoot}>{children}</OverlayRootContext.Provider>
      <div ref={setOverlayRoot} className={tokens.overlayRoot} />
    </section>
  )
}

export function WorkbenchSurface(props: WorkbenchSurfaceProps) {
  const { resolvedScheme, locale } = useSurfaceSnapshot()
  return (
    <ThemeProvider
      appearance={resolvedScheme}
      theme={{ inherit: false }}
      enableGlobalStyle={false}
      style={{ display: 'contents' }}
    >
      <ConfigProvider locale={locale === 'zh' ? zhCN : enUS} button={{ autoInsertSpace: false }}><TokenSurface {...props} /></ConfigProvider>
    </ThemeProvider>
  )
}
