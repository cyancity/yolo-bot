import { Tabs as AntTabs } from 'antd'
import type { ReactNode } from 'react'
export interface TabItem { readonly value: string; readonly label: string; readonly disabled?: boolean; readonly panel: ReactNode }
export interface TabsProps { readonly label: string; readonly value: string; readonly onValueChange: (value: string) => void; readonly items: readonly TabItem[]; readonly orientation?: 'horizontal' | 'vertical'; readonly activation?: 'automatic' | 'manual'; readonly className?: string }
export function Tabs({ label, value, onValueChange, items, orientation = 'horizontal', className }: TabsProps) {
  const activeKey = items.some(item => item.value === value) ? value : items.find(item => !item.disabled)?.value ?? value
  return <AntTabs aria-label={label} activeKey={activeKey} onChange={onValueChange} tabPosition={orientation === 'vertical' ? 'left' : 'top'} className={className ?? ''} items={items.map(item => ({ key: item.value, label: item.label, disabled: item.disabled ?? false, children: item.panel }))} />
}
