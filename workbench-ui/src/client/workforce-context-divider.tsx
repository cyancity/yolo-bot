import { WF } from './workforce-strings.ts'
import css from './workforce.module.css'

/** 消息流里的上下文分隔线：任务之间各一条；待发的新任务在底部再给一条，可回到上一个任务。 */
export function ContextDivider({ resumeTitle, onResume }: {
  readonly resumeTitle?: string | undefined
  readonly onResume?: (() => void) | undefined
}) {
  return (
    <div className={css.contextDivider} role="separator">
      <span>{WF.taskStatus.newContext}</span>
      {onResume !== undefined && resumeTitle !== undefined && (
        <button type="button" className={css.contextResume} onClick={onResume} title={resumeTitle}>
          {WF.taskStatus.resumeContext(resumeTitle)}
        </button>
      )}
    </div>
  )
}
