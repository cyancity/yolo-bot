import * as TabsPrimitive from '@radix-ui/react-tabs'
import type { ReactNode } from 'react'
import css from './tabs.module.css'

export interface TabItem { readonly value: string; readonly label: string; readonly disabled?: boolean; readonly panel: ReactNode }
export interface TabsProps {
  readonly label: string; readonly value: string; readonly onValueChange: (value: string) => void; readonly items: readonly TabItem[]
  readonly orientation?: 'horizontal' | 'vertical'; readonly activation?: 'automatic' | 'manual'; readonly className?: string
}
export function Tabs({ label, value, onValueChange, items, orientation = 'horizontal', activation = 'manual', className }: TabsProps) {
  const activeValue = items.some(item => item.value === value) ? value : items.find(item => !item.disabled)?.value ?? value
  return <TabsPrimitive.Root value={activeValue} onValueChange={onValueChange} orientation={orientation} activationMode={activation} className={`${css.tabs} ${orientation === 'vertical' ? css.vertical : ''} ${className ?? ''}`}>
    <TabsPrimitive.List aria-label={label} className={css.list}>
      {items.map(item => <TabsPrimitive.Trigger key={item.value} value={item.value} disabled={item.disabled} className={css.tab}>{item.label}</TabsPrimitive.Trigger>)}
    </TabsPrimitive.List>
    {items.map(item => <TabsPrimitive.Content key={item.value} value={item.value} className={css.panel}>{item.panel}</TabsPrimitive.Content>)}
  </TabsPrimitive.Root>
}
