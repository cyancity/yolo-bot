import { useState } from 'react'
import { Icon, type IconName } from './icons.tsx'
import ui from './ui.module.css'
/** Broken and missing images share a stable fallback. A new URL resets the failure state. */
export function Thumbnail({ src, label, icon = 'video', hideOnError = false }: { src?: string | undefined; label: string; icon?: IconName; hideOnError?: boolean }) {
  const [failed, setFailed] = useState<string>()
  if (hideOnError && (!src || failed === src)) return null
  return <span className={ui.thumbnail} data-thumbnail-fallback={!src || failed === src ? '' : undefined}>
    {src && failed !== src ? <img src={src} alt={label} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(src)} /> : <Icon name={icon} />}
  </span>
}
export function SectionTitle({ icon, tone = 'accent', children }: { icon: IconName; tone?: string; children: React.ReactNode }) {
  return <span className={ui.sectionHeading}><span className={ui.iconBlock} data-tone={tone}><Icon name={icon} /></span>{children}</span>
}
