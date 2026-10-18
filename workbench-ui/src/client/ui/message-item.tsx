import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { MessagePrimitive } from '@assistant-ui/react'
import { Button } from './button.tsx'
import css from './message-item.module.css'
import { Bubble } from './bubble.tsx'
import { Icon } from './icons.tsx'
import { WF } from '../workforce-strings.ts'

export interface TaskRef {
  readonly id: string
  readonly title: string
  readonly status: 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
}

export interface MessageAction {
  readonly id: string
  readonly label: string
  readonly onInvoke: () => void
  readonly disabled?: boolean
  readonly loading?: boolean
  readonly tone?: 'neutral' | 'danger'
}
export interface QuoteAction {
  readonly label: string
  readonly onJump: () => void
}

export interface ThreadAction {
  readonly replyCount: number
  readonly onOpen: () => void
}

function isQuoteAction(value: unknown): value is QuoteAction {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.label === 'string' && typeof record.onJump === 'function'
}

function isThreadAction(value: unknown): value is ThreadAction {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.replyCount === 'number' && typeof record.onOpen === 'function'
}

export interface MessageItemProps extends Omit<HTMLAttributes<HTMLElement>, 'id'> {
  readonly id: string
  readonly author?: { readonly id?: string; readonly name: string } | string
  readonly role?: 'user' | 'agent' | 'system'
  readonly timestamp?: string
  /** 与上一条同作者同 thread 的连续消息：省略署名/头像区。 */
  readonly grouped?: boolean
  readonly avatar?: ReactNode
  readonly body?: ReactNode
  readonly task?: TaskRef
  readonly quote?: QuoteAction | ReactNode
  readonly thread?: ThreadAction | ReactNode
  readonly delivery?: 'sending' | 'waiting' | 'failed'
  readonly error?: string
  /** 行尾操作入口（弱操作）；如复制。 */
  readonly actions?: readonly MessageAction[]
  readonly actionSlot?: ReactNode
  readonly children?: ReactNode
  readonly self?: boolean
}
export const MessageItem = forwardRef<HTMLElement, MessageItemProps>(function MessageItem({
  id, author, role, timestamp, grouped, avatar, body, task, quote, thread, delivery, error, actions, actionSlot, children, self, className, ...rest
}: MessageItemProps, ref) {
  const authorName = typeof author === 'string' ? author : author?.name
  return (
    <article
      ref={ref}
      {...rest}
      className={`${css.item} ${grouped ? css.grouped : ''} ${self ? css.self : ''} ${className ?? ''}`}
      data-message-id={id}
      data-msg-role={role}
      data-delivery={delivery}
    >
      {!grouped && <span className={css.avatarCol} aria-hidden="true">{avatar}</span>}
      <div className={css.main}>
        {!grouped && authorName && (
          <div className={css.meta}>
            <span className={css.author}>{authorName}</span>
            {timestamp && <time className={css.time}>{timestamp}</time>}
            {delivery === 'sending' && <span className={css.delivery}>{WF.ui.sendingDelivery}</span>}
            {delivery === 'waiting' && <span className={css.delivery}>{WF.ui.waitingDelivery}</span>}
          </div>
        )}
        {quote && (
          isQuoteAction(quote) ? (
            <Button variant="plain" type="button" className={css.quote} onClick={quote.onJump}>
              {quote.label}
            </Button>
          ) : (
            quote
          )
        )}
        {role === 'system' ? (
          <div className={css.systemBody}>{body}</div>
        ) : (
          <div className={css.bodyRow}>
            {body !== undefined && <div className={css.body}>{body}</div>}
            {actions && actions.length > 0 && (
              <span className={css.actions}>
                {actions.map(a => (
                  <Button variant="plain"
                    key={a.id}
                    type="button"
                    className={css.actionBtn}
                    disabled={a.disabled}
                    aria-busy={a.loading ? true : undefined}
                    onClick={a.onInvoke}
                  >
                    {a.label}
                  </Button>
                ))}
              </span>
            )}
            {actionSlot}
          </div>
        )}
        {delivery === 'failed' && (
          <div className={css.failedRow} role="alert">
            <span className={css.failedText}>{error ?? WF.common.failed}</span>
          </div>
        )}
        <MessagePrimitive.Error>
          <div className={css.failedRow} role="alert">
            <span className={css.failedText}>{error ?? WF.common.failed}</span>
          </div>
        </MessagePrimitive.Error>
        {task && (
          <div className={css.taskLine}>
            <Icon name="task" />
            <span className={css.taskTitle}>{task.title}</span>
            <span className={css.taskStatus} data-status={task.status}>{task.status}</span>
          </div>
        )}
        {thread && (
          isThreadAction(thread) ? (
            <Button variant="plain" type="button" className={css.threadBtn} onClick={thread.onOpen}>
              {WF.ui.viewTask(thread.replyCount)}
            </Button>
          ) : (
            thread
          )
        )}
        {children}
      </div>
    </article>
  )
})

/** 便捷气泡包装。 */
export function MessageBubbleBody({ self, children }: { self: boolean; children: ReactNode }) {
  return <Bubble side={self ? 'self' : 'peer'}>{children}</Bubble>
}
