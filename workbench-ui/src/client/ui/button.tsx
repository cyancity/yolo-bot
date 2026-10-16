import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import css from './button.module.css'

export type Size = 'sm' | 'md' | 'lg'
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
  readonly variant?: ButtonVariant
  readonly size?: Size
  readonly loading?: boolean
  readonly type?: 'button' | 'submit'
  readonly children?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, disabled, type = 'button', children, className, onClick, ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled}
      aria-disabled={loading ? true : undefined}
      aria-busy={loading ? true : undefined}
      data-variant={variant}
      className={`${css.button} ${css[variant]} ${css[size]} ${className ?? ''}`}
      onClick={loading ? e => e.preventDefault() : onClick}
    >
      {loading && <span className={css.spinner} aria-hidden="true" />}
      {children}
    </button>
  )
})
