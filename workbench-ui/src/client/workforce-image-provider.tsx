import { useEffect, useRef, useState } from 'react'
import { Input as LobeInput, TextArea as LobeTextArea } from '@lobehub/ui'
import { Button as LobeButton, Input as AntInput, Select as LobeSelect, Switch as LobeSwitch } from 'antd'
import { cx } from './ui/index.tsx'
import { WF } from './workforce-strings.ts'
import type { ImageProvider, ImageProviderStatus } from './workforce-types.ts'
import type { WorkforceSource } from './workforce-source.ts'
import css from './workforce.module.css'

const DEFAULT_KEY_REF = 'IMAGE_API_KEY'
const DEFAULT_CODEX_MODEL = 'gpt-6-luna'
const DEFAULT_PROVIDER: ImageProvider = { kind: 'codex', model: DEFAULT_CODEX_MODEL }
const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)

export type ImageReadiness = 'unknown' | 'ready' | 'codex-missing' | 'codex-logged-out' | 'key-missing'

/** Whether employees can generate images right now; `unknown` while the status is loading or failed. */
export function imageReadiness(status: ImageProviderStatus | undefined): ImageReadiness {
  if (!status) return 'unknown'
  if (status.effective.kind === 'codex') {
    if (!status.codex.installed) return 'codex-missing'
    return status.codex.loggedIn ? 'ready' : 'codex-logged-out'
  }
  if (status.effective.kind === 'openai' && !status.keyConfigured) return 'key-missing'
  return 'ready'
}

function providerSummary(provider: ImageProvider): string {
  if (provider.kind === 'codex') return WF.image.summaryCodex(provider.model)
  if (provider.kind === 'openai') return WF.image.summaryApi(provider.model)
  return WF.image.summaryCommand([provider.command, ...provider.args].join(' '))
}

/** Shared image service, shown under the MCP servers in the employees page. `openSignal` scrolls here from an employee form. */
export function ImageProviderSection({ source, status, onSaved, openSignal }: {
  readonly source: WorkforceSource
  readonly status: ImageProviderStatus | undefined
  readonly onSaved: (status: ImageProviderStatus) => void
  readonly openSignal: number
}) {
  const provider = status?.provider ?? null
  const effective = status?.effective ?? DEFAULT_PROVIDER
  const readiness = imageReadiness(status)
  const root = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  const [kind, setKind] = useState<ImageProvider['kind']>('codex')
  const [codexModel, setCodexModel] = useState(DEFAULT_CODEX_MODEL)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [keyRef, setKeyRef] = useState(DEFAULT_KEY_REF)
  const [key, setKey] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const begin = (nextKind: ImageProvider['kind'] = effective.kind): void => {
    setEditing(true); setError(undefined); setKey('')
    setKind(nextKind)
    setCodexModel(effective.kind === 'codex' ? effective.model : DEFAULT_CODEX_MODEL)
    setBaseUrl(effective.kind === 'openai' ? effective.baseUrl : '')
    setModel(effective.kind === 'openai' ? effective.model : '')
    setKeyRef(effective.kind === 'openai' ? effective.keyRef : DEFAULT_KEY_REF)
    setCommand(effective.kind === 'command' ? effective.command : '')
    setArgs(effective.kind === 'command' ? effective.args.join('\n') : '')
    setEnv(effective.kind === 'command' ? Object.entries(effective.env ?? {}).map(([name, value]) => `${name}=${value}`).join('\n') : '')
  }

  useEffect(() => {
    if (openSignal === 0) return
    root.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    // 可用时直接打开设置；不可用时停在指引上，由用户选安装 Codex 还是改用接口。
    if (readiness === 'ready' || readiness === 'key-missing') begin()
  }, [openSignal])

  const run = async (action: () => Promise<ImageProviderStatus>): Promise<void> => {
    setBusy(true); setError(undefined)
    try { onSaved(await action()); setEditing(false) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const save = () => run(async () => {
    const next: ImageProvider = kind === 'codex'
      ? { kind, model: codexModel.trim() || DEFAULT_CODEX_MODEL }
      : kind === 'openai'
        ? { kind, baseUrl: baseUrl.trim(), model: model.trim(), keyRef: keyRef.trim() || DEFAULT_KEY_REF }
        : { kind, command: command.trim(), args: lines(args), env: Object.fromEntries(lines(env).map(line => [line.split('=', 1)[0]!.trim(), line.slice(line.indexOf('=') + 1).trim()])) }
    const saved = await source.saveImageProvider(next)
    return kind === 'openai' && key.trim() ? await source.saveImageKey(key.trim()) : saved
  })

  return (
    <div ref={root} className={css.empForm} data-workforce-image-provider>
      <div className={css.empHead}>
        <h2 className={css.empTitle}>{WF.image.title}</h2>
        {!editing && <LobeButton autoInsertSpace={false} onClick={() => begin()}>{WF.image.edit}</LobeButton>}
      </div>
      {!editing && status !== undefined && <p className={css.empIntro}>{providerSummary(effective)}</p>}
      {!editing && <ImageSetupGuide readiness={readiness} busy={busy} onUseApi={() => begin('openai')} onRecheck={() => void run(() => source.imageProvider(true))} />}
      {editing && (
        <div className={cx(css.empFormGrid, css.imageFormGrid)}>
          <div className={css.empField}>
            <label htmlFor="wf-image-kind">{WF.image.source}</label>
            <LobeSelect id="wf-image-kind" className={css.empInput ?? ''} value={kind} onChange={setKind} options={[
              { value: 'codex', label: WF.image.sourceCodex },
              { value: 'openai', label: WF.image.sourceApi },
              { value: 'command', label: WF.image.sourceCommand },
            ]} />
          </div>
          {kind === 'codex' && (
            <div className={css.empField}>
              <label htmlFor="wf-image-codex-model">{WF.image.model}</label>
              <LobeInput id="wf-image-codex-model" type="block" className={cx('wb-input', css.empInput)} value={codexModel} onChange={e => setCodexModel(e.target.value)} placeholder={DEFAULT_CODEX_MODEL} />
            </div>
          )}
          {kind === 'openai' && (
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
          )}
          {kind === 'command' && (
            <>
              <div className={css.empField}>
                <label htmlFor="wf-image-command">{WF.image.command}</label>
                <LobeInput id="wf-image-command" type="block" className={cx('wb-input', css.empInput)} value={command} onChange={e => setCommand(e.target.value)} placeholder="node" />
              </div>
              <div className={css.empField}>
                <label htmlFor="wf-image-args">{WF.image.args}</label>
                <LobeTextArea id="wf-image-args" type="block" rows={5} value={args} onChange={e => setArgs(e.target.value)} placeholder={'cli.mjs\n--prompt\n{prompt}\n--out\n{outDir}'} />
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
          {provider !== null && <LobeButton disabled={busy} onClick={() => void run(() => source.saveImageProvider(null))}>{WF.image.reset}</LobeButton>}
          {error !== undefined && <span className={css.empFormError} role="alert">{error}</span>}
        </div>
      )}
      {!editing && error !== undefined && <p className={cx(css.empIntro, css.empFormError)} role="alert">{error}</p>}
    </div>
  )
}

/** What to do when images can't be generated yet: install or log in to Codex, or switch to a third-party API. */
function ImageSetupGuide({ readiness, busy, onUseApi, onRecheck }: {
  readonly readiness: ImageReadiness
  readonly busy: boolean
  readonly onUseApi: () => void
  readonly onRecheck: () => void
}) {
  if (readiness === 'unknown' || readiness === 'ready') return null
  if (readiness === 'key-missing') return <p className={cx(css.empIntro, css.imageWarning)}>{WF.image.keyMissing}</p>
  const missing = readiness === 'codex-missing'
  return (
    <div className={css.imageGuide} role="status">
      <p className={css.imageWarning}>{missing ? WF.image.codexMissing : WF.image.codexLoggedOut}</p>
      <p>{missing ? WF.image.guideInstall : WF.image.guideLogin}</p>
      <pre className={css.imageCommands}>{missing ? 'npm install -g @openai/codex\ncodex login' : 'codex login'}</pre>
      <p>{WF.image.guideNoSubscription}</p>
      <div className={css.imageGuideActions}>
        <LobeButton size="small" loading={busy} onClick={onRecheck}>{WF.image.recheck}</LobeButton>
        <LobeButton size="small" onClick={onUseApi}>{WF.image.useApi}</LobeButton>
      </div>
    </div>
  )
}

/** The per-employee switch; tells the user which service it will use, or that it can't draw yet. */
export function ImageGenerationField({ value, onChange, status, onConfigure }: {
  readonly value: boolean
  readonly onChange: (value: boolean) => void
  readonly status: ImageProviderStatus | undefined
  readonly onConfigure: () => void
}) {
  const readiness = imageReadiness(status)
  const effective = status?.effective ?? DEFAULT_PROVIDER
  return (
    <div className={css.empField}>
      <label className={css.empCheckboxLabel}>
        <LobeSwitch size="small" checked={value} onChange={onChange} />
        {WF.image.toggle}
      </label>
      {value && readiness !== 'unknown' && (
        <span className={cx(css.empModelHint, readiness !== 'ready' && css.imageWarning)}>
          {readiness === 'ready' ? WF.image.uses(providerSummary(effective)) : WF.image.notReady}
          {' '}
          <button type="button" className={css.imageLink} onClick={onConfigure}>{readiness === 'ready' ? WF.image.change : WF.image.configure}</button>
        </span>
      )}
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
