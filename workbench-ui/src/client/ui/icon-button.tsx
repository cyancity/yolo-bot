import { Button as AntButton, type ButtonProps as AntButtonProps } from 'antd'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react'
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
  return <AntButton
    {...(rest as AntButtonProps)}
    ref={ref as Ref<HTMLButtonElement | HTMLAnchorElement>}
    htmlType="button"
    type={pressed || !ghost ? 'default' : 'text'}
    icon={<span className={css.icon} aria-hidden="true">{icon}</span>}
    size={size === 'sm' ? 'small' : size === 'lg' ? 'large' : 'middle'}
    loading={loading}
    disabled={Boolean(disabled)}
    aria-label={label}
    title={label}
    aria-pressed={pressed}
    aria-busy={loading ? true : undefined}
    className={`${css.iconButton} ${css[size] ?? ''} ${className ?? ''}`}
    onClick={loading ? e => e.preventDefault() : onClick}
  />
})
