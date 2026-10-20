import { Badge as AntBadge } from 'antd'
import LobeTag from '@lobehub/ui/es/Tag'
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { Slot } from './slot.tsx'
import css from './badge.module.css'
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'unread'
export type BadgeVariant = 'standard' | 'pill' | 'dot'
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> { readonly tone?: Tone; readonly variant?: BadgeVariant; readonly dot?: boolean; readonly count?: number; readonly label?: string; readonly asChild?: boolean; readonly children?: ReactNode }
const colors = { neutral: undefined, accent: 'processing', success: 'success', warning: 'warning', danger: 'error', info: 'processing', unread: 'processing' } as const
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge({ tone = 'neutral', variant = 'standard', dot = false, count, label, children, className, asChild, ...props }, ref) {
  const isDot = dot || variant === 'dot'
  const content = children ?? (count !== undefined ? count > 99 ? '99+' : count : null)
  if (asChild) return <Slot {...props} ref={ref} className={className} aria-label={label}>{children}</Slot>
  return <span {...props} ref={ref} className={`${css.badge} ${className ?? ''}`} aria-label={label}>{isDot ? <AntBadge dot /> : count !== undefined && children === undefined ? <AntBadge count={count} overflowCount={99} /> : <LobeTag size="small" {...(colors[tone] ? { color: colors[tone] } : {})} style={{ margin: 0 }}>{content}</LobeTag>}</span>
})
