import { Switch as AntSwitch } from 'antd'
import { useId } from 'react'
import css from './switch.module.css'
export function Switch({ label, checked, disabled = false, onChange }: { readonly label: string; readonly checked: boolean; readonly disabled?: boolean; readonly onChange: (checked: boolean) => void }) {
  const id = useId()
  return <label className={css.label} htmlFor={id}><AntSwitch id={id} checked={checked} disabled={disabled} onChange={onChange} /><span>{label}</span></label>
}
