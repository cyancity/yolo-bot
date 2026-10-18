import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { Slot } from '@radix-ui/react-slot'
import css from './empty-state.module.css'

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 图标或插图插槽 */
  readonly icon?: ReactNode
  /** 空状态主标题 */
  readonly title?: ReactNode
  /** 空状态辅助描述说明 */
  readonly description?: ReactNode
  /** 操作按钮或操作区插槽 */
  readonly action?: ReactNode
  /** 紧凑尺寸模式（适合侧栏、嵌入列表与小卡片） */
  readonly compact?: boolean
  readonly asChild?: boolean
  /** 自定义扩展内容插槽（如推荐提问卡片组、快捷启动按键等） */
  readonly children?: ReactNode
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { icon, title, description, action, compact = false, asChild = false, className, children, ...rest },
  ref,
) {
  const Component = asChild ? Slot : 'div'
  return (
    <Component
      {...rest}
      ref={ref}
      data-compact={compact ? '' : undefined}
      className={`${css.emptyState} ${compact ? css.compact : ''} ${className ?? ''}`}
    >
      {asChild ? (
        children
      ) : (
        <>
          {icon && <div className={css.iconWrap} aria-hidden="true">{icon}</div>}
          {title && <h3 className={css.title}>{title}</h3>}
          {description && <p className={css.description}>{description}</p>}
          {action && <div className={css.actions}>{action}</div>}
          {children && <div className={css.content}>{children}</div>}
        </>
      )}
    </Component>
  )
})
