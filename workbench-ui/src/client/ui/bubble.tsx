import type { HTMLAttributes, ReactNode } from 'react'
import css from './bubble.module.css'

export interface BubbleProps extends HTMLAttributes<HTMLDivElement> {
  readonly side: 'self' | 'peer'
  readonly children?: ReactNode
}

/** 只画消息容器；作者/时间/状态由 MessageItem 负责。Discord 普通正文不使用。 */
export function Bubble({ side, children, className, ...rest }: BubbleProps) {
  return (
    <div {...rest} className={`${css.bubble} ${css[side]} ${className ?? ''}`} data-bubble-side={side}>
      {children}
    </div>
  )
}
