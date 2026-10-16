/**
 * 任务成果卡片：`文件名 · vN · 作者 · 最终版/草稿`，点文件名预览当前显示的
 * 版本（最终版或最新版），chevron 展开每个不可变版本（作者、时间、字数、
 * 预览、下载），非最终版可「设为最终版」。预览复用 workforce-attachments 的
 * WorkforceFilePreview。版本真源在宿主 store，这里只按 workforce-types 契约
 * 展示并调用发布路由；发布返回的整条任务先就地顶替，再让 source 轮询对齐。
 */
import { useEffect, useMemo, useState } from 'react'
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import { WorkforceApi } from './workforce-api.ts'
import { WF } from './workforce-strings.ts'
import { WorkforceFilePreview, WorkforceNativeFileMenu, attachmentOpenMode, openNativeDeliverable, revealNativeFile, gateAttachment } from './workforce-attachments.tsx'
import type { WorkforceSource } from './workforce-source.ts'
import type { Employee, Task, TaskDeliverable, TaskDeliverableVersion } from './workforce-types.ts'
import css from './workforce-deliverables.module.css'

const LABELS = {
  get published() { return WF.deliverables.final },
  get draft() { return WF.deliverables.draft },
  get publish() { return WF.deliverables.setFinal },
  get publishing() { return WF.deliverables.settingFinal },
  get open() { return WF.deliverables.open },
  get download() { return WF.deliverables.download },
  get publishNote() { return WF.deliverables.publishNote },
}

/** 作者 id → 显示名：`user` 是当前用户，`unknown`（旧数据）与查不到的 id 都是「未知」。 */
function authorName(authorId: string, employees: readonly Employee[]): string {
  if (authorId === 'user') return WF.employee.you
  return employees.find(item => item.id === authorId)?.name ?? WF.common.unknown
}

function fmtStamp(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

interface DeliverableView {
  readonly versions: readonly TaskDeliverableVersion[]
  /** 卡片上显示的版本号：有最终版就显示最终版那版，否则最新版。 */
  readonly shownVersion: number
  readonly authorId: string
  readonly published: boolean
  /** 有比最终版更新的草稿时的版本号。 */
  readonly newDraftVersion?: number
}

/**
 * 旧数据没有 `versions`：宿主把原平铺文件当 v1（作者未知、最终版），
 * 这里照此显示，并在宿主补齐前不伪造版本列表。
 */
function viewOf(item: TaskDeliverable): DeliverableView {
  const versions = [...(item.versions ?? [])].sort((a, b) => a.version - b.version)
  const latest = versions[versions.length - 1]
  if (latest === undefined) return { versions, shownVersion: 1, authorId: 'unknown', published: true }
  const publishedVersion = item.publishedVersion
  const shown = publishedVersion === undefined
    ? latest
    : versions.find(version => version.version === publishedVersion) ?? latest
  return {
    versions,
    shownVersion: shown.version,
    authorId: shown.authorId,
    published: publishedVersion !== undefined,
    ...(publishedVersion !== undefined && latest.version > publishedVersion ? { newDraftVersion: latest.version } : {}),
  }
}

/** 站内文件路由加 `download=1` 让宿主带 Content-Disposition。 */
function downloadHref(url: string): string {
  const parsed = new URL(url, window.location.href)
  parsed.searchParams.set('download', '1')
  return parsed.pathname + parsed.search + parsed.hash
}

function DeliverableCard({ taskId, item, employees, api, onPublished }: {
  readonly taskId: string
  readonly item: TaskDeliverable
  readonly employees: readonly Employee[]
  readonly api: WorkforceApi
  readonly onPublished: (task: Task) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const view = viewOf(item)
  const extension = item.name.includes('.') ? item.name.split('.').pop()!.toLowerCase() : 'file'
  const [previewVersion, setPreviewVersion] = useState<number>()
  const shownUrl = api.deliverableUrl(taskId, item.name, view.shownVersion)

  /**
   * 成果「打开」的统一入口：图片/视频/音频/PDF/文本走内联预览；Office 走系统应用打开；
   * 安装包与未知格式只下载（不执行、不预览）。一个文件只有一个主动作。
   */
  const openDeliverable = async (version: number): Promise<void> => {
    const url = api.deliverableUrl(taskId, item.name, version)
    const name = version === view.shownVersion ? item.name : `${item.name} v${version}`
    const mode = attachmentOpenMode(url, name)
    if (mode === 'preview') { setPreviewVersion(version); return }
    setBusy(true); setError(undefined)
    // external：在资源管理器中显示；native：交给系统应用打开
    const result = mode === 'external'
      ? await revealNativeFile(url)
      : await openNativeDeliverable(url, { action: 'open' })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
    }
  }

  const publish = async (version: number): Promise<void> => {
    setBusy(true); setError(undefined)
    try {
      onPublished(await api.publishDeliverable(taskId, item.name, version))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const hasMultipleVersions = view.versions.length > 1
  const versionPill = hasMultipleVersions ? (
    <button
      type="button"
      className={css.versionTag}
      data-published={view.published}
      aria-expanded={open}
      aria-label={WF.deliverables.versionAria(view.published, view.shownVersion, open)}
      title={WF.deliverables.toggleVersions(open)}
      onClick={() => setOpen(value => !value)}
    >
      <span>{view.published ? '✓ ' : ''}v{view.shownVersion}</span>
      <svg className={css.hamburgerIcon} aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>
  ) : (
    <span className={css.versionTag} data-published={view.published}>
      {view.published ? '✓ ' : ''}v{view.shownVersion}
    </span>
  )

  const head = <>
    <span className={css.fileIcon} data-extension={extension}><FileTypeIcon path={item.name} size={22} /></span>
    <button type="button" className={css.fileName} title={WF.deliverables.openFileTitle(item.name)} onClick={() => void openDeliverable(view.shownVersion)}>{item.name}</button>
    {versionPill}
    <span className={css.authorTag}>{authorName(view.authorId, employees)}</span>
    {view.newDraftVersion !== undefined && <span className={css.draftMark}>{WF.deliverables.newDraftVersion(view.newDraftVersion)}</span>}
  </>

  return (
    <div className={css.card} data-deliverable={item.name}>
      <div className={css.head}>
        <span className={css.headMain}>{head}</span>
        <WorkforceNativeFileMenu
          url={shownUrl}
          name={`${item.name} v${view.shownVersion}`}
          downloadUrl={downloadHref(shownUrl)}
          downloadName={item.name}
          showFolderButton
        />
      </div>
      {open && (
        <div className={css.versions}>
          <div className={css.publishNote}>{LABELS.publishNote}</div>
          {view.versions.map(version => (
            <div key={version.version} className={css.versionRow} data-current={version.version === item.publishedVersion}>
              <span className={css.versionNo}>v{version.version}</span>
              <span className={css.versionAuthor}>{authorName(version.authorId, employees)}</span>
              <span className={css.versionTime}>{fmtStamp(version.createdAt)}</span>
              <span className={css.versionChars}>{WF.deliverables.charCount(version.charCount)}</span>
              <span className={css.versionSpacer} />
              <button type="button" className={css.versionAction} disabled={busy} onClick={() => void openDeliverable(version.version)}>{LABELS.open}</button>
              {version.version !== item.publishedVersion && (
                <button type="button" className={css.versionAction} title={LABELS.publishNote} disabled={busy} onClick={() => void publish(version.version)}>
                  {busy ? LABELS.publishing : LABELS.publish}
                </button>
              )}
              <WorkforceNativeFileMenu
                url={api.deliverableUrl(taskId, item.name, version.version)}
                name={`${item.name} v${version.version}`}
                downloadUrl={downloadHref(api.deliverableUrl(taskId, item.name, version.version))}
                downloadName={item.name}
              />
            </div>
          ))}
          <button
            type="button"
            className={css.collapseRow}
            onClick={() => setOpen(false)}
            aria-label={WF.deliverables.collapseVersionList}
            title={WF.deliverables.collapseVersionList}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        </div>
      )}
      {error && <span className={css.error} role="alert">{error}</span>}
      {previewVersion !== undefined && (
        <WorkforceFilePreview
          url={api.deliverableUrl(taskId, item.name, previewVersion)}
          name={previewVersion === view.shownVersion ? item.name : `${item.name} v${previewVersion}`}
          onClose={() => setPreviewVersion(undefined)}
        />
      )}
    </div>
  )
}


/** 任务成果区：任务下的每个成果一张卡。 */
export function DeliverableChips({ task, employees, source }: {
  readonly task: Task
  readonly employees: readonly Employee[]
  readonly source: WorkforceSource
}) {
  const api = useMemo(() => new WorkforceApi(), [])
  const [published, setPublished] = useState<Task>()
  // 轮询换上新任务对象后就丢掉本地顶替，以宿主快照为准。
  useEffect(() => { setPublished(undefined) }, [task])
  const effective = published ?? task
  const visibleDeliverables = effective.deliverables.filter(item => gateAttachment(item.name).visible)
  if (visibleDeliverables.length === 0) return null
  const onPublished = (next: Task): void => { setPublished(next); source.refresh() }
  return (
    <div className={css.chips}>
      {visibleDeliverables.map(item => (
        <DeliverableCard key={item.name} taskId={effective.id} item={item} employees={employees} api={api} onPublished={onPublished} />
      ))}
    </div>
  )
}
