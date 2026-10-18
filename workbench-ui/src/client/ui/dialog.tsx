import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { useOverlayTarget } from './root.tsx'
import css from './dialog.module.css'
import { Button } from './button.tsx'
import { IconButton } from './icon-button.tsx'
import { Icon } from './icons.tsx'
import { WF } from '../workforce-strings.ts'

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
  /** 受控开关；缺省（含旧式挂载即开用法）视为 true。 */
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
  /** 旧式签名：关闭回调（与 onOpenChange(false) 等价）。 */
  readonly onClose?: () => void
  /** 关闭按钮的可访问名。 */
  readonly closeLabel?: string
  readonly title: string
  readonly description?: string
  readonly children?: ReactNode
  /** 唯一主动作；tone danger 时渲染实底删除类按钮。 */
  readonly primaryAction?: DialogAction
  /** 次要动作（如取消操作）。 */
  readonly secondaryAction?: DialogAction
  /** 自定义底部内容。 */
  readonly footer?: ReactNode
  /** 表单提交回调；传入时内部内容以 <form> 承载并支持回车提交。 */
  readonly onSubmit?: (event: React.FormEvent) => void
  /** 提交中防关闭。 */
  readonly busy?: boolean
  readonly initialFocusRef?: RefObject<HTMLElement | null>
  readonly returnFocusRef?: RefObject<HTMLElement | null>
  readonly wide?: boolean
  readonly size?: DialogSize
  /** 全屏覆盖宿主标题栏下方的可用区；挂载时收起其他 dialog，卸载时恢复。 */
  readonly fullScreen?: boolean
}

export function Dialog({
  open,
  onOpenChange,
  onClose,
  closeLabel,
  title,
  description,
  children,
  primaryAction,
  secondaryAction,
  footer,
  onSubmit,
  busy,
  initialFocusRef,
  returnFocusRef,
  wide,
  size,
  fullScreen,
}: DialogProps) {
  const overlay = useOverlayTarget()
  const restoreRef = useRef<HTMLElement | null>(null)
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const isFullScreen = fullScreen || size === 'fullScreen'
  const isWide = wide || size === 'wide' || size === 'lg'
  const isSm = size === 'sm'

  useEffect(() => {
    if (!isFullScreen || !(open ?? true)) return
    const suspended = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).filter(dialog => dialog !== dialogRef.current)
    for (const dialog of suspended) dialog.open = false
    return () => { for (const dialog of suspended) if (dialog.isConnected) dialog.open = true }
  }, [isFullScreen, open])
  const change = (next: boolean) => {
    if (!next && busy) return
    onOpenChange?.(next)
    if (!next) onClose?.()
  }

  const contentClasses = [
    css.dialog,
    isSm ? css.sm : '',
    isWide ? css.wide : '',
    isFullScreen ? css.fullScreen : '',
  ].filter(Boolean).join(' ')

  const actions = (primaryAction || secondaryAction || footer) ? (
    <div className={css.foot}>
      {secondaryAction && (
        <Button
          variant="secondary"
          disabled={secondaryAction.disabled ?? busy ?? false}
          loading={secondaryAction.loading ?? false}
          type={secondaryAction.type ?? 'button'}
          onClick={secondaryAction.onInvoke}
        >
          {secondaryAction.label}
        </Button>
      )}
      {primaryAction && (
        <Button
          variant={primaryAction.tone === 'danger' ? 'danger' : 'primary'}
          disabled={primaryAction.disabled ?? false}
          loading={primaryAction.loading ?? false}
          type={primaryAction.type ?? (onSubmit ? 'submit' : 'button')}
          onClick={onSubmit && (!primaryAction.type || primaryAction.type === 'submit') ? undefined : primaryAction.onInvoke}
        >
          {primaryAction.label}
        </Button>
      )}
      {footer}
    </div>
  ) : null

  return <DialogPrimitive.Root open={open ?? true} onOpenChange={change}>
    <DialogPrimitive.Portal container={overlay ?? undefined}>
      <DialogPrimitive.Overlay className={css.overlay} />
      <DialogPrimitive.Content asChild className={contentClasses} {...(!description ? { 'aria-describedby': undefined } : {})} aria-busy={busy ? true : undefined}
        onOpenAutoFocus={event => {
          restoreRef.current = returnFocusRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
          if (initialFocusRef?.current) { event.preventDefault(); initialFocusRef.current.focus() }
        }}
        onCloseAutoFocus={event => { event.preventDefault(); (returnFocusRef?.current ?? restoreRef.current)?.focus() }}
        onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
        onPointerDownOutside={event => { if (busy) event.preventDefault() }}
      ><dialog ref={dialogRef} open={open ?? true} onCancel={event => { event.preventDefault(); change(false) }}>
        <div className={css.head}>
          <DialogPrimitive.Title className={css.title}>{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close asChild><IconButton label={closeLabel ?? WF.common.close} icon={<Icon name="close" />} size="sm" data-dialog-close disabled={busy} /></DialogPrimitive.Close>
        </div>
        {description && <DialogPrimitive.Description className={css.description}>{description}</DialogPrimitive.Description>}
        {onSubmit ? (
          <form className={css.form} onSubmit={onSubmit}>
            <div className={css.body}>{children}</div>
            {actions}
          </form>
        ) : (
          <>
            <div className={css.body}>{children}</div>
            {actions}
          </>
        )}
      </dialog></DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>
}
