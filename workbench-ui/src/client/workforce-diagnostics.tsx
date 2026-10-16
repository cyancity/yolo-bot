import { useEffect, useId, useState } from 'react'
import { API_PREFIX } from './transport.ts'
import { useWorkforceFileSession } from './workforce-attachments.tsx'
import { Button, Dialog, Select, Switch } from './ui/index.tsx'
import { WF } from './workforce-strings.ts'
import css from './workforce-memory.module.css'

export interface DiagnosticTaskChoice { readonly id: string; readonly title: string }

async function diagnosticRequest(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${API_PREFIX}/workforce${path}`, { signal, cache: 'no-store' })
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object' || !('ok' in body) || body.ok !== true || !('data' in body) || !response.ok) {
    const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined
    throw new Error(error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : WF.diagnostics.readFailed)
  }
  return body.data
}

/** Standalone; the workspace owner wires this into the settings menu. */
export function WorkforceDiagnosticsDialog({ onClose, tasks: suppliedTasks }: {
  readonly onClose: () => void
  readonly tasks?: readonly DiagnosticTaskChoice[] | undefined
}) {
  const selectId = useId(), previewId = useId()
  const [tasks, setTasks] = useState<readonly DiagnosticTaskChoice[]>(suppliedTasks ?? [])
  const [taskError, setTaskError] = useState<string>()
  // 传入的列表为空（快照可能还没加载完）时自己拉一次任务列表；拉完之前不说“还没有任务”
  const [tasksSettled, setTasksSettled] = useState((suppliedTasks?.length ?? 0) > 0)
  const [includeConversation, setIncludeConversation] = useState(false)
  const [taskId, setTaskId] = useState(suppliedTasks?.[0]?.id ?? '')
  const [refresh, setRefresh] = useState(0)
  const [report, setReport] = useState<{ taskId: string; data: unknown }>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const fileSession = useWorkforceFileSession()
  const [savedPath, setSavedPath] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const requestedTask = includeConversation ? taskId : ''
  useEffect(() => {
    const controller = new AbortController()
    const install = (next: readonly DiagnosticTaskChoice[]) => {
      setTasks(next); setTaskId(previous => next.some(task => task.id === previous) ? previous : next[0]?.id ?? '')
      if (next.length === 0) setIncludeConversation(false)
      setTasksSettled(true)
    }
    if (suppliedTasks !== undefined && suppliedTasks.length > 0) { install(suppliedTasks); return () => controller.abort() }
    void diagnosticRequest('/tasks', controller.signal).then(value => {
      if (controller.signal.aborted) return
      if (!value || typeof value !== 'object' || !('tasks' in value) || !Array.isArray(value.tasks)) throw new Error(WF.diagnostics.tasksFormatInvalid)
      const next: DiagnosticTaskChoice[] = []
      for (const task of value.tasks as unknown[]) {
        if (task && typeof task === 'object' && 'id' in task && typeof task.id === 'string' && 'title' in task && typeof task.title === 'string') next.push({ id: task.id, title: task.title })
      }
      install(next); setTaskError(undefined)
    }).catch(failure => { if (!controller.signal.aborted) { setTaskError(failure instanceof Error ? failure.message : WF.diagnostics.tasksReadFailed); setTasksSettled(true) } })
    return () => controller.abort()
  }, [suppliedTasks, refresh])
  useEffect(() => {
    const controller = new AbortController()
    setReport(undefined); setError(undefined); setSavedPath(undefined)
    if (includeConversation && !requestedTask) { setLoading(false); return () => controller.abort() }
    setLoading(true)
    const query = requestedTask ? `?taskId=${encodeURIComponent(requestedTask)}` : ''
    void diagnosticRequest(`/diagnostics${query}`, controller.signal).then(data => {
      if (!controller.signal.aborted) setReport({ taskId: requestedTask, data })
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : WF.diagnostics.readFailed)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [requestedTask, includeConversation, refresh])
  const ready = !loading && report !== undefined && report.taskId === requestedTask && (!includeConversation || taskId !== '')
  const preview = ready ? JSON.stringify(report.data, null, 2) ?? '' : ''
  const partial = Boolean(ready && report.data && typeof report.data === 'object' && 'errors' in report.data && Array.isArray(report.data.errors) && report.data.errors.length > 0)
  const download = () => {
    if (!ready) return
    try {
      const url = URL.createObjectURL(new Blob([preview], { type: 'application/json;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url; link.download = `workbench-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      try { document.body.append(link); link.click() } finally { link.remove(); URL.revokeObjectURL(url) }
    } catch { setError(WF.diagnostics.downloadFailed) }
  }
  // 桌面版：写数据根 diagnostics/ 后可直接系统级定位；与预览同参数（同 taskId）保证内容一致。
  const saveLocal = async () => {
    if (!ready || saving) return
    setSaving(true); setError(undefined)
    try {
      const response = await fetch(`${API_PREFIX}/workforce/diagnostics/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestedTask ? { taskId: requestedTask } : {}), cache: 'no-store' })
      const body: unknown = await response.json()
      const path = body && typeof body === 'object' && 'data' in body && body.data && typeof body.data === 'object' && 'path' in body.data && typeof body.data.path === 'string' ? body.data.path : undefined
      if (!response.ok || !(body && typeof body === 'object' && 'ok' in body && body.ok === true) || !path) {
        const message = body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' && 'message' in body.error && typeof body.error.message === 'string' ? body.error.message : WF.diagnostics.saveFailed
        throw new Error(message)
      }
      setSavedPath(path)
    } catch (failure) { setError(failure instanceof Error ? failure.message : WF.diagnostics.saveFailed) }
    finally { setSaving(false) }
  }
  const revealSaved = async () => {
    if (!fileSession || !savedPath || revealing) return
    setRevealing(true); setError(undefined)
    try { const result = await fileSession.openWorkspacePath({ path: savedPath, action: 'reveal' }); if (!result.ok) throw new Error(WF.diagnostics.revealFailed) }
    catch (failure) { setError(failure instanceof Error ? failure.message : WF.diagnostics.revealFailed) }
    finally { setRevealing(false) }
  }
  return <Dialog title={WF.diagnostics.title} closeLabel={WF.diagnostics.close} onClose={onClose}>
    <section className={css.editor} aria-label={WF.diagnostics.editorAria}>
      <p className={css.hint}>{WF.diagnostics.hint}</p>
      {/* 没有任务时不放一个点不动的开关，只说明原因 */}
      {tasks.length > 0 && <Switch label={WF.diagnostics.includeTaskSwitch} checked={includeConversation} onChange={setIncludeConversation} />}
      {includeConversation && <div className={css.form}>
        <label htmlFor={selectId}>{WF.diagnostics.selectTaskLabel}</label>
        <Select id={selectId} value={taskId} onChange={event => setTaskId(event.target.value)}>
          {tasks.map(task => <option key={task.id} value={task.id}>{task.title || task.id}</option>)}
        </Select>
      </div>}
      {taskError && <p className={css.hint}>{WF.diagnostics.tasksReadFailedNotice(taskError)}</p>}
      {!taskError && !tasksSettled && <p role="status" className={css.hint}>{WF.diagnostics.readingTasksList}</p>}
      {!taskError && tasksSettled && tasks.length === 0 && <p className={css.hint}>{WF.diagnostics.noTasksToAttach}</p>}
      {loading && <p role="status" className={css.hint}>{WF.diagnostics.loading}</p>}
      {error && <p role="alert" className={css.error}>{error}</p>}
      {partial && <p role="status" className={css.hint}>{WF.diagnostics.partialErrorNotice}</p>}
      <div className={css.form}>
        <label htmlFor={previewId}>{WF.diagnostics.jsonPreview}</label>
        <textarea id={previewId} aria-busy={loading} readOnly rows={12} value={preview} style={{ fontFamily: 'monospace', fontSize: 'var(--wb-font-xs)', maxHeight: '40vh', resize: 'vertical' }} />
      </div>
      {savedPath && <div className={css.form}>
        <label>{WF.diagnostics.savedToLocalMachine}<textarea readOnly rows={2} value={savedPath} style={{ fontFamily: 'monospace', fontSize: 'var(--wb-font-xs)' }} /></label>
      </div>}
      <div className={css.actions}>
        {fileSession ? (
          <>
            <Button disabled={!ready || saving} onClick={() => void saveLocal()}>{saving ? WF.diagnostics.saving : WF.diagnostics.saveLocal}</Button>
            {savedPath && <Button disabled={revealing} onClick={() => void revealSaved()}>{revealing ? WF.diagnostics.revealing : WF.diagnostics.reveal}</Button>}
          </>
        ) : (
          <Button disabled={!ready} onClick={download}>{WF.diagnostics.download}</Button>
        )}
        <Button disabled={loading || saving} onClick={() => setRefresh(value => value + 1)}>{WF.message.regenerate}</Button>
        <Button onClick={onClose}>{WF.common.cancel}</Button>
      </div>
    </section>
  </Dialog>
}
