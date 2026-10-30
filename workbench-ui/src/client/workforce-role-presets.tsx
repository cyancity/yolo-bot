import { useEffect, useState } from 'react'
import { Input as LobeInput } from '@lobehub/ui'
import { Select as LobeSelect, Switch as LobeSwitch } from 'antd'
import { cx } from './ui/index.tsx'
import { WF } from './workforce-strings.ts'
import type { AgentCli, AgentCliStatus, EmployeeAgent, WebSearchStatus } from './workforce-types.ts'
import type { WorkforceSource } from './workforce-source.ts'
import css from './workforce.module.css'

/** Defaults a role preset writes into the new-employee form. */
export interface RolePreset {
  readonly name: string
  readonly title: string
  readonly persona: string
  readonly toolAccess: 'office' | 'development'
  readonly skills: readonly string[]
  readonly imageGeneration: boolean
  readonly webSearch: boolean
  readonly agent: EmployeeAgent | null
}

const AGENT_PREFERENCE: readonly AgentCli[] = ['codex', 'claude', 'kimi', 'opencode']
const FALLBACK_AGENT: AgentCli = 'codex'

export function rolePresets(clis: readonly AgentCliStatus[] | undefined): RolePreset[] {
  const cli = AGENT_PREFERENCE.map(id => clis?.find(item => item.id === id && item.installed)).find(Boolean)
  const agentLabel = cli?.label ?? 'Codex'
  const base = { skills: [], imageGeneration: false, webSearch: false, agent: null }
  return [
    { ...base, name: WF.roles.clerk, title: WF.roles.clerkTitle, persona: WF.roles.clerkPersona, toolAccess: 'office', skills: ['office-documents', 'document-to-action-items'] },
    { ...base, name: WF.roles.marketer, title: WF.roles.marketerTitle, persona: WF.roles.marketerPersona, toolAccess: 'office', skills: ['marketing-research', 'marketing-copywriting'], webSearch: true },
    { ...base, name: WF.image.designer, title: WF.image.designerTitle, persona: WF.image.designerPersona, toolAccess: 'office', imageGeneration: true },
    { ...base, name: WF.roles.developer, title: WF.roles.developerTitle, persona: WF.roles.developerPersona, toolAccess: 'development' },
    { ...base, name: WF.roles.agentDeveloper(agentLabel), title: WF.roles.agentDeveloperTitle, persona: WF.roles.agentDeveloperPersona, toolAccess: 'development', agent: { cli: cli?.id ?? FALLBACK_AGENT } },
  ]
}

export function RolePresets({ presets, onPick }: { readonly presets: readonly RolePreset[]; readonly onPick: (preset: RolePreset) => void }) {
  return (
    <div className={css.empField}>
      <label>{WF.roles.presets}</label>
      <div className={css.skillPickList}>
        {presets.map(preset => (
          <button key={preset.title} type="button" className={css.skillPick} onClick={() => onPick(preset)}>＋ {preset.name}</button>
        ))}
      </div>
    </div>
  )
}

/** Office employees only; development employees can always search. */
export function WebSearchField({ value, onChange, status }: {
  readonly value: boolean
  readonly onChange: (value: boolean) => void
  readonly status: WebSearchStatus | undefined
}) {
  return (
    <div className={css.empField}>
      <label className={css.empCheckboxLabel}>
        <LobeSwitch size="small" checked={value} onChange={onChange} />
        {WF.roles.webSearch}
      </label>
      {value && status?.configured === false && <span className={cx(css.empModelHint, css.imageWarning)}>{WF.roles.webSearchMissing}</span>}
    </div>
  )
}

export function ExternalAgentField({ value, onChange, clis, onRecheck }: {
  readonly value: EmployeeAgent | null
  readonly onChange: (value: EmployeeAgent | null) => void
  readonly clis: readonly AgentCliStatus[] | undefined
  readonly onRecheck: () => void
}) {
  const selected = value === null ? undefined : clis?.find(item => item.id === value.cli)
  const label = selected?.label ?? value?.cli ?? ''
  return (
    <div className={css.empField}>
      <label htmlFor="wf-employee-agent">{WF.roles.externalAgent}</label>
      <div className={css.agentFieldRow}>
        <LobeSelect
          id="wf-employee-agent"
          className={css.empInput ?? ''}
          value={value?.cli ?? ''}
          onChange={(cli: AgentCli | '') => onChange(cli ? { cli, ...(value?.model ? { model: value.model } : {}) } : null)}
          options={[
            { value: '', label: WF.roles.externalAgentNone },
            ...(clis ?? []).map(item => ({ value: item.id, label: item.installed ? item.label : `${item.label}（${WF.roles.notInstalled}）` })),
          ]}
        />
        {value !== null && (
          <LobeInput type="block" className={cx('wb-input', css.empInput)} aria-label={WF.roles.agentModel} value={value.model ?? ''} placeholder={WF.roles.agentModelPlaceholder}
            onChange={e => onChange({ cli: value.cli, ...(e.target.value.trim() ? { model: e.target.value } : {}) })} />
        )}
      </div>
      {value !== null && selected?.installed !== false && <span className={css.empModelHint}>{WF.roles.agentReady(label)}</span>}
      {value !== null && selected?.installed === false && (
        <span className={cx(css.empModelHint, css.imageWarning)}>
          {WF.roles.agentMissing(label)}{' '}
          <button type="button" className={css.imageLink} onClick={onRecheck}>{WF.roles.recheck}</button>
        </span>
      )}
    </div>
  )
}

/** Installed agent CLIs; `refresh` re-runs host detection after the user installs one. */
export function useAgentClis(source: WorkforceSource, version: number) {
  const [clis, setClis] = useState<readonly AgentCliStatus[] | undefined>()
  useEffect(() => {
    let alive = true
    void source.agentClis().then(value => { if (alive) setClis(value) }).catch(() => { if (alive) setClis(undefined) })
    return () => { alive = false }
  }, [source, version])
  const refresh = () => { void source.agentClis(true).then(setClis).catch(() => undefined) }
  return [clis, refresh] as const
}

export function useWebSearchStatus(source: WorkforceSource, version: number) {
  const [status, setStatus] = useState<WebSearchStatus | undefined>()
  useEffect(() => {
    let alive = true
    void source.webSearchStatus().then(value => { if (alive) setStatus(value) }).catch(() => { if (alive) setStatus(undefined) })
    return () => { alive = false }
  }, [source, version])
  return status
}
