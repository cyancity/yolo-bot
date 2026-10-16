/**
 * Menu：操作菜单（Radix DropdownMenu，本包内联）。
 * 内容 portal 到当前根的 overlayRoot，继承同一 style/scheme 快照；
 * modal=false，避免宿主 body 级 scroll-lock/inert 副作用。
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { cloneElement, isValidElement, useRef, type ReactElement } from 'react'
import { useOverlayTarget } from './root.tsx'
import css from './menu.module.css'

export interface MenuItem {
  readonly id: string
  readonly label: string
  readonly disabled?: boolean
  readonly checked?: boolean
  readonly tone?: 'neutral' | 'danger'
  readonly onSelect: () => void
}

export interface MenuSection {
  readonly id: string
  readonly label?: string
  readonly items: readonly MenuItem[]
}

export interface MenuProps {
  readonly label: string
  /** 触发器：一个可接收 ref/aria 的元素（通常是 IconButton 或 Button）。 */
  readonly trigger: ReactElement
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly items?: readonly MenuItem[]
  readonly sections?: readonly MenuSection[]
  readonly align?: 'start' | 'center' | 'end'
  readonly side?: 'top' | 'right' | 'bottom' | 'left'
}

export function Menu({ label, trigger, open, onOpenChange, items, sections, align = 'end', side = 'bottom' }: MenuProps) {
  const overlay = useOverlayTarget()
  // Radix Trigger 在 pointerdown/键位上自切开关；补一条 click 兜底给不带 pointerdown 的环境
  // （jsdom fireEvent.click、程序化 .click()），并用时间戳跳过真实点击链里的重复切换。
  const pointerDownAt = useRef(0)
  const triggerEl = isValidElement(trigger)
    ? cloneElement(trigger, {
        onPointerDown: (e: PointerEvent) => {
          pointerDownAt.current = Date.now()
          ;(trigger.props as { onPointerDown?: (ev: PointerEvent) => void }).onPointerDown?.(e)
        },
        onClick: (e: MouseEvent) => {
          ;(trigger.props as { onClick?: (ev: MouseEvent) => void }).onClick?.(e)
          if (Date.now() - pointerDownAt.current > 400) onOpenChange?.(!(open ?? false))
        },
      } as Record<string, unknown>)
    : trigger
  const renderItem = (item: MenuItem) => (
    <DropdownMenu.Item
      key={item.id}
      className={`${css.item} ${item.tone === 'danger' ? css.danger : ''}`}
      disabled={item.disabled ?? false}
      onSelect={() => { if (!item.disabled) item.onSelect() }}
    >
      {item.checked !== undefined && (
        <span className={css.check} aria-hidden="true">{item.checked ? '✓' : ''}</span>
      )}
      <span className={css.itemLabel}>{item.label}</span>
    </DropdownMenu.Item>
  )
  return (
    <DropdownMenu.Root modal={false} {...(open !== undefined ? { open, ...(onOpenChange ? { onOpenChange } : {}) } : {})}>
      <DropdownMenu.Trigger asChild>{triggerEl}</DropdownMenu.Trigger>
      <DropdownMenu.Portal container={overlay ?? undefined}>
        <DropdownMenu.Content
          className={css.content}
          align={align}
          side={side}
          sideOffset={4}
          aria-label={label}
          loop
        >
          {(sections ?? [{ id: 'default', items: items ?? [] }]).map((section, i) => (
            <DropdownMenu.Group key={section.id} className={css.group}>
              {section.label && <DropdownMenu.Label className={css.groupLabel}>{section.label}</DropdownMenu.Label>}
              {section.items.map(renderItem)}
              {sections && i < sections.length - 1 && <DropdownMenu.Separator className={css.separator} />}
            </DropdownMenu.Group>
          ))}
          <DropdownMenu.Arrow className={css.arrow} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
