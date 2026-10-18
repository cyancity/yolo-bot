import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import css from './button.module.css'
import { Slot } from '@radix-ui/react-slot'

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
  const Component = asChild ? Slot : 'button'
  return (
    <Component
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-disabled={loading ? true : undefined}
      aria-busy={loading ? true : undefined}
      data-variant={variant}
      className={`${variant === 'plain' ? css.plain : `${css.button} ${css[variant]} ${css[size]}`} ${className ?? ''}`}
      onClick={loading ? e => e.preventDefault() : onClick}
    >
      {asChild ? children : <>{loading && <span className={css.spinner} aria-hidden="true" />}{children}</>}
    </Component>
  )
})
