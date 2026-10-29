import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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

/** 任务闲置超过 2 小时，任务大厅默认另起新上下文 */
export const CONTINUATION_IDLE_MS = 2 * 60 * 60 * 1000

export type ContinuationMode = 'continue' | 'new'

/**
 * 任务大厅默认延续最近的任务；运行中或有待答提问时始终延续。
 * 只有任务闲置超过 CONTINUATION_IDLE_MS，才默认另起新上下文。
 */
export function resolveDefaultContinuationMode(
  task: Task | undefined,
  hasPendingQuestion = false,
  now = Date.now(),
): ContinuationMode {
  if (!task) return 'new'
  if (task.status === 'running' || hasPendingQuestion) return 'continue'
  const elapsed = now - Date.parse(task.updatedAt ?? '')
  return Number.isFinite(elapsed) && elapsed > CONTINUATION_IDLE_MS ? 'new' : 'continue'
}

/**
 * 延续模式状态。换任务时重算默认值；用户点「接着这个任务」选中的任务固定为延续。
 * 运行中 updatedAt 频繁变化，所以只按任务 id 和待答提问重算，不覆盖用户的手动切换。
 */
export function useContinuationMode(task: Task | undefined, hasPendingQuestion: boolean) {
  const pinnedRef = useRef<string | undefined>(undefined)
  // 新出现待答提问时也重算，让回答回到原任务。
  const key = `${task?.id ?? ''}:${hasPendingQuestion}`
  const [state, setState] = useState(() => ({ key, mode: resolveDefaultContinuationMode(task, hasPendingQuestion) }))
  let mode = state.mode
  if (state.key !== key) {
    mode = task !== undefined && pinnedRef.current === task.id ? 'continue' : resolveDefaultContinuationMode(task, hasPendingQuestion)
    setState({ key, mode })
  }
  const idleAt = task !== undefined && task.status !== 'running' && !hasPendingQuestion && pinnedRef.current !== task.id
    ? Date.parse(task.updatedAt ?? '') + CONTINUATION_IDLE_MS
    : NaN
  useEffect(() => {
    if (!Number.isFinite(idleAt)) return
    const remaining = idleAt - Date.now()
    if (remaining <= 0) return
    const timer = setTimeout(() => setState(prev => ({ ...prev, mode: 'new' })), remaining)
    return () => clearTimeout(timer)
  }, [idleAt])
  const setMode = useCallback((next: ContinuationMode) => setState(prev => ({ ...prev, mode: next })), [])
  /** 用户手动选中一个任务继续：固定为延续，不受闲置时长影响。 */
  const pin = useCallback((taskId: string) => {
    pinnedRef.current = taskId
    setState(prev => ({ ...prev, mode: 'continue' }))
  }, [])
  return { mode, setMode, pin }
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
