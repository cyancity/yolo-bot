import { Input as AntInput, type InputProps as AntInputProps } from 'antd'
import { Input as LobeInput, TextArea as LobeTextArea, type TextAreaProps as LobeTextAreaProps } from '@lobehub/ui/es/Input'
import { forwardRef, useId, type ChangeEvent, type ForwardedRef, type ReactNode, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import css from './input.module.css'

function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === 'function') ref(value)
  else if (ref) ref.current = value
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, type, size, ...props }, ref) {
  return <AntInput {...(props as AntInputProps)} {...(size !== undefined ? { htmlSize: size } : {})} {...(type ? { type } : {})} className={className ?? ''} ref={instance => assignRef(ref, instance?.input ?? null)} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <LobeTextArea {...(props as LobeTextAreaProps)} type="block" className={className ?? ''} ref={instance => assignRef(ref, instance?.resizableTextArea?.textArea ?? null)} />
})

export interface InputProps {
  readonly id?: string
  readonly label: string
  readonly value: string
  readonly onValueChange: (value: string) => void
  readonly kind?: 'text' | 'search' | 'password' | 'multiline'
  readonly hint?: string
  readonly error?: string
  readonly disabled?: boolean
  readonly readOnly?: boolean
  readonly required?: boolean
  readonly rows?: number
  readonly placeholder?: string
  readonly autoComplete?: string
  readonly trailing?: ReactNode
}

export const Input = forwardRef<HTMLInputElement | HTMLTextAreaElement, InputProps>(function Input(
  { id, label, value, onValueChange, kind = 'text', hint, error, disabled, readOnly, required, rows = 3, placeholder, autoComplete, trailing },
  ref,
) {
  const autoId = useId()
  const fieldId = id ?? `wb-input-${autoId}`
  const hintId = hint ? `${fieldId}-hint` : undefined
  const errorId = error ? `${fieldId}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  const shared = {
    id: fieldId,
    value,
    ...(disabled !== undefined ? { disabled } : {}),
    ...(readOnly !== undefined ? { readOnly } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(autoComplete !== undefined ? { autoComplete } : {}),
    ...(describedBy !== undefined ? { 'aria-describedby': describedBy } : {}),
    ...(error ? { 'aria-invalid': true } : {}),
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onValueChange(e.target.value),
  }
  return (
    <div className={css.field} data-invalid={error ? 'true' : undefined}>
      <label className={css.label} htmlFor={fieldId}>
        {label}{required && <span className={css.required} aria-hidden="true"> *</span>}
      </label>
      {kind === 'multiline' ? <LobeTextArea
        {...shared}
        className={css.control ?? ''}
        type="block"
        {...(error ? { status: 'error' as const } : {})}
        rows={rows}
        ref={instance => assignRef(ref, instance?.resizableTextArea?.textArea ?? null)}
      /> : kind === 'text' ? <LobeInput
        {...shared}
        className={css.control ?? ''}
        type="block"
        {...(error ? { status: 'error' as const } : {})}
        {...(trailing !== undefined ? { suffix: trailing } : {})}
        ref={instance => assignRef(ref, instance?.input ?? null)}
      /> : <AntInput
        {...shared}
        className={css.control ?? ''}
        type={kind}
        {...(error ? { status: 'error' as const } : {})}
        {...(trailing !== undefined ? { suffix: trailing } : {})}
        ref={instance => assignRef(ref, instance?.input ?? null)}
      />}
      {hint && <p className={css.hint} id={hintId}>{hint}</p>}
      {error && <p className={css.error} id={errorId} role="alert">{error}</p>}
    </div>
  )
})
