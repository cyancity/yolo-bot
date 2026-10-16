/**
 * ThreadPanel：命名 region，右侧任务面板。
 * 顺序固定：标题栏 → 源消息 → 状态行 → trace → 阻断事实 → 消息流 → 成果 → composer。
 * Esc 由调用方在「无子浮层」时调用 onClose；关闭后焦点回原入口。
 */
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import css from './thread-panel.module.css'
import { IconButton } from './icon-button.tsx'
import { Icon } from './icons.tsx'
import { WF } from '../workforce-strings.ts'
import type { TaskRef } from './message-item.tsx'

export interface ThreadPanelProps {
  readonly open: boolean
  readonly title: string
  readonly contextLabel: string
  readonly task?: TaskRef
  readonly sourceMessage?: ReactNode
  readonly status?: ReactNode
  readonly trace?: ReactNode
  readonly blockers?: ReactNode
  readonly messages: ReactNode
  readonly results?: ReactNode
  readonly composer?: ReactNode
  readonly tools?: ReactNode
  readonly onClose: () => void
  readonly returnFocusRef?: RefObject<HTMLElement | null>
}

export function ThreadPanel({
  open, title, contextLabel, sourceMessage, status, trace, blockers, messages, results, composer, tools, onClose, returnFocusRef,
}: ThreadPanelProps) {
  const uid = useId()
  const titleId = `${uid}-title`
  const rootRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    const el = rootRef.current?.querySelector<HTMLElement>(`#${CSS.escape(titleId)}`)
    el?.focus?.()
    return () => { returnFocusRef?.current?.focus?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null
  return (
    <aside
      ref={rootRef}
      className={css.panel}
      role="region"
      aria-labelledby={titleId}
      data-thread-panel
    >
      <header className={css.head}>
        <div className={css.headText}>
          <h2 className={css.title} id={titleId} tabIndex={-1}>{title}</h2>
          <span className={css.context}>{contextLabel}</span>
        </div>
        {tools}
        <IconButton label={WF.ui.closeTaskPanel} icon={<Icon name="close" />} size="sm" onClick={onClose} />
      </header>
      {sourceMessage && <div className={css.sourceMessage}>{sourceMessage}</div>}
      {(status || trace) && (
        <div className={css.statusArea}>
          {status}
          {trace}
        </div>
      )}
      {blockers}
      <div className={css.stream}>{messages}</div>
      {results && <div className={css.results}>{results}</div>}
      {composer && <div className={css.composerWrap}>{composer}</div>}
    </aside>
  )
}
