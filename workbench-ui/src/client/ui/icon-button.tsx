import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import css from './icon-button.module.css'
import type { Size } from './button.tsx'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type'> {
  /** 可访问名称（必填）：图标无文字，label 作为 aria-label/title。 */
  readonly label: string
  readonly icon: ReactNode
  readonly size?: Size
  readonly loading?: boolean
  /** 真正切换态（aria-pressed）；普通选中导航不要用。 */
  readonly pressed?: boolean
  readonly ghost?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'md', loading = false, pressed, ghost = true, disabled, className, onClick, ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-busy={loading ? true : undefined}
      className={`${css.iconButton} ${css[size]} ${ghost ? css.ghost : css.secondary} ${pressed ? css.pressed : ''} ${className ?? ''}`}
      onClick={loading ? e => e.preventDefault() : onClick}
    >
      <span className={css.icon} aria-hidden="true">{icon}</span>
    </button>
  )
})
