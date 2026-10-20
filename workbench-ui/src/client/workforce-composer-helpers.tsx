import { useEffect, useRef, type ReactNode } from 'react'
import { WF } from './workforce-strings.ts'
import type { Task } from './workforce-types.ts'
import css from './workforce.module.css'

/** Composer 触发词状态：@ 员工与 / skill 共用一套浮层、键盘与失焦规则。 */
export type ComposerTrigger = { readonly kind: 'at' | 'slash'; readonly query: string }

/** 浮层一行候选：label 是展示文本，insert 是回填到输入框的 token。 */
export interface TriggerItem {
  readonly key: string
  readonly label: string
  readonly insert: string
  readonly meta?: string
  readonly icon?: ReactNode
}

/** 10 分钟内完成的任务仍默认延续 */
export const CONTINUATION_RECENT_WINDOW_MS = 10 * 60 * 1000

/**
 * 任务大厅默认延续策略：
 * 1. 吸附的任务处于 running 或等待用户回复/提问时，默认延续；
 * 2. 任务 done 且完成在 10 分钟内，默认延续；
 * 3. 其他（done 超过 10 分钟、cancelled、failed 等）默认「新任务」，吸附条仍显示，用户可一键切回延续。
 */
export function resolveDefaultContinuationMode(
  task: Task | undefined,
  hasPendingQuestion = false,
  now = Date.now(),
): 'continue' | 'new' {
  if (!task) return 'new'
  if (task.status === 'running' || hasPendingQuestion) return 'continue'
  if (task.status === 'done' && task.updatedAt) {
    const elapsed = now - Date.parse(task.updatedAt)
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= CONTINUATION_RECENT_WINDOW_MS) {
      return 'continue'
    }
  }
  return 'new'
}

/** @ 与 / 共用的候选浮层；loading/empty 也在同一壳内呈现。 */
export function TriggerMenu({ items, activeIndex, loading, onPick }: {
  readonly items: readonly TriggerItem[]
  readonly activeIndex: number
  readonly loading: boolean
  readonly onPick: (item: TriggerItem) => void
}) {
  const activeItemRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (typeof activeItemRef.current?.scrollIntoView === 'function') {
      activeItemRef.current.scrollIntoView({
        block: 'nearest',
      })
    }
  }, [activeIndex])

  if (loading) return <div className={css.atMenu} role="listbox" aria-label={WF.composer.atPlaceholder}><div className={css.atItem}>{WF.common.loading}</div></div>
  if (items.length === 0) return <div className={css.atMenu} role="listbox" aria-label={WF.composer.atPlaceholder}><div className={css.atItem}>{WF.composer.atEmpty}</div></div>
  return (
    <div className={css.atMenu} role="listbox" aria-label={WF.composer.atPlaceholder}>
      {items.map((item, index) => (
        <button
          key={item.key}
          ref={index === activeIndex ? activeItemRef : null}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`${css.atItem} ${index === activeIndex ? css.atItemActive : ''}`}
          onMouseDown={event => { event.preventDefault(); onPick(item) }}
        >
          {item.icon}
          <span className={css.atItemName}>{item.label}</span>
          <span className={css.atItemRole}>{item.meta}</span>
        </button>
      ))}
    </div>
  )
}
