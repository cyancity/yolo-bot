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
          message: response.status === 404 ? '模型测试接口暂不可用，请刷新工作台后重试。' : '无法测试模型，请检查工作台连接后重试。',
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
  const defaultSelectRef = useRef<HTMLSelectElement>(null)
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
      setNotice('凭据已保存到 DSH 原生凭据库。关闭后请再次点击原操作；不会自动发送之前的输入。')
    } catch { setActionError('凭据保存或状态刷新未完成，请检查连接后重试。') }
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
        ? '已移除 DSH 本机保存的 Key；此供应商仍有其他原生凭据来源。'
        : '已移除 DSH 本机保存的 Key。仍可浏览工作台。')
    } catch { setActionError('清除或状态刷新未完成，请检查连接后重试。') }
    finally { setBusy(false) }
  }
  const saveDefault = async (value: string) => {
    const slash = value.indexOf('/')
    if (busy || slash <= 0) return
    setBusy(true); setActionError(undefined); setNotice(undefined)
    try {
      await api.saveDefaultModel(value.slice(0, slash), value.slice(slash + 1))
      await refreshAfterWrite()
      setNotice('默认模型已保存。关闭后再次点击发送或原操作。')
    } catch { setActionError('默认模型保存或状态刷新未完成，请重新选择后重试。') }
    finally { setBusy(false) }
  }
  const verificationError = verification.result?.error
  const title = page === 'key' ? `${targetProvider?.displayName ?? '模型'} · DSH 凭据`
    : page === 'clear' ? '清除 DSH 凭据' : '模型接入'
  return <Dialog title={title} closeLabel="关闭" onClose={source.close} busy={busy} fullScreen>
    <div className={css.accessContent} data-workforce-models-dialog data-model-page={page}>
      <p className={css.onboardingCopy}>直接复用 DSH 原生模型与凭据。未接入也能浏览频道、私信和历史，执行模型操作时才需要接入。</p>
      <p className={css.onboardingCopy}>已有 DSH 凭据可直接使用；这里保存和清除的也是同一份原生凭据，不另存工作台 Key。</p>
      {access?.message && <p className={css.sectionDesc} role="status">{access.message}</p>}
      {notice && <div className={css.successBanner} role="status">{notice}</div>}
      {error && <div className={css.errorBanner} role="alert"><span>{error}</span><button type="button" className={css.actionBtn} disabled={loading || busy} onClick={() => void refresh()}>重试</button></div>}
      {actionError && <div className={css.errorBanner} role="alert">{actionError}</div>}
      {page === 'key' ? <div className={css.dialogContent}>
        <button type="button" className={css.actionBtn} disabled={busy} onClick={back}>返回模型选择</button>
        <div className={css.field}>
          <label htmlFor="wf-key-provider">模型供应商</label>
          <select id="wf-key-provider" className={css.modelSelect} value={target} disabled={busy || loading} onChange={event => openKey(event.target.value)}>
            {!keyProviders.some(item => item.id === target) && <option value={target}>{targetProvider?.displayName ?? (target || '请选择供应商')}</option>}
            {keyProviders.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}
          </select>
        </div>
        {loaded && !loading && !keyWritable && <p className={css.fieldHint}>{targetProvider && !requiresModelKey(targetProvider)
          ? '该供应商使用 DSH 原生认证或无需 API Key，请在 DSH 中管理连接后刷新状态。'
          : '当前供应商的凭据由 DSH 管理，无法在这里编辑。请检查 DSH 原生模型设置后刷新状态。'}</p>}
        {keyWritable && <div className={css.field}>
          <label htmlFor="wf-model-key-input">API Key</label>
          <div className={css.keyInputWrap}>
            <input id="wf-model-key-input" type={showKey ? 'text' : 'password'} className={css.keyInput} value={key} placeholder={WF.models.keyPlaceholder} autoComplete="off" spellCheck={false} autoFocus disabled={busy} onChange={event => setKey(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void saveKey() }} />
            <button type="button" className={css.keyToggleBtn} disabled={busy} onClick={() => setShowKey(value => !value)}>{showKey ? WF.models.hideKey : WF.models.showKey}</button>
          </div>
          <span className={css.fieldHint}>Key 保存到 DSH 原生凭据库。保存只表示配置已存储，测试连接才能确认调用。</span>
        </div>}
        <div className={css.modalFooter}>
          <button type="button" className={css.actionBtn} disabled={busy} onClick={source.close}>暂不接入</button>
          <button type="button" className={`${css.actionBtn} ${css.actionBtnPrimary}`} disabled={busy || loading || !keyWritable || !key.trim()} onClick={() => void saveKey()}>{busy ? '保存中…' : '保存到 DSH'}</button>
        </div>
      </div> : page === 'clear' ? <div className={css.dialogContent}>
        <p>{WF.models.clearKeyConfirm(targetProvider?.displayName ?? target)} 这会同时影响 DSH 中使用此供应商的其他会话。</p>
        <div className={css.modalFooter}>
          <button type="button" className={css.actionBtn} disabled={busy} autoFocus onClick={back}>取消</button>
          <button type="button" className={`${css.actionBtn} ${css.actionBtnDanger}`} disabled={busy || !keyWritable} onClick={() => void clearKey()}>{busy ? '清除中…' : '确认清除'}</button>
        </div>
      </div> : <div className={css.modelsContainer}>
        <div className={css.section}>
          <label className={css.sectionTitle} htmlFor="wf-default-model">默认模型</label>
          <span className={css.sectionDesc}>员工未单独设置模型时使用此选择。员工自己的模型在「数字员工」中修改。</span>
          <select ref={defaultSelectRef} id="wf-default-model" className={css.modelSelect} value={currentValue} disabled={busy || loading || selectableModels.length === 0} onChange={event => void saveDefault(event.target.value)}>
            <option value="">请选择默认模型</option>
            {currentValue && !selectableModels.some(item => item.value === currentValue) && <option value={currentValue}>{currentValue}（当前不可用）</option>}
            {selectableModels.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          {loaded && !loading && selectableModels.length === 0 && <span className={css.fieldHint}>DSH 尚未提供模型目录，请检查原生模型配置后刷新。</span>}
        </div>
        <div className={css.section}>
          <div className={css.cardHead}>
            <span className={css.sectionDesc}>测试连接会发起一次模型调用，可能产生少量费用。发送前不会自动测试。</span>
            <button type="button" className={css.actionBtn} disabled={!loaded || loading || busy || verification.busy} onClick={() => void verification.verify()}>{verification.busy ? '正在测试…' : '测试连接'}</button>
          </div>
          {verification.result?.verified && <div className={css.successBanner} role="status">当前默认模型（{verification.result.selection}）连接与模型调用成功。</div>}
          {verificationError && <div className={css.errorBanner} role="alert"><span>{verificationError.message}</span><button type="button" className={css.actionBtn} disabled={busy || verification.busy} onClick={() => {
            if (verificationError.action === 'addKey') openKey(verificationError.provider)
            else if (verificationError.action === 'changeModel') defaultSelectRef.current?.focus()
            else void verification.verify()
          }}>{verificationError.action === 'addKey' ? '管理 DSH 凭据' : verificationError.action === 'changeModel' ? '选择模型' : '重试'}</button></div>}
        </div>
        <div className={css.section}>
          <span className={css.sectionTitle}>DSH 模型供应商</span>
          <div className={css.cardsList}>{state.providers.map(item => <div key={item.id} className={css.card} data-model-provider={item.id}>
            <div className={css.cardHead}>
              <div className={css.cardInfo}>
                <span className={css.cardTitle}>{item.displayName}</span>
                <span className={`${css.badge} ${css.badgeKind}`}>{requiresModelKey(item) ? 'API Key' : 'DSH 原生连接'}</span>
                <span className={`${css.badge} ${item.configured || !requiresModelKey(item) ? css.badgeOk : css.badgeDim}`}>{!requiresModelKey(item) ? '交由 DSH 调用' : item.configured ? '已有凭据' : '未接入'}</span>
              </div>
              {canEditModelKey(item) && <div className={css.cardActions}>
                <button type="button" className={css.actionBtn} disabled={busy || loading} onClick={() => openKey(item.id)}>{item.configured ? '更新凭据' : '添加凭据'}</button>
                {item.configured && <button type="button" className={`${css.actionBtn} ${css.actionBtnDanger}`} disabled={busy || loading} onClick={() => { setTarget(item.id); setActionError(undefined); setPage('clear') }}>清除 Key</button>}
              </div>}
            </div>
            <div className={css.cardBody}>
              {item.description && <div>{item.description}</div>}
              {!requiresModelKey(item) && <div>使用宿主已有的认证方式；是否可调用以实际回执为准，无需在这里填写 Key。</div>}
              {requiresModelKey(item) && item.writable === false && <div>此凭据来源无法在工作台编辑，请在 DSH 原生设置中管理。</div>}
              {item.models.length > 0 ? <div className={css.modelsTags}>{item.models.map(model => <span key={model.id} className={css.modelTag}>{model.name ?? model.id}</span>)}</div> : <span className={css.emptyHint}>{WF.models.emptyModels}</span>}
            </div>
          </div>)}</div>
        </div>
        <div className={css.modalFooter}>
          <button type="button" className={css.actionBtn} disabled={loading || busy} onClick={() => { verification.invalidate(); void refresh() }}>{loading || busy ? '刷新中…' : '刷新 DSH 状态'}</button>
          <button type="button" className={css.actionBtn} disabled={busy} onClick={source.close}>暂不接入</button>
          <button type="button" className={`${css.actionBtn} ${css.actionBtnPrimary}`} disabled={busy} onClick={source.close}>完成并返回</button>
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
  missing_key: { category: 'missing_key', message: '尚未配置模型凭据，请在 DSH 中接入后重试。', action: 'addKey' },
  invalid_key: { category: 'invalid_key', message: '模型凭据无效或已被拒绝，请更新 DSH 凭据后重试。', action: 'addKey' },
  quota: { category: 'quota', message: '供应商余额不足或额度已用尽，请到供应商充值，或换一个模型。', action: 'changeModel' },
  network: { category: 'network', message: '连接失败、超时或触发限流，请稍后重试。', action: 'retry' },
  model_unavailable: { category: 'model_unavailable', message: '模型不存在、不可用或不支持工具调用，请选择其他模型。', action: 'changeModel' },
  missing_model: { category: 'missing_model', message: '尚未选择默认模型，请先选择模型。', action: 'changeModel' },
  unknown: { category: 'unknown', message: '模型测试未完成，请重试。', action: 'retry' },
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
    label: error.action === 'addKey' ? '管理模型凭据' : error.action === 'changeModel' ? WF.errorActions.changeModel : WF.errorActions.retry,
    ...(error.provider ? { provider: error.provider } : {}),
  }
}
