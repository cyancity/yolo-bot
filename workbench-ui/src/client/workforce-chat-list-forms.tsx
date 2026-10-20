import { useRef, useState, type FormEvent } from 'react'
import type { Employee } from './workforce-types.ts'
import { Button, Dialog, TextInput } from './ui/index.tsx'
import { Checkbox } from 'antd'
import { WF } from './workforce-strings.ts'
import css from './workforce-chat-list.module.css'
import dialogCss from './workforce-channels.module.css'
/** 发起群聊：可选群名 + 勾选员工（不选 = 全员）。单一主动作「完成」。 */
export function CreateChatModal({ employees, onClose, onSubmit }: {
  readonly employees: readonly Employee[]
  readonly onClose: () => void
  readonly onSubmit: (input: { title: string; memberIds: readonly string[] }) => void | Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

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

  return (
    <Dialog title={WF.common.createGroupChat} closeLabel={WF.common.cancel} onClose={onClose} busy={busy} initialFocusRef={nameRef}>
      <form className={dialogCss.dialogForm} onSubmit={e => void submit(e)}>
          <div className={dialogCss.formItem}>
            <label className={dialogCss.formLabel} htmlFor="new-chat-name">{WF.chatList.groupChatNameOptional}</label>
            <TextInput
              id="new-chat-name"
              ref={nameRef}
              type="text"
              className={dialogCss.inputField}
              value={title}
              placeholder={WF.chatList.chatNamePlaceholder}
              maxLength={30}
              onChange={e => setTitle(e.target.value)}
            />
          </div>
          <div className={dialogCss.formItem}>
            <label className={dialogCss.formLabel}>{WF.chatList.selectMembersLabel}</label>
            <div className={css.memberList} role="group" aria-label={WF.chatList.selectMembersAria}>
              {employees.map(employee => (
                <label key={employee.id} className={css.memberRow}>
                  <Checkbox checked={picked.has(employee.id)} onChange={() => toggle(employee.id)} />
                  <span className={css.memberName}>{employee.name}{employee.isLeader && <span className={css.chatTag}>{WF.common.lead}</span>}</span>
                </label>
              ))}
              {employees.length === 0 && <span className={css.chatPreview}>{WF.chatList.noEmployeesHint}</span>}
            </div>
          </div>
          <div className={dialogCss.dialogFooter}>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{WF.common.cancel}</Button>
            <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? WF.chatList.creating : WF.chatList.finish}</Button>
          </div>
      </form>
    </Dialog>
  )
}

/** 群聊名称编辑：留空保存 = 清除覆盖，回退到成员名串显示。 */
export function ChatNameModal({ current, fallback, title = WF.chatList.groupChatName, inputLabel, hint = WF.chatList.chatNameHint, restoreFocus, onClose, onSubmit }: {
  readonly current: string
  readonly fallback: string
  readonly title?: string | undefined
  readonly inputLabel?: string | undefined
  readonly hint?: string | undefined
  /** 真实触发元素（右键捕获的会话行）；关闭时仍在 DOM 就恢复焦点给它。 */
  readonly restoreFocus?: HTMLElement | undefined
  readonly onClose: () => void
  readonly onSubmit: (value: string) => void | Promise<void>
}) {
  const [value, setValue] = useState(current)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(restoreFocus?.isConnected ? restoreFocus : null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try { await onSubmit(value.trim()) }
    finally { setBusy(false) }
  }
  return (
    <Dialog title={title} closeLabel={WF.common.cancel} onClose={onClose} busy={busy} initialFocusRef={inputRef} returnFocusRef={returnFocusRef}>
      <form className={dialogCss.dialogForm} onSubmit={e => void submit(e)}>
          <div className={dialogCss.formItem}>
            {inputLabel && <label className={dialogCss.formLabel}>{inputLabel}</label>}
            <TextInput
              type="text"
              ref={inputRef}
              className={dialogCss.inputField}
              value={value}
              placeholder={fallback}
              maxLength={30}
              onChange={e => setValue(e.target.value)}
            />
            {hint && <span className={css.chatHint}>{hint}</span>}
          </div>
          <div className={dialogCss.dialogFooter}>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{WF.common.cancel}</Button>
            <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? WF.models.saving : WF.common.save}</Button>
          </div>
      </form>
    </Dialog>
  )
}
