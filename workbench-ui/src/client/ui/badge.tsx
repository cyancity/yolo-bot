import type { HTMLAttributes, ReactNode } from 'react'
import css from './badge.module.css'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: Tone
  /** 计数/短值的可访问完整名称（如「3 条未读」）。 */
  readonly label?: string
  readonly children?: ReactNode
}

export const Badge = function Badge({ tone = 'neutral', label, children, className, ...rest }: BadgeProps) {
  return (
    <span {...rest} className={`${css.badge} ${css[tone]} ${className ?? ''}`} aria-label={label}>
      {children}
    </span>
  )
}
