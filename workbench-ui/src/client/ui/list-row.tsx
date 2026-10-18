import { forwardRef, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Slot } from '@radix-ui/react-slot'
import css from './list-row.module.css'

export type ListRowSize = 'sm' | 'md' | 'lg'

export interface ListRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 前置槽位：头像、图标或复选框 */
  readonly leading?: ReactNode
  /** 主标题文本（超出自动省略） */
  readonly title: ReactNode
  /** 次要描述文本（超出自动省略） */
  readonly description?: ReactNode
  /** 右上/右侧元信息文本，如时间戳或状态角标 */
  readonly meta?: ReactNode
  /** 尾部操作区域：操作按钮、开关或箭头 */
  readonly trailing?: ReactNode
  /** 选中状态 */
  readonly selected?: boolean
  /** 禁用状态 */
  readonly disabled?: boolean
  /** 尺寸大小，默认 md */
  readonly size?: ListRowSize
  /** 点击回调（存在时以交互方式呈现手势与键盘焦点） */
  readonly onClick?: (e: MouseEvent<HTMLElement>) => void
  /** 右键回调 */
  readonly onContextMenu?: (e: MouseEvent<HTMLElement>) => void
  /** 自定义根元素渲染（Radix Slot） */
  readonly asChild?: boolean
  readonly children?: ReactNode
}

export const ListRow = forwardRef<HTMLDivElement, ListRowProps>(function ListRow(
  {
    leading,
    title,
    description,
    meta,
    trailing,
    selected = false,
    disabled = false,
    size = 'md',
    onClick,
    onContextMenu,
    asChild = false,
    className,
    children,
    ...rest
  },
  ref,
) {
  const Component = asChild ? Slot : 'div'
  const isInteractive = !disabled && Boolean(onClick)

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    if (onClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      onClick(e as unknown as MouseEvent<HTMLDivElement>)
    }
  }

  return (
    <Component
      {...rest}
      ref={ref}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? (disabled ? -1 : 0) : undefined}
      aria-selected={selected ? true : undefined}
      aria-disabled={disabled ? true : undefined}
      data-selected={selected ? '' : undefined}
      data-size={size}
      className={`${css.row} ${css[size]} ${isInteractive ? css.interactive : ''} ${selected ? css.selected : ''} ${disabled ? css.disabled : ''} ${className ?? ''}`}
      onClick={disabled ? undefined : onClick}
      onContextMenu={onContextMenu}
      onKeyDown={handleKeyDown}
    >
      {asChild ? (
        children
      ) : (
        <>
          {leading && <span className={css.leading}>{leading}</span>}
          <span className={css.main}>
            <span className={css.header}>
              <span className={css.title}>{title}</span>
              {meta && <span className={css.meta}>{meta}</span>}
            </span>
            {description && <span className={css.description}>{description}</span>}
            {children}
          </span>
          {trailing && <span className={css.trailing}>{trailing}</span>}
        </>
      )}
    </Component>
  )
})
