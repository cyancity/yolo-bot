import { useEffect, useState } from 'react'
import { Input as LobeInput, TextArea as LobeTextArea } from '@lobehub/ui'
import { Button as LobeButton, Input as AntInput, Select as LobeSelect, Switch as LobeSwitch } from 'antd'
import { cx } from './ui/index.tsx'
import { WF } from './workforce-strings.ts'
import type { ImageProvider, ImageProviderStatus } from './workforce-types.ts'
import type { WorkforceSource } from './workforce-source.ts'
import css from './workforce.module.css'

const DEFAULT_KEY_REF = 'IMAGE_API_KEY'
const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)

/** Shared image provider, shown under the MCP servers in the employees page. */
export function ImageProviderSection({ source, status, onSaved }: {
  readonly source: WorkforceSource
  readonly status: ImageProviderStatus | undefined
  readonly onSaved: (status: ImageProviderStatus) => void
}) {
  const provider = status?.provider ?? null
  const [editing, setEditing] = useState(false)
  const [kind, setKind] = useState<ImageProvider['kind']>('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [keyRef, setKeyRef] = useState(DEFAULT_KEY_REF)
  const [key, setKey] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const begin = (): void => {
    setEditing(true); setError(undefined); setKey('')
    setKind(provider?.kind ?? 'openai')
    setBaseUrl(provider?.kind === 'openai' ? provider.baseUrl : '')
    setModel(provider?.kind === 'openai' ? provider.model : '')
    setKeyRef(provider?.kind === 'openai' ? provider.keyRef : DEFAULT_KEY_REF)
    setCommand(provider?.kind === 'command' ? provider.command : '')
    setArgs(provider?.kind === 'command' ? provider.args.join('\n') : '')
    setEnv(provider?.kind === 'command' ? Object.entries(provider.env ?? {}).map(([name, value]) => `${name}=${value}`).join('\n') : '')
  }

  const run = async (action: () => Promise<ImageProviderStatus>): Promise<void> => {
    setBusy(true); setError(undefined)
    try { onSaved(await action()); setEditing(false) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const save = () => run(async () => {
    const next: ImageProvider = kind === 'openai'
      ? { kind, baseUrl: baseUrl.trim(), model: model.trim(), keyRef: keyRef.trim() || DEFAULT_KEY_REF }
      : { kind, command: command.trim(), args: lines(args), env: Object.fromEntries(lines(env).map(line => [line.split('=', 1)[0]!.trim(), line.slice(line.indexOf('=') + 1).trim()])) }
    const saved = await source.saveImageProvider(next)
    return kind === 'openai' && key.trim() ? await source.saveImageKey(key.trim()) : saved
  })

  const summary = provider === null ? WF.image.notConfigured
    : provider.kind === 'openai' ? WF.image.summaryApi(provider.model, status?.keyConfigured === true)
      : WF.image.summaryCommand([provider.command, ...provider.args].join(' '))

  return (
    <div className={css.empForm} data-workforce-image-provider>
      <div className={css.empHead}>
        <h2 className={css.empTitle}>{WF.image.title}</h2>
        {!editing && <LobeButton autoInsertSpace={false} onClick={begin}>{WF.image.edit}</LobeButton>}
      </div>
      {!editing && <p className={css.empIntro}>{summary}</p>}
      {editing && (
        <div className={css.empFormGrid}>
          <div className={css.empField}>
            <label htmlFor="wf-image-kind">{WF.image.source}</label>
            <LobeSelect id="wf-image-kind" className={css.empInput ?? ''} value={kind} onChange={setKind} options={[
              { value: 'openai', label: WF.image.sourceApi },
              { value: 'command', label: WF.image.sourceCommand },
            ]} />
          </div>
          {kind === 'openai' ? (
            <>
              <div className={css.empField}>
                <label htmlFor="wf-image-url">{WF.image.baseUrl}</label>
                <LobeInput id="wf-image-url" type="block" className={cx('wb-input', css.empInput)} value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
              </div>
              <div className={css.empField}>
                <label htmlFor="wf-image-model">{WF.image.model}</label>
                <LobeInput id="wf-image-model" type="block" className={cx('wb-input', css.empInput)} value={model} onChange={e => setModel(e.target.value)} placeholder="gpt-image-1" />
              </div>
              <div className={css.empField}>
                <label htmlFor="wf-image-key">{WF.image.key}</label>
                <AntInput.Password id="wf-image-key" className={cx('wb-input', css.empInput)} value={key} onChange={e => setKey(e.target.value)} autoComplete="off" spellCheck={false}
                  placeholder={status?.keyConfigured && provider?.kind === 'openai' ? WF.image.keyKept : ''} />
              </div>
              <div className={css.empField}>
                <label htmlFor="wf-image-key-ref">{WF.image.keyRef}</label>
                <LobeInput id="wf-image-key-ref" type="block" className={cx('wb-input', css.empInput)} value={keyRef} onChange={e => setKeyRef(e.target.value)} />
              </div>
            </>
          ) : (
            <>
              <div className={css.empField}>
                <label htmlFor="wf-image-command">{WF.image.command}</label>
                <LobeInput id="wf-image-command" type="block" className={cx('wb-input', css.empInput)} value={command} onChange={e => setCommand(e.target.value)} placeholder="node" />
              </div>
              <div className={css.empField}>
                <label htmlFor="wf-image-args">{WF.image.args}</label>
                <LobeTextArea id="wf-image-args" type="block" rows={5} value={args} onChange={e => setArgs(e.target.value)} placeholder={'scripts/cli.mjs\ngenerate\n--raw-prompt\n{prompt}\n--out\n{outDir}'} />
              </div>
              <div className={css.empField}>
                <label htmlFor="wf-image-env">{WF.image.env}</label>
                <LobeTextArea id="wf-image-env" type="block" rows={2} value={env} onChange={e => setEnv(e.target.value)} />
              </div>
            </>
          )}
        </div>
      )}
      {editing && (
        <div className={css.empFormActions}>
          <LobeButton type="primary" loading={busy} onClick={() => void save()}>{WF.employeesPage.save}</LobeButton>
          <LobeButton onClick={() => setEditing(false)}>{WF.employeesPage.cancel}</LobeButton>
          {provider !== null && <LobeButton danger disabled={busy} onClick={() => void run(() => source.saveImageProvider(null))}>{WF.image.clear}</LobeButton>}
          {error !== undefined && <span className={css.empFormError} role="alert">{error}</span>}
        </div>
      )}
    </div>
  )
}

export function ImageGenerationField({ value, onChange, configured }: {
  readonly value: boolean
  readonly onChange: (value: boolean) => void
  readonly configured: boolean
}) {
  return (
    <div className={css.empField}>
      <label className={css.empCheckboxLabel}>
        <LobeSwitch size="small" checked={value} onChange={onChange} />
        {WF.image.toggle}
      </label>
      {value && !configured && <span className={css.empModelHint}>{WF.image.providerMissing}</span>}
    </div>
  )
}

export interface RolePreset {
  readonly name: string
  readonly title: string
  readonly persona: string
  readonly imageGeneration: boolean
}

export function RolePresets({ onPick }: { readonly onPick: (preset: RolePreset) => void }) {
  const presets: RolePreset[] = [
    { name: WF.image.designer, title: WF.image.designerTitle, persona: WF.image.designerPersona, imageGeneration: true },
  ]
  return (
    <div className={css.empField}>
      <label>{WF.image.presets}</label>
      <div className={css.skillPickList}>
        {presets.map(preset => (
          <button key={preset.name} type="button" className={css.skillPick} onClick={() => onPick(preset)}>＋ {preset.name}</button>
        ))}
      </div>
    </div>
  )
}

export function useImageProvider(source: WorkforceSource, version: number) {
  const [status, setStatus] = useState<ImageProviderStatus | undefined>()
  useEffect(() => {
    let alive = true
    void source.imageProvider().then(value => { if (alive) setStatus(value) }).catch(() => { if (alive) setStatus(undefined) })
    return () => { alive = false }
  }, [source, version])
  return [status, setStatus] as const
}
