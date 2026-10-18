import { Button, TextInput } from './ui/primitives.ts'
import { Select } from './ui/select.tsx'
/** 工作台唯一模型接入弹窗。编辑 Key、选择模型和清除确认都在同一个 Dialog 内。 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Dialog } from './ui/index.tsx'
import { API_PREFIX } from './transport.ts'
import { WF } from './workforce-strings.ts'
import { WorkforceApi, type DefaultModelSelection } from './workforce-api.ts'
import { WorkforceModelsSource, canEditModelKey, requiresModelKey } from './workforce-models-source.ts'
export type { DefaultModelSelection }
import css from './workforce-models.module.css'

export interface SelectableModel {
  readonly value: string
  readonly label: string
  readonly providerId: string
  readonly providerName: string
  readonly modelName: string
}

/** 目录订阅没有接入副作用，浏览员工编辑页也不会自动弹窗。 */
export function useWorkforceModels(instance?: WorkforceModelsSource | WorkforceApi) {
  const source = useMemo(() => instance instanceof WorkforceModelsSource ? instance : new WorkforceModelsSource(instance), [instance])
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  useEffect(() => { void source.refresh().catch(() => {}) }, [source])
  const refresh = useCallback(() => source.refresh().catch(() => undefined), [source])
  const selectableModels = useMemo<readonly SelectableModel[]>(() => snapshot.state.providers.flatMap(provider => provider.models.map(model => ({
    value: `${provider.id}/${model.id}`,
    label: `${provider.displayName} · ${model.name ?? model.id}`,
    providerId: provider.id,
    providerName: provider.displayName,
    modelName: model.name ?? model.id,
  }))), [snapshot.state.providers])
  return { api: source.api, source, ...snapshot, refresh, selectableModels }
}

interface ModelVerificationResult {
  readonly selection: string
  readonly verified: boolean
  readonly error?: ClassifiedModelError
}

function useModelVerification(selection: DefaultModelSelection | undefined) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ModelVerificationResult>()
  const request = useRef<AbortController>()
  const generation = useRef(0)
  const identity = selection ? `${selection.provider}/${selection.model}` : ''
  const invalidate = useCallback(() => {
    generation.current++
    request.current?.abort()
    request.current = undefined
    setBusy(false)
    setResult(undefined)
  }, [])
  useEffect(() => {
    invalidate()
    return () => { generation.current++; request.current?.abort() }
  }, [identity, invalidate])
  const verify = async () => {
    invalidate()
    if (!selection) {
      setResult({ selection: identity, verified: false, error: MODEL_ERRORS.missing_model })
      return
    }
    const controller = new AbortController()
    request.current = controller
    const currentGeneration = generation.current
    setBusy(true)
    const timeout = window.setTimeout(() => controller.abort(), 25_000)
    try {
      const response = await fetch(`${API_PREFIX}/workforce/models/verify`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: controller.signal,
      })
      if (currentGeneration !== generation.current) return
      if (!response.ok) {
        setResult({ selection: identity, verified: false, error: {
          ...MODEL_ERRORS.network,
          message: response.status === 404 ? WF.models.testUnavailable404 : WF.models.testUnavailableGeneral,
        } })
        return
      }
      const body = await response.json() as {
        ok?: boolean
        data?: { verified?: boolean; provider?: string; model?: string; error?: { category?: string; message?: string } }
      }
      if (currentGeneration !== generation.current) return
      const data = body.ok === true ? body.data : undefined
      const verified = data?.verified === true && data.provider === selection.provider && data.model === selection.model
      const error = verified ? undefined : classifyModelError(data?.error?.category, data?.error?.message) ?? MODEL_ERRORS.unknown
      setResult({ selection: identity, verified, ...(error ? { error: { ...error, provider: data?.provider ?? error.provider } } : {}) })
    } catch {
      if (currentGeneration === generation.current) setResult({ selection: identity, verified: false, error: MODEL_ERRORS.network })
    } finally {
      window.clearTimeout(timeout)
      if (currentGeneration === generation.current) { request.current = undefined; setBusy(false) }
    }
  }
  return { busy, result: result?.selection === identity ? result : undefined, verify, invalidate }
}

/** 根级宿主只订阅一次；关闭不卸载原页面或更改 composer 草稿。 */
export function GlobalModelAccess({ source }: { readonly source: WorkforceModelsSource }) {
  const { access } = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  return access === undefined ? null : <WorkforceModelsModal source={source} />
}

export function WorkforceModelsModal({ source }: { readonly source: WorkforceModelsSource }) {
  const { api, state, loading, loaded, error, access, refresh, selectableModels } = useWorkforceModels(source)
  const verification = useModelVerification(state.defaultModel)
  const defaultSelectRef = useRef<HTMLButtonElement>(null)
  const [page, setPage] = useState<'models' | 'key' | 'clear'>(access?.provider ? 'key' : 'models')
  const [target, setTarget] = useState(access?.provider ?? '')
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const targetProvider = state.providers.find(item => item.id === target)
  const keyProviders = state.providers.filter(canEditModelKey)
  const currentValue = state.defaultModel ? `${state.defaultModel.provider}/${state.defaultModel.model}` : ''
  const keyWritable = targetProvider !== undefined && canEditModelKey(targetProvider)
  const openKey = (providerId?: string) => {
    setTarget(providerId ?? state.defaultModel?.provider ?? keyProviders[0]?.id ?? '')
    setKey(''); setShowKey(false); setActionError(undefined); setPage('key')
  }
  const back = () => { setPage('models'); setKey(''); setShowKey(false); setActionError(undefined) }
  const refreshAfterWrite = async () => {
    verification.invalidate()
    await source.refresh()
  }
  const saveKey = async () => {
    if (busy || !keyWritable || !key.trim()) return
    setBusy(true); setActionError(undefined); setNotice(undefined)
    try {
      await api.saveModelKey(target, key.trim())
      setKey(''); setShowKey(false)
      await refreshAfterWrite()
      setPage('models')
      setNotice(WF.models.keySavedNotice)
    } catch { setActionError(WF.models.keySaveFailed) }
    finally { setBusy(false) }
  }
  const clearKey = async () => {
    if (busy || !keyWritable) return
    setBusy(true); setActionError(undefined); setNotice(undefined)
    try {
      await api.deleteModelKey(target)
      await refreshAfterWrite()
      setPage('models')
      setNotice(source.getSnapshot().state.providers.find(item => item.id === target)?.configured
        ? WF.models.keyClearedOtherSources
        : WF.models.keyClearedSuccess)
    } catch { setActionError(WF.models.keyClearFailed) }
    finally { setBusy(false) }
  }
  const saveDefault = async (value: string) => {
    const slash = value.indexOf('/')
    if (busy || slash <= 0) return
    setBusy(true); setActionError(undefined); setNotice(undefined)
    try {
      await api.saveDefaultModel(value.slice(0, slash), value.slice(slash + 1))
      await refreshAfterWrite()
      setNotice(WF.models.defaultSavedNotice)
    } catch { setActionError(WF.models.defaultSaveFailed) }
    finally { setBusy(false) }
  }
  const verificationError = verification.result?.error
  const title = page === 'key' ? `${targetProvider?.displayName ?? WF.models.title} · ${WF.models.keyTitle}`
    : page === 'clear' ? WF.models.clearKeyTitle : WF.models.modelAccessTitle
  return <Dialog title={title} closeLabel={WF.common.close} onClose={source.close} busy={busy} fullScreen>
    <div className={css.accessContent} data-workforce-models-dialog data-model-page={page}>
      <p className={css.onboardingCopy}>{WF.models.onboardingIntro}</p>
      <p className={css.onboardingCopy}>{WF.models.onboardingDshKeys}</p>
      {access?.message && <p className={css.sectionDesc} role="status">{access.message}</p>}
      {notice && <div className={css.successBanner} role="status">{notice}</div>}
      {error && <div className={css.errorBanner} role="alert"><span>{error}</span><Button variant="plain" type="button" className={css.actionBtn} disabled={loading || busy} onClick={() => void refresh()}>{WF.common.retry}</Button></div>}
      {actionError && <div className={css.errorBanner} role="alert">{actionError}</div>}
      {page === 'key' ? <div className={css.dialogContent}>
        <Button variant="plain" type="button" className={css.actionBtn} disabled={busy} onClick={back}>{WF.nav.back}</Button>
        <div className={css.field}>
          <label htmlFor="wf-key-provider">{WF.models.providers}</label>
          <Select id="wf-key-provider" className={css.modelSelect} value={target} disabled={busy || loading} onChange={event => openKey(event.target.value)}>
            {!keyProviders.some(item => item.id === target) && <option value={target}>{targetProvider?.displayName ?? (target || WF.models.selectProviderPlaceholder)}</option>}
            {keyProviders.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}
          </Select>
        </div>
        {loaded && !loading && !keyWritable && <p className={css.fieldHint}>{targetProvider && !requiresModelKey(targetProvider)
          ? WF.models.nativeOrNoKeyNeeded
          : WF.models.managedByDsh}</p>}
        {keyWritable && <div className={css.field}>
          <label htmlFor="wf-model-key-input">API Key</label>
          <div className={css.keyInputWrap}>
            <TextInput id="wf-model-key-input" type={showKey ? 'text' : 'password'} className={css.keyInput} value={key} placeholder={WF.models.keyPlaceholder} autoComplete="off" spellCheck={false} autoFocus disabled={busy} onChange={event => setKey(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void saveKey() }} />
            <Button variant="plain" type="button" className={css.keyToggleBtn} disabled={busy} onClick={() => setShowKey(value => !value)}>{showKey ? WF.models.hideKey : WF.models.showKey}</Button>
          </div>
          <span className={css.fieldHint}>{WF.models.keyStorageNotice}</span>
        </div>}
        <div className={css.modalFooter}>
          <Button variant="plain" type="button" className={css.actionBtn} disabled={busy} onClick={source.close}>{WF.models.skipAccess}</Button>
          <Button variant="plain" type="button" className={`${css.actionBtn} ${css.actionBtnPrimary}`} disabled={busy || loading || !keyWritable || !key.trim()} onClick={() => void saveKey()}>{busy ? WF.models.saving : WF.models.saveToDsh}</Button>
        </div>
      </div> : page === 'clear' ? <div className={css.dialogContent}>
        <p>{WF.models.clearKeyConfirm(targetProvider?.displayName ?? target)} {WF.models.clearKeyAffectsOtherSessions}</p>
        <div className={css.modalFooter}>
          <Button variant="plain" type="button" className={css.actionBtn} disabled={busy} autoFocus onClick={back}>{WF.common.cancel}</Button>
          <Button variant="plain" type="button" className={`${css.actionBtn} ${css.actionBtnDanger}`} disabled={busy || !keyWritable} onClick={() => void clearKey()}>{busy ? WF.models.clearing : WF.models.confirmClear}</Button>
        </div>
      </div> : <div className={css.modelsContainer}>
        <div className={css.section}>
          <label className={css.sectionTitle} htmlFor="wf-default-model">{WF.models.defaultModel}</label>
          <span className={css.sectionDesc}>{WF.models.defaultModelHint}</span>
          <Select ref={defaultSelectRef} id="wf-default-model" className={css.modelSelect} value={currentValue} disabled={busy || loading || selectableModels.length === 0} onChange={event => void saveDefault(event.target.value)}>
            <option value="">{WF.models.selectModel}</option>
            {currentValue && !selectableModels.some(item => item.value === currentValue) && <option value={currentValue}>{currentValue} ({WF.models.unavailable})</option>}
            {selectableModels.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </Select>
          {loaded && !loading && selectableModels.length === 0 && <span className={css.fieldHint}>{WF.models.serviceUnavailableHint}</span>}
        </div>
        <div className={css.section}>
          <div className={css.cardHead}>
            <span className={css.sectionDesc}>{WF.models.testConnectionDesc}</span>
            <Button variant="plain" type="button" className={css.actionBtn} disabled={!loaded || loading || busy || verification.busy} onClick={() => void verification.verify()}>{verification.busy ? WF.models.testingConnection : WF.models.testConnection}</Button>
          </div>
          {verification.result?.verified && <div className={css.successBanner} role="status">{WF.models.testSuccess(verification.result.selection)}</div>}
          {verificationError && <div className={css.errorBanner} role="alert"><span>{verificationError.message}</span><Button variant="plain" type="button" className={css.actionBtn} disabled={busy || verification.busy} onClick={() => {
            if (verificationError.action === 'addKey') openKey(verificationError.provider)
            else if (verificationError.action === 'changeModel') defaultSelectRef.current?.focus()
            else void verification.verify()
          }}>{verificationError.action === 'addKey' ? WF.models.manageDshKeys : verificationError.action === 'changeModel' ? WF.models.selectModel : WF.common.retry}</Button></div>}
        </div>
        <div className={css.section}>
          <span className={css.sectionTitle}>{WF.models.providersSectionTitle}</span>
          <div className={css.cardsList}>{state.providers.map(item => <div key={item.id} className={css.card} data-model-provider={item.id}>
            <div className={css.cardHead}>
              <div className={css.cardInfo}>
                <span className={css.cardTitle}>{item.displayName}</span>
                <span className={`${css.badge} ${css.badgeKind}`}>{requiresModelKey(item) ? 'API Key' : WF.models.nativeConnectionBadge}</span>
                <span className={`${css.badge} ${item.configured || !requiresModelKey(item) ? css.badgeOk : css.badgeDim}`}>{!requiresModelKey(item) ? WF.models.delegatedToDsh : item.configured ? WF.models.hasCredentials : WF.models.notConnected}</span>
              </div>
              {canEditModelKey(item) && <div className={css.cardActions}>
                <Button variant="plain" type="button" className={css.actionBtn} disabled={busy || loading} onClick={() => openKey(item.id)}>{item.configured ? WF.models.updateCredentials : WF.models.addCredentials}</Button>
                {item.configured && <Button variant="plain" type="button" className={`${css.actionBtn} ${css.actionBtnDanger}`} disabled={busy || loading} onClick={() => { setTarget(item.id); setActionError(undefined); setPage('clear') }}>{WF.models.clearKey}</Button>}
              </div>}
            </div>
            <div className={css.cardBody}>
              {item.description && <div>{item.description}</div>}
              {!requiresModelKey(item) && <div>{WF.models.nativeOrNoKeyNeeded}</div>}
              {requiresModelKey(item) && item.writable === false && <div>{WF.models.managedByDsh}</div>}
              {item.models.length > 0 ? <div className={css.modelsTags}>{item.models.map(model => <span key={model.id} className={css.modelTag}>{model.name ?? model.id}</span>)}</div> : <span className={css.emptyHint}>{WF.models.emptyModels}</span>}
            </div>
          </div>)}</div>
        </div>
        <div className={css.modalFooter}>
          <Button variant="plain" type="button" className={css.actionBtn} disabled={loading || busy} onClick={() => { verification.invalidate(); void refresh() }}>{loading || busy ? WF.models.refreshing : WF.models.refreshDshStatus}</Button>
          <Button variant="plain" type="button" className={css.actionBtn} disabled={busy} onClick={source.close}>{WF.models.skipAccess}</Button>
          <Button variant="plain" type="button" className={`${css.actionBtn} ${css.actionBtnPrimary}`} disabled={busy} onClick={source.close}>{WF.models.finishAndReturn}</Button>
        </div>
      </div>}
    </div>
  </Dialog>
}

export type ModelErrorActionKind = 'addKey' | 'retry' | 'changeModel' | 'editEmployee' | 'checkModels'
export interface ModelErrorAction {
  readonly kind: ModelErrorActionKind
  readonly label: string
  readonly provider?: string | undefined
  readonly prompt?: string | undefined
}
export type ModelErrorCategory = 'missing_key' | 'invalid_key' | 'quota' | 'network' | 'model_unavailable' | 'missing_model' | 'unknown'
export interface ClassifiedModelError {
  readonly category: ModelErrorCategory
  readonly message: string
  readonly action: 'addKey' | 'changeModel' | 'retry'
  readonly provider?: string | undefined
}
const MODEL_ERRORS: Record<ModelErrorCategory, ClassifiedModelError> = {
  missing_key: { category: 'missing_key', get message() { return WF.models.errorMissingKey }, action: 'addKey' },
  invalid_key: { category: 'invalid_key', get message() { return WF.models.errorInvalidKey }, action: 'addKey' },
  quota: { category: 'quota', get message() { return WF.models.errorQuota }, action: 'changeModel' },
  network: { category: 'network', get message() { return WF.models.errorNetwork }, action: 'retry' },
  model_unavailable: { category: 'model_unavailable', get message() { return WF.models.errorModelUnavailable }, action: 'changeModel' },
  missing_model: { category: 'missing_model', get message() { return WF.models.errorMissingModel }, action: 'changeModel' },
  unknown: { category: 'unknown', get message() { return WF.models.errorUnknown }, action: 'retry' },
}

/** 同时处理宿主错误码和原生供应商消息；只返回安全的产品文案。 */
export function classifyModelError(code?: string, message?: string): ClassifiedModelError | undefined {
  const text = `${code ?? ''} ${message ?? ''}`
  const provider = message?.match(/(?:provider\s*[:=]\s*|供应商[「“"]?)([a-zA-Z0-9_-]+)/i)?.[1]
    ?? message?.match(/([a-zA-Z0-9_-]+)\s*(?:还没有填|的 key 无效)/i)?.[1]
  let category: ModelErrorCategory | undefined
  if (/\b(?:MISSING_MODEL|MISSING_DEFAULT_MODEL|NO_DEFAULT_MODEL|DEFAULT_MODEL_REQUIRED)\b|尚未选择默认模型|未配置默认模型|请先(?:选择|配置).{0,8}默认模型/i.test(text)) category = 'missing_model'
  else if (/\b(?:MISSING_KEY|MISSING_CREDENTIAL)\b|还没有填 API key|(?:未配置|没有配置|尚未配置|缺少).*(?:API.?Key|密钥)|(?:missing|no) (?:api.?key|credential)|api.?key.*(?:not found|not set|required)/i.test(text)) category = 'missing_key'
  else if (/\b(?:QUOTA|QUOTA_EXCEEDED|INSUFFICIENT_QUOTA|INSUFFICIENT_BALANCE|HTTP_402|402)\b|余额不足|额度.{0,8}(?:用尽|不足|耗尽)|insufficient.*(?:balance|credit|quota)|quota.*(?:exceed|exhaust)|credit balance.*low/i.test(text)) category = 'quota'
  else if (/\b(?:AUTH|INVALID_KEY|INVALID_CREDENTIAL|INVALID_API_KEY|AUTHENTICATION_ERROR|AUTHENTICATION_FAILED|HTTP_401|HTTP_403|401|403)\b|(?:key|密钥).*(?:无效|拒绝|失效)|invalid.*(?:api.?key|credential)|incorrect api key|unauthorized|authentication fail/i.test(text)) category = 'invalid_key'
  else if (/\b(?:NO_ADAPTER|MODEL_UNAVAILABLE|UNKNOWN_MODEL|UNKNOWN_PROVIDER|MODEL_NOT_FOUND|UNSUPPORTED_MODEL|UNSUPPORTED_TOOLS?|UNSUPPORTED_TOOL_CALLING|HTTP_404)\b|model.*(?:not found|not exist|unavailable|not supported|unsupported)|不存在或已下线|来源未注册|模型.*(?:不存在|不可用|下线|不支持)|(?:tools?|tool[\s_-]?calling|function[\s_-]?calling).{0,80}(?:not supported|unsupported|not available)|(?:not support|unsupported|does not support).{0,80}(?:tools?|tool[\s_-]?calling|function[\s_-]?calling)|不支持.{0,20}工具/i.test(text)) category = 'model_unavailable'
  else if (/\b(?:NETWORK|TRANSPORT|ABORTED|STREAM_CLOSED|NETWORK_ERROR|CONNECTION_ERROR|NETWORK_UNAVAILABLE|TIMEOUT|REQUEST_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|RATE_LIMIT|HTTP_429|HTTP_5\d\d|UND_ERR_[A-Z_]+|429|502|503|504)\b|fetch failed|failed to fetch|network error|timed? ?out|rate.?limit|too many requests|超时|限流|连接失败/i.test(text)) category = 'network'
  else if ((code ?? '').toLowerCase() === 'unknown') category = 'unknown'
  if (!category) return undefined
  return { ...MODEL_ERRORS[category], ...(provider ? { provider } : {}) }
}

export function parseModelErrorAction(errorCode?: string, errorText?: string): ModelErrorAction | undefined {
  const error = classifyModelError(errorCode, errorText)
  if (!error) return undefined
  return {
    kind: error.action,
    label: error.action === 'addKey' ? WF.models.manageModelKeys : error.action === 'changeModel' ? WF.errorActions.changeModel : WF.errorActions.retry,
    ...(error.provider ? { provider: error.provider } : {}),
  }
}
