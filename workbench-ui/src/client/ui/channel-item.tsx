import { Button } from './button.tsx'
import type { MouseEvent, ReactNode } from 'react'
import css from './channel-item.module.css'
import { WF } from '../workforce-strings.ts'
export interface ChannelItemProps {
  readonly id: string
  readonly kind: 'channel' | 'dm'
  readonly label: string
  readonly selected: boolean
  readonly unreadCount?: number
  readonly mentionCount?: number
  /** 会话行的第二行摘要。 */
  readonly preview?: string
  readonly timestamp?: string
  readonly avatar?: ReactNode
  readonly muted?: boolean
  readonly disabled?: boolean
  readonly onSelect: () => void
  readonly onContextMenu?: (e: MouseEvent<HTMLButtonElement>) => void
  readonly trailing?: ReactNode
}

/** 导航行：频道行（#号）与私信行共用。 */
export function ChannelItem({ kind, label, selected, unreadCount, mentionCount, preview, timestamp, avatar, muted, disabled, onSelect, onContextMenu, trailing }: ChannelItemProps) {
  const unreadText = [
    unreadCount ? WF.ui.unreadCount(unreadCount) : '',
    mentionCount ? WF.ui.mentionCount(mentionCount) : '',
  ].filter(Boolean).join(', ')
  return (
    <Button variant="plain"
      type="button"
      className={`${css.item} ${kind === 'dm' ? css.dm : ''} ${selected ? css.selected : ''} ${muted ? css.muted : ''}`}
      data-kind={kind}
      aria-current={selected ? 'page' : undefined}
      aria-label={unreadText ? `${label}，${unreadText}` : undefined}
      disabled={disabled}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onKeyDown={e => { if (e.shiftKey && e.key === 'F10' && onContextMenu) onContextMenu(e as unknown as MouseEvent<HTMLButtonElement>) }}
    >
      {avatar
        ? <span className={css.avatarWrap}>{avatar}</span>
        : kind === 'channel' ? <span className={css.hash} aria-hidden="true">#</span> : null}
      <span className={css.main}>
        <span className={css.labelRow}>
          <span className={css.label}>{label}</span>
          {timestamp && <span className={css.time}>{timestamp}</span>}
        </span>
        {preview && <span className={css.preview}>{preview}</span>}
      </span>
      {trailing}
      {(mentionCount ?? 0) > 0 && (
        <span className={css.mention} aria-hidden="true">{mentionCount}</span>
      )}
      {(unreadCount ?? 0) > 0 && (
        <span className={css.unread} aria-hidden="true">{unreadCount! > 99 ? '99+' : unreadCount}</span>
      )}
    </Button>
  )
}
