import { Button as AntButton, type ButtonProps as AntButtonProps } from 'antd'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react'
import css from './button.module.css'
import { Slot } from './slot.tsx'

export type Size = 'sm' | 'md' | 'lg'
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'plain'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
  readonly variant?: ButtonVariant
  readonly size?: Size
  readonly loading?: boolean
  readonly type?: 'button' | 'submit'
  readonly children?: ReactNode
  readonly asChild?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, disabled, type = 'button', children, className, onClick, asChild = false, ...rest },
  ref,
) {
  if (asChild) return <Slot {...rest} ref={ref} type={type} disabled={Boolean(disabled || loading)} className={className} aria-disabled={disabled || loading} aria-busy={loading || undefined} onClick={disabled || loading ? event => { event.preventDefault(); event.stopPropagation() } : onClick}>{children}</Slot>
  return <AntButton
    {...(rest as AntButtonProps)}
    ref={ref as Ref<HTMLButtonElement | HTMLAnchorElement>}
    htmlType={type}
    type={variant === 'primary' || variant === 'danger' ? 'primary' : variant === 'ghost' || variant === 'plain' ? 'text' : 'default'}
    danger={variant === 'danger'}
    size={size === 'sm' ? 'small' : size === 'lg' ? 'large' : 'middle'}
    loading={loading}
    disabled={Boolean(disabled)}
    aria-disabled={loading ? true : undefined}
    aria-busy={loading ? true : undefined}
    data-variant={variant}
    className={`${css.button} ${className ?? ''}`}
    onClick={loading ? e => e.preventDefault() : onClick}
  >{children}</AntButton>
})
