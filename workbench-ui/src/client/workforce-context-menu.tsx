/**
 * WorkforceContextMenu：Discord 风格右键菜单组件。
 * 替换浏览器默认上下文菜单，提供分组、高亮、危险操作与二级菜单支持。
 */
import { Button } from './ui/primitives.ts'
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Dialog, useTokenScopeAttrs } from './ui/index.tsx'
import { WF } from './workforce-strings.ts'
import css from './workforce-context-menu.module.css'

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
  readonly items: readonly ContextMenuItem[]
}

export interface WorkforceContextMenuProps {
  readonly x: number
  readonly y: number
  readonly sections: readonly ContextMenuSection[]
  readonly onClose: () => void
}

export function WorkforceContextMenu({ x, y, sections, onClose }: WorkforceContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [activeSubmenuId, setActiveSubmenuId] = useState<string | null>(null)
  const [coords, setCoords] = useState<{ x: number; y: number }>({ x, y })
  const [submenuToLeft, setSubmenuToLeft] = useState(false)
  const scopeAttrs = useTokenScopeAttrs()

  // 视口边界调整：防止溢出屏幕右侧或下侧
  useEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const padding = 12
    const winWidth = window.innerWidth
    const winHeight = window.innerHeight

    let nextX = x
    let nextY = y

    if (x + rect.width > winWidth - padding) {
      nextX = Math.max(padding, winWidth - rect.width - padding)
    }
    if (y + rect.height > winHeight - padding) {
      nextY = Math.max(padding, winHeight - rect.height - padding)
    }

    setCoords({ x: nextX, y: nextY })
    setSubmenuToLeft(nextX + rect.width + 160 > winWidth)
  }, [x, y])

  // 按 Esc 或窗口失去焦点时关闭
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const handleItemClick = (e: MouseEvent, item: ContextMenuItem) => {
    e.stopPropagation()
    if (item.disabled) return
    if (item.children && item.children.length > 0) {
      setActiveSubmenuId(prev => (prev === item.id ? null : item.id))
      return
    }
    item.onClick?.()
    onClose()
  }

  // 侧栏等插件根各自是层叠上下文，菜单留在子树里会被内容区盖住；portal 到 body 并重建 token 作用域。
  const menu = (
    <div {...scopeAttrs}>
      <div
        className={css.overlay}
        onMouseDown={onClose}
        onContextMenu={e => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        ref={menuRef}
        className={css.menu}
        style={{ left: `${coords.x}px`, top: `${coords.y}px` }}
        onContextMenu={e => e.preventDefault()}
      >
        {sections.map((section, sIndex) => (
          <div key={section.id} className={css.section}>
            {sIndex > 0 && <div className={css.divider} />}
            {section.items.map(item => {
              const hasChildren = item.children && item.children.length > 0
              const isSubmenuOpen = activeSubmenuId === item.id
              return (
                <div
                  key={item.id}
                  style={{ position: 'relative' }}
                  onMouseEnter={() => {
                    if (hasChildren) setActiveSubmenuId(item.id)
                    else setActiveSubmenuId(null)
                  }}
                >
                  <Button variant="plain"
                    type="button"
                    className={`${css.item} ${item.danger ? css.itemDanger : ''} ${item.disabled ? css.itemDisabled : ''} ${isSubmenuOpen ? css.itemFocused : ''}`}
                    onClick={e => handleItemClick(e, item)}
                  >
                    {item.icon && <span className={css.itemIcon}>{item.icon}</span>}
                    <span className={css.itemLabel}>{item.label}</span>
                    {hasChildren && <span className={css.arrow}>›</span>}
                  </Button>

                  {hasChildren && isSubmenuOpen && (
                    <div
                      className={`${css.submenu} ${submenuToLeft ? css.submenuLeft : ''}`}
                    >
                      {item.children!.map(child => (
                        <Button variant="plain"
                          key={child.id}
                          type="button"
                          className={`${css.item} ${child.danger ? css.itemDanger : ''} ${child.disabled ? css.itemDisabled : ''}`}
                          onClick={e => handleItemClick(e, child)}
                        >
                          {child.icon && <span className={css.itemIcon}>{child.icon}</span>}
                          <span className={css.itemLabel}>{child.label}</span>
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
  return typeof document !== 'undefined' ? createPortal(menu, document.body) : menu
}

/** 危险操作二次确认弹窗 */
export interface ConfirmDialogProps {
  readonly title: string
  readonly message: string
  readonly confirmLabel?: string | undefined
  readonly cancelLabel?: string | undefined
  readonly danger?: boolean | undefined
  readonly error?: string | undefined
  readonly onConfirm: () => void | Promise<void>
  readonly onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = WF.common.confirm,
  cancelLabel = WF.common.cancel,
  danger = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Native modal owns focus, Escape and restoration; Enter activates only the focused button.

  return (
    <Dialog title={title} closeLabel={cancelLabel} onClose={onCancel}>
        <div className={css.modalBody}>
          {message}
          {error && <div className={css.modalError} role="alert">{error}</div>}
        </div>
        <div className={css.modalFoot}>
          <Button variant="plain" type="button" className={css.modalCancelBtn} autoFocus onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant="plain"
            type="button"
            className={`${css.modalConfirmBtn} ${danger ? css.modalDangerBtn : ''}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
    </Dialog>
  )
}
