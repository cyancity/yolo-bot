import { Checkbox as AntCheckbox, Radio, type CheckboxProps as AntCheckboxProps } from 'antd'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import css from './choice.module.css'
export interface CheckboxProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  readonly checked?: boolean | 'indeterminate'
  readonly defaultChecked?: boolean
  readonly onCheckedChange?: (checked: boolean | 'indeterminate') => void
}
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox({ checked, defaultChecked, onCheckedChange, disabled, className, id, name, value, 'aria-label': label, ...rest }, ref) {
  return <AntCheckbox {...(rest as unknown as AntCheckboxProps)} ref={instance => { const element = instance?.input as unknown as HTMLButtonElement | null; if (typeof ref === 'function') ref(element); else if (ref) ref.current = element }} {...(checked !== undefined ? { checked: checked === true } : {})} {...(defaultChecked !== undefined ? { defaultChecked } : {})} indeterminate={checked === 'indeterminate'} onChange={event => onCheckedChange?.(event.target.checked)} {...(disabled !== undefined ? { disabled } : {})} {...(className ? { className } : {})} {...(id ? { id } : {})} {...(name ? { name } : {})} {...(value !== undefined ? { value } : {})} {...(label ? { 'aria-label': label } : {})} />
})
export function RadioGroup({ value, onValueChange, label, items, disabled, className }: {
  readonly value: string; readonly onValueChange: (value: string) => void; readonly label: string
  readonly items: readonly { readonly value: string; readonly label: ReactNode; readonly disabled?: boolean }[]
  readonly disabled?: boolean; readonly className?: string
}) {
  return <Radio.Group value={value} onChange={event => onValueChange(event.target.value)} aria-label={label} disabled={disabled ?? false} className={`${css.group} ${className ?? ''}`}>{items.map(item => <Radio key={item.value} value={item.value} disabled={Boolean(disabled || item.disabled)}>{item.label}</Radio>)}</Radio.Group>
}
