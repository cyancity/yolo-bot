import { useEffect, useId, useState } from 'react'
import { API_PREFIX } from './transport.ts'
import { useWorkforceFileSession } from './workforce-attachments.tsx'
import { Button, Dialog, Select, Switch } from './ui/index.tsx'
import css from './workforce-memory.module.css'

export interface DiagnosticTaskChoice { readonly id: string; readonly title: string }

async function diagnosticRequest(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${API_PREFIX}/workforce${path}`, { signal, cache: 'no-store' })
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object' || !('ok' in body) || body.ok !== true || !('data' in body) || !response.ok) {
    const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined
    throw new Error(error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '诊断读取失败，请重试')
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
      if (!value || typeof value !== 'object' || !('tasks' in value) || !Array.isArray(value.tasks)) throw new Error('任务列表格式无效')
      const next: DiagnosticTaskChoice[] = []
      for (const task of value.tasks as unknown[]) {
        if (task && typeof task === 'object' && 'id' in task && typeof task.id === 'string' && 'title' in task && typeof task.title === 'string') next.push({ id: task.id, title: task.title })
      }
      install(next); setTaskError(undefined)
    }).catch(failure => { if (!controller.signal.aborted) { setTaskError(failure instanceof Error ? failure.message : '任务列表读取失败'); setTasksSettled(true) } })
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
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '诊断读取失败，请重试')
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
    } catch { setError('文件下载未完成，请重试') }
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
        const message = body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' && 'message' in body.error && typeof body.error.message === 'string' ? body.error.message : '保存到本机失败，请重试'
        throw new Error(message)
      }
      setSavedPath(path)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '保存到本机失败，请重试') }
    finally { setSaving(false) }
  }
  const revealSaved = async () => {
    if (!fileSession || !savedPath || revealing) return
    setRevealing(true); setError(undefined)
    try { const result = await fileSession.openWorkspacePath({ path: savedPath, action: 'reveal' }); if (!result.ok) throw new Error('无法在资源管理器中显示，请手动打开路径') }
    catch (failure) { setError(failure instanceof Error ? failure.message : '无法在资源管理器中显示，请手动打开路径') }
    finally { setRevealing(false) }
  }
  return <Dialog title="导出诊断" closeLabel="关闭诊断" onClose={onClose}>
    <section className={css.editor} aria-label="诊断导出设置">
      <p className={css.hint}>诊断文件不会自动上传。默认不包含对话、记忆或材料正文；附加的对话取所选任务最近 50 条消息，含工具名与状态、不含工具参数；常见密钥形态已遮蔽，但不能保证识别全部秘密，请在分享前检查预览。</p>
      {/* 没有任务时不放一个点不动的开关，只说明原因 */}
      {tasks.length > 0 && <Switch label="附上某个任务的对话" checked={includeConversation} onChange={setIncludeConversation} />}
      {includeConversation && <div className={css.form}>
        <label htmlFor={selectId}>选择任务（附最近 50 条消息）</label>
        <Select id={selectId} value={taskId} onChange={event => setTaskId(event.target.value)}>
          {tasks.map(task => <option key={task.id} value={task.id}>{task.title || task.id}</option>)}
        </Select>
      </div>}
      {taskError && <p className={css.hint}>任务列表未能读取：{taskError}。仍可导出不含对话的诊断。</p>}
      {!taskError && !tasksSettled && <p role="status" className={css.hint}>正在读取任务列表…</p>}
      {!taskError && tasksSettled && tasks.length === 0 && <p className={css.hint}>还没有任务，所以暂时不能附上任务对话；默认诊断照常可以保存。</p>}
      {loading && <p role="status" className={css.hint}>正在生成诊断…</p>}
      {error && <p role="alert" className={css.error}>{error}</p>}
      {partial && <p role="status" className={css.hint}>部分信息未能读取，已在预览的 errors 中说明；仍可下载。</p>}
      <div className={css.form}>
        <label htmlFor={previewId}>JSON 预览</label>
        <textarea id={previewId} aria-busy={loading} readOnly rows={12} value={preview} style={{ fontFamily: 'monospace', fontSize: 'var(--wb-font-xs)', maxHeight: '40vh', resize: 'vertical' }} />
      </div>
      {savedPath && <div className={css.form}>
        <label>已保存到本机<textarea readOnly rows={2} value={savedPath} style={{ fontFamily: 'monospace', fontSize: 'var(--wb-font-xs)' }} /></label>
      </div>}
      <div className={css.actions}>
        {fileSession ? (
          <>
            <Button disabled={!ready || saving} onClick={() => void saveLocal()}>{saving ? '正在保存…' : '保存到本机'}</Button>
            {savedPath && <Button disabled={revealing} onClick={() => void revealSaved()}>{revealing ? '正在打开…' : '在资源管理器中显示'}</Button>}
          </>
        ) : (
          <Button disabled={!ready} onClick={download}>下载诊断文件</Button>
        )}
        <Button disabled={loading || saving} onClick={() => setRefresh(value => value + 1)}>重新生成</Button>
        <Button onClick={onClose}>取消</Button>
      </div>
    </section>
  </Dialog>
}
