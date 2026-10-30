import { useEffect, useRef } from 'react'

/** Esc closes a side panel; typing in a field, an open dialog, or an open dropdown keeps the key for itself. */
export function useEscapeClose(onClose: () => void): void {
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      if (document.querySelector('[role="dialog"], .ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-dropdown:not(.ant-dropdown-hidden)')) return
      latest.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}
