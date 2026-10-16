import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Tooltip } from './ui/index.tsx'
import { Dialog } from './ui/index.tsx'
import { WorkbenchApiError } from './transport.ts'
import { WorkforceApi, type WorkforceMemories, type WorkforceMemory, type WorkforceMemoryScope } from './workforce-api.ts'
import type { Employee, WorkforceMessage } from './workforce-types.ts'
import css from './workforce-memory.module.css'

const SCOPE_LABELS: Record<WorkforceMemoryScope, string> = { global: '全局', channel: '频道', employee: '员工' }
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
      setEditing(undefined); setDraft(''); setNotice('已保存。新任务生效；私信在下一条消息生效。')
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
      setDeleting(undefined); setNotice('已删除记忆。'); await reload()
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const usage = data?.usage[`${scope}:${scopeId ?? ''}`] ?? 0
  return <section className={css.editor} aria-label={`${SCOPE_LABELS[scope]}记忆编辑器`}>
    <p className={css.hint}>记忆作为长期约束供员工参考。修改在新任务生效，私信在下一条消息生效；不会改变进行中的任务。</p>
    {data && <div className={css.usage} role="status">已用 {usage} / {data.limits[scope]} 字（不含空白）</div>}
    {loading && !data && <div className={css.loading} role="status" aria-label="正在加载记忆"><span /><span /><span /></div>}
    {error && !deleting && <div className={css.error} role="alert">{error}<button type="button" disabled={busy} onClick={() => void reload()}>重新加载</button></div>}
    {data && <>
      <ul className={css.list}>
        {data.memories.map(memory => <li key={memory.id} className={css.item}>
          <p className={css.text}>{memory.text}</p>
          <div className={css.meta}>由{memory.source.by === 'user' ? '你' : employees.find(employee => employee.id === memory.source.by)?.name ?? '员工'}记录 · {new Date(memory.updatedAt).toLocaleString('zh-CN')}</div>
          <div className={css.actions}>
            {memory.source.threadId && onOpenSource && <button type="button" onClick={() => {
              try { onOpenSource(memory.source.threadId!, memory.source.messageId) }
              catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
            }}>查看来源</button>}
            <button type="button" disabled={busy} onClick={() => { setEditing(memory); setDraft(memory.text); setError(undefined); setNotice('') }}>编辑</button>
            <button type="button" disabled={busy} onClick={() => { setDeleting(memory); setError(undefined) }}>删除</button>
          </div>
        </li>)}
      </ul>
      {data.memories.length === 0 && <p className={css.hint}>还没有记忆。添加明确的偏好、事实或对员工的交代。</p>}
      <div className={css.form}>
        <label htmlFor={inputId}>{editing ? (scope === 'employee' ? '编辑交代' : '编辑记忆') : (scope === 'employee' ? '添加交代' : '添加记忆')}</label>
        <textarea id={inputId} rows={3} value={draft} disabled={busy} onChange={event => { setDraft(event.target.value); setNotice('') }} placeholder={scope === 'employee' ? '例如：文案用短句，核对数据源，不加外部自选推断' : '例如：文案用短句，不用夸张承诺'} />
        <div className={css.actions}>
          <button type="button" disabled={busy || loading || draft.trim() === ''} onClick={() => void save()}>{busy ? '保存中…' : scope === 'employee' ? '保存交代' : '保存记忆'}</button>
          {editing && <button type="button" disabled={busy} onClick={() => { setEditing(undefined); setDraft('') }}>取消编辑</button>}
        </div>
      </div>
    </>}
    {notice && <p className={css.hint} role="status">{notice}</p>}
    {deleting && <Dialog title="删除记忆" closeLabel="取消" busy={busy} onClose={() => setDeleting(undefined)}>
      <div className={css.editor}><p>删除后，新任务不再使用这条记忆。</p><p className={css.text}>{deleting.text}</p>
        {error && <p className={css.error} role="alert">{error}</p>}
        <div className={css.actions}><button type="button" autoFocus disabled={busy} onClick={() => setDeleting(undefined)}>取消</button><button type="button" disabled={busy} onClick={() => void remove()}>{busy ? '删除中…' : '确认删除'}</button></div>
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
  return <Dialog title={title} closeLabel="关闭记忆" onClose={onClose}>
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
    <Tooltip content={memory.text} side="top"><span>{undone ? '已撤销记忆' : `已记入${SCOPE_LABELS[memory.scope]}记忆`}</span></Tooltip>
    {!undone && <><span aria-hidden="true">·</span><button type="button" disabled={busy} onClick={() => void undo()}>{busy ? '撤销中…' : '撤销'}</button></>}
    {error && <span className={css.error} role="alert">{error}</span>}
  </div>
}
