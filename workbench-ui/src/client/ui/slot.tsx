import { cloneElement, forwardRef, isValidElement, type HTMLAttributes, type ReactElement, type Ref } from 'react'

/** Preserve the public asChild contract without adding a styling or interaction runtime. */
export const Slot = forwardRef<HTMLElement, HTMLAttributes<HTMLElement> & { disabled?: boolean; type?: string }>(function Slot({ children, ...props }, ref) {
  if (!isValidElement(children)) return null
  const child = children as ReactElement<Record<string, unknown>>
  const merged: Record<string, unknown> = { ...child.props, ...props }
  for (const key of Object.keys(props)) {
    const outer = props[key as keyof typeof props]
    const inner = child.props[key]
    if (/^on[A-Z]/.test(key) && typeof outer === 'function' && typeof inner === 'function') {
      merged[key] = (event: { defaultPrevented?: boolean }) => { if (props.disabled) { outer(event); return }; inner(event); if (!event.defaultPrevented) outer(event) }
    }
  }
  merged.className = [child.props.className, props.className].filter(Boolean).join(' ')
  merged.style = { ...(child.props.style as object), ...props.style }
  const childRef = (child as unknown as { ref?: Ref<HTMLElement> }).ref
  merged.ref = (element: HTMLElement | null) => {
    for (const target of [ref, childRef]) {
      if (typeof target === 'function') target(element)
      else if (target) (target as { current: HTMLElement | null }).current = element
    }
  }
  return cloneElement(child, merged)
})
