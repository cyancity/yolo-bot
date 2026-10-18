import { Button } from './button.tsx'
/**
 * MessageItem：语义 article 行。全左对齐署名行，
 * 分组连续消息省略头像与署名。body 是 renderer 产物；
 * children 放工具/成果等已获准组合。
 */
import type { HTMLAttributes, ReactNode } from 'react'
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

export interface MessageItemProps extends Omit<HTMLAttributes<HTMLElement>, 'id'> {
  readonly id: string
  readonly author: { readonly id: string; readonly name: string }
  readonly role: 'user' | 'agent' | 'system'
  readonly timestamp?: string
  /** 与上一条同作者同 thread 的连续消息：省略署名/头像区。 */
  readonly grouped?: boolean
  readonly avatar?: ReactNode
  readonly body: ReactNode
  readonly task?: TaskRef
  readonly quote?: { readonly label: string; readonly onJump: () => void }
  readonly thread?: { readonly replyCount: number; readonly onOpen: () => void }
  readonly delivery?: 'sending' | 'waiting' | 'failed'
  readonly error?: string
  /** 行尾操作入口（弱操作）；如复制。 */
  readonly actions?: readonly MessageAction[]
  readonly children?: ReactNode
  /** 标记作者侧（用户消息/对方消息）。 */
  readonly self?: boolean
}

export function MessageItem({
  id, author, role, timestamp, grouped, avatar, body, task, quote, thread, delivery, error, actions, children, self, className, ...rest
}: MessageItemProps) {
  return (
    <article
      {...rest}
      className={`${css.item} ${grouped ? css.grouped : ''} ${self ? css.self : ''} ${className ?? ''}`}
      data-message-id={id}
      data-msg-role={role}
      data-delivery={delivery}
    >
      {!grouped && <span className={css.avatarCol} aria-hidden="true">{avatar}</span>}
      <div className={css.main}>
        {!grouped && (
          <div className={css.meta}>
            <span className={css.author}>{author.name}</span>
            {timestamp && <time className={css.time}>{timestamp}</time>}
            {delivery === 'sending' && <span className={css.delivery}>{WF.ui.sendingDelivery}</span>}
            {delivery === 'waiting' && <span className={css.delivery}>{WF.ui.waitingDelivery}</span>}
          </div>
        )}
        {quote && (
          <Button variant="plain" type="button" className={css.quote} onClick={quote.onJump}>
            {quote.label}
          </Button>
        )}
        {role === 'system' ? (
          <div className={css.systemBody}>{body}</div>
        ) : (
          <div className={css.bodyRow}>
            <div className={css.body}>{body}</div>
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
          </div>
        )}
        {delivery === 'failed' && (
          <div className={css.failedRow} role="alert">
            <span className={css.failedText}>{error ?? WF.common.failed}</span>
          </div>
        )}
        {task && (
          <div className={css.taskLine}>
            <Icon name="task" />
            <span className={css.taskTitle}>{task.title}</span>
            <span className={css.taskStatus} data-status={task.status}>{task.status}</span>
          </div>
        )}
        {thread && (
          <Button variant="plain" type="button" className={css.threadBtn} onClick={thread.onOpen}>
            {WF.ui.viewTask(thread.replyCount)}
          </Button>
        )}
        {children}
      </div>
    </article>
  )
}

/** 便捷气泡包装。 */
export function MessageBubbleBody({ self, children }: { self: boolean; children: ReactNode }) {
  return <Bubble side={self ? 'self' : 'peer'}>{children}</Bubble>
}
