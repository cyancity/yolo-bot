/**
 * 数字员工工作台全域骨架屏组件。
 * 模仿真实布局、用现有 token、轻 shimmer、reduced-motion 静止、<150ms 不闪。
 */
import { useEffect, useState } from 'react'
import css from './workforce-skeleton.module.css'

/**
 * 延迟展示骨架屏 Hook：加载时间 < delayMs（默认 150ms）时不闪烁骨架屏。
 */
export function useDelayedLoading(loading: boolean, delayMs = 150): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!loading) {
      setVisible(false)
      return
    }
    const timer = window.setTimeout(() => {
      setVisible(true)
    }, delayMs)
    return () => {
      window.clearTimeout(timer)
    }
  }, [loading, delayMs])

  return visible
}

/**
 * 消息流骨架屏：模仿真实消息行（头像 + 名字 + 时间 + 多行长短不一的气泡内容）。
 */
export function MessageStreamSkeleton() {
  return (
    <div className={css.streamSkeleton} data-workforce-skeleton="messages" aria-busy="true" aria-label="载入消息中…">
      {/* 行 1：短消息 */}
      <div className={css.msgSkeleton}>
        <div className={`${css.msgAvatar} ${css.bone}`} />
        <div className={css.msgBody}>
          <div className={css.msgHead}>
            <div className={`${css.msgName} ${css.bone}`} style={{ width: '64px' }} />
            <div className={`${css.msgTime} ${css.bone}`} />
          </div>
          <div className={css.msgBubble} style={{ maxWidth: '65%' }}>
            <div className={`${css.line} ${css.bone}`} style={{ width: '88%' }} />
          </div>
        </div>
      </div>

      {/* 行 2：长回复 */}
      <div className={css.msgSkeleton}>
        <div className={`${css.msgAvatar} ${css.bone}`} />
        <div className={css.msgBody}>
          <div className={css.msgHead}>
            <div className={`${css.msgName} ${css.bone}`} style={{ width: '80px' }} />
            <div className={`${css.msgTime} ${css.bone}`} />
          </div>
          <div className={css.msgBubble} style={{ maxWidth: '85%' }}>
            <div className={`${css.line} ${css.bone}`} style={{ width: '92%' }} />
            <div className={`${css.line} ${css.bone}`} style={{ width: '76%' }} />
            <div className={`${css.line} ${css.bone}`} style={{ width: '48%' }} />
          </div>
        </div>
      </div>

      {/* 行 3：追问 */}
      <div className={css.msgSkeleton}>
        <div className={`${css.msgAvatar} ${css.bone}`} />
        <div className={css.msgBody}>
          <div className={css.msgHead}>
            <div className={`${css.msgName} ${css.bone}`} style={{ width: '56px' }} />
            <div className={`${css.msgTime} ${css.bone}`} />
          </div>
          <div className={css.msgBubble} style={{ maxWidth: '50%' }}>
            <div className={`${css.line} ${css.bone}`} style={{ width: '84%' }} />
          </div>
        </div>
      </div>

      {/* 行 4：回复 */}
      <div className={css.msgSkeleton}>
        <div className={`${css.msgAvatar} ${css.bone}`} />
        <div className={css.msgBody}>
          <div className={css.msgHead}>
            <div className={`${css.msgName} ${css.bone}`} style={{ width: '84px' }} />
            <div className={`${css.msgTime} ${css.bone}`} />
          </div>
          <div className={css.msgBubble} style={{ maxWidth: '78%' }}>
            <div className={`${css.line} ${css.bone}`} style={{ width: '96%' }} />
            <div className={`${css.line} ${css.bone}`} style={{ width: '60%' }} />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 侧栏频道/私信列表骨架屏。
 */
export function SidebarListSkeleton() {
  return (
    <div className={css.sidebarSkeleton} data-workforce-skeleton="sidebar" aria-busy="true">
      <div className={`${css.sidebarSectionHead} ${css.bone}`} />
      <div className={css.sidebarRow}>
        <div className={`${css.sidebarIcon} ${css.bone}`} />
        <div className={`${css.sidebarLabel} ${css.bone}`} style={{ width: '70%' }} />
      </div>
      <div className={css.sidebarRow}>
        <div className={`${css.sidebarIcon} ${css.bone}`} />
        <div className={`${css.sidebarLabel} ${css.bone}`} style={{ width: '55%' }} />
      </div>
      <div className={`${css.sidebarSectionHead} ${css.bone}`} style={{ marginTop: '14px' }} />
      <div className={css.sidebarRow}>
        <div className={`${css.sidebarIcon} ${css.bone}`} style={{ borderRadius: '50%' }} />
        <div className={`${css.sidebarLabel} ${css.bone}`} style={{ width: '65%' }} />
      </div>
      <div className={css.sidebarRow}>
        <div className={`${css.sidebarIcon} ${css.bone}`} style={{ borderRadius: '50%' }} />
        <div className={`${css.sidebarLabel} ${css.bone}`} style={{ width: '80%' }} />
      </div>
    </div>
  )
}

/**
 * 员工管理页卡片骨架屏。
 */
export function EmployeesPageSkeleton() {
  return (
    <div className={css.empListSkeleton} data-workforce-skeleton="employees" aria-busy="true">
      {[1, 2, 3].map(i => (
        <div key={i} className={css.empCardSkeleton}>
          <div className={`${css.empAvatar} ${css.bone}`} />
          <div className={css.empBody}>
            <div className={`${css.empName} ${css.bone}`} style={{ width: `${70 + i * 15}px` }} />
            <div className={`${css.empRole} ${css.bone}`} style={{ width: `${130 + i * 20}px` }} />
            <div className={`${css.empMeta} ${css.bone}`} style={{ width: `${90 + i * 25}px` }} />
          </div>
          <div className={`${css.empActions} ${css.bone}`} />
        </div>
      ))}
    </div>
  )
}

