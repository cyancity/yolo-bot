import { WF } from '../workforce-strings.ts'
/**
 * Composer：输入区壳。唯一发送主按钮（或同位 Stop）；附件、@、提示为弱元素。
 * 草稿、上传、投递状态由调用方持有；@候选等浮层由调用方经 popup 槽渲染。
 */
import { forwardRef, useId, type MutableRefObject, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { TextArea as LobeTextArea, type TextAreaProps as LobeTextAreaProps } from '@lobehub/ui/es/Input'
import css from './composer.module.css'
import { Button } from './button.tsx'
import { Icon } from './icons.tsx'

export type ComposerState = 'ready' | 'sending' | 'blocked' | 'failed'

export interface ComposerAttachment {
  readonly id: string
  readonly name: string
  readonly state: 'uploading' | 'ready' | 'failed'
  readonly error?: string
}

export interface ComposerProps {
  /** key 变化即换上下文（频道/thread/DM），草稿状态由外层按 key 管理。 */
  readonly contextKey: string
  /** 目的地可读名称，如「发送到 #任务大厅」「回复此任务」。 */
  readonly label: string
  readonly text: string
  readonly onTextChange: (text: string) => void
  readonly onSubmit: () => void
  readonly state?: ComposerState
  readonly blockedReason?: string
  readonly error?: string
  readonly attachments?: readonly ComposerAttachment[]
  readonly onRemoveAttachment?: (id: string) => void
  readonly onRetryAttachment?: (id: string) => void
  readonly onStop?: () => void
  /** 左侧工具槽（附件/@/技能等弱入口）。 */
  readonly tools?: ReactNode
  /** 快捷键/目的提示；窄容器由调用方决定隐藏。 */
  readonly hint?: ReactNode
  /** 发送失败时按钮文案换成「重试发送」（同按钮名额，不另加）。 */
  readonly retryLabel?: string
  readonly sendLabel?: string
  readonly stopLabel?: string
  /** @mention/自动完成等浮层，由调用方定位渲染在 composer 内部相对容器。 */
  readonly popup?: ReactNode
  readonly textareaProps?: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'id'>
  readonly textareaRef?: React.Ref<HTMLTextAreaElement>
}

export const Composer = forwardRef<HTMLDivElement, ComposerProps>(function Composer(
  {
    contextKey, label, text, onTextChange, onSubmit, state = 'ready', blockedReason, error,
    attachments, onRemoveAttachment, onRetryAttachment, onStop, tools, hint,
    retryLabel = WF.composer.retry, sendLabel = WF.composer.send, stopLabel = WF.composer.stop,
    popup, textareaProps, textareaRef,
  },
  ref,
) {
  const uid = useId()
  const taId = `${uid}-input`
  const canSend = text.trim().length > 0 || (attachments?.some(a => a.state === 'ready') ?? false)
  const blocked = state === 'blocked'
  return (
    <div ref={ref} className={css.composer} data-state={state} data-context-key={contextKey} data-composer-card>
      {attachments && attachments.length > 0 && (
        <ul className={css.attachments} aria-label={WF.ui.attachmentsAria}>
          {attachments.map(a => (
            <li key={a.id} className={css.attachment} data-state={a.state}>
              <Icon name="file" />
              <span className={css.attachName}>{a.name}</span>
              {a.state === 'uploading' && <span className={css.attachState}>{WF.ui.uploadingState}</span>}
              {a.state === 'failed' && (
                <button type="button" className={css.attachRetry} onClick={() => onRetryAttachment?.(a.id)}>
                  {WF.ui.attachmentFailed(a.error)}, {WF.ui.retryAttachment}
                </button>
              )}
              {onRemoveAttachment && (
                <button type="button" className={css.attachRemove} aria-label={WF.ui.removeAttachmentAria(a.name)} onClick={() => onRemoveAttachment(a.id)}>
                  <Icon name="close" width={14} height={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className={css.inputRow}>
        {tools && <div className={css.tools}>{tools}</div>}
        <div className={css.inputWrap}>
          <label htmlFor={taId} className={css.srOnly}>{label}</label>
          <LobeTextArea
            {...(textareaProps as LobeTextAreaProps)}
            type="block"
            ref={instance => {
              const input = instance?.resizableTextArea?.textArea ?? null
              if (typeof textareaRef === 'function') textareaRef(input)
              else if (textareaRef) (textareaRef as MutableRefObject<HTMLTextAreaElement | null>).current = input
            }}
            id={taId}
            data-composer-input
            className={`${css.textarea} ${textareaProps?.className ?? ''}`}
            value={text}
            placeholder={label}
            aria-label={label}
            {...(error ? { 'aria-invalid': true } : {})}
            onChange={e => onTextChange(e.target.value)}
          />
          {popup}
        </div>
        {state === 'sending' && onStop ? (
          <Button variant="secondary" onClick={onStop} aria-label={stopLabel}>
            <Icon name="stop" />{stopLabel}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={blocked || !canSend}
            loading={state === 'sending'}
            onClick={onSubmit}
            title={blocked ? blockedReason : undefined}
            data-composer-send
          >
            {state === 'failed' ? retryLabel : sendLabel}
          </Button>
        )}
      </div>
      {(blockedReason || error || hint) && (
        <div className={css.foot} data-composer-foot>
          {blocked && blockedReason && <span className={css.blocked}>{blockedReason}</span>}
          {error && <span className={css.error} role="alert">{error}</span>}
          {hint && <span className={css.hint}>{hint}</span>}
        </div>
      )}
    </div>
  )
})
