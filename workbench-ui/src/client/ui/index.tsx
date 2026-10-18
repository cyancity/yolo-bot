import { Button } from './button.tsx'
/**
 * Workbench layout primitives (see docs/design/ui-system.md section 3).
 * Pages are assembled from these; they own spacing, width, hierarchy and
 * surface color, and read only the tokens defined by `ui.module.css`'s
 * `.tokens` class. Page code must not write its own layout CSS for the
 * things these cover.
 *
 *   PageShell    content column: header, sub-nav, body, bottom ActionBar
 *   PageHeader   crumb + title (+ adjacent meta) + subtitle
 *   Banner       info strip under the sub-nav
 *   SubNav       ordered sub-flow navigation
 *   Panel        white container with an optional title row
 *   PanelSection a divided zone inside a Panel (optionally tinted)
 *   Grid         `split` (main 2/3 + aside 1/3) or `cards` (equal-width)
 *   ActionBar    the confirm gate pinned under the scroll area
 *   Tag / Stat / Empty / SkeletonBar   small shared pieces
 */
import { createContext, useContext, useState, useEffect, useRef, isValidElement } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import ui from './ui.module.css'
import { Icon } from './icons.tsx'
import { Dialog as WbDialog } from './dialog.tsx'
import { tokenRootClass, tokenScopeClass } from './root.tsx'

/** Join class names, skipping falsy entries. */
export function cx(...names: readonly (string | false | undefined | null)[]): string {
  return names.filter(Boolean).join(' ')
}

export { ui as uiClasses }
export { tokenRootClass, tokenScopeClass }
export { WorkbenchSurface, useSurfaceSnapshot, useOverlayTarget, OverlayRootContext, useTokenScopeAttrs } from './root.tsx'
export type { SurfaceSnapshot } from './root.tsx'
export { Button, IconButton, Input, Composer, Avatar, MessageItem, Bubble, ChannelItem, Badge, Menu, ContextMenu, Tooltip, Tabs, Toast, ToastRegion, Skeleton, ThreadPanel, Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Chip, EmptyState, ListRow } from './primitives.ts'
export type { ButtonProps, ButtonVariant, Size } from './button.tsx'
export type { IconButtonProps } from './icon-button.tsx'
export type { InputProps } from './input.tsx'
export type { ComposerProps, ComposerAttachment, ComposerState } from './composer.tsx'
export type { AvatarProps } from './avatar.tsx'
export type { MessageItemProps, MessageAction, TaskRef } from './message-item.tsx'
export type { BubbleProps } from './bubble.tsx'
export type { ChannelItemProps } from './channel-item.tsx'
export type { BadgeProps, Tone as BadgeTone, BadgeVariant } from './badge.tsx'
export type { MenuProps, MenuItem, MenuSection } from './menu.tsx'
export type { ContextMenuProps, ContextMenuItem, ContextMenuSection } from './context-menu.tsx'
export type { DialogProps, DialogAction, DialogSize } from './dialog.tsx'
export type { TooltipProps } from './tooltip.tsx'
export type { TabsProps, TabItem } from './tabs.tsx'
export type { ToastProps, ToastAction } from './toast.tsx'
export type { SkeletonProps } from './skeleton.tsx'
export type { ThreadPanelProps } from './thread-panel.tsx'
export type { CardProps, CardHeaderProps, CardTitleProps, CardDescriptionProps, CardContentProps, CardFooterProps, CardVariant } from './card.tsx'
export type { ChipProps, ChipTone } from './chip.tsx'
export type { EmptyStateProps } from './empty-state.tsx'
export type { ListRowProps, ListRowSize } from './list-row.tsx'

interface HeaderRegistration { host: HTMLElement; header?: ReactNode; subnav?: ReactNode; maxWidth?: number | undefined }
const AppHeaderContext = createContext<((value: HeaderRegistration | null) => void) | undefined>(undefined)
/** One persistent header shared by every page; PageShell publishes its page controls. */
export function AppHeaderProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<HeaderRegistration | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 })
  useEffect(() => {
    if (!page) return
    const shell = page.host
    const place = () => {
      const rect = shell.getBoundingClientRect()
      const root = shell.closest('[data-wb-root]')
      const zoom = root ? Number(getComputedStyle(root).zoom) || 1 : 1
      setPosition({ left: rect.left / zoom, top: rect.top / zoom, width: rect.width / zoom })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(shell)
    window.addEventListener('resize', place)
    return () => { observer.disconnect(); window.removeEventListener('resize', place) }
  }, [page?.host])
  return <AppHeaderContext.Provider value={setPage}>{children}
    <div className={ui.headerDock} style={{ ...position, visibility: page ? 'visible' : 'hidden' }}>
      <AppHeader header={page?.header} subnav={page?.subnav} maxWidth={page?.maxWidth} />
    </div>
  </AppHeaderContext.Provider>
}
/** The shared header contains page controls only. */
export function AppHeader({ header, subnav, maxWidth, variant = 'primary' }: { header?: ReactNode; subnav?: ReactNode; maxWidth?: number | undefined; variant?: 'primary' | 'secondary' }) {
  return <div className={ui.appHeader} data-app-header data-header-variant={variant}>
    <div className={ui.appHeaderRow} style={maxWidth === undefined ? undefined : { maxWidth: `calc(${maxWidth}px + 2 * var(--wb-space-6))` }}>{header}</div>
    {subnav && <div className={ui.fixedSubnav}>{subnav}</div>}
  </div>
}

// ---------------------------------------------------------------- PageShell

/** Where ActionBars portal to; undefined outside a PageShell (renders inline). */
const ShellContext = createContext<{ readonly slot: HTMLElement | null } | undefined>(undefined)

export interface PageShellProps {
  /** Narrower content column (px) for focused pages; the shared header row follows it so titles stay aligned. */
  readonly maxWidth?: number | undefined
  /** Usually a <PageHeader>. */
  readonly header?: ReactNode
  /** Usually a <SubNav>; sits directly under the header. */
  readonly subnav?: ReactNode
  /** Optional strip between sub-nav and body (e.g. "正在回看…"). */
  readonly banner?: ReactNode
  readonly children?: ReactNode
}

/**
 * The content column for every page: a scrolling area holding one centered
 * column (`--wb-page-max`) with header, sub-nav, banner and body stacked at
 * `--wb-space-4`, plus a fixed slot below it that any descendant
 * <ActionBar> renders into.
 */
export function PageShell({ header, subnav, banner, maxWidth, children }: PageShellProps) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const publish = useContext(AppHeaderContext)
  const shellRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = shellRef.current
    if (!publish || !host) return
    publish({ host, header, subnav, maxWidth })
    return () => publish(null)
  }, [publish, header, subnav, maxWidth])
  const subtitle = isValidElement<PageHeaderProps>(header) ? header.props.subtitle : undefined
  return (
    <ShellContext.Provider value={{ slot }}>
      <div ref={shellRef} className={ui.shell}>
        {publish && <div className={ui.headerSpace} style={{ height: subnav ? 100 : 52 }} />}
        <div data-workbench-scroll className={ui.scroll}>
          <div className={ui.column} style={maxWidth === undefined ? undefined : { maxWidth }}>
            {!publish && header}
            {!publish && subnav}
            {publish && subtitle && <p className={ui.subtitle}>{subtitle}</p>}
            {banner}
            {children}
          </div>
        </div>
        <div ref={setSlot} className={ui.actionSlot} />
      </div>
    </ShellContext.Provider>
  )
}

// --------------------------------------------------------------- PageHeader

export interface PageHeaderProps {
  readonly title: ReactNode
  /** One-line status under the title. */
  readonly subtitle?: ReactNode
  /** Back link text ("← 作品列表"); renders above the title when onCrumb is set. */
  readonly crumb?: string
  readonly onCrumb?: () => void
  /** A few page-specific controls that sit right next to the title (never pushed to the far edge). */
  readonly status?: ReactNode
  readonly meta?: ReactNode
  /** Bare status lamps beside the title (no pill background). */
  readonly lamps?: ReactNode
}

/** Navigation context: optional back crumb, the title with adjacent meta, then the subtitle. */
export function PageHeader({ title, subtitle, crumb, onCrumb, meta, status, lamps }: PageHeaderProps) {
  return (
    <header className={ui.header}>
      {crumb !== undefined && onCrumb !== undefined && (
        <Button variant="plain" type="button" className={ui.crumb} onClick={onCrumb}>{crumb}</Button>
      )}
      <div className={ui.titleRow}>
        <h1 className={ui.title}>{title}</h1>
        {status && <Tag tone="accent">{status}</Tag>}
        {lamps}
        {meta !== undefined && <div className={ui.meta}>{meta}</div>}
      </div>
      {subtitle !== undefined && <p className={ui.subtitle}>{subtitle}</p>}
    </header>
  )
}

/** Info strip between the sub-nav and the body (e.g. "正在回看…" with a way back). */
export function Banner({ children }: { readonly children: ReactNode }) {
  return <div className={ui.banner} role="status">{children}</div>
}

// ------------------------------------------------------------------- SubNav

export interface SubNavItem {
  readonly key: string
  readonly label: ReactNode
  /** done = reachable (button when onSelect given), current = highlighted, todo = disabled. */
  readonly state: 'done' | 'current' | 'todo'
  /** Text inside the number bubble; defaults to ✓ for done, the 1-based index otherwise. */
  readonly marker?: ReactNode
  /** Tint as a pre-stage (purple), e.g. 素材. */
  readonly pre?: boolean
  /** True for the done item the page is currently re-viewing. */
  readonly viewing?: boolean
}

export interface SubNavProps {
  readonly label: string
  readonly items: readonly SubNavItem[]
  /** Called with an item key when a done item is clicked. */
  readonly onSelect?: (key: string) => void
}

/** The sub-flow bar: done items can be revisited, the current one is highlighted, later ones are disabled. */
export function SubNav({ label, items, onSelect }: SubNavProps) {
  return (
    <ol className={ui.subnav} aria-label={label}>
      {items.map((item, index) => {
        const marker = item.marker ?? (item.state === 'done' ? '✓' : String(index + 1))
        const classes = cx(
          ui.step,
          item.state === 'done' && ui.stepDone,
          item.state === 'current' && ui.stepCurrent,
          item.pre === true && ui.stepPre,
          item.viewing === true && ui.stepViewing,
        )
        const inner = (
          <>
            {item.marker === null ? null : <span className={ui.stepNo} aria-hidden="true">{marker}</span>}
            {item.label}
          </>
        )
        return (
          <li
            key={item.key}
            className={ui.subnavItem}
            aria-current={item.state === 'current' ? 'step' : undefined}
            data-stage={item.key}
            data-state={item.state}
          >
            {index > 0 && <span className={ui.subnavArrow} aria-hidden="true">›</span>}
            {item.state === 'done' && onSelect !== undefined
              ? <Button variant="plain" type="button" className={classes} onClick={() => onSelect(item.key)}>{inner}</Button>
              : item.state === 'todo'
                ? <Button variant="plain" type="button" className={classes} disabled>{inner}</Button>
                : <span className={classes}>{inner}</span>}
          </li>
        )
      })}
    </ol>
  )
}

// -------------------------------------------------------------------- Panel

export interface PanelProps {
  /** Title row text; omit for a bare panel. */
  readonly title?: ReactNode
  /** Right side of the title row: secondary info or a small action. */
  readonly aside?: ReactNode
  /** Custom header slot overriding or replacing default title/aside row */
  readonly header?: ReactNode
  /** Optional footer strip at bottom of panel */
  readonly footer?: ReactNode
  /** Remove body padding (lists/tables that bleed to the edges; use PanelSections inside). */
  readonly flush?: boolean
  readonly className?: string | undefined
  readonly children?: ReactNode
  readonly [key: `data-${string}`]: string | undefined
}

/**
 * White container, full width of its parent. Put related content in ONE
 * Panel and divide it with <PanelSection>s so the page background never
 * shows between related blocks.
 */
export function Panel({ title, aside, header, footer, flush = false, className, children, ...data }: PanelProps) {
  const hasHead = header !== undefined || title !== undefined || aside !== undefined
  return (
    <section className={cx(ui.panel, flush && ui.panelFlush, !hasHead && ui.panelBare, className)} {...data}>
      {hasHead && (
        <div className={ui.panelHead}>
          {header !== undefined ? (
            header
          ) : (
            <>
              {title !== undefined && <h3 className={ui.panelTitle}>{title}</h3>}
              {aside !== undefined && <span className={ui.panelAside}>{aside}</span>}
            </>
          )}
        </div>
      )}
      <div className={ui.panelBody}>{children}</div>
      {footer !== undefined && <div className={ui.panelFoot}>{footer}</div>}
    </section>
  )
}

export interface PanelSectionProps {
  /** Small caps-style label above the section content. */
  readonly title?: ReactNode
  /** Tint the zone with `--wb-surface-sub` (secondary actions, upload zones, reject strips). */
  readonly sub?: boolean
  readonly className?: string | undefined
  readonly children?: ReactNode
  readonly [key: `data-${string}`]: string | undefined
}

/** A zone inside a Panel, separated by a divider line; bleeds to the Panel edges. */
export function PanelSection({ title, sub = false, className, children, ...data }: PanelSectionProps) {
  return (
    <div className={cx(ui.section, sub && ui.sectionSub, className)} {...data}>
      {title !== undefined && <h4 className={ui.sectionTitle}>{title}</h4>}
      {children}
    </div>
  )
}

// --------------------------------------------------------------------- Grid

export type GridProps =
  | {
    readonly variant: 'split'
    /** Left (reading-first) column, about 2/3 wide; stacks above `aside` on narrow areas. */
    readonly main: ReactNode
    /** Right column, about 1/3: companion info or the next action. */
    readonly aside: ReactNode
  }
  | {
    readonly variant: 'cards'
    /** Minimum card width in px before the grid drops a column (default 260). */
    readonly minCard?: number | undefined
    readonly children: ReactNode
    readonly className?: string | undefined
  }

/** Primary/secondary split or an equal-width card grid; both wrap on narrow widths. */
export function Grid(props: GridProps) {
  if (props.variant === 'split') {
    return (
      <div className={ui.split}>
        <div className={ui.splitMain}>{props.main}</div>
        <div className={ui.splitAside}>{props.aside}</div>
      </div>
    )
  }
  return (
    <div
      className={cx(ui.cards, props.className)}
      style={props.minCard === undefined ? undefined : ({ ['--wb-card-min' as string]: `${props.minCard}px` })}
    >
      {props.children}
    </div>
  )
}

// ---------------------------------------------------------------- ActionBar

export interface ActionBarProps {
  /** Buttons, leftmost first: the primary action starts the reading line. */
  readonly children: ReactNode
  /** Quiet explanation pinned to the right. */
  readonly caption?: ReactNode
}

/** The confirm gate: rendered under the scroll area (outside it), aligned to the page column. */
export function ActionBar({ children, caption }: ActionBarProps) {
  const shell = useContext(ShellContext)
  const bar = (
    <div className={ui.actionBar} data-action-bar>
      <div className={ui.actionInner}>
        {children}
        {caption !== undefined && <span className={ui.actionCaption}>{caption}</span>}
      </div>
    </div>
  )
  if (shell === undefined) return bar
  return shell.slot === null ? null : createPortal(bar, shell.slot)
}

// ---------------------------------------------------------- small components

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'asset' | 'info' | 'danger'

const TAG_TONE: Readonly<Record<Tone, string | undefined>> = {
  neutral: undefined,
  accent: ui.tagAccent,
  ok: ui.tagOk,
  warn: ui.tagWarn,
  asset: ui.tagAsset,
  info: ui.tagInfo,
  danger: ui.tagDanger,
}

/** Pill label (provenance, status, kind). */
export function Tag({ tone = 'neutral', className, children }: {
  readonly tone?: Tone
  readonly className?: string | undefined
  readonly children: ReactNode
}) {
  return <span className={cx(ui.tag, TAG_TONE[tone], className)}>{children}</span>
}

/** Small labelled number/state tile. */
export function Stat({ label, value, tone }: {
  readonly label: string
  readonly value: ReactNode
  readonly tone?: 'ok' | 'warn' | 'danger' | undefined
}) {
  const toneClass = tone === 'ok' ? ui.statOk : tone === 'warn' ? ui.statWarn : tone === 'danger' ? ui.statDanger : undefined
  return (
    <div className={ui.stat}>
      <div className={ui.statLabel}>{label}</div>
      <div className={cx(ui.statValue, toneClass)}>{value}</div>
    </div>
  )
}

/** Muted empty/waiting message. */
export function Empty({ children }: { readonly children: ReactNode }) {
  return <div className={ui.empty}><Icon name="folder" />{children}</div>
}

/** One shimmering placeholder bar. */
export function SkeletonBar({ width, className }: { readonly width?: string; readonly className?: string | undefined }) {
  return <span className={cx(ui.skeleton, className)} style={width === undefined ? undefined : { width }} aria-hidden="true" />
}


/** 扩展契约 Dialog（components.Dialog）：旧 props 由新原生实现承接；ActionBar portal 在 dialog 内关闭。 */
export function Dialog(props: Parameters<typeof WbDialog>[0]) {
  return (
    <ShellContext.Provider value={undefined}>
      <WbDialog {...props} />
    </ShellContext.Provider>
  )
}
export { Switch } from './switch.tsx'
export { Select } from './select.tsx'
export { TextInput, Textarea } from './input.tsx'
export { Checkbox, RadioGroup } from './choice.tsx'

