import * as SelectPrimitive from '@radix-ui/react-select'
import { Children, Fragment, forwardRef, isValidElement, useState, type ChangeEvent, type ReactNode, type SelectHTMLAttributes } from 'react'
import { useOverlayTarget } from './root.tsx'
import { Icon } from './icons.tsx'
import css from './select.module.css'

type OptionGroup = { label: string; disabled: boolean }
type Option = { value: string; label: ReactNode; disabled: boolean; group?: OptionGroup | undefined }
const EMPTY_VALUE = '__wb_select_empty__'
const encode = (value: string) => value === '' ? EMPTY_VALUE : value

function readOptions(children: ReactNode, group?: OptionGroup): Option[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean; label?: string }>(child)) return []
    if (child.type === 'optgroup') return readOptions(child.props.children, { label: child.props.label ?? '', disabled: child.props.disabled === true })
    if (child.type !== 'option') return readOptions(child.props.children, group)
    return [{ value: String(child.props.value ?? child.props.children ?? ''), label: child.props.children, disabled: child.props.disabled === true || group?.disabled === true, group }]
  })
}

/** shadcn's Radix Select composition, with the existing native-select props contract. */
export const Select = forwardRef<HTMLButtonElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { children, className, value, defaultValue, onChange, disabled, required, name, form, id, 'aria-label': ariaLabel, 'aria-labelledby': labelledBy, ...rest }, ref,
) {
  const overlay = useOverlayTarget()
  const options = readOptions(children)
  const groups: { group: OptionGroup | undefined; start: number; options: Option[] }[] = []
  for (const [index, option] of options.entries()) {
    const previous = groups[groups.length - 1]
    if (previous && previous.group === option.group) previous.options.push(option)
    else groups.push({ group: option.group, start: index, options: [option] })
  }
  const renderOption = (option: Option, index: number) => <SelectPrimitive.Item key={`${option.value}:${index}`} value={encode(option.value)} disabled={option.disabled} className={css.item}>
    <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className={css.indicator}><Icon name="check" /></SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
  const [localValue, setLocalValue] = useState(() => String(defaultValue ?? options.find(option => !option.disabled)?.value ?? ''))
  const selected = String(value ?? localValue)
  const change = (next: string) => {
    const decoded = next === EMPTY_VALUE ? '' : next
    setLocalValue(decoded)
    if (onChange) {
      const target = document.createElement('select')
      for (const option of options) target.add(new Option(String(option.label ?? ''), option.value))
      target.value = decoded
      target.disabled = disabled ?? false
      if (name) target.name = name
      if (id) target.id = id
      const nativeEvent = new Event('change', { bubbles: true })
      onChange({ target, currentTarget: target, nativeEvent, type: 'change', bubbles: true, cancelable: false, defaultPrevented: false,
        preventDefault: () => nativeEvent.preventDefault(), stopPropagation: () => nativeEvent.stopPropagation(),
        isDefaultPrevented: () => nativeEvent.defaultPrevented, isPropagationStopped: () => false, persist: () => {},
      } as ChangeEvent<HTMLSelectElement>)
    }
  }
  return <SelectPrimitive.Root value={encode(selected)} onValueChange={change} disabled={disabled ?? false} required={required ?? false} {...(name ? { name } : {})} {...(form ? { form } : {})}>
    <SelectPrimitive.Trigger ref={ref} id={id} value={selected} aria-label={ariaLabel} aria-labelledby={labelledBy} aria-describedby={rest['aria-describedby']} aria-invalid={rest['aria-invalid']} title={rest.title} className={`${css.trigger} ${className ?? ''}`}>
      <SelectPrimitive.Value />
      <SelectPrimitive.Icon className={css.icon}><Icon name="chevronDown" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal container={overlay ?? undefined}>
      <SelectPrimitive.Content className={css.content} position="popper" sideOffset={4} align="start">
        <SelectPrimitive.ScrollUpButton className={css.scroll}><Icon name="chevronDown" /></SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className={css.viewport}>
          {groups.map(({ group, start, options: items }) => group
            ? <SelectPrimitive.Group key={start} className={css.group}>
                <SelectPrimitive.Label className={css.groupLabel}>{group.label}</SelectPrimitive.Label>
                {items.map((option, index) => renderOption(option, start + index))}
              </SelectPrimitive.Group>
            : <Fragment key={start}>{items.map((option, index) => renderOption(option, start + index))}</Fragment>)}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className={css.scroll}><Icon name="chevronDown" /></SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  </SelectPrimitive.Root>
})
