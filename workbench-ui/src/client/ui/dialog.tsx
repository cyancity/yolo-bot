/**
 * Dialog：原生 <dialog>.showModal()。top layer 由浏览器提供，焦点循环/Esc
 * 为原生语义；不扫描/关闭宿主 dialog、不写 body scroll-lock。
 * 同时支持受控（open + onOpenChange）与挂载即开（onClose/closeLabel）两种
 * 调用形态；footer 最多一个主动作（primaryAction），关闭为标题栏 IconButton。
 * fullScreen 实例挂载时暂时收起其他已开 dialog、卸载时恢复（不触发其 onClose）。
 */
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import css from './dialog.module.css'
import { Button } from './button.tsx'
import { IconButton } from './icon-button.tsx'
import { Icon } from './icons.tsx'
import { WF } from '../workforce-strings.ts'

export interface DialogAction {
  readonly id: string
  readonly label: string
  readonly onInvoke: () => void
  readonly disabled?: boolean
  readonly loading?: boolean
  readonly tone?: 'neutral' | 'danger'
}

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
  /** 提交中防关闭。 */
  readonly busy?: boolean
  readonly initialFocusRef?: RefObject<HTMLElement | null>
  readonly returnFocusRef?: RefObject<HTMLElement | null>
  readonly wide?: boolean
  /** 全屏覆盖宿主标题栏下方的可用区；挂载时收起其他 dialog，卸载时恢复。 */
  readonly fullScreen?: boolean
}

export function Dialog({ open, onOpenChange, onClose, closeLabel, title, description, children, primaryAction, busy, initialFocusRef, returnFocusRef, wide, fullScreen }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descId = useId()
  const isOpen = open ?? true
  const busyRef = useRef(busy)
  busyRef.current = busy
  const closeRef = useRef(() => {})
  closeRef.current = () => {
    onOpenChange?.(false)
    onClose?.()
  }

  // 生命周期：fullScreen 挂载时收起其他 dialog（不经 onClose），卸载时恢复。
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    restoreRef.current = returnFocusRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    const suspended = fullScreen
      ? Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).filter(item => item !== el)
      : []
    for (const item of suspended) item.close()
    return () => {
      el.close()
      for (const item of suspended) if (item.isConnected && !item.open) item.showModal()
      restoreRef.current?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 开合状态跟随 open 属性（挂载即开时缺省 true）。
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (isOpen && !el.open) {
      el.showModal()
      const initial = initialFocusRef?.current
      if (initial && el.contains(initial)) initial.focus()
      else el.querySelector<HTMLElement>('[data-dialog-close]')?.focus()
    } else if (!isOpen && el.open) {
      el.close()
    }
  }, [isOpen, initialFocusRef])

  const requestClose = () => {
    if (busyRef.current) return
    closeRef.current()
  }

  return (
    <dialog
      ref={dialogRef}
      className={`${css.dialog} ${wide ? css.wide : ''} ${fullScreen ? css.fullScreen : ''}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      aria-busy={busy ? true : undefined}
      onCancel={e => {
        // Esc/cancel：不走原生默认关闭，统一经 onClose（旧契约）。
        e.preventDefault()
        requestClose()
      }}
      onClick={e => {
        // 点遮罩（dialog 元素自身，非内容盒）关闭；busy 时阻止。
        if (e.target === dialogRef.current) requestClose()
      }}
    >
      <div className={css.head}>
        <h2 className={css.title} id={titleId}>{title}</h2>
        <IconButton
          label={closeLabel ?? WF.common.close}
          icon={<Icon name="close" />}
          size="sm"
          data-dialog-close
          disabled={busy}
          onClick={requestClose}
        />
      </div>
      {description && <p className={css.description} id={descId}>{description}</p>}
      <div className={css.body}>{children}</div>
      {primaryAction && (
        <div className={css.foot}>
          <Button
            variant={primaryAction.tone === 'danger' ? 'danger' : 'primary'}
            disabled={primaryAction.disabled ?? false}
            loading={primaryAction.loading ?? false}
            onClick={primaryAction.onInvoke}
          >
            {primaryAction.label}
          </Button>
        </div>
      )}
    </dialog>
  )
}
