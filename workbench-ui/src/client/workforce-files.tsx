/**
 * 当前对话上下文的文件时间线（Codex 式侧面板）。
 *
 * 数据来自宿主真实投影：`ThreadMessages.files`（thread 级完整历史，页截断不影响）
 * 与 `WorkforceMessage.attachments`（行级真实文件），按稳定 id 合并去重。
 * 铁律：不在 UI 造字段、不渲染假数据；「员工口头声称生成」不算文件。
 * 上下文范围：DM 限当前 DM；线程面板限当前 thread；频道聚合当前频道的任务 thread。
 * 文件行复用 attachments 模块的卡片/门控能力（脚本隐藏、二进制不文本预览）。
 */
import type { ReactNode } from 'react'
import { Dialog, EmptyState, ListRow } from './ui/index.tsx'
import { WorkforceAttachment, gateAttachment } from './workforce-attachments.tsx'
import type { Employee, WorkforceFile, WorkforceMessage } from './workforce-types.ts'
import { WF } from './workforce-strings.ts'
import css from './workforce-files.module.css'

/**
 * 合并当前上下文的真实文件行：thread 级 files（宿主权威全历史，分页截断不影响）
 * 加消息行 attachments（补充行级投影），按稳定 id 去重，按时间倒序。
 * 只读真实来源（presented/tool/deliverable），不凭模型文字造行。
 */
export function workforceContextFiles(
  threadFiles: readonly (readonly WorkforceFile[] | undefined)[],
  messages: readonly WorkforceMessage[] = [],
): readonly WorkforceFile[] {
  const seen = new Set<string>()
  const files: WorkforceFile[] = []
  const push = (file: WorkforceFile): void => {
    if (seen.has(file.id)) return
    seen.add(file.id)
    files.push(file)
  }
  for (const page of threadFiles) for (const file of page ?? []) push(file)
  for (const message of messages) for (const file of message.attachments ?? []) push(file)
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function fmtFileTime(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 时间线列表：时间 + 真实文件行（路径 / 作者 / 版本 / 来源），复用附件卡片能力。 */
export function WorkforceFilesTimeline({ files, employees }: {
  readonly files: readonly WorkforceFile[]
  readonly employees: readonly Employee[]
}) {
  const rows = files.filter(file => gateAttachment(file.name, file.mime).visible)
  if (rows.length === 0) {
    return <EmptyState title={WF.files.emptyTitle} description={WF.files.emptyHintFiltered} compact />
  }
  return (
    <div className={css.timeline} role="list" aria-label={WF.files.timelineAria}>
      {rows.map(file => {
        const author = employees.find(employee => employee.id === file.employeeId)?.name
        return (
          <ListRow
            key={file.id}
            className={css.fileItem}
            leading={<span className={css.fileTime}>{fmtFileTime(file.createdAt)}</span>}
            title={
              <WorkforceAttachment
                url={file.url}
                locationUrl={file.locationUrl}
                name={file.name}
                sizeBytes={file.sizeBytes}
                mime={file.mime}
              />
            }
            description={
              <div className={css.fileMetaLine} title={file.path}>
                <span className={css.fileSource}>{file.source === 'deliverable' ? WF.files.sourceDeliverable : file.source === 'tool' ? WF.files.sourceTool : WF.files.sourceChat}</span>
                {file.version !== undefined && <span className={css.fileVersion}>v{file.version}</span>}
                {author !== undefined && <span className={css.fileAuthor}>{author}</span>}
              </div>
            }
          />
        )
      })}
    </div>
  )
}

export function WorkforceFilesDrawer({ title, contextLabel, status, error, children, onClose }: {
  readonly title: string
  /** 上下文描述（频道 / 私信 / 线程），显示在标题下方。 */
  readonly contextLabel?: string | undefined
  /** loading = 正在读取；empty = 读毕无文件；ready = 渲染 children（真实列表）。 */
  readonly status: 'loading' | 'empty' | 'ready'
  readonly error?: string | undefined
  /** status='ready' 时的真实文件列表节点（接线后传入）。 */
  readonly children?: ReactNode
  readonly onClose: () => void
}) {
  let content: ReactNode
  if (status === 'loading') {
    content = <div className={css.loading} role="status" aria-label={WF.files.loading}><span /><span /><span /></div>
  } else if (status === 'empty') {
    content = <EmptyState title={WF.files.emptyTitle} description={WF.files.emptyHint} compact />
  } else {
    content = children
  }
  return (
    <Dialog title={title} closeLabel={WF.files.closeDialog} onClose={onClose}>
      <div className={css.drawer}>
        {contextLabel !== undefined && <p className={css.scope}>{contextLabel}</p>}
        {error !== undefined && <p className={css.error} role="alert">{error}</p>}
        {content}
      </div>
    </Dialog>
  )
}
