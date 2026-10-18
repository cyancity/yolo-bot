import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import css from './bubble.module.css'

export interface BubbleProps extends HTMLAttributes<HTMLDivElement> {
  readonly side: 'self' | 'peer'
  readonly children?: ReactNode
}

/** 只画消息容器；作者/时间/状态由 MessageItem 负责。Discord 普通正文不使用。 */
export const Bubble = forwardRef<HTMLDivElement, BubbleProps>(function Bubble(
  { side, children, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      {...rest}
      className={`${css.bubble} ${css[side]} ${className ?? ''}`}
      data-bubble-side={side}
    >
      {children}
    </div>
  )
})
