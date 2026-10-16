/**
 * Toast：role=status 短通知；hover/focus 暂停计时；至多一个弱文字操作；
 * portal 到当前根 overlayRoot。紧急错误不用它（用可见 alert）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useOverlayTarget } from './root.tsx'
import { Button } from './button.tsx'
import { IconButton } from './icon-button.tsx'
import { Icon } from './icons.tsx'
import { WF } from '../workforce-strings.ts'
import css from './toast.module.css'
import type { Tone } from './badge.tsx'

export interface ToastAction {
  readonly id: string
  readonly label: string
  readonly onInvoke: () => void
}

export interface ToastProps {
  readonly id: string
  readonly message: string
  readonly tone?: Tone
  readonly open: boolean
  readonly onDismiss: () => void
  readonly durationMs?: number
  readonly action?: ToastAction
}

export function Toast({ message, tone = 'neutral', open, onDismiss, durationMs = 5000, action }: ToastProps) {
  const overlay = useOverlayTarget()
  const [paused, setPaused] = useState(false)
  const remaining = useRef(durationMs)
  const started = useRef(0)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    started.current = Date.now()
    if (paused) return
    timer.current = window.setTimeout(onDismiss, remaining.current)
    return () => {
      window.clearTimeout(timer.current)
      remaining.current = Math.max(0, remaining.current - (Date.now() - started.current))
    }
  }, [open, paused, onDismiss, durationMs])

  if (!open) return null
  return createPortal(
    <div
      className={`${css.toast} ${css[tone] ?? ''}`}
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => { started.current = Date.now(); setPaused(false) }}
      onFocus={() => setPaused(true)}
      onBlur={() => { started.current = Date.now(); setPaused(false) }}
    >
      <span className={css.message}>{message}</span>
      {action && (
        <Button variant="ghost" size="sm" onClick={() => { action.onInvoke(); onDismiss() }}>
          {action.label}
        </Button>
      )}
      <IconButton label={WF.common.close} icon={<Icon name="close" />} size="sm" onClick={onDismiss} />
    </div>,
    overlay ?? document.body,
  )
}

/** 多条 Toast 的堆叠容器，渲染在根底部。 */
export function ToastRegion({ children }: { children?: ReactNode }) {
  return <div className={css.region} aria-label={WF.common.notifications}>{children}</div>
}
