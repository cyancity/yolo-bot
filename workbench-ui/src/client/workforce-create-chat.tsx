import { Button, TextInput, Checkbox } from './ui/primitives.ts'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Employee } from './workforce-types.ts'
import dialogCss from './workforce-channels.module.css'
import css from './workforce-create-chat.module.css'
import { WF } from './workforce-strings.ts'

/** 发起群聊：可选群名 + 勾选员工（不选 = 全员）。单一主动作「完成」。 */
export function CreateChatModal({ employees, onClose, onSubmit }: {
  readonly employees: readonly Employee[]
  readonly onClose: () => void
  readonly onSubmit: (input: { title: string; memberIds: readonly string[] }) => void | Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  // Esc 关闭（autoFocus 输入内也生效）并在关闭后把焦点还给触发点。
  const previousFocus = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null)
  useEffect(() => () => previousFocus.current?.focus(), [])

  const toggle = (id: string) => {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try { await onSubmit({ title, memberIds: [...picked] }) }
    finally { setBusy(false) }
  }

  const modal = (
    <div className={dialogCss.dialogBackdrop} onClick={onClose}>
      <div className={dialogCss.dialogCard} role="dialog" aria-modal="true" aria-label={WF.common.createGroupChat}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); onClose() } }}>
        <h3 className={dialogCss.dialogTitle}>{WF.common.createGroupChat}</h3>
        <form className={dialogCss.dialogForm} onSubmit={e => void submit(e)}>
          <div className={dialogCss.formItem}>
            <label className={dialogCss.formLabel} htmlFor="new-chat-name">{WF.chatList.groupChatNameOptional}</label>
            <TextInput
              id="new-chat-name"
              type="text"
              className={dialogCss.inputField}
              value={title}
              placeholder={WF.chatList.chatNamePlaceholder}
              maxLength={30}
              autoFocus
              onChange={e => setTitle(e.target.value)}
            />
          </div>
          <div className={dialogCss.formItem}>
            <label className={dialogCss.formLabel}>{WF.chatList.selectMembersLabel}</label>
            <div className={css.memberList} role="group" aria-label={WF.chatList.selectMembersAria}>
              {employees.map(employee => (
                <label key={employee.id} className={css.memberRow}>
                  <Checkbox checked={picked.has(employee.id)} onCheckedChange={() => toggle(employee.id)} />
                  <span className={css.memberName}>{employee.name}{employee.isLeader && <span className={css.chatTag}>{WF.common.lead}</span>}</span>
                </label>
              ))}
              {employees.length === 0 && <span className={css.chatPreview}>{WF.chatList.noEmployeesHint}</span>}
            </div>
          </div>
          <div className={dialogCss.dialogFooter}>
            <Button variant="plain" type="button" className={dialogCss.cancelBtn} onClick={onClose}>{WF.common.cancel}</Button>
            <Button variant="plain" type="submit" className={dialogCss.submitBtn} disabled={busy}>{busy ? WF.chatList.creating : WF.chatList.finish}</Button>
          </div>
        </form>
      </div>
    </div>
  )
  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal
}
