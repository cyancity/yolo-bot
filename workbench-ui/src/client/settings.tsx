/** Core interface settings inside the official settings shell. */
import { useState } from 'react'
import { Radio as LobeRadio, Select as LobeSelect } from 'antd'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { WorkbenchNavActions, WorkbenchNavState } from './nav.ts'
import type { WorkbenchChromeProps } from '../extension.ts'
import type { PrefsSource, ZoomPref } from './prefs.ts'
import type { PreferenceFields } from '../extension.ts'
import { ZOOM_CHOICES, normalizeZoom, normalizeLocale, LOCALE_FIELD, SIDEBAR_TAKEOVER_FIELD } from './prefs.ts'
import { Switch, WorkbenchSurface } from './ui/index.tsx'
import { useZoom } from './ui/zoom.ts'
import { S } from './strings.ts'
import { WF } from './workforce-strings.ts'
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
  const localePref = normalizeLocale(props.usePrefs(value => value[LOCALE_FIELD]))
  const takeover = props.usePrefs(value => value[SIDEBAR_TAKEOVER_FIELD] !== false)
  const [prefs, setPrefs] = useWorkforcePrefs()
  const [error, setError] = useState<string>()
  return <WorkbenchSurface className={css.section} style={{ height: 'auto', display: 'block' }}>
    <section className={css.group}>
      <h3 className={css.groupTitle}>{S.settings.interface}</h3>
      <label className={css.row}>
        <span className={css.rowLabel}>{S.nav.zoom}</span>
        <LobeSelect aria-label={S.nav.zoom} value={String(zoomPref)} onChange={value => {
          const next = value === 'auto' ? 'auto' : Number(value)
          void props.setZoom(next).then(() => setError(undefined), failure => setError(failure instanceof Error ? failure.message : String(failure)))
        }} options={[
          { value: 'auto', label: S.nav.zoomAuto(zoom) },
          ...ZOOM_CHOICES.map(choice => ({ value: String(choice), label: `${Math.round(choice * 1000) / 10}%` })),
        ]} />
      </label>
      <label className={css.row}>
        <span className={css.rowLabel}>{S.settings.languageLabel}</span>
        <LobeSelect aria-label={S.settings.languageLabel} value={localePref} onChange={value => void props.patchPrefs({ [LOCALE_FIELD]: normalizeLocale(value) })} options={[{ value: 'auto', label: S.settings.languageAuto }, { value: 'zh', label: S.settings.languageZh }, { value: 'en', label: S.settings.languageEn }]} />
      </label>
      {error && <p role="alert">{error}</p>}
      <Switch label={S.settings.sidebarTakeover} checked={takeover}
        onChange={checked => void props.patchPrefs({ [SIDEBAR_TAKEOVER_FIELD]: checked })} />
    </section>
    <section className={css.group}>
      <h3 className={css.groupTitle}>{S.settings.appearance}</h3>
      <fieldset className={css.radioGroup}>
        <legend className={css.rowLabel}>{WF.settings.layoutTitle}</legend>
        <LobeRadio.Group className={css.radioOptions ?? ''} value={prefs.style} onChange={event => setPrefs({ style: event.target.value as WorkforceStyle })}>
          <LobeRadio value="discord">{WF.settings.layoutDiscord}</LobeRadio>
          <LobeRadio value="wechat">{WF.settings.layoutWechat}</LobeRadio>
        </LobeRadio.Group>
      </fieldset>
      <fieldset className={css.radioGroup}>
        <legend className={css.rowLabel}>{S.settings.schemeLabel}</legend>
        <LobeRadio.Group className={css.radioOptions ?? ''} value={prefs.scheme} onChange={event => setPrefs({ scheme: event.target.value as WorkforceScheme })}>
          <LobeRadio value="system">{S.settings.schemeSystem}</LobeRadio>
          <LobeRadio value="light">{S.settings.schemeLight}</LobeRadio>
          <LobeRadio value="dark">{S.settings.schemeDark}</LobeRadio>
        </LobeRadio.Group>
      </fieldset>
      <Switch label={S.settings.showSteps} checked={prefs.showSteps}
        onChange={checked => setPrefs({ showSteps: checked })} />
    </section>
    {props.renderSlot('workbench.settings', chrome)}
  </WorkbenchSurface>
}
