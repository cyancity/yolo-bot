import { Tag } from 'antd'
import { forwardRef, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Slot } from './slot.tsx'
import { Icon } from './icons.tsx'
import { WF } from '../workforce-strings.ts'
import { definedProps } from './props.ts'
export type ChipTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
export interface ChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'onClick'> { readonly tone?: ChipTone; readonly selected?: boolean; readonly disabled?: boolean; readonly icon?: ReactNode; readonly removable?: boolean; readonly onRemove?: (event: MouseEvent<HTMLButtonElement>) => void; readonly removeAriaLabel?: string; readonly onClick?: (event: MouseEvent<HTMLSpanElement>) => void; readonly asChild?: boolean; readonly children?: ReactNode }
const colors = { neutral: undefined, accent: 'processing', success: 'success', warning: 'warning', danger: 'error', info: 'processing' } as const
export const Chip = forwardRef<HTMLSpanElement, ChipProps>(function Chip({ tone = 'neutral', selected = false, disabled = false, icon, removable, onRemove, removeAriaLabel = WF.ui.remove, onClick, asChild = false, className, children, ...rest }, ref) {
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => { if (!disabled && onClick && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onClick(event as unknown as MouseEvent<HTMLSpanElement>) } }
  const shared = { ...rest, ref, className: className ?? '', 'aria-disabled': disabled, 'aria-pressed': selected, ...(onClick ? { role: 'button', tabIndex: disabled ? -1 : 0 } : {}), ...(!disabled && onClick ? { onClick } : {}), onKeyDown }
  if (asChild) return <Slot {...shared}>{children}</Slot>
  const color = selected ? 'processing' : colors[tone]
  return <Tag {...definedProps(shared)} {...(color ? { color } : {})} {...(icon ? { icon } : {})} closable={!disabled && (removable ?? Boolean(onRemove))} closeIcon={<Icon name="close" width={12} height={12} aria-hidden={false} aria-label={removeAriaLabel} />} onClose={event => { event.preventDefault(); event.stopPropagation(); if (!disabled) onRemove?.(event as unknown as MouseEvent<HTMLButtonElement>) }}>{children}</Tag>
})
