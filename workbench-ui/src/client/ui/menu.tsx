import { Dropdown, type MenuProps as AntMenuProps } from 'antd'
import { cloneElement, type ReactElement } from 'react'
import { useOverlayTarget } from './root.tsx'
import { Icon } from './icons.tsx'
export interface MenuItem { readonly id: string; readonly label: string; readonly disabled?: boolean; readonly checked?: boolean; readonly tone?: 'neutral' | 'danger'; readonly onSelect: () => void }
export interface MenuSection { readonly id: string; readonly label?: string; readonly items: readonly MenuItem[] }
export interface MenuProps { readonly label: string; readonly trigger: ReactElement; readonly open?: boolean; readonly onOpenChange?: (open: boolean) => void; readonly items?: readonly MenuItem[]; readonly sections?: readonly MenuSection[]; readonly align?: 'start' | 'center' | 'end'; readonly side?: 'top' | 'right' | 'bottom' | 'left' }
export function Menu({ label, trigger, open, onOpenChange, items, sections, align = 'end', side = 'bottom' }: MenuProps) {
  const overlay = useOverlayTarget()
  const mapItem = (item: MenuItem) => ({ key: item.id, label: item.label, disabled: item.disabled ?? false, danger: item.tone === 'danger', icon: item.checked ? <Icon name="check" /> : undefined, onClick: () => { if (!item.disabled) item.onSelect() } })
  const entries: AntMenuProps['items'] = (sections ?? [{ id: 'default', items: items ?? [] }]).flatMap((section, index) => [
    ...(index ? [{ type: 'divider' as const }] : []),
    ...(section.label ? [{ key: section.id, type: 'group' as const, label: section.label, children: section.items.map(mapItem) }] : section.items.map(mapItem)),
  ])
  const placement = side === 'top' ? align === 'start' ? 'topLeft' : 'topRight' : side === 'bottom' ? align === 'start' ? 'bottomLeft' : 'bottomRight' : side === 'right' ? 'bottomLeft' : 'bottomRight'
  return <Dropdown menu={{ items: entries, 'aria-label': label }} trigger={['click']} placement={placement} {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})} getPopupContainer={element => element.closest('dialog') ?? overlay ?? document.body}>{cloneElement(trigger, { 'aria-label': (trigger.props as { 'aria-label'?: string })['aria-label'] ?? label } as Record<string, unknown>)}</Dropdown>
}
