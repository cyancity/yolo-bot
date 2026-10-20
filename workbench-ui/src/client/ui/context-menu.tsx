import { Dropdown, type MenuProps } from 'antd'
import type { ReactNode } from 'react'
import { useOverlayTarget } from './root.tsx'
export interface ContextMenuItem { readonly id: string; readonly label: string; readonly icon?: ReactNode; readonly danger?: boolean; readonly disabled?: boolean; readonly onClick?: () => void; readonly children?: readonly ContextMenuItem[] }
export interface ContextMenuSection { readonly id: string; readonly label?: string; readonly items: readonly ContextMenuItem[] }
export interface ContextMenuProps { readonly x: number; readonly y: number; readonly sections: readonly ContextMenuSection[]; readonly onClose: () => void; readonly open?: boolean }
export function ContextMenu({ x, y, sections, onClose, open = true }: ContextMenuProps) {
  const overlay = useOverlayTarget()
  const mapItem = (item: ContextMenuItem): NonNullable<MenuProps['items']>[number] => ({ key: item.id, label: item.label, ...(item.icon ? { icon: item.icon } : {}), danger: item.danger ?? false, disabled: item.disabled ?? false, ...(item.children?.length ? { children: item.children.map(mapItem) } : { onClick: () => { if (!item.disabled) { item.onClick?.(); onClose() } } }) })
  const items: MenuProps['items'] = sections.flatMap((section, index) => [ ...(index ? [{ type: 'divider' as const }] : []), ...(section.label ? [{ type: 'group' as const, key: section.id, label: section.label, children: section.items.map(mapItem) }] : section.items.map(mapItem)) ])
  return <Dropdown key={`${x}:${y}`} open={open} autoFocus menu={{ items }} trigger={['contextMenu']} onOpenChange={value => { if (!value) onClose() }} getPopupContainer={() => document.querySelector<HTMLDialogElement>('dialog[open]') ?? overlay ?? document.body}><span aria-hidden="true" style={{ position: 'fixed', left: x, top: y, width: 1, height: 1, pointerEvents: 'none' }} /></Dropdown>
}
