import { useRef, useState } from 'react'
import { Alert, TextArea } from '@lobehub/ui'
import { API_PREFIX } from './transport.ts'
import { Button, Dialog } from './ui/index.tsx'
import { WF } from './workforce-strings.ts'
import { useWorkforceFileSession } from './workforce-attachments.tsx'
import css from './workforce-memory.module.css'

export function WorkforceBackupDialog({ onClose }: { readonly onClose: () => void }) {
  const pending = useRef(false)
  const nativePending = useRef(false)
  const fileSession = useWorkforceFileSession()
  const [revealing, setRevealing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [directory, setDirectory] = useState<string>()
  const [error, setError] = useState<string>()
  const create = async () => {
    if (pending.current) return
    pending.current = true
    setLoading(true); setError(undefined); setDirectory(undefined)
    try {
      const response = await fetch(`${API_PREFIX}/workforce/backup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', cache: 'no-store' })
      const body: unknown = await response.json()
      if (!response.ok || !body || typeof body !== 'object' || !('ok' in body) || body.ok !== true || !('data' in body)) {
        const failure = body && typeof body === 'object' && 'error' in body ? body.error : undefined
        throw new Error(failure && typeof failure === 'object' && 'message' in failure && typeof failure.message === 'string' ? failure.message : WF.backup.failure)
      }
      const data = body.data
      if (!data || typeof data !== 'object' || !('directory' in data) || typeof data.directory !== 'string') throw new Error(WF.backup.failure)
      setDirectory(data.directory)
    } catch (failure) { setError(failure instanceof Error ? failure.message : WF.backup.failure) }
    finally { pending.current = false; setLoading(false) }
  }
  const reveal = async () => {
    if (!fileSession || !directory || nativePending.current) return
    nativePending.current = true
    setRevealing(true); setError(undefined)
    try {
      const result = await fileSession.openWorkspacePath({ path: directory, action: 'reveal' })
      if (!result.ok) throw new Error(WF.backup.revealFailure)
    } catch (failure) { setError(failure instanceof Error ? failure.message : WF.backup.revealFailure) }
    finally { nativePending.current = false; setRevealing(false) }
  }
  return <Dialog title={WF.backup.title} closeLabel={WF.backup.close} onClose={onClose}>
    <section className={css.editor} aria-label={WF.backup.title}>
      <p className={css.hint}>{WF.backup.description}</p>
      <p className={css.hint}>{WF.backup.consistency}</p>
      {loading && <p role="status" className={css.hint}>{WF.backup.creating}</p>}
      {error && <Alert className={css.errorAlert ?? ''} type="error" showIcon message={error} />}
      {directory && <div role="status" className={css.form}>
        <strong>{WF.backup.created}</strong>
        <label>{WF.backup.path}<TextArea readOnly rows={3} value={directory} type="block" /></label>
      </div>}
      <p className={css.hint}>{WF.backup.recover}</p>
      <div className={css.actions}>
        {!directory && <Button disabled={loading} onClick={() => void create()}>{loading ? WF.backup.creating : WF.backup.create}</Button>}
        {directory && fileSession && <Button disabled={revealing} onClick={() => void reveal()}>{revealing ? WF.backup.revealing : WF.backup.reveal}</Button>}
        <Button onClick={onClose}>{WF.backup.done}</Button>
      </div>
    </section>
  </Dialog>
}
