import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { Slot } from '@radix-ui/react-slot'
import css from './card.module.css'

export type CardVariant = 'default' | 'interactive' | 'subtle'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  readonly variant?: CardVariant
  readonly selected?: boolean
  readonly asChild?: boolean
  readonly children?: ReactNode
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { variant = 'default', selected = false, asChild = false, className, children, ...rest },
  ref,
) {
  const Component = asChild ? Slot : 'div'
  return (
    <Component
      {...rest}
      ref={ref}
      data-variant={variant}
      data-selected={selected ? '' : undefined}
      aria-selected={selected ? true : undefined}
      className={`${css.card} ${css[variant]} ${selected ? css.selected : ''} ${className ?? ''}`}
    >
      {children}
    </Component>
  )
})

export interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  readonly asChild?: boolean
  readonly children?: ReactNode
}

export const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(function CardHeader(
  { asChild = false, className, children, ...rest },
  ref,
) {
  const Component = asChild ? Slot : 'div'
  return (
    <Component {...rest} ref={ref} className={`${css.header} ${className ?? ''}`}>
      {children}
    </Component>
  )
})

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  readonly asChild?: boolean
  readonly children?: ReactNode
}

export const CardTitle = forwardRef<HTMLHeadingElement, CardTitleProps>(function CardTitle(
  { asChild = false, className, children, ...rest },
  ref,
) {
  const Component = asChild ? Slot : 'h3'
  return (
    <Component {...rest} ref={ref} className={`${css.title} ${className ?? ''}`}>
      {children}
    </Component>
  )
})

export interface CardDescriptionProps extends HTMLAttributes<HTMLParagraphElement> {
  readonly asChild?: boolean
  readonly children?: ReactNode
}

export const CardDescription = forwardRef<HTMLParagraphElement, CardDescriptionProps>(function CardDescription(
  { asChild = false, className, children, ...rest },
  ref,
) {
  const Component = asChild ? Slot : 'p'
  return (
    <Component {...rest} ref={ref} className={`${css.description} ${className ?? ''}`}>
      {children}
    </Component>
  )
})

export interface CardContentProps extends HTMLAttributes<HTMLDivElement> {
  readonly asChild?: boolean
  readonly children?: ReactNode
}

export const CardContent = forwardRef<HTMLDivElement, CardContentProps>(function CardContent(
  { asChild = false, className, children, ...rest },
  ref,
) {
  const Component = asChild ? Slot : 'div'
  return (
    <Component {...rest} ref={ref} className={`${css.content} ${className ?? ''}`}>
      {children}
    </Component>
  )
})

export interface CardFooterProps extends HTMLAttributes<HTMLDivElement> {
  readonly asChild?: boolean
  readonly children?: ReactNode
}

export const CardFooter = forwardRef<HTMLDivElement, CardFooterProps>(function CardFooter(
  { asChild = false, className, children, ...rest },
  ref,
) {
  const Component = asChild ? Slot : 'div'
  return (
    <Component {...rest} ref={ref} className={`${css.footer} ${className ?? ''}`}>
      {children}
    </Component>
  )
})
