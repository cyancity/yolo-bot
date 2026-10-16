/**
 * Interface scale plumbing: the live viewport width, the zoom derived from
 * it and the persisted preference, and the style props that apply it to a
 * workbench root (CSS `zoom`, so layout, text and borders all scale).
 */
import { useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { effectiveViewport, effectiveZoom, SIDEBAR_ZOOM_MAX, type ZoomPref } from '../prefs.ts'

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

/** Live viewport width in screen CSS px (re-renders on window resize). */
export function useViewportWidth(): number | undefined {
  return useSyncExternalStore(
    subscribeResize,
    () => window.innerWidth,
    () => undefined,
  )
}

/** Everything a zoomed root needs to size itself and its children. */
export interface ZoomState {
  /** Scale factor applied to the root. */
  readonly zoom: number
  /** Viewport width in zoomed px (raw width / zoom), or undefined outside a browser. */
  readonly viewport: number | undefined
  /** Raw viewport width in screen px. */
  readonly rawViewport: number | undefined
}

/**
 * Resolve the interface scale for the current window.
 * @param pref - the persisted preference (auto or a fixed factor).
 * @returns the factor plus the zoom-adjusted viewport width.
 */
export function useZoom(pref: ZoomPref): ZoomState {
  const raw = useViewportWidth()
  return { zoom: effectiveZoom(pref, raw), viewport: effectiveViewport(pref, raw), rawViewport: raw }
}

/**
 * Style props for a workbench root: CSS zoom plus the `--wb-zoom` variable
 * (children may read it, e.g. to convert screen px).
 * @param zoom - scale factor; 1 adds nothing.
 * @returns the inline style object.
 */
export function zoomStyle(zoom: number): CSSProperties {
  return zoom === 1 ? {} : ({ zoom, ['--wb-zoom' as string]: zoom } as CSSProperties)
}

/**
 * The sidebar sits in a host-owned fixed-px column, so it scales only up to
 * SIDEBAR_ZOOM_MAX; its collapsed 56px rail never scales.
 * @param zoom - the main surface's factor.
 * @param collapsed - whether the column is the icon rail.
 * @returns the factor for the sidebar root.
 */
export function sidebarZoom(zoom: number, collapsed: boolean): number {
  return collapsed ? 1 : Math.min(zoom, SIDEBAR_ZOOM_MAX)
}
