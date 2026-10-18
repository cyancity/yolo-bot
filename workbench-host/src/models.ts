/**
 * Native model routes at /wb/api/workforce/models. Credentials remain in
 * the host credentials service; default selection remains in agentDefaultModel.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GenerateOptions, LlmConfigurableProvider, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AdmitFn } from './extension.ts'
import { elapsedSeconds, modelClassOf, operationalRecorder, providerClassOf, verifyErrorCategoryOf, type OperationalErrorCategory } from './workforce/operational-diagnostics.ts'

const PREFIX = '/wb/api/workforce/models'
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const VERIFY_TIMEOUT_MS = 20_000

const send = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
const ok = (res: ServerResponse, data: unknown) => send(res, 200, { ok: true, data })
const fail = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { ok: false, error: { code, message } })
const httpError = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code })

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16 * 1024) { req.resume(); throw httpError(400, 'bad_request', '请求过大') }
    chunks.push(Buffer.from(chunk))
  }
  let value: unknown
  try { value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} }
  catch { throw httpError(400, 'bad_request', '请求不是合法 JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'bad_request', '请求必须是对象')
  return value as Record<string, unknown>
}

type Get = (name: string) => unknown

interface LlmLike {
  listProviders(): readonly { id: string; name?: string }[]
  listModels(provider: string): Promise<readonly { id: string; name?: string }[]>
  listConfigurableProviders?(): readonly LlmConfigurableProvider[]
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
interface CredentialsLike {
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}
interface SettingsLike { describe(options: { redactSecrets: true }): readonly { ns: string; value: unknown }[] }
interface ModelSelection { provider: string; model: string; reasoningEffort?: GenerateOptions['reasoningEffort'] }
interface DefaultModelLike {
  currentSelection(): ModelSelection | undefined
  saveSelection?(next: { provider: string; model: string }): Promise<void>
}


const llmOf = (get: Get) => get('llm') as LlmLike | undefined
const registered = (get: Get, provider: string) => llmOf(get)?.listProviders?.().some(item => item.id === provider) === true

/** Only an explicit apiKeyEnv requires a key; other native routes own their authentication. */
function keyRefFor(get: Get, provider: string): string | undefined {
  const unavailable = () => httpError(503, 'model_settings_unavailable', '原生模型设置暂不可用，请在原生模型设置中检查配置后重试')
  try {
    const entry = llmOf(get)?.listConfigurableProviders?.().find(item => item.provider === provider)
    if (!entry && provider !== 'deepseek-official') return undefined
    const settings = get('settings') as SettingsLike | undefined
    const descriptor = settings?.describe({ redactSecrets: true }).find(row => row.ns === (entry?.settingsNs ?? 'llm-deepseek'))
    if (!descriptor) throw unavailable()
    let profile = descriptor.value
    for (const part of entry?.settingsPath ?? []) {
      if (profile === undefined) break
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw unavailable()
      profile = Object.hasOwn(profile, part) ? Reflect.get(profile, part) : undefined
    }
    if (profile !== undefined && (!profile || typeof profile !== 'object' || Array.isArray(profile))) throw unavailable()
    const ref: unknown = profile && typeof profile === 'object' && Object.hasOwn(profile, 'apiKeyEnv') ? Reflect.get(profile, 'apiKeyEnv') : undefined
    if (ref === undefined) return provider === 'deepseek-official' ? 'DEEPSEEK_API_KEY' : undefined
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) throw unavailable()
    return ref
  } catch { throw unavailable() }
}

async function describeCredential(get: Get, ref: string) {
  try {
    const credentials = get('credentials') as CredentialsLike | undefined
    if (!credentials) throw new Error('unavailable')
    return await credentials.describe(ref)
  } catch { throw httpError(503, 'credentials_unavailable', '凭据状态暂不可用，请重试') }
}


async function status(get: Get) {
  const llm = llmOf(get)
  const defaults = (get('agentDefaultModel') as DefaultModelLike | undefined)?.currentSelection?.()
  const providers: Record<string, unknown>[] = []
  for (const route of llm?.listProviders() ?? []) {
    let models: { id: string; name?: string }[] = []
    try { models = [...await llm!.listModels(route.id)].map(model => ({ id: model.id, ...(model.name ? { name: model.name } : {}) })) }
    catch { /* 目录暂不可用时返回空清单，设置页仍可填 key */ }
    const entry: Record<string, unknown> = { id: route.id, name: route.name ?? route.id, kind: 'apikey', models }
    const ref = keyRefFor(get, route.id)
    entry.requiresApiKey = ref !== undefined
    if (ref !== undefined) {
      entry.credentialRef = entry.keyRef = ref
      const info = await describeCredential(get, ref)
      entry.configured = info.configured === true
      entry.writable = info.writable === true
      if (info.source) entry.keySource = info.source
    } else {
      entry.configured = true
      entry.writable = false
      entry.keySource = 'native'
    }
    providers.push(entry)
  }
  return {
    providers,
    defaultModel: defaults ?? null,
  }
}

type VerifyCategory = 'missing_key' | 'invalid_key' | 'quota' | 'network' | 'model_unavailable' | 'missing_model' | 'unknown'
type VerifyError = { category: VerifyCategory; message: string; action: 'addKey' | 'changeModel' | 'retry' }

/** Only these product-owned messages cross HTTP; provider diagnostics stay private. */
function verifyError(category: VerifyCategory): VerifyError {
  switch (category) {
    case 'missing_key': return { category, message: '尚未配置 API Key，请添加 Key 后再测试。', action: 'addKey' }
    case 'invalid_key': return { category, message: 'API Key 无效或已被拒绝，请更新 Key 后再测试。', action: 'addKey' }
    case 'quota': return { category, message: '供应商余额不足或额度已用尽，请到供应商充值，或换一个模型。', action: 'changeModel' }
    case 'network': return { category, message: '连接失败、超时或触发限流，请稍后重试。', action: 'retry' }
    case 'model_unavailable': return { category, message: '模型不存在、不可用或不支持工具调用，请选择其他模型。', action: 'changeModel' }
    case 'missing_model': return { category, message: '尚未选择默认模型，请先选择模型。', action: 'changeModel' }
    case 'unknown': return { category, message: '模型测试未完成，请重试。', action: 'retry' }
  }
}

function classifyVerifyError(error: unknown): VerifyCategory {
  const codes: string[] = [], messages: string[] = [], statuses: number[] = []
  // Native errors carry failure facts; transport causes may add a stable socket code.
  for (let value = error, depth = 0; value && typeof value === 'object' && depth < 4; depth++) {
    const facts = value as { code?: unknown; message?: unknown; status?: unknown; failure?: { code?: unknown; message?: unknown; status?: unknown }; cause?: unknown }
    for (const row of [facts, facts.failure]) {
      if (typeof row?.code === 'string') codes.push(row.code.toUpperCase())
      if (typeof row?.message === 'string') messages.push(row.message)
      if (typeof row?.status === 'number') statuses.push(row.status)
    }
    value = facts.cause
  }
  const code = codes.join(' '), detail = messages.join(' ')
  if (/\b(?:MISSING_CREDENTIAL|MISSING_KEY|ACCOUNT_SIGN_IN_REQUIRED)\b/.test(code) || /no (?:api key|credential)|api key.{0,40}(?:not set|missing)|未配置.{0,12}(?:key|密钥)/i.test(detail)) return 'missing_key'
  if (/\b(?:QUOTA|ACCOUNT_QUOTA|QUOTA_EXCEEDED|INSUFFICIENT_QUOTA|INSUFFICIENT_BALANCE|HTTP_402)\b/.test(code) || statuses.includes(402) || /insufficient[\s_-]+(?:quota|balance|credits?)|(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)|exceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota|(?:balance|credits?)[\s_-]+(?:exhausted|depleted)|out[\s_-]+of[\s_-]+(?:credits?|budget)|余额不足|额度.{0,8}(?:不足|用尽|耗尽)/i.test(detail)) return 'quota'
  if (/\b(?:AUTH|INVALID_CREDENTIAL|INVALID_KEY|INVALID_API_KEY|ACCOUNT_TOKEN_INVALID|HTTP_401|HTTP_403)\b/.test(code) || statuses.some(status => status === 401 || status === 403) || /\b(?:401|403)\b|invalid[\s_-]+(?:api[\s_-]+)?key|incorrect api key|authentication.{0,20}(?:failed|invalid)|unauthorized/i.test(detail)) return 'invalid_key'
  if (/\b(?:NO_ADAPTER|MODEL_UNAVAILABLE|MODEL_NOT_FOUND|UNKNOWN_MODEL|UNSUPPORTED_MODEL|UNSUPPORTED_TOOLS?|UNSUPPORTED_TOOL_CALLING|HTTP_404|UNSUPPORTED_REASONING_EFFORT)\b/.test(code) || statuses.includes(404) || /model.{0,80}(?:not found|does not exist|not available|unavailable|not supported|unsupported)|(?:unknown|unsupported|invalid)[\s_-]+model|(?:tools?|tool[\s_-]?calling|function[\s_-]?calling).{0,80}(?:not supported|unsupported|not available)|(?:not support|unsupported|does not support).{0,80}(?:tools?|tool[\s_-]?calling|function[\s_-]?calling)|模型.{0,20}(?:不存在|不可用|不支持)|不支持.{0,20}工具/i.test(detail)) return 'model_unavailable'
  if (/\b(?:TIMEOUT|TRANSPORT|ABORTED|RATE_LIMIT|SERVER|NETWORK_UNAVAILABLE|STREAM_CLOSED|SERVER_PENDING|HTTP_429|HTTP_5\d\d|ECONN[A-Z]+|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+)\b/.test(code) || statuses.some(status => status === 429 || status >= 500) || /timeout|timed?\s*out|network|fetch failed|connection|socket|rate.?limit|\b429\b|网络|超时|限流/i.test(detail)) return 'network'
  return 'unknown'
}

async function verify(get: Get, signal: AbortSignal, selection: ModelSelection | undefined) {
  const identity = selection ? { provider: selection.provider, model: selection.model } : {}
  const failed = (category: VerifyCategory) => ({ verified: false, ...identity, error: verifyError(category) })
  if (!selection?.provider || !selection.model) return failed('missing_model')
  const llm = llmOf(get)
  if (!llm?.stream || !registered(get, selection.provider)) return failed('model_unavailable')
  let iterator: AsyncIterator<StreamChunk> | undefined
  const streamControl = new AbortController()
  const closeStream = () => {
    streamControl.abort()
    // A non-cooperative adapter's teardown must not hold the HTTP deadline.
    try { void iterator?.return?.().catch(() => {}) } catch { /* The signal already owns cancellation. */ }
  }
  signal.addEventListener('abort', closeStream, { once: true })
  try {
    signal.throwIfAborted()
    const ref = keyRefFor(get, selection.provider)
    if (ref !== undefined && !(await describeCredential(get, ref)).configured) return failed('missing_key')
    signal.throwIfAborted()
    let output = false
    // Native model metadata has no negative tools-capability field. Always probe
    // the tools wire shape, not just a pure-text completion. Nothing executes it.
    iterator = llm.stream({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK. Do not invoke tools.' }] }],
      tools: [{ name: 'workbench_connection_probe', description: 'A connection test declaration only; no tool is executed.', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
      maxTokens: 32,
      signal: AbortSignal.any([signal, streamControl.signal]),
    })[Symbol.asyncIterator]()
    for (;;) {
      const next = await iterator.next()
      if (next.done) return failed('unknown')
      const chunk = next.value
      signal.throwIfAborted()
      if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text.length > 0) output = true
      if (chunk.type === 'tool-call-delta' || chunk.type === 'block-end') output = true
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          const failure = chunk.reason.failure
          return failed(classifyVerifyError(failure))
        }
        if (!['stop', 'max-tokens', 'tool-calls'].includes(chunk.reason.kind)) return failed('unknown')
        return output ? { verified: true, ...identity } : failed('unknown')
      }
    }
  } catch (error) {
    // Metadata failures do not diagnose the model or its authentication.
    if (error && typeof error === 'object' && 'code' in error && (error.code === 'model_settings_unavailable' || error.code === 'credentials_unavailable')) return failed('unknown')
    return failed(signal.aborted ? 'network' : classifyVerifyError(error))
  } finally {
    signal.removeEventListener('abort', closeStream)
    closeStream()
  }
}

async function verifyRequest(req: IncomingMessage, res: ServerResponse, get: Get): Promise<void> {
  const defaults = get('agentDefaultModel') as DefaultModelLike | undefined
  const current = defaults?.currentSelection?.()
  const selection = current ? { ...current } : undefined
  const control = new AbortController()
  const cancel = () => control.abort()
  const aborted = new Promise<unknown>(resolve => {
    const onAbort = () => resolve({ verified: false, ...(selection ? { provider: selection.provider, model: selection.model } : {}), error: verifyError('network') })
    control.signal.addEventListener('abort', onAbort, { once: true })
  })
  req.once('aborted', cancel)
  res.once('close', cancel)
  const timer = setTimeout(cancel, VERIFY_TIMEOUT_MS)
  if (req.aborted || res.destroyed) cancel()
  const checkStartedAt = Date.now()
  let checkOutcome: 'success' | 'failed' | 'aborted' = 'failed'
  let checkCategory: OperationalErrorCategory | null = 'unknown'
  try {
    const result = await Promise.race([verify(get, control.signal, selection), aborted]) as { verified?: boolean; error?: { category?: string } }
    // TEL-H：记录模型测试的类别化结果（不含 key/provider/model 原值）。
    if (control.signal.aborted) { checkOutcome = 'aborted'; checkCategory = 'cancelled' }
    else if (result.verified === true) { checkOutcome = 'success'; checkCategory = null }
    else checkCategory = verifyErrorCategoryOf(result.error?.category)
    if (!res.destroyed && !res.writableEnded) ok(res, result)
  } catch (error) {
    checkCategory = error && typeof error === 'object' && 'status' in error && (error.status === 401 || error.status === 403) ? 'permission' : 'internal'
    throw error
  } finally {
    operationalRecorder.recordModelCheck({ outcome: checkOutcome, errorCategory: checkCategory, providerClass: providerClassOf(selection?.provider), modelClass: modelClassOf(selection?.provider, selection?.model), elapsedSec: elapsedSeconds(checkStartedAt) })
    // Signal and iterator cleanup proceed even after a disconnected HTTP client.
    control.abort()
    clearTimeout(timer)
    req.off('aborted', cancel)
    res.off('close', cancel)
  }
}

function key(input: Record<string, unknown>): string {
  const key = typeof input.key === 'string' ? input.key.trim() : ''
  if (key.length < 8 || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) throw httpError(400, 'bad_request', 'API Key 格式不正确')
  return key
}
function apikeyTarget(get: Get, input: Record<string, unknown>): { provider: string; ref: string } {
  const provider = typeof input.provider === 'string' ? input.provider : ''
  if (!provider || !registered(get, provider)) throw httpError(400, 'bad_request', '该模型来源未注册')
  const ref = keyRefFor(get, provider)
  if (ref === undefined) throw httpError(400, 'native_model_settings_required', '此模型使用原生认证；如需填写 API Key，请在原生模型设置中配置')
  return { provider, ref }
}

export function createModelsHandler(deps: { get: Get }, admit: AdmitFn, fallback: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const { get } = deps
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return fallback(req, res)
    const rejection = admit(req).rejection
    if (rejection) return fail(res, rejection, 'local_admission_required', '本机会话未授权')
    try {
      const seg = url.pathname.slice(PREFIX.length).split('/').filter(Boolean)
      const method = req.method ?? 'GET'
      if (seg.length === 0 && method === 'GET') return ok(res, await status(get))
      const input = ['PUT', 'POST', 'PATCH', 'DELETE'].includes(method) ? await jsonBody(req) : {}
      if (seg.length === 1 && seg[0] === 'verify' && method === 'POST') {
        if (Object.keys(input).length) throw httpError(400, 'bad_request', '模型测试不接受参数，请先选择默认模型')
        return await verifyRequest(req, res, get)
      }
      if (seg.length === 1 && seg[0] === 'key') {
        const credentials = get('credentials') as CredentialsLike | undefined
        if (!credentials) throw httpError(503, 'unavailable', '凭据服务不可用')
        if (method === 'PUT' || method === 'POST') {
          const { provider, ref } = apikeyTarget(get, input)
          const value = key(input)
          try { await credentials.set(ref, value) }
          catch { throw httpError(503, 'unavailable', 'Key 保存失败，请重试') }
          return ok(res, { provider, configured: (await describeCredential(get, ref)).configured })
        }
        if (method === 'DELETE') {
          const { provider, ref } = apikeyTarget(get, input)
          try { await credentials.unset(ref) }
          catch { throw httpError(503, 'unavailable', 'Key 删除失败，请重试') }
          return ok(res, { provider, configured: (await describeCredential(get, ref)).configured })
        }
      }
      if (seg.length === 1 && seg[0] === 'default' && method === 'PUT') {
        const provider = typeof input.provider === 'string' ? input.provider : ''
        const model = typeof input.model === 'string' ? input.model : ''
        if (!provider || !model) throw httpError(400, 'bad_request', '请选择模型')
        if (!registered(get, provider)) throw httpError(400, 'bad_request', '该模型来源未注册或已下线')
        const defaults = get('agentDefaultModel') as DefaultModelLike | undefined
        if (!defaults?.saveSelection) throw httpError(503, 'unavailable', '默认模型服务不可用')
        await defaults.saveSelection({ provider, model })
        return ok(res, { provider, model })
      }
      return fail(res, 404, 'not_found', '模型接口不存在')
    } catch (error) {
      const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 500
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : status === 400 ? 'bad_request' : 'internal'
      return fail(res, status, code, status === 500 ? '模型设置暂不可用，请重试' : (error as Error).message)
    }
  }
}
