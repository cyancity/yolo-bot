import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { Icon } from './icons.tsx'
import css from './choice.module.css'

export const Checkbox = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>>(function Checkbox({ className, ...props }, ref) {
  return <CheckboxPrimitive.Root {...props} ref={ref} className={`${css.checkbox} ${className ?? ''}`}>
    <CheckboxPrimitive.Indicator className={css.check}><Icon name="check" /></CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
})

export function RadioGroup({ value, onValueChange, label, items, disabled, className }: {
  readonly value: string; readonly onValueChange: (value: string) => void; readonly label: string
  readonly items: readonly { readonly value: string; readonly label: ReactNode; readonly disabled?: boolean }[]
  readonly disabled?: boolean; readonly className?: string
}) {
  return <RadioGroupPrimitive.Root value={value} onValueChange={onValueChange} aria-label={label} disabled={disabled ?? false} className={`${css.group} ${className ?? ''}`}>
    {items.map(item => <label key={item.value} className={css.option}>
      <RadioGroupPrimitive.Item value={item.value} disabled={item.disabled ?? false} className={css.radio}><RadioGroupPrimitive.Indicator className={css.dot} /></RadioGroupPrimitive.Item>
      <span>{item.label}</span>
    </label>)}
  </RadioGroupPrimitive.Root>
}
