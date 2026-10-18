import { TextInput, Checkbox, Dialog } from './ui/index.tsx'
import { useState, type FormEvent } from 'react'
import type { Employee } from './workforce-types.ts'
import css from './workforce-create-chat.module.css'
import { WF } from './workforce-strings.ts'

/** 发起群聊：可选群名 + 勾选员工（不选 = 全员）。单一主动作「完成」。基于 kit Dialog。 */
export function CreateChatModal({ employees, onClose, onSubmit }: {
  readonly employees: readonly Employee[]
  readonly onClose: () => void
  readonly onSubmit: (input: { title: string; memberIds: readonly string[] }) => void | Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)

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
    <Dialog
      size="sm"
      title={WF.common.createGroupChat}
      closeLabel={WF.common.cancel}
      onClose={onClose}
      busy={busy}
      onSubmit={e => void submit(e)}
      secondaryAction={{
        label: WF.common.cancel,
        onInvoke: onClose,
        disabled: busy,
      }}
      primaryAction={{
        label: busy ? WF.chatList.creating : WF.chatList.finish,
        type: 'submit',
        disabled: busy,
        loading: busy,
      }}
    >
      <div className={css.formItem}>
        <label className={css.formLabel} htmlFor="new-chat-name">{WF.chatList.groupChatNameOptional}</label>
        <TextInput
          id="new-chat-name"
          type="text"
          value={title}
          placeholder={WF.chatList.chatNamePlaceholder}
          maxLength={30}
          autoFocus
          onChange={e => setTitle(e.target.value)}
        />
      </div>
      <div className={css.formItem}>
        <label className={css.formLabel}>{WF.chatList.selectMembersLabel}</label>
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
    </Dialog>
  )
}
