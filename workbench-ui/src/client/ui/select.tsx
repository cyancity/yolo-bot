import { Select as AntSelect } from 'antd'
import { Children, forwardRef, isValidElement, useState, type ChangeEvent, type ReactNode, type SelectHTMLAttributes } from 'react'
import { useOverlayTarget } from './root.tsx'
type Item = { value: string; label: ReactNode; disabled: boolean; group?: string | undefined }
function readOptions(children: ReactNode, inheritedDisabled = false, group?: string): Item[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean; label?: string }>(child)) return []
    if (child.type !== 'option') return readOptions(child.props.children, inheritedDisabled || child.props.disabled === true, child.type === 'optgroup' ? child.props.label : group)
    return [{ value: String(child.props.value ?? child.props.children ?? ''), label: child.props.children, disabled: inheritedDisabled || child.props.disabled === true, group }]
  })
}
/** Public native-select values and change events are adapted to the native Lobe control. */
export const Select = forwardRef<HTMLButtonElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ children, className, value, defaultValue, onChange, disabled, required, name, form, id, 'aria-label': label, ...rest }, ref) {
  const overlay = useOverlayTarget()
  const options = readOptions(children)
  const dropdownOptions: Array<Item | { label: string; options: Item[] }> = []
  for (const item of options) {
    if (!item.group) { dropdownOptions.push(item); continue }
    const previous = dropdownOptions[dropdownOptions.length - 1]
    if (previous && 'options' in previous && previous.label === item.group) previous.options.push(item)
    else dropdownOptions.push({ label: item.group, options: [item] })
  }
  const [localValue, setLocalValue] = useState(() => String(defaultValue ?? options.find(item => !item.disabled)?.value ?? ''))
  const selected = String(value ?? localValue)
  return <><AntSelect {...(id ? { id } : {})} value={selected} options={dropdownOptions} {...(disabled !== undefined ? { disabled } : {})} className={className ?? ''} aria-label={label} aria-labelledby={rest['aria-labelledby']} aria-describedby={rest['aria-describedby']} aria-invalid={rest['aria-invalid']} {...(rest.title ? { title: rest.title } : {})} getPopupContainer={trigger => trigger.closest('dialog') ?? overlay ?? document.body} ref={instance => { const element = instance?.nativeElement as unknown as HTMLButtonElement | null; if (typeof ref === 'function') ref(element); else if (ref) ref.current = element }} onChange={next => {
    setLocalValue(next)
    if (!onChange) return
    const target = document.createElement('select')
    for (const option of options) target.add(new Option(String(option.label ?? ''), option.value))
    target.value = next; target.disabled = disabled ?? false; if (name) target.name = name; if (id) target.id = id
    const nativeEvent = new Event('change', { bubbles: true })
    onChange({ target, currentTarget: target, nativeEvent, type: 'change', bubbles: true, cancelable: false, defaultPrevented: false, preventDefault: () => nativeEvent.preventDefault(), stopPropagation: () => nativeEvent.stopPropagation(), isDefaultPrevented: () => nativeEvent.defaultPrevented, isPropagationStopped: () => false, persist: () => {} } as ChangeEvent<HTMLSelectElement>)
  }} />{name && <select hidden tabIndex={-1} aria-hidden="true" name={name} form={form} value={selected} required={required} disabled={disabled} onChange={() => {}}>{options.map((item, index) => <option key={index} value={item.value}>{typeof item.label === 'string' ? item.label : item.value}</option>)}</select>}</>
})
