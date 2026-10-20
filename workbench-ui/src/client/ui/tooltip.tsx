import { Popover, Tooltip as AntTooltip } from 'antd'
import type { ReactElement } from 'react'
import { useOverlayTarget } from './root.tsx'
export interface TooltipProps {
  readonly content: string; readonly children: ReactElement; readonly side?: 'top' | 'right' | 'bottom' | 'left'
  readonly align?: 'start' | 'center' | 'end'; readonly delayMs?: number; readonly maxWidth?: number; readonly openOnClick?: boolean
}
export function Tooltip({ content, children, side = 'top', align = 'center', delayMs = 400, maxWidth, openOnClick = false }: TooltipProps) {
  const overlay = useOverlayTarget()
  const placement = align === 'center' ? side : `${side}${side === 'top' || side === 'bottom' ? align === 'start' ? 'Left' : 'Right' : align === 'start' ? 'Top' : 'Bottom'}`
  const container = (trigger: HTMLElement) => trigger.closest('dialog') ?? overlay ?? document.body
  const styles = maxWidth === undefined ? undefined : { body: { maxWidth } }
  return openOnClick ? <Popover content={content} trigger="click" placement={placement as 'top'} getPopupContainer={container} {...(styles ? { styles } : {})}>{children}</Popover> : <AntTooltip title={content} mouseEnterDelay={delayMs / 1000} placement={placement as 'top'} getPopupContainer={container} {...(styles ? { styles } : {})}>{children}</AntTooltip>
}
