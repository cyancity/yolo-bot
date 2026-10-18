/**
 * 工作流技能审核框（设置菜单「我的工作流技能」入口）。
 * 列表：标题/来源任务/状态/待审核数。审核：slug/标题/描述/正文可编辑保存，
 * findings block 红 warn 黄；退回必填意见；删除二次确认；安装勾选绑定员工
 * （默认不勾，有 block 禁用）；安装后显示位置与绑定员工。
 * 编辑按草稿 id 暂存，切换与刷新不清未保存输入；Esc/关闭前确认丢弃。
 */
import { Button, TextInput, Textarea, Checkbox } from './ui/primitives.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog } from './ui/index.tsx'
import { WorkforceApi } from './workforce-api.ts'
import type { Employee, Task, WorkforceSkillDraft, WorkforceUserSkill } from './workforce-types.ts'
import type { WorkforceSource } from './workforce-source.ts'
import { WorkforceModelsSource } from './workforce-models-source.ts'
import { WF } from './workforce-strings.ts'
import css from './workforce-skill-drafts.module.css'

const SD = WF.skillDrafts

const STATUS_LABEL: Record<WorkforceSkillDraft['status'] | 'disabled', string> = {
  requested: SD.statusRequested,
  drafted: SD.statusDrafted,
  returned: SD.statusReturned,
  installed: SD.statusInstalled,
  disabled: SD.statusDisabled,
}

interface DraftEdits {
  readonly slug: string
  readonly title: string
  readonly description: string
  readonly body: string
}

function editsOf(draft: WorkforceSkillDraft): DraftEdits {
  return { slug: draft.slug, title: draft.title, description: draft.description, body: draft.body }
}

function sameEdits(draft: WorkforceSkillDraft, edits: DraftEdits): boolean {
  return draft.slug === edits.slug && draft.title === edits.title
    && draft.description === edits.description && draft.body === edits.body
}

function employeeName(employees: readonly Employee[], id: string): string {
  return employees.find(employee => employee.id === id)?.name ?? id
}

/** 「沉淀为技能」任务页脚入口：可填一句说明；提交后提示去审核框看。 */
export function SkillDraftRequest({ task, source, onRequested }: {
  readonly task: Task
  readonly source: WorkforceSource
  readonly onRequested?: (() => void) | undefined
}) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string>()
  if (task.status === 'running') return null
  const submit = async (): Promise<void> => {
    setBusy(true); setError(undefined)
    try {
      await source.requestSkillDraft(task.id, note.trim() === '' ? undefined : note.trim())
      setDone(true); setOpen(false); onRequested?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }
  if (done) return <div className={css.requestedNote} role="status">{SD.taskRequested}</div>
  return (
    <div className={css.requestRow}>
      {!open ? (
        <Button variant="plain" type="button" className={css.requestButton} onClick={() => setOpen(true)}>{SD.taskRequest}</Button>
      ) : (
        <div className={css.requestForm}>
          <TextInput
            className={css.requestInput}
            value={note}
            placeholder={SD.taskRequestNote}
            aria-label={SD.taskRequest}
            disabled={busy}
            onChange={event => setNote(event.target.value)}
          />
          <Button variant="plain" type="button" className={css.requestSubmit} disabled={busy} onClick={() => void submit()}>{busy ? SD.taskRequestSending : SD.taskRequestSubmit}</Button>
          <Button variant="plain" type="button" className={css.requestButton} disabled={busy} onClick={() => { setOpen(false); setError(undefined) }}>{SD.taskRequestCancel}</Button>
        </div>
      )}
      {error !== undefined && <span className={css.error} role="alert">{error}</span>}
    </div>
  )
}

export function WorkforceSkillDraftsDialog({ source, employees, tasks, api: suppliedApi, onChanged, onClose }: {
  readonly source?: WorkforceSource | undefined
  readonly employees: readonly Employee[]
  readonly tasks: readonly Task[]
  readonly api?: WorkforceApi | undefined
  readonly onChanged?: (() => void) | undefined
  readonly onClose: () => void
}) {
  const api = useMemo(() => suppliedApi ?? new WorkforceApi(), [suppliedApi])
  const models = useMemo(() => source?.models ?? new WorkforceModelsSource(api), [source, api])
  const mounted = useRef(true)
  const requestSeq = useRef(0)
  const [drafts, setDrafts] = useState<readonly WorkforceSkillDraft[] | undefined>()
  const [userSkills, setUserSkills] = useState<readonly WorkforceUserSkill[] | undefined>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [selectedId, setSelectedId] = useState<string>()
  // 未保存编辑与安装勾选都按草稿 id 暂存，切换/刷新不丢。
  const [edits, setEdits] = useState<Readonly<Record<string, DraftEdits>>>({})
  const [installPicks, setInstallPicks] = useState<Readonly<Record<string, readonly string[]>>>({})
  const [installedInfo, setInstalledInfo] = useState<Readonly<Record<string, { readonly path?: string; readonly bound: readonly string[] }>>>({})
  const [returnOpen, setReturnOpen] = useState(false)
  const [returnNote, setReturnNote] = useState('')
  const [returnError, setReturnError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState<WorkforceSkillDraft>()
  const [confirmDisable, setConfirmDisable] = useState<WorkforceSkillDraft>()
  const [disabledInfo, setDisabledInfo] = useState<Readonly<Record<string, string | undefined>>>({})
  const [confirmClose, setConfirmClose] = useState(false)

  const reload = useCallback(async () => {
    const seq = ++requestSeq.current
    try {
      const next = await api.skillDrafts()
      if (mounted.current && seq === requestSeq.current) { setDrafts(next); setError(undefined) }
    } catch (failure) {
      if (mounted.current && seq === requestSeq.current) setError(failure instanceof Error ? failure.message : String(failure))
    }
    // 用户技能根独立拉取：失败只影响停用入口的展示，不盖住草稿列表
    const skills = await api.userSkills().catch(() => undefined)
    if (mounted.current && seq === requestSeq.current && skills !== undefined) setUserSkills(skills)
  }, [api])

  useEffect(() => {
    mounted.current = true
    void reload()
    return () => { mounted.current = false; requestSeq.current += 1 }
  }, [reload])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  const taskTitle = useCallback((taskId: string): string => tasks.find(task => task.id === taskId)?.title ?? taskId, [tasks])
  const pendingCount = (drafts ?? []).filter(draft => draft.status === 'drafted').length
  const selected = drafts?.find(draft => draft.id === selectedId)

  const selectDraft = (draft: WorkforceSkillDraft): void => {
    setSelectedId(draft.id)
    setReturnOpen(false); setReturnNote(''); setReturnError(undefined)
    setEdits(prev => prev[draft.id] === undefined ? { ...prev, [draft.id]: editsOf(draft) } : prev)
  }

  const anyDirty = drafts !== undefined && drafts.some(draft => {
    const entry = edits[draft.id]
    return entry !== undefined && !sameEdits(draft, entry)
  })

  // 已安装但 slug 不在用户技能根（origin=workflow）→ 视为已停用；userSkills 未拉到时按已安装展示
  const inUserRoot = (draft: WorkforceSkillDraft): boolean =>
    userSkills?.some(skill => skill.name === draft.slug && skill.origin === 'workflow') === true
  const statusTag = (draft: WorkforceSkillDraft): WorkforceSkillDraft['status'] | 'disabled' =>
    draft.status === 'installed' && userSkills !== undefined && !inUserRoot(draft) ? 'disabled' : draft.status

  const tryClose = (): void => { if (anyDirty) setConfirmClose(true); else onClose() }

  const patchEdit = (id: string, patch: Partial<DraftEdits>): void => {
    setEdits(prev => ({ ...prev, [id]: { ...(prev[id] ?? { slug: '', title: '', description: '', body: '' }), ...patch } }))
  }

  const save = async (draft: WorkforceSkillDraft): Promise<void> => {
    const entry = edits[draft.id]
    if (entry === undefined || sameEdits(draft, entry)) return
    setBusy(true); setError(undefined)
    try {
      const patch: { slug?: string; title?: string; description?: string; body?: string } = {}
      if (entry.slug !== draft.slug) patch.slug = entry.slug
      if (entry.title !== draft.title) patch.title = entry.title
      if (entry.description !== draft.description) patch.description = entry.description
      if (entry.body !== draft.body) patch.body = entry.body
      await api.updateSkillDraft(draft.id, patch)
      if (!mounted.current) return
      setNotice(SD.saved); onChanged?.()
      await reload()
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (mounted.current) setBusy(false) }
  }

  const doReturn = async (draft: WorkforceSkillDraft): Promise<void> => {
    if (returnNote.trim() === '') { setReturnError(SD.returnMissing); return }
    setBusy(true); setReturnError(undefined)
    try {
      if (source) await source.returnSkillDraft(draft.id, returnNote.trim())
      else {
        const task = tasks.find(item => item.id === draft.taskId)
        await models.require([employees.find(item => item.id === task?.assigneeId) ?? employees.find(item => item.isLeader)])
        await api.returnSkillDraft(draft.id, returnNote.trim())
      }
      if (!mounted.current) return
      setReturnOpen(false); setReturnNote(''); onChanged?.()
      await reload()
    } catch (failure) { if (mounted.current) setReturnError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (mounted.current) setBusy(false) }
  }

  const doDelete = async (): Promise<void> => {
    if (confirmDelete === undefined) return
    setBusy(true)
    try {
      await api.deleteSkillDraft(confirmDelete.id)
      if (!mounted.current) return
      setEdits(prev => { const next = { ...prev }; delete next[confirmDelete.id]; return next })
      if (selectedId === confirmDelete.id) setSelectedId(undefined)
      setConfirmDelete(undefined); onChanged?.()
      await reload()
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (mounted.current) setBusy(false) }
  }

  const doDisable = async (): Promise<void> => {
    if (confirmDisable === undefined) return
    setBusy(true); setError(undefined)
    try {
      const result = await api.disableUserSkill(confirmDisable.slug)
      if (!mounted.current) return
      setDisabledInfo(prev => ({ ...prev, [confirmDisable.id]: result.movedTo }))
      setConfirmDisable(undefined); setNotice(''); onChanged?.()
      await reload()
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (mounted.current) setBusy(false) }
  }

  const togglePick = (draftId: string, employeeId: string, checked: boolean): void => {
    setInstallPicks(prev => {
      const current = prev[draftId] ?? []
      return { ...prev, [draftId]: checked ? [...current, employeeId] : current.filter(id => id !== employeeId) }
    })
  }

  const install = async (draft: WorkforceSkillDraft): Promise<void> => {
    setBusy(true); setError(undefined)
    try {
      const result = await api.installSkillDraft(draft.id, installPicks[draft.id] ?? [])
      if (!mounted.current) return
      setInstalledInfo(prev => ({ ...prev, [draft.id]: { path: result.path, bound: installPicks[draft.id] ?? [] } }))
      setNotice(SD.installDone); onChanged?.()
      await reload()
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (mounted.current) setBusy(false) }
  }

  const renderList = () => (
    <div className={css.listPane}>
      <p className={css.hint}>{SD.intro}</p>
      {pendingCount > 0 && <div className={css.pendingBadge} role="status">{SD.pendingCount(pendingCount)}</div>}
      {error !== undefined && <div className={css.error} role="alert">{error}<Button variant="plain" type="button" disabled={busy} onClick={() => void reload()}>{SD.retry}</Button></div>}
      {drafts === undefined && error === undefined && <div className={css.loading} aria-label={SD.loadError}><span /><span /><span /></div>}
      {drafts !== undefined && drafts.length === 0 && <p className={css.hint}>{SD.empty}</p>}
      <ul className={css.draftList}>
        {(drafts ?? []).map(draft => {
          const dirty = edits[draft.id] !== undefined && !sameEdits(draft, edits[draft.id]!)
          return (
            <li key={draft.id}>
              <Button variant="plain" type="button" className={css.draftRow} onClick={() => selectDraft(draft)}>
                <span className={css.draftTitle}>{draft.title === '' ? draft.slug : draft.title}{dirty ? ' ·' : ''}</span>
                <span className={css.draftMeta}>{SD.sourceTask}：{taskTitle(draft.taskId)}</span>
                <span className={css.badge} data-status={statusTag(draft)}>{STATUS_LABEL[statusTag(draft)]}</span>
              </Button>
            </li>
          )
        })}
      </ul>
      {notice !== '' && <p className={css.notice} role="status">{notice}</p>}
    </div>
  )

  const renderEditor = (draft: WorkforceSkillDraft) => {
    const entry = edits[draft.id] ?? editsOf(draft)
    const dirty = !sameEdits(draft, entry)
    const hasBlock = draft.findings.some(finding => finding.level === 'block')
    const canEdit = draft.status !== 'installed'
    const picks = installPicks[draft.id] ?? []
    const bound = draft.status === 'installed'
      ? [...new Set([...(installedInfo[draft.id]?.bound ?? []), ...employees.filter(employee => employee.skills.includes(draft.slug)).map(employee => employee.id)])]
      : []
    return (
      <div className={css.editorPane}>
        <div className={css.editorHead}>
          <Button variant="plain" type="button" className={css.backButton} onClick={() => setSelectedId(undefined)}>{SD.backToList}</Button>
          <span className={css.badge} data-status={statusTag(draft)}>{STATUS_LABEL[statusTag(draft)]}</span>
          {draft.editedBy === 'user' && <span className={css.badge} data-status="edited">{SD.editedByUser}</span>}
          <span className={css.draftMeta}>{SD.sourceTask}：{taskTitle(draft.taskId)}</span>
        </div>
        <div className={css.field}>
          <label htmlFor="wf-sd-slug">{SD.fieldSlug}</label>
          <TextInput id="wf-sd-slug" value={entry.slug} disabled={!canEdit || busy} onChange={event => patchEdit(draft.id, { slug: event.target.value })} />
          <span className={css.hint}>{SD.slugHint}</span>
        </div>
        <div className={css.field}>
          <label htmlFor="wf-sd-title">{SD.fieldTitle}</label>
          <TextInput id="wf-sd-title" value={entry.title} disabled={!canEdit || busy} onChange={event => patchEdit(draft.id, { title: event.target.value })} />
        </div>
        <div className={css.field}>
          <label htmlFor="wf-sd-desc">{SD.fieldDescription}</label>
          <TextInput id="wf-sd-desc" value={entry.description} disabled={!canEdit || busy} onChange={event => patchEdit(draft.id, { description: event.target.value })} />
        </div>
        <div className={css.field}>
          <label htmlFor="wf-sd-body">{SD.fieldBody}</label>
          <Textarea id="wf-sd-body" rows={12} value={entry.body} disabled={!canEdit || busy} onChange={event => patchEdit(draft.id, { body: event.target.value })} />
        </div>

        <div className={css.findings} aria-label={SD.findingsTitle}>
          <div className={css.findingsTitle}>{SD.findingsTitle}</div>
          {draft.findings.length === 0 && <div className={css.hint}>{SD.findingsEmpty}</div>}
          <ul className={css.findingList}>
            {draft.findings.map((finding, index) => (
              <li key={index} className={css.finding} data-level={finding.level}>
                <span className={css.findingLevel} data-level={finding.level}>{finding.level === 'block' ? SD.findingBlock : SD.findingWarn}</span>
                <span>{finding.message}</span>
                {finding.excerpt !== undefined && <code className={css.findingExcerpt}>{finding.excerpt}</code>}
              </li>
            ))}
          </ul>
        </div>

        {error !== undefined && <div className={css.error} role="alert">{error}</div>}

        {draft.status === 'installed' ? (
          <div className={css.installedInfo}>
            {disabledInfo[draft.id] !== undefined || statusTag(draft) === 'disabled' ? (
              <div>{SD.disabledDone(disabledInfo[draft.id])}</div>
            ) : (
              <>
                <div>{SD.installedPath}：<code>{installedInfo[draft.id]?.path ?? `${draft.slug}/SKILL.md`}</code></div>
                <div>{SD.boundEmployees}：{bound.length === 0 ? SD.boundNone : bound.map(id => employeeName(employees, id)).join('、')}</div>
                {inUserRoot(draft) && <div><Button variant="plain" type="button" className={css.dangerButton} disabled={busy} onClick={() => setConfirmDisable(draft)}>{SD.disableAction}</Button></div>}
              </>
            )}
          </div>
        ) : draft.status === 'drafted' ? (
          <div className={css.installBox}>
            <div className={css.installTitle}>{SD.installTitle}</div>
            <div className={css.hint}>{SD.installHint}</div>
            <div className={css.pickList}>
              {employees.map(employee => (
                <label key={employee.id} className={css.pickItem}>
                  <Checkbox
                    checked={picks.includes(employee.id)}
                    disabled={busy}
                    onCheckedChange={checked => togglePick(draft.id, employee.id, checked === true)}
                  />
                  {employee.name}
                </label>
              ))}
            </div>
            {hasBlock && <div className={css.blockedReason} role="status">{SD.installBlocked}</div>}
            <Button variant="plain" type="button" className={css.primaryButton} disabled={busy || hasBlock} title={hasBlock ? SD.installBlocked : undefined} onClick={() => void install(draft)}>
              {busy ? SD.installing : SD.install}
            </Button>
          </div>
        ) : (
          <div className={css.hint}>{SD.notReadyToInstall}</div>
        )}

        {canEdit && (
          <div className={css.editorActions}>
            <Button variant="plain" type="button" className={css.primaryButton} disabled={busy || !dirty} onClick={() => void save(draft)}>{busy ? SD.saving : SD.save}</Button>
            <Button variant="plain" type="button" className={css.actionButton} disabled={busy} onClick={() => { setReturnOpen(value => !value); setReturnError(undefined) }}>{SD.returnAction}</Button>
            <Button variant="plain" type="button" className={css.dangerButton} disabled={busy} onClick={() => setConfirmDelete(draft)}>{SD.deleteAction}</Button>
          </div>
        )}
        {returnOpen && canEdit && (
          <div className={css.returnBox}>
            <label htmlFor="wf-sd-return">{SD.returnNote}</label>
            <Textarea id="wf-sd-return" rows={2} value={returnNote} disabled={busy} onChange={event => { setReturnNote(event.target.value); setReturnError(undefined) }} />
            {returnError !== undefined && <span className={css.error} role="alert">{returnError}</span>}
            <Button variant="plain" type="button" className={css.primaryButton} disabled={busy} onClick={() => void doReturn(draft)}>{SD.returnSubmit}</Button>
          </div>
        )}
        {notice !== '' && <p className={css.notice} role="status">{notice}</p>}
      </div>
    )
  }

  return (
    <Dialog title={SD.title} closeLabel={SD.close} onClose={tryClose} busy={busy}>
      <div className={css.content}>
        {selected === undefined ? renderList() : renderEditor(selected)}
      </div>
      {confirmDelete !== undefined && (
        <Dialog title={SD.deleteTitle} closeLabel={SD.taskRequestCancel} busy={busy} onClose={() => setConfirmDelete(undefined)}>
          <p>{SD.deleteConfirm(confirmDelete.title === '' ? confirmDelete.slug : confirmDelete.title)}</p>
          <div className={css.editorActions}>
            <Button variant="plain" type="button" className={css.dangerButton} disabled={busy} onClick={() => void doDelete()}>{SD.deleteSubmit}</Button>
            <Button variant="plain" type="button" className={css.actionButton} disabled={busy} onClick={() => setConfirmDelete(undefined)}>{SD.taskRequestCancel}</Button>
          </div>
        </Dialog>
      )}
      {confirmDisable !== undefined && (
        <Dialog title={SD.disableTitle} closeLabel={SD.taskRequestCancel} busy={busy} onClose={() => setConfirmDisable(undefined)}>
          <p>{SD.disableConfirm(confirmDisable.slug)}</p>
          <div className={css.editorActions}>
            <Button variant="plain" type="button" className={css.dangerButton} disabled={busy} onClick={() => void doDisable()}>{busy ? SD.disabling : SD.disableSubmit}</Button>
            <Button variant="plain" type="button" className={css.actionButton} disabled={busy} onClick={() => setConfirmDisable(undefined)}>{SD.taskRequestCancel}</Button>
          </div>
        </Dialog>
      )}
      {confirmClose && (
        <Dialog title={SD.discardTitle} closeLabel={SD.discardNo} onClose={() => setConfirmClose(false)}>
          <p>{SD.discardConfirm}</p>
          <div className={css.editorActions}>
            <Button variant="plain" type="button" className={css.dangerButton} onClick={onClose}>{SD.discardYes}</Button>
            <Button variant="plain" type="button" className={css.actionButton} onClick={() => setConfirmClose(false)}>{SD.discardNo}</Button>
          </div>
        </Dialog>
      )}
    </Dialog>
  )
}
