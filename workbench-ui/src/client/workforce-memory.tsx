import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Tooltip } from './ui/index.tsx'
import { Dialog } from './ui/index.tsx'
import { WorkbenchApiError } from './transport.ts'
import { WorkforceApi, type WorkforceMemories, type WorkforceMemory, type WorkforceMemoryScope } from './workforce-api.ts'
import type { Employee, WorkforceMessage } from './workforce-types.ts'
import css from './workforce-memory.module.css'
import { WF } from './workforce-strings.ts'

const getScopeLabels = (): Record<WorkforceMemoryScope, string> => ({ global: WF.memory.scopeGlobal, channel: WF.memory.scopeChannel, employee: WF.memory.scopeEmployee })
export type MemorySourceNavigation = (threadId: string, messageId?: string) => void

export function WorkforceMemoryEditor({ scope, scopeId, employees = [], onOpenSource, api: suppliedApi }: {
  readonly scope: WorkforceMemoryScope
  readonly scopeId?: string | undefined
  readonly employees?: readonly Employee[] | undefined
  readonly onOpenSource?: MemorySourceNavigation | undefined
  readonly api?: WorkforceApi | undefined
}) {
  const api = useMemo(() => suppliedApi ?? new WorkforceApi(), [suppliedApi])
  const inputId = useId()
  const mounted = useRef(true)
  const request = useRef(0)
  const [data, setData] = useState<WorkforceMemories>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [editing, setEditing] = useState<WorkforceMemory>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<WorkforceMemory>()
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(timer)
  }, [notice])
  const reload = useCallback(async () => {
    const seq = ++request.current
    setLoading(true)
    try {
      const next = await api.memories(scope, scopeId)
      if (mounted.current && seq === request.current) { setData(next); setError(undefined) }
    } catch (failure) {
      if (mounted.current && seq === request.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally { if (mounted.current && seq === request.current) setLoading(false) }
  }, [api, scope, scopeId])
  useEffect(() => {
    mounted.current = true
    setData(undefined); setEditing(undefined); setDraft(''); setNotice('')
    void reload()
    return () => { mounted.current = false; request.current += 1 }
  }, [reload])
  const save = async () => {
    if (busy || draft.trim() === '') return
    setBusy(true); setError(undefined)
    try {
      if (editing) await api.updateMemory(editing.id, draft.trim())
      else await api.createMemory({ scope, scopeId, text: draft.trim() })
      if (!mounted.current) return
      setEditing(undefined); setDraft(''); setNotice(WF.memory.saveSuccess)
      await reload()
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const remove = async () => {
    if (!deleting || busy) return
    setBusy(true); setError(undefined)
    try {
      await api.deleteMemory(deleting.id)
      if (!mounted.current) return
      if (editing?.id === deleting.id) { setEditing(undefined); setDraft('') }
      setDeleting(undefined); setNotice(WF.memory.deleteSuccess); await reload()
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const usage = data?.usage[`${scope}:${scopeId ?? ''}`] ?? 0
  const scopeLabels = getScopeLabels()
  return <section className={css.editor} aria-label={WF.memory.editorAria(scopeLabels[scope])}>
    <p className={css.hint}>{WF.memory.hint}</p>
    {data && <div className={css.usage} role="status">{WF.memory.usage(usage, data.limits[scope])}</div>}
    {loading && !data && <div className={css.loading} role="status" aria-label={WF.memory.loading}><span /><span /><span /></div>}
    {error && !deleting && <div className={css.error} role="alert">{error}<button type="button" disabled={busy} onClick={() => void reload()}>{WF.memory.reload}</button></div>}
    {data && <>
      <ul className={css.list}>
        {data.memories.map(memory => <li key={memory.id} className={css.item}>
          <p className={css.text}>{memory.text}</p>
          <div className={css.meta}>{WF.memory.recordedBy(memory.source.by === 'user' ? WF.common.you : (employees.find(employee => employee.id === memory.source.by)?.name ?? WF.common.employee), new Date(memory.updatedAt).toLocaleString())}</div>
          <div className={css.actions}>
            {memory.source.threadId && onOpenSource && <button type="button" onClick={() => {
              try { onOpenSource(memory.source.threadId!, memory.source.messageId) }
              catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
            }}>{WF.memory.viewSource}</button>}
            <button type="button" disabled={busy} onClick={() => { setEditing(memory); setDraft(memory.text); setError(undefined); setNotice('') }}>{WF.common.edit}</button>
            <button type="button" disabled={busy} onClick={() => { setDeleting(memory); setError(undefined) }}>{WF.common.delete}</button>
          </div>
        </li>)}
      </ul>
      {data.memories.length === 0 && <p className={css.hint}>{WF.memory.emptyHint}</p>}
      <div className={css.form}>
        <label htmlFor={inputId}>{editing ? (scope === 'employee' ? WF.memory.instructionEdit : WF.memory.memoryEdit) : (scope === 'employee' ? WF.memory.instructionAdd : WF.memory.memoryAdd)}</label>
        <textarea id={inputId} rows={3} value={draft} disabled={busy} onChange={event => { setDraft(event.target.value); setNotice('') }} placeholder={scope === 'employee' ? WF.memory.instructionPlaceholder : WF.memory.memoryPlaceholder} />
        <div className={css.actions}>
          <button type="button" disabled={busy || loading || draft.trim() === ''} onClick={() => void save()}>{busy ? WF.models.saving : scope === 'employee' ? WF.memory.instructionSave : WF.memory.memorySave}</button>
          {editing && <button type="button" disabled={busy} onClick={() => { setEditing(undefined); setDraft('') }}>{WF.memory.cancelEdit}</button>}
        </div>
      </div>
    </>}
    {notice && <p className={css.hint} role="status">{notice}</p>}
    {deleting && <Dialog title={WF.memory.deleteMemoryTitle} closeLabel={WF.common.cancel} busy={busy} onClose={() => setDeleting(undefined)}>
      <div className={css.editor}><p>{WF.memory.deleteMemoryDesc}</p><p className={css.text}>{deleting.text}</p>
        {error && <p className={css.error} role="alert">{error}</p>}
        <div className={css.actions}><button type="button" autoFocus disabled={busy} onClick={() => setDeleting(undefined)}>{WF.common.cancel}</button><button type="button" disabled={busy} onClick={() => void remove()}>{busy ? WF.models.clearing : WF.memory.deleteConfirm}</button></div>
      </div>
    </Dialog>}
  </section>
}

export function WorkforceMemoryDialog({ title, scope, scopeId, employees, onOpenSource, onClose, drawer = false }: {
  readonly title: string
  readonly scope: WorkforceMemoryScope
  readonly scopeId?: string | undefined
  readonly employees: readonly Employee[]
  readonly onOpenSource?: MemorySourceNavigation | undefined
  readonly onClose: () => void
  readonly drawer?: boolean | undefined
}) {
  return <Dialog title={title} closeLabel={WF.memory.closeMemory} onClose={onClose}>
    <div className={drawer ? css.drawer : css.dialogContent}><WorkforceMemoryEditor key={`${scope}:${scopeId ?? ''}`} scope={scope} scopeId={scopeId} employees={employees} onOpenSource={onOpenSource} /></div>
  </Dialog>
}

export interface RememberedMemory {
  readonly id: string
  readonly scope: WorkforceMemoryScope
  readonly scopeId?: string
  readonly text: string
}
/** Only an actual successful tool result can produce a memory acknowledgement. */
export function readRememberedMemory(message: WorkforceMessage): RememberedMemory | undefined {
  if (message.tool?.name !== 'wb_remember' || message.tool.status !== 'done') return undefined
  try {
    const value: unknown = JSON.parse(message.text)
    if (!value || typeof value !== 'object' || !('remembered' in value) || value.remembered !== true || !('memory' in value)) return undefined
    const memory = value.memory
    if (!memory || typeof memory !== 'object' || !('id' in memory) || typeof memory.id !== 'string' || !('text' in memory) || typeof memory.text !== 'string' || !('scope' in memory) || !['global', 'channel', 'employee'].includes(String(memory.scope))) return undefined
    const scope = memory.scope
    if (scope !== 'global' && scope !== 'channel' && scope !== 'employee') return undefined
    return { id: memory.id, scope, text: memory.text, ...'scopeId' in memory && typeof memory.scopeId === 'string' ? { scopeId: memory.scopeId } : {} }
  } catch { return undefined }
}

export function RememberedMemoryCard({ memory }: { readonly memory: RememberedMemory }) {
  const [busy, setBusy] = useState(false), [undone, setUndone] = useState(false), [error, setError] = useState<string>()
  const undo = async () => {
    if (busy || undone) return
    setBusy(true); setError(undefined)
    try { await new WorkforceApi().deleteMemory(memory.id); setUndone(true) }
    catch (failure) {
      // 已在抽屉里删掉的记忆，撤销视为已完成。
      if (failure instanceof WorkbenchApiError && failure.code === 'not_found') setUndone(true)
      else setError(failure instanceof Error ? failure.message : String(failure))
    }
    finally { setBusy(false) }
  }
  return <div className={css.remembered} data-memory-id={memory.id}>
    <Tooltip content={memory.text} side="top"><span>{undone ? WF.memory.memoryUndone : WF.memory.memoryRecorded(getScopeLabels()[memory.scope])}</span></Tooltip>
    {!undone && <><span aria-hidden="true">·</span><button type="button" disabled={busy} onClick={() => void undo()}>{busy ? WF.memory.undoing : WF.memory.undo}</button></>}
    {error && <span className={css.error} role="alert">{error}</span>}
  </div>
}
