/**
 * WorkforceContextMenu：工作台右键上下文菜单与确认弹窗。
 * 基于 kit ContextMenu 与 Dialog 封装，提供分组、高亮、危险操作与二级菜单支持。
 */
import { ContextMenu, Dialog, type ContextMenuItem, type ContextMenuSection, type ContextMenuProps } from './ui/index.tsx'
import { useState } from 'react'
import { WF } from './workforce-strings.ts'

export type { ContextMenuItem, ContextMenuSection }
export type WorkforceContextMenuProps = ContextMenuProps
export const WorkforceContextMenu = ContextMenu

/** 危险操作二次确认弹窗：基于 kit Dialog 的薄封装 */
export interface ConfirmDialogProps {
  readonly title: string
  readonly message: string
  readonly confirmLabel?: string | undefined
  readonly cancelLabel?: string | undefined
  readonly danger?: boolean | undefined
  readonly error?: string | undefined
  readonly onConfirm: () => void | Promise<void>
  readonly onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = WF.common.confirm,
  cancelLabel = WF.common.cancel,
  danger = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)

  const handleConfirm = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      size="sm"
      title={title}
      closeLabel={cancelLabel}
      onClose={onCancel}
      busy={busy}
      secondaryAction={{
        label: cancelLabel,
        onInvoke: onCancel,
        disabled: busy,
      }}
      primaryAction={{
        label: confirmLabel,
        tone: danger ? 'danger' : 'neutral',
        disabled: busy,
        loading: busy,
        onInvoke: () => void handleConfirm(),
      }}
    >
      <div>{message}</div>
      {error && <div role="alert" style={{ color: 'var(--wb-danger)', marginTop: 'var(--wb-space-3)' }}>{error}</div>}
    </Dialog>
  )
}
