import { useEffect, useId, useRef, type FormEvent, type ReactNode, type RefObject } from 'react'
import { Button } from './button.tsx'
import { IconButton } from './icon-button.tsx'
import { Icon } from './icons.tsx'
import { WF } from '../workforce-strings.ts'
import css from './dialog.module.css'

export interface DialogAction {
  readonly id?: string
  readonly label: string
  readonly onInvoke?: () => void
  readonly disabled?: boolean
  readonly loading?: boolean
  readonly tone?: 'neutral' | 'danger'
  readonly type?: 'button' | 'submit'
}
export type DialogSize = 'sm' | 'md' | 'lg' | 'wide' | 'fullScreen'
export interface DialogProps {
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly onClose?: () => void
  readonly closeLabel?: string
  readonly title: string
  readonly description?: string
  readonly children?: ReactNode
  readonly primaryAction?: DialogAction
  readonly secondaryAction?: DialogAction
  readonly footer?: ReactNode
  readonly onSubmit?: (event: FormEvent) => void
  readonly busy?: boolean
  readonly initialFocusRef?: RefObject<HTMLElement | null>
  readonly returnFocusRef?: RefObject<HTMLElement | null>
  readonly wide?: boolean
  readonly size?: DialogSize
  readonly fullScreen?: boolean
  readonly className?: string
}

/** Native top layer keeps dialogs above every host or plugin stacking context. */
export function Dialog({ open, onOpenChange, onClose, closeLabel, title, description, children, primaryAction, secondaryAction, footer, onSubmit, busy, initialFocusRef, returnFocusRef, wide, size, fullScreen, className }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descId = useId()
  const isOpen = open ?? true
  const isFullScreen = fullScreen || size === 'fullScreen'
  const closeRef = useRef(() => {})
  closeRef.current = () => { if (!busy) { onOpenChange?.(false); onClose?.() } }
  useEffect(() => {
    const element = dialogRef.current
    if (!element) return
    restoreRef.current = returnFocusRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    const suspended = isFullScreen ? Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).filter(item => item !== element) : []
    for (const item of suspended) item.close()
    return () => {
      element.close()
      for (const item of suspended) if (item.isConnected && !item.open) item.showModal()
      restoreRef.current?.focus()
    }
  }, [])
  useEffect(() => {
    const element = dialogRef.current
    if (!element) return
    if (isOpen && !element.open) {
      element.showModal()
      const initial = initialFocusRef?.current
      if (initial && element.contains(initial)) initial.focus()
      else element.querySelector<HTMLElement>('[data-dialog-close]')?.focus()
    } else if (!isOpen && element.open) element.close()
  }, [isOpen, initialFocusRef])
  const actions = primaryAction || secondaryAction || footer ? <div className={css.foot}>
    {secondaryAction && <Button variant="secondary" disabled={secondaryAction.disabled ?? busy ?? false} loading={secondaryAction.loading ?? false} type={secondaryAction.type ?? 'button'} onClick={secondaryAction.onInvoke}>{secondaryAction.label}</Button>}
    {primaryAction && <Button variant={primaryAction.tone === 'danger' ? 'danger' : 'primary'} disabled={primaryAction.disabled ?? false} loading={primaryAction.loading ?? false} type={primaryAction.type ?? (onSubmit ? 'submit' : 'button')} onClick={onSubmit && (!primaryAction.type || primaryAction.type === 'submit') ? undefined : primaryAction.onInvoke}>{primaryAction.label}</Button>}
    {footer}
  </div> : null
  return <dialog ref={dialogRef} className={[css.dialog, size === 'sm' && css.sm, (wide || size === 'lg' || size === 'wide') && css.wide, isFullScreen && css.fullScreen, className].filter(Boolean).join(' ')} aria-labelledby={titleId} aria-describedby={description ? descId : undefined} aria-busy={busy || undefined} onCancel={event => { event.preventDefault(); closeRef.current() }} onClick={event => { if (event.target === dialogRef.current) closeRef.current() }}>
    <div className={css.head}><h2 className={css.title} id={titleId}>{title}</h2><IconButton label={closeLabel ?? WF.common.close} icon={<Icon name="close" />} size="sm" data-dialog-close disabled={busy} onClick={() => closeRef.current()} /></div>
    {description && <p className={css.description} id={descId}>{description}</p>}
    {onSubmit ? <form className={css.form} onSubmit={onSubmit}><div className={css.body}>{children}</div>{actions}</form> : <><div className={css.body}>{children}</div>{actions}</>}
  </dialog>
}
