/** Core interface settings inside the official settings shell. */
import { useState } from 'react'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { WorkbenchNavActions, WorkbenchNavState } from './nav.ts'
import type { WorkbenchChromeProps } from '../extension.ts'
import type { PrefsSource, ZoomPref } from './prefs.ts'
import type { PreferenceFields } from '../extension.ts'
import { ZOOM_CHOICES, normalizeZoom, SIDEBAR_TAKEOVER_FIELD } from './prefs.ts'
import { Select, Switch, WorkbenchSurface } from './ui/index.tsx'
import { useZoom } from './ui/zoom.ts'
import { S } from './strings.ts'
import { useWorkforcePrefs, type WorkforceScheme, type WorkforceStyle } from './workforce-prefs.ts'
import css from './settings.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { 'settings.section': { kind: 'list'; scope: 'root'; owner: { close: () => void } } }
}
export interface WorkbenchSettingsInjected {
  setZoom(zoom: ZoomPref): Promise<void>
  patchPrefs(fields: PreferenceFields): Promise<void>
  readonly hooks: { prefs: PrefsSource }
  readonly chrome: WorkbenchChromeProps
}
export type WorkbenchSettingsSectionProps = ComposedProps<'settings.section', string, 'workbench.settings', EngineStoreHandle<WorkbenchNavState, WorkbenchNavActions>, WorkbenchSettingsInjected>
export function WorkbenchSettingsSection(props: WorkbenchSettingsSectionProps) {
  const view = props.useStore(value => value.view)
  const chrome: WorkbenchChromeProps = { ...props.chrome, activePageId: view.kind === 'extension' ? view.id : null }
  const zoomPref = normalizeZoom(props.usePrefs(value => value.zoom))
  const { zoom } = useZoom(zoomPref)
  const takeover = props.usePrefs(value => value[SIDEBAR_TAKEOVER_FIELD] !== false)
  const [prefs, setPrefs] = useWorkforcePrefs()
  const [error, setError] = useState<string>()
  return <WorkbenchSurface className={css.section} style={{ height: 'auto', display: 'block' }}>
    <section className={css.group}>
      <h3 className={css.groupTitle}>{S.settings.interface}</h3>
      <label className={css.row}>
        <span className={css.rowLabel}>{S.nav.zoom}</span>
        <Select aria-label={S.nav.zoom} value={String(zoomPref)} onChange={event => {
          const next = event.target.value === 'auto' ? 'auto' : Number(event.target.value)
          void props.setZoom(next).then(() => setError(undefined), failure => setError(failure instanceof Error ? failure.message : String(failure)))
        }}>
          <option value="auto">{S.nav.zoomAuto(zoom)}</option>
          {ZOOM_CHOICES.map(choice => <option key={choice} value={String(choice)}>{Math.round(choice * 1000) / 10}%</option>)}
        </Select>
      </label>
      {error && <p role="alert">{error}</p>}
      <Switch label={S.settings.sidebarTakeover} checked={takeover}
        onChange={checked => void props.patchPrefs({ [SIDEBAR_TAKEOVER_FIELD]: checked })} />
    </section>
    <section className={css.group}>
      <h3 className={css.groupTitle}>{S.settings.appearance}</h3>
      <fieldset className={css.radioGroup}>
        <legend className={css.rowLabel}>{S.settings.styleLabel}</legend>
        {(['discord', 'wechat'] as WorkforceStyle[]).map(value => (
          <label key={value} className={css.radioRow}>
            <input type="radio" name="wb-style" checked={prefs.style === value}
              onChange={() => setPrefs({ style: value })} />
            <span>{value === 'discord' ? S.settings.styleDiscord : S.settings.styleWechat}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className={css.radioGroup}>
        <legend className={css.rowLabel}>{S.settings.schemeLabel}</legend>
        {(['system', 'light', 'dark'] as WorkforceScheme[]).map(value => (
          <label key={value} className={css.radioRow}>
            <input type="radio" name="wb-scheme" checked={prefs.scheme === value}
              onChange={() => setPrefs({ scheme: value })} />
            <span>{value === 'system' ? S.settings.schemeSystem : value === 'light' ? S.settings.schemeLight : S.settings.schemeDark}</span>
          </label>
        ))}
      </fieldset>
      <Switch label={S.settings.showSteps} checked={prefs.showSteps}
        onChange={checked => setPrefs({ showSteps: checked })} />
    </section>
    {props.renderSlot('workbench.settings', chrome)}
  </WorkbenchSurface>
}
