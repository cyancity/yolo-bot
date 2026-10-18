import { useLayoutEffect, useRef } from 'react'

/** The pinned layout exposes only a destructive toggle, so presentation never writes its store. */
export function IndependentSidebarPresentation({ hidden }: { readonly hidden: boolean }) {
  const marker = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (!hidden || !marker.current) return
    let frame = marker.current.parentElement
    while (frame && !frame.style.gridTemplateColumns) frame = frame.parentElement
    if (!frame) return
    const target = frame
    const previousColumns = target.style.getPropertyValue('--wb-independent-grid-columns')
    const previousPresentation = target.getAttribute('data-wb-sidebar-presentation')
    const sync = () => {
      const rest = target.style.gridTemplateColumns.match(/^\S+\s+(.+)$/)?.[1]
      const rail = marker.current && getComputedStyle(marker.current).getPropertyValue('--wb-rail-width').trim()
      if (!rest || !rail) return
      const columns = `${rail} ${rest}`
      if (target.style.getPropertyValue('--wb-independent-grid-columns') !== columns) {
        target.style.setProperty('--wb-independent-grid-columns', columns)
      }
      target.setAttribute('data-wb-sidebar-presentation', 'hidden')
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(target, { attributes: true, attributeFilter: ['style'] })
    return () => {
      observer.disconnect()
      if (previousColumns) target.style.setProperty('--wb-independent-grid-columns', previousColumns)
      else target.style.removeProperty('--wb-independent-grid-columns')
      if (previousPresentation === null) target.removeAttribute('data-wb-sidebar-presentation')
      else target.setAttribute('data-wb-sidebar-presentation', previousPresentation)
    }
  }, [hidden])
  return <span ref={marker} hidden />
}
