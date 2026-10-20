import { List } from '@lobehub/ui'
import { forwardRef, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Slot } from './slot.tsx'
export type ListRowSize = 'sm' | 'md' | 'lg'
export interface ListRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> { readonly leading?: ReactNode; readonly title: ReactNode; readonly description?: ReactNode; readonly meta?: ReactNode; readonly trailing?: ReactNode; readonly selected?: boolean; readonly disabled?: boolean; readonly size?: ListRowSize; readonly onClick?: (event: MouseEvent<HTMLElement>) => void; readonly onContextMenu?: (event: MouseEvent<HTMLElement>) => void; readonly asChild?: boolean; readonly children?: ReactNode }
export const ListRow = forwardRef<HTMLDivElement, ListRowProps>(function ListRow({ leading, title, description, meta, trailing, selected = false, disabled = false, size = 'md', onClick, onContextMenu, asChild = false, className, children, ...rest }, ref) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => { if (!disabled && onClick && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onClick(event as unknown as MouseEvent<HTMLDivElement>) } }
  const shared = { ...rest, ref, className: className ?? '', 'aria-selected': selected, 'aria-disabled': disabled, 'data-size': size, ...(onClick ? { role: 'button', tabIndex: disabled ? -1 : 0 } : {}), onKeyDown: handleKeyDown, ...(onContextMenu ? { onContextMenu } : {}) }
  if (asChild) return <Slot {...shared}>{children}</Slot>
  return <List.Item {...shared} title={<>{title}{meta}</>} avatar={leading} description={<>{description}{children}</>} actions={trailing} active={selected} padding={size === 'sm' ? 4 : size === 'lg' ? 12 : 8} {...(!disabled && onClick ? { onClick: onClick as () => void } : {})} />
})
