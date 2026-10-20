import { memo, useEffect, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { Tag as LobeTag } from '@lobehub/ui'
import { Button as LobeButton } from 'antd'
import type { TurnNodeData } from './workforce-canvas-data.ts'
import { WorkforceAvatar } from './workforce-avatar.tsx'
import { Icon } from './ui/icons.tsx'
import { WF } from './workforce-strings.ts'
import css from './workforce-canvas.module.css'

export const TurnCanvasNode = memo(function TurnCanvasNode({
  data,
  selected,
}: NodeProps & { data: TurnNodeData }) {
  const {
    channelTitle,
    promptText,
    replySnippet,
    senderName,
    agentName,
    agentRole,
    agentAvatarColor,
    toolsCount,
    status,
    usage,
  } = data

  const cached = usage?.cacheReadTokens ?? 0
  const uncached = usage?.inputTokens ?? 0
  const totalIn = cached + uncached
  const hitRate = totalIn > 0 && cached > 0 ? Math.round((cached / totalIn) * 100) : 0
  const formatK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  const [menuOpen, setMenuOpen] = useState(false)
  const [copiedText, setCopiedText] = useState<string | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuOpen])

  const copyId = (text: string, label: string) => {
    void navigator.clipboard.writeText(text)
    setCopiedText(`${label} ${WF.common.copied}`)
    setMenuOpen(false)
    window.setTimeout(() => setCopiedText(null), 2000)
  }

  return (
    <div
      className={`${css.turnCard} ${selected ? css.turnCardSelected : ''}`}
      onContextMenu={e => {
        e.preventDefault()
        e.stopPropagation()
        setMenuOpen(true)
      }}
    >
      <Handle type="target" position={Position.Left} className={css.handle} />

      <div className={css.turnHeader}>
        <LobeTag size="small" className={css.channelTag ?? ''}>{channelTitle}</LobeTag>
        {status === 'running' && <LobeTag color="processing" size="small">{WF.common.running}</LobeTag>}
        {status === 'done' && <LobeTag color="success" size="small">{WF.common.done}</LobeTag>}
        {status === 'failed' && <LobeTag color="error" size="small">{WF.common.failed}</LobeTag>}
        <div className={css.moreMenuWrap}>
          <LobeButton
            type="text"
            className={css.nodeMoreBtn ?? ''}
            title={WF.common.moreOptions}
            onClick={e => {
              e.stopPropagation()
              setMenuOpen(o => !o)
            }}
          >
            ···
          </LobeButton>
          {menuOpen && (
            <div
              className={css.nodeDropdownMenu}
              onClick={e => e.stopPropagation()}
            >
              <button type="button" className={css.contextMenuItem} onClick={() => copyId(data.threadId, WF.canvas.threadId)}>
                <Icon name="copy" width={14} height={14} />
                <span>{WF.canvas.copyThreadId(data.threadId.slice(0, 8))}</span>
              </button>
              {data.taskId && (
                <button type="button" className={css.contextMenuItem} onClick={() => copyId(data.taskId!, WF.canvas.taskId)}>
                  <Icon name="copy" width={14} height={14} />
                  <span>{WF.canvas.copyTaskId(data.taskId!.slice(0, 8))}</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={css.promptRow}>
        <div className={css.userBubble}>
          <span className={css.userPrefix}>{(!senderName || senderName === '你' || senderName === 'You') ? WF.canvas.userPrefix : `${senderName}:`}</span>
          <span className={css.promptContent}>{promptText}</span>
        </div>
      </div>

      {replySnippet && (
        <div className={css.replyRow}>
          <div className={css.agentAvatarWrap}>
            <WorkforceAvatar
              name={agentName || WF.common.employee}
              role={agentRole}
              color={agentAvatarColor}
              size={28}
              state={status === 'running' ? 'working' : 'idle'}
              live={status === 'running'}
            />
          </div>
          <div className={css.agentBubble}>
            {agentName && <span className={css.agentName}>{agentName}</span>}
            <p className={css.replyContent}>{replySnippet}</p>
          </div>
        </div>
      )}

      <div className={css.turnFooter}>
        {toolsCount > 0 && (
          <LobeTag size="small">{WF.canvas.toolsCount(toolsCount)}</LobeTag>
        )}
        {usage && (
          <LobeTag size="small" title={WF.canvas.cacheTitle(totalIn, cached, usage.outputTokens)}>
            {WF.canvas.cacheBadge(hitRate, formatK(totalIn))}
          </LobeTag>
        )}
      </div>

      <Handle type="source" position={Position.Right} className={css.handle} />


      {copiedText && (
        <div className={css.copiedToast} style={{ position: 'absolute', bottom: -28, left: 10, zIndex: 1000 }}>
          ✓ {copiedText}
        </div>
      )}
    </div>
  )
})
