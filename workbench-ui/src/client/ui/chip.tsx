import { forwardRef, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { Icon } from './icons.tsx'
import css from './chip.module.css'
import { WF } from '../workforce-strings.ts'

export type ChipTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

export interface ChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'onClick'> {
  readonly tone?: ChipTone
  /** 选中态（用于筛选/多选胶囊） */
  readonly selected?: boolean
  /** 禁用态 */
  readonly disabled?: boolean
  /** 前置图标或插槽 */
  readonly icon?: ReactNode
  /** 是否可移除（提供 onRemove 时默认 true） */
  readonly removable?: boolean
  /** 移除按钮点击回调 */
  readonly onRemove?: (e: MouseEvent<HTMLButtonElement>) => void
  /** 移除按钮的无障碍标签 */
  readonly removeAriaLabel?: string
  /** 点击回调（存在时支持键盘回车/空格触发） */
  readonly onClick?: (e: MouseEvent<HTMLSpanElement>) => void
  readonly asChild?: boolean
  readonly children?: ReactNode
}

export const Chip = forwardRef<HTMLSpanElement, ChipProps>(function Chip(
  {
    tone = 'neutral',
    selected = false,
    disabled = false,
    icon,
    removable,
    onRemove,
    removeAriaLabel = WF.ui.remove,
    onClick,
    asChild = false,
    className,
    children,
    ...rest
  },
  ref,
) {
  const Component = asChild ? Slot : 'span'
  const isClickable = !disabled && Boolean(onClick)
  const isRemovable = removable ?? Boolean(onRemove)

  const handleKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (disabled) return
    if (onClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      onClick(e as unknown as MouseEvent<HTMLSpanElement>)
    }
  }

  const handleRemove = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    if (!disabled) {
      onRemove?.(e)
    }
  }

  return (
    <Component
      {...rest}
      ref={ref}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? (disabled ? -1 : 0) : undefined}
      aria-pressed={isClickable ? selected : undefined}
      aria-disabled={disabled ? true : undefined}
      data-tone={tone}
      data-selected={selected ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      className={`${css.chip} ${css[tone]} ${selected ? css.selected : ''} ${isClickable ? css.clickable : ''} ${disabled ? css.disabled : ''} ${className ?? ''}`}
      onClick={disabled ? undefined : onClick}
      onKeyDown={handleKeyDown}
    >
      {asChild ? (
        children
      ) : (
        <>
          {icon && <span className={css.icon} aria-hidden="true">{icon}</span>}
          {children && <span className={css.label}>{children}</span>}
          {isRemovable && (
            <button
              type="button"
              className={css.removeButton}
              aria-label={removeAriaLabel}
              disabled={disabled}
              onClick={handleRemove}
            >
              <Icon name="close" />
            </button>
          )}
        </>
      )}
    </Component>
  )
})
