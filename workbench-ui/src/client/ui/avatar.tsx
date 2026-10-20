import { useState, type CSSProperties } from 'react'
import LobeAvatar from '@lobehub/ui/es/Avatar'
import css from './avatar.module.css'

export interface AvatarProps {
  readonly name: string
  readonly src?: string
  readonly size?: 24 | 36 | 40 | number
  /** 状态点：idle 无点，working 有标记，unavailable 置灰。 */
  readonly presence?: 'idle' | 'working' | 'unavailable'
  /** 旁边已有姓名文本时 true（默认）；非装饰时 name 作为可访问名。 */
  readonly decorative?: boolean
  readonly color?: string
  readonly className?: string
}

/** 静态身份头像：图片失败回退名字首字。员工的动态 Morph Bot 头像走 WorkforceAvatar。 */
export function Avatar({ name, src, size = 36, presence, decorative = true, color, className }: AvatarProps) {
  const [imgFailed, setImgFailed] = useState(false)
  const initial = (name.trim()[0] ?? '?').toUpperCase()
  const style: CSSProperties = {
    width: `${size}px`,
    height: `${size}px`,
  }
  return (
    <span
      className={`${css.avatar} ${presence === 'unavailable' ? css.unavailable : ''} ${className ?? ''}`}
      style={style}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative ? true : undefined}
    >
      <LobeAvatar
        avatar={src && !imgFailed
          ? <img src={src} alt="" className={css.img} onError={() => setImgFailed(true)} />
          : initial}
        title={name}
        size={size}
        shape="circle"
        {...(color ? { background: color } : {})}
      />
      {presence === 'working' && <span className={css.dot} aria-hidden="true" />}
    </span>
  )
}
