import * as SwitchPrimitive from '@radix-ui/react-switch'
import { useId } from 'react'
import css from './switch.module.css'

export function Switch({ label, checked, disabled = false, onChange }: {
  readonly label: string; readonly checked: boolean; readonly disabled?: boolean; readonly onChange: (checked: boolean) => void
}) {
  const id = useId()
  return <label className={css.label} htmlFor={id}>
    <SwitchPrimitive.Root id={id} className={css.root} checked={checked} disabled={disabled} onCheckedChange={onChange}>
      <SwitchPrimitive.Thumb className={css.thumb} />
    </SwitchPrimitive.Root>
    <span>{label}</span>
  </label>
}
