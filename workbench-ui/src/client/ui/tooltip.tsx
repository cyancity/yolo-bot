import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import type { ReactElement } from 'react'
import { useOverlayTarget } from './root.tsx'
import css from './tooltip.module.css'

export interface TooltipProps {
  readonly content: string; readonly children: ReactElement; readonly side?: 'top' | 'right' | 'bottom' | 'left'
  readonly align?: 'start' | 'center' | 'end'; readonly delayMs?: number; readonly maxWidth?: number; readonly openOnClick?: boolean
}
export function Tooltip({ content, children, side = 'top', align = 'center', delayMs = 400, maxWidth, openOnClick = false }: TooltipProps) {
  const overlay = useOverlayTarget()
  const contentProps = { className: css.tip, side, align, sideOffset: 6, style: maxWidth === undefined ? undefined : { maxWidth } }
  if (openOnClick) return <PopoverPrimitive.Root>
    <PopoverPrimitive.Trigger asChild>{children}</PopoverPrimitive.Trigger>
    <PopoverPrimitive.Portal container={overlay ?? undefined}><PopoverPrimitive.Content {...contentProps} onOpenAutoFocus={event => event.preventDefault()}>{content}</PopoverPrimitive.Content></PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>
  return <TooltipPrimitive.Provider delayDuration={delayMs}>
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal container={overlay ?? undefined}><TooltipPrimitive.Content {...contentProps}>{content}</TooltipPrimitive.Content></TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  </TooltipPrimitive.Provider>
}
