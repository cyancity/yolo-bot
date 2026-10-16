/**
 * Tooltip：自有实现。hover/focus 出现、Esc 隐藏、blur 结束；portal 到当前根
 * 的 overlayRoot（没有 overlay 根时落 body），不承载交互内容与必需信息。
 * openOnClick 用于信息图标：点击固定展开，再点或 Esc/外点关闭。
 */
import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useOverlayTarget } from './root.tsx'
import css from './tooltip.module.css'

export interface TooltipProps {
  readonly content: string
  readonly children: ReactElement
  readonly side?: 'top' | 'right' | 'bottom' | 'left'
  readonly align?: 'start' | 'center' | 'end'
  readonly delayMs?: number
  readonly maxWidth?: number
  /** 点击 anchor 切换展开（适合只读说明按钮）；默认仅 hover/focus。 */
  readonly openOnClick?: boolean
}

export function Tooltip({ content, children, side = 'top', align = 'center', delayMs = 400, maxWidth, openOnClick = false }: TooltipProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const delayRef = useRef<number | undefined>(undefined)
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const overlay = useOverlayTarget()

  const clearTimer = () => { if (delayRef.current !== undefined) { window.clearTimeout(delayRef.current); delayRef.current = undefined } }

  const measure = useCallback(() => {
    const el = wrapRef.current?.firstElementChild
    if (el instanceof HTMLElement) {
      const r = el.getBoundingClientRect()
      const gap = 6
      const cx = align === 'start' ? r.left : align === 'end' ? r.right : r.left + r.width / 2
      let left = cx
      let top = r.top - gap
      if (side === 'bottom') top = r.bottom + gap
      if (side === 'left') { left = r.left - gap; top = r.top }
      if (side === 'right') { left = r.right + gap; top = r.top }
      setPos({ left, top })
    }
  }, [align, side])

  const show = useCallback(() => {
    clearTimer()
    delayRef.current = window.setTimeout(() => { measure(); setOpen(true) }, delayMs)
  }, [delayMs, measure])

  const hide = useCallback(() => {
    clearTimer()
    if (!pinned) setOpen(false)
  }, [pinned])

  const togglePin = useCallback(() => {
    if (!openOnClick) return
    clearTimer()
    if (open && pinned) { setPinned(false); setOpen(false) }
    else { measure(); setPinned(true); setOpen(true) }
  }, [openOnClick, open, pinned, measure])

  useEffect(() => () => clearTimer(), [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPinned(false); setOpen(false) } }
    const onDown = (e: PointerEvent) => {
      if (pinned && wrapRef.current && !wrapRef.current.contains(e.target as Node) && !(e.target as Element).closest?.('[role="tooltip"]')) {
        setPinned(false); setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown) }
  }, [open, pinned])

  const describedId = open ? id : undefined
  const child = isValidElement(children)
    ? cloneElement(children, {
        'aria-describedby': [
          (children.props as Record<string, unknown>)['aria-describedby'],
          describedId,
        ].filter(Boolean).join(' ') || undefined,
      } as Record<string, unknown>)
    : children

  return (
    <>
      <span
        ref={wrapRef}
        className={css.anchor}
        onMouseEnter={pinned ? undefined : show}
        onMouseLeave={pinned ? undefined : hide}
        onFocus={pinned ? undefined : show}
        onBlur={pinned ? undefined : hide}
        onClick={openOnClick ? togglePin : undefined}
      >
        {child}
      </span>
      {open && createPortal(
        <span
          role="tooltip"
          id={id}
          className={css.tip}
          data-side={side}
          data-align={align}
          style={{ ...(pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }), ...(maxWidth !== undefined ? { maxWidth } : {}) }}
        >
          {content}
        </span>,
        overlay ?? document.body,
      )}
    </>
  )
}
