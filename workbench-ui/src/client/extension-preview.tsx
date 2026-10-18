import { createContext, useContext, type ReactNode } from 'react'
import type { WorkbenchPreview, WorkbenchPreviewOutletProps } from '../extension.ts'

type PreviewRenderer = (preview: WorkbenchPreview, fallback?: ReactNode) => ReactNode

export const WorkbenchPreviewContext = createContext<PreviewRenderer | null>(null)

/** Uses the main entry's authorized slot renderer, including across React portals. */
export function WorkbenchExtensionPreview({ preview, fallback }: WorkbenchPreviewOutletProps) {
  const render = useContext(WorkbenchPreviewContext)
  return render ? render(preview, fallback) : fallback ?? null
}

/** Recognizes only the public envelope; extensions validate their own payload. */
export function readExtensionPreview(value: unknown): WorkbenchPreview | undefined {
  if (value === null || typeof value !== 'object' || !('extensionPreview' in value)) return undefined
  const preview = value.extensionPreview
  if (preview === null || typeof preview !== 'object' || !('id' in preview)
    || typeof preview.id !== 'string' || preview.id.length === 0 || !('data' in preview)) return undefined
  return { id: preview.id, data: preview.data }
}
