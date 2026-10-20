import { Empty } from 'antd'
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { Slot } from './slot.tsx'
export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> { readonly icon?: ReactNode; readonly title?: ReactNode; readonly description?: ReactNode; readonly action?: ReactNode; readonly compact?: boolean; readonly asChild?: boolean; readonly children?: ReactNode }
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState({ icon, title, description, action, compact = false, asChild = false, className, children, ...rest }, ref) {
  if (asChild) return <Slot {...rest} ref={ref} className={className}>{children}</Slot>
  return <div {...rest} ref={ref} className={className} data-compact={compact || undefined}><Empty image={icon ?? Empty.PRESENTED_IMAGE_SIMPLE} description={<>{title && <strong>{title}</strong>}{description && <div>{description}</div>}</>}>{action}{children}</Empty></div>
})
