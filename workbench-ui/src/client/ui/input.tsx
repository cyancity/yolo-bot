import { forwardRef, useId, type ChangeEvent, type ReactNode, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import css from './input.module.css'

/** shadcn text controls; native props allow incremental migration of existing forms. */
export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...props }, ref) {
  return <input {...props} ref={ref} className={`${css.control} ${className ?? ''}`} />
})
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea {...props} ref={ref} className={`${css.control} ${className ?? ''}`} />
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
    disabled,
    readOnly,
    required,
    placeholder,
    autoComplete,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : undefined,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onValueChange(e.target.value),
    className: css.control,
  }
  return (
    <div className={css.field} data-invalid={error ? 'true' : undefined}>
      <label className={css.label} htmlFor={fieldId}>
        {label}{required && <span className={css.required} aria-hidden="true"> *</span>}
      </label>
      {kind === 'multiline' ? (
        <textarea {...shared} rows={rows} ref={ref as never} />
      ) : (
        <div className={css.inputWrap}>
          <input {...shared} type={kind === 'search' ? 'search' : kind} ref={ref as never} />
          {trailing && <span className={css.trailing}>{trailing}</span>}
        </div>
      )}
      {hint && <p className={css.hint} id={hintId}>{hint}</p>}
      {error && <p className={css.error} id={errorId} role="alert">{error}</p>}
    </div>
  )
})
