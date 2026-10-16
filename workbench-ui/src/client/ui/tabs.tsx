/**
 * Tabs：自有实现。roving tabindex，方向键/Home/End 移动；manual 激活（默认）
 * 用 Enter/Space 选中；automatic 随焦点激活。tab 与 tabpanel 的 id 关联。
 */
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import css from './tabs.module.css'

export interface TabItem {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
  readonly panel: ReactNode
}

export interface TabsProps {
  readonly label: string
  readonly value: string
  readonly onValueChange: (value: string) => void
  readonly items: readonly TabItem[]
  readonly orientation?: 'horizontal' | 'vertical'
  readonly activation?: 'automatic' | 'manual'
  readonly className?: string
}

export function Tabs({ label, value, onValueChange, items, orientation = 'horizontal', activation = 'manual', className }: TabsProps) {
  const uid = useId()
  const listRef = useRef<HTMLDivElement | null>(null)
  const activeValue = items.some(i => i.value === value) ? value : items.find(i => !i.disabled)?.value ?? value
  const tabId = (v: string) => `${uid}-tab-${v}`
  const panelId = (v: string) => `${uid}-panel-${v}`

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const horizontal = orientation === 'horizontal'
    const prevKey = horizontal ? 'ArrowLeft' : 'ArrowUp'
    const nextKey = horizontal ? 'ArrowRight' : 'ArrowDown'
    if (![prevKey, nextKey, 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const enabled = items.filter(i => !i.disabled)
    if (enabled.length === 0) return
    const focusIndex = enabled.findIndex(i => i.value === (document.activeElement?.getAttribute('data-tab-value') ?? activeValue))
    let next = focusIndex < 0 ? 0 : focusIndex
    if (e.key === nextKey) next = (focusIndex + 1) % enabled.length
    else if (e.key === prevKey) next = (focusIndex - 1 + enabled.length) % enabled.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = enabled.length - 1
    const target = enabled[next]
    if (!target) return
    listRef.current?.querySelector<HTMLElement>(`[data-tab-value="${CSS.escape(target.value)}"]`)?.focus()
    if (activation === 'automatic') onValueChange(target.value)
  }

  return (
    <div className={`${css.tabs} ${orientation === 'vertical' ? css.vertical : ''} ${className ?? ''}`}>
      <div role="tablist" aria-label={label} aria-orientation={orientation} className={css.list} ref={listRef} onKeyDown={onKeyDown}>
        {items.map(item => (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={tabId(item.value)}
            aria-selected={item.value === activeValue}
            aria-controls={panelId(item.value)}
            aria-disabled={item.disabled ? true : undefined}
            data-tab-value={item.value}
            tabIndex={item.value === activeValue ? 0 : -1}
            disabled={item.disabled}
            className={css.tab}
            onClick={() => { if (!item.disabled) onValueChange(item.value) }}
            onKeyDown={e => {
              if (activation === 'manual' && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                if (!item.disabled) onValueChange(item.value)
              }
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {items.map(item => (
        <div
          key={item.value}
          role="tabpanel"
          id={panelId(item.value)}
          aria-labelledby={tabId(item.value)}
          hidden={item.value !== activeValue}
          className={css.panel}
        >
          {item.value === activeValue ? item.panel : null}
        </div>
      ))}
    </div>
  )
}
