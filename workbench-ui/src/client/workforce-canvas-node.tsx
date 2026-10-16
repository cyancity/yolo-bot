import { memo, useEffect, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { TurnNodeData } from './workforce-canvas-data.ts'
import { WorkforceAvatar } from './workforce-avatar.tsx'
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
    setCopiedText(`${label} 已复制`)
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
        <span className={css.channelTag}>{channelTitle}</span>
        {status === 'running' && <span className={`${css.statusBadge} ${css.statusRunning}`}>执行中</span>}
        {status === 'done' && <span className={`${css.statusBadge} ${css.statusDone}`}>已完成</span>}
        {status === 'failed' && <span className={`${css.statusBadge} ${css.statusFailed}`}>失败</span>}
        <div className={css.moreMenuWrap}>
          <button
            type="button"
            className={css.nodeMoreBtn}
            title="更多操作"
            onClick={e => {
              e.stopPropagation()
              setMenuOpen(o => !o)
            }}
          >
            ···
          </button>
          {menuOpen && (
            <div
              className={css.nodeDropdownMenu}
              onClick={e => e.stopPropagation()}
            >
              <button type="button" className={css.contextMenuItem} onClick={() => copyId(data.threadId, '会话 ID')}>
                <span>📋</span>
                <span>复制会话 ID ({data.threadId.slice(0, 8)}…)</span>
              </button>
              {data.taskId && (
                <button type="button" className={css.contextMenuItem} onClick={() => copyId(data.taskId!, '任务 ID')}>
                  <span>📋</span>
                  <span>复制任务 ID ({data.taskId!.slice(0, 8)}…)</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={css.promptRow}>
        <div className={css.userBubble}>
          <span className={css.userPrefix}>{senderName}:</span>
          <span className={css.promptContent}>{promptText}</span>
        </div>
      </div>

      {replySnippet && (
        <div className={css.replyRow}>
          <div className={css.agentAvatarWrap}>
            <WorkforceAvatar
              name={agentName || '员工'}
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
          <span className={css.toolBadge}>
            🛠️ {toolsCount} 工具
          </span>
        )}
        {usage && (
          <span className={css.cacheBadge} title={`输入: ${totalIn} (缓存: ${cached}) · 输出: ${usage.outputTokens}`}>
            {hitRate > 0 ? `⚡ 缓存 ${hitRate}%` : `入 ${formatK(totalIn)}`}
          </span>
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
