/**
 * ContextMenu：基于 Radix DropdownMenu 实现的坐标定位上下文菜单。
 * 替代原生右键菜单，提供分组、图标、危险操作、二级菜单与全键盘交互，并自动处理视口碰撞逃逸。
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ReactNode } from 'react'
import { useOverlayTarget } from './root.tsx'
import css from './context-menu.module.css'

export interface ContextMenuItem {
  readonly id: string
  readonly label: string
  readonly icon?: ReactNode
  readonly danger?: boolean
  readonly disabled?: boolean
  readonly onClick?: () => void
  readonly children?: readonly ContextMenuItem[]
}

export interface ContextMenuSection {
  readonly id: string
  readonly label?: string
  readonly items: readonly ContextMenuItem[]
}

export interface ContextMenuProps {
  readonly x: number
  readonly y: number
  readonly sections: readonly ContextMenuSection[]
  readonly onClose: () => void
  readonly open?: boolean
}

export function ContextMenu({ x, y, sections, onClose, open = true }: ContextMenuProps) {
  const overlay = useOverlayTarget()

  const renderItem = (item: ContextMenuItem) => {
    const hasChildren = Boolean(item.children && item.children.length > 0)
    if (hasChildren) {
      return (
        <DropdownMenu.Sub key={item.id}>
          <DropdownMenu.SubTrigger
            className={`${css.item} ${item.danger ? css.itemDanger : ''}`}
            disabled={item.disabled ?? false}
          >
            {item.icon && <span className={css.itemIcon}>{item.icon}</span>}
            <span className={css.itemLabel}>{item.label}</span>
            <span className={css.arrow}>›</span>
          </DropdownMenu.SubTrigger>
          <DropdownMenu.Portal container={overlay ?? undefined}>
            <DropdownMenu.SubContent
              className={css.content}
              sideOffset={4}
              alignOffset={-4}
              collisionPadding={12}
            >
              {item.children!.map(child => (
                <DropdownMenu.Item
                  key={child.id}
                  className={`${css.item} ${child.danger ? css.itemDanger : ''}`}
                  disabled={child.disabled ?? false}
                  onSelect={() => {
                    if (!child.disabled) {
                      child.onClick?.()
                      onClose()
                    }
                  }}
                >
                  {child.icon && <span className={css.itemIcon}>{child.icon}</span>}
                  <span className={css.itemLabel}>{child.label}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.SubContent>
          </DropdownMenu.Portal>
        </DropdownMenu.Sub>
      )
    }

    return (
      <DropdownMenu.Item
        key={item.id}
        className={`${css.item} ${item.danger ? css.itemDanger : ''}`}
        disabled={item.disabled ?? false}
        onSelect={() => {
          if (!item.disabled) {
            item.onClick?.()
            onClose()
          }
        }}
      >
        {item.icon && <span className={css.itemIcon}>{item.icon}</span>}
        <span className={css.itemLabel}>{item.label}</span>
      </DropdownMenu.Item>
    )
  }

  return (
    <DropdownMenu.Root
      key={`${x}-${y}`}
      open={open}
      onOpenChange={next => {
        if (!next) onClose()
      }}
    >
      <DropdownMenu.Trigger asChild>
        <div
          style={{
            position: 'fixed',
            left: `${x}px`,
            top: `${y}px`,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
          aria-hidden="true"
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={overlay ?? undefined}>
        <DropdownMenu.Content
          className={css.content}
          side="bottom"
          align="start"
          sideOffset={2}
          avoidCollisions
          collisionPadding={12}
          onCloseAutoFocus={e => {
            e.preventDefault()
          }}
        >
          {sections.map((section, sIndex) => (
            <DropdownMenu.Group key={section.id} className={css.group}>
              {section.label && <DropdownMenu.Label className={css.groupLabel}>{section.label}</DropdownMenu.Label>}
              {section.items.map(renderItem)}
              {sIndex < sections.length - 1 && <DropdownMenu.Separator className={css.separator} />}
            </DropdownMenu.Group>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
