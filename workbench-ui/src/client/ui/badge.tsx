import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { Slot } from '@radix-ui/react-slot'
import css from './badge.module.css'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'unread'
export type BadgeVariant = 'standard' | 'pill' | 'dot'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: Tone
  readonly variant?: BadgeVariant
  /** 未读/状态小圆点模式（等价于 variant="dot"） */
  readonly dot?: boolean
  /** 数字角标计数（未提供 children 时，自动格式化为 >99 时展示 '99+'） */
  readonly count?: number
  /** 计数/短值的可访问完整名称（如「3 条未读」）。 */
  readonly label?: string
  readonly asChild?: boolean
  readonly children?: ReactNode
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = 'neutral', variant = 'standard', dot = false, count, label, children, className, asChild = false, ...rest },
  ref,
) {
  const Component = asChild ? Slot : 'span'
  const isDot = dot || variant === 'dot'
  const effectiveVariant = isDot ? 'dot' : variant
  const content = isDot ? null : children !== undefined ? children : count !== undefined ? (count > 99 ? '99+' : count) : null

  return (
    <Component
      {...rest}
      ref={ref}
      className={`${css.badge} ${css[tone] ?? ''} ${effectiveVariant === 'standard' ? '' : css[effectiveVariant]} ${className ?? ''}`}
      aria-label={label}
    >
      {content}
    </Component>
  )
})
