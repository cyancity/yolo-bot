import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModelsHandler } from '../src/models.ts'
import { listenForFetch } from './helpers/http-server.ts'

const PROVIDER = 'fixture-native-route'
const MODEL = 'fixture-model'
const REF = 'SHARED_NATIVE_MODEL_REF'
const FIXTURE_KEY = 'fixture-key-only-in-memory'
const PRIVATE_DETAIL = 'fixture-private-metadata-detail'
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }))
})

async function fixture(provider = PROVIDER) {
  const stored = new Set<string>()
  const credentials = {
    describe: vi.fn(async (ref: string) => ({ configured: stored.has(ref), writable: true, source: 'store', key: FIXTURE_KEY })),
    set: vi.fn(async (ref: string, _value: string) => { stored.add(ref) }),
    unset: vi.fn(async (ref: string) => { stored.delete(ref) }),
  }
  const settings = {
    describe: vi.fn((_options: { redactSecrets: true }): { ns: string; value: unknown }[] => [
      { ns: 'fixture-model-settings', value: { profiles: { 'profile.with.dots': { apiKeyEnv: REF } } } },
      { ns: 'llm-pi-ai', value: { providers: { [provider]: { apiKeyEnv: 'WRONG_LEGACY_REF' } } } },
    ]),
  }
  const llm = {
    listProviders: vi.fn(() => [{ id: provider, name: 'Fixture provider' }]),
    listModels: vi.fn(async (_provider: string) => [{ id: MODEL, name: 'Fixture model' }]),
    listConfigurableProviders: vi.fn(() => [{ provider, settingsNs: 'fixture-model-settings', settingsPath: ['profiles', 'profile.with.dots'] }]),
    stream: vi.fn((_options: { provider: string; model: string }) => (async function* () {
      yield { type: 'text-delta', text: 'OK' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()),
  }
  const services: Record<string, unknown> = {
    llm, settings, credentials,
    agentDefaultModel: { currentSelection: () => ({ provider, model: MODEL }) },
  }
  let rejection: 401 | 403 | undefined
  const fallback = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(404); res.end('fallback') })
  const handler = createModelsHandler(
    { get: name => services[name] },
    () => rejection ? { rejection } : { peer: {} },
    fallback,
  )
  const server = createServer(handler)
  servers.push(server)
  const base = `http://127.0.0.1:${await listenForFetch(server)}/wb/api/workforce/models`
  const request = async (route = '', method = 'GET', body?: unknown) => {
    const response = await fetch(base + route, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const text = await response.text()
    expect(text).not.toContain(FIXTURE_KEY)
    expect(text).not.toContain(PRIVATE_DETAIL)
    return { status: response.status, body: JSON.parse(text) }
  }
  return { credentials, settings, llm, services, stored, request, fallback, base, reject: (next: 401 | 403) => { rejection = next } }
}

describe('BYOK 原生模型元数据与凭据引用', () => {
  it('status、verify、写删按 settingsNs/settingsPath 读取同一个真实引用，不采用旧命名猜测', async () => {
    const f = await fixture()
    f.stored.add('WRONG_LEGACY_REF')
    f.stored.add('FIXTURE_NATIVE_ROUTE_API_KEY')
    const initial = await f.request()
    expect(initial.status).toBe(200)
    expect(initial.body.data.providers).toEqual([{
      id: PROVIDER, name: 'Fixture provider', kind: 'apikey', models: [{ id: MODEL, name: 'Fixture model' }],
      requiresApiKey: true, credentialRef: REF, keyRef: REF, configured: false, writable: true, keySource: 'store',
    }])
    const missing = await f.request('/verify', 'POST', {})
    expect(missing.status).toBe(200)
    expect(missing.body).toMatchObject({ ok: true, data: { verified: false, error: { category: 'missing_key', action: 'addKey' } } })
    expect(f.llm.stream).not.toHaveBeenCalled()

    const saved = await f.request('/key', 'PUT', { provider: PROVIDER, key: ` ${FIXTURE_KEY} `, credentialRef: 'RENDERER_REF' })
    expect(saved).toEqual({ status: 200, body: { ok: true, data: { provider: PROVIDER, configured: true } } })
    expect(f.credentials.set).toHaveBeenCalledExactlyOnceWith(REF, FIXTURE_KEY)
    expect((await f.request()).body.data.providers[0].configured).toBe(true)
    const verified = await f.request('/verify', 'POST', {})
    expect(verified).toEqual({ status: 200, body: { ok: true, data: { verified: true, provider: PROVIDER, model: MODEL } } })
    expect(f.llm.stream).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: PROVIDER, model: MODEL }))

    const cleared = await f.request('/key', 'DELETE', { provider: PROVIDER, credentialRef: 'RENDERER_REF' })
    expect(cleared).toEqual({ status: 200, body: { ok: true, data: { provider: PROVIDER, configured: false } } })
    expect(f.credentials.unset).toHaveBeenCalledExactlyOnceWith(REF)
    expect(f.credentials.describe.mock.calls.every(([ref]) => ref === REF)).toBe(true)
    expect(f.settings.describe.mock.calls.every(([options]) => options.redactSecrets === true)).toBe(true)
    expect(f.stored).toEqual(new Set(['WRONG_LEGACY_REF', 'FIXTURE_NATIVE_ROUTE_API_KEY']))
  })

  it.each([false, true])('官方模型无显式 apiKeyEnv 时使用 DEEPSEEK_API_KEY，configurable entry=%s', async configurable => {
    const f = await fixture('deepseek-official')
    f.llm.listConfigurableProviders.mockReturnValue(configurable
      ? [{ provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [] }]
      : [])
    f.settings.describe.mockReturnValue([{ ns: 'llm-deepseek', value: {} }])
    const status = await f.request()
    expect(status.status).toBe(200)
    expect(status.body.data.providers[0]).toMatchObject({ requiresApiKey: true, credentialRef: 'DEEPSEEK_API_KEY', configured: false })
    await f.request('/key', 'PUT', { provider: 'deepseek-official', key: FIXTURE_KEY })
    expect(f.credentials.set).toHaveBeenCalledExactlyOnceWith('DEEPSEEK_API_KEY', FIXTURE_KEY)
    expect((await f.request('/verify', 'POST', {})).body.data.verified).toBe(true)
    await f.request('/key', 'DELETE', { provider: 'deepseek-official' })
    expect(f.credentials.unset).toHaveBeenCalledExactlyOnceWith('DEEPSEEK_API_KEY')
    expect(f.credentials.describe.mock.calls.every(([ref]) => ref === 'DEEPSEEK_API_KEY')).toBe(true)
  })

  it('官方自定义长引用优先于默认引用，状态与写删使用当前原生配置', async () => {
    const f = await fixture('deepseek-official')
    const longRef = `CUSTOM_${'A'.repeat(140)}`
    f.settings.describe.mockReturnValue([{ ns: 'fixture-model-settings', value: { profiles: { 'profile.with.dots': { apiKeyEnv: longRef } } } }])
    expect((await f.request()).body.data.providers[0].credentialRef).toBe(longRef)
    await f.request('/key', 'PUT', { provider: 'deepseek-official', key: FIXTURE_KEY })
    expect(f.credentials.set).toHaveBeenCalledExactlyOnceWith(longRef, FIXTURE_KEY)
    expect((await f.request('/verify', 'POST', {})).body.data.verified).toBe(true)
    await f.request('/key', 'DELETE', { provider: 'deepseek-official' })
    expect(f.credentials.unset).toHaveBeenCalledExactlyOnceWith(longRef)
    expect(f.credentials.describe.mock.calls.every(([ref]) => ref === longRef)).toBe(true)
  })

  it.each([false, true])('无引用 native 交给宿主尝试，不造 Key 且 PUT/DELETE 明确拒绝，configurable=%s', async configurable => {
    const f = await fixture()
    if (configurable) f.settings.describe.mockReturnValue([{ ns: 'fixture-model-settings', value: { profiles: { 'profile.with.dots': {} } } }])
    else f.llm.listConfigurableProviders.mockReturnValue([])
    const status = await f.request()
    expect(status.status).toBe(200)
    expect(status.body.data.providers[0]).toMatchObject({ configured: true, requiresApiKey: false, writable: false, keySource: 'native' })
    expect(status.body.data.providers[0]).not.toHaveProperty('credentialRef')
    expect(status.body.data.providers[0]).not.toHaveProperty('keyRef')
    const verified = await f.request('/verify', 'POST', {})
    expect(verified.body.data).toEqual({ verified: true, provider: PROVIDER, model: MODEL })
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    for (const method of ['PUT', 'DELETE']) {
      const result = await f.request('/key', method, { provider: PROVIDER, key: FIXTURE_KEY })
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ ok: false, error: { code: 'native_model_settings_required' } })
    }
    expect(f.credentials.describe).not.toHaveBeenCalled()
    expect(f.credentials.set).not.toHaveBeenCalled()
    expect(f.credentials.unset).not.toHaveBeenCalled()
    expect(f.stored.size).toBe(0)
  })

  it.each(['settings throw', 'settings missing', 'invalid ref', 'credentials throw', 'credentials missing'] as const)('%s：status/key安全503，verify明确unknown且不调用模型', async failure => {
    const f = await fixture()
    const settingsFailure = failure.startsWith('settings') || failure === 'invalid ref'
    const code = settingsFailure ? 'model_settings_unavailable' : 'credentials_unavailable'
    if (failure === 'settings throw') f.settings.describe.mockImplementation(() => { throw new Error(PRIVATE_DETAIL) })
    if (failure === 'settings missing') f.settings.describe.mockReturnValue([])
    if (failure === 'invalid ref') f.settings.describe.mockReturnValue([{ ns: 'fixture-model-settings', value: { profiles: { 'profile.with.dots': { apiKeyEnv: 'invalid-ref!' } } } }])
    if (failure === 'credentials throw') f.credentials.describe.mockRejectedValue(new Error(PRIVATE_DETAIL))
    if (failure === 'credentials missing') delete f.services.credentials
    for (const [route, method, body] of [
      ['', 'GET', undefined],
      ['/key', 'PUT', { provider: PROVIDER, key: FIXTURE_KEY }],
      ['/key', 'DELETE', { provider: PROVIDER }],
      ['/verify', 'POST', {}],
    ] as const) {
      const result = await f.request(route, method, body)
      if (route === '/verify') {
        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({ ok: true, data: { verified: false, provider: PROVIDER, model: MODEL, error: { category: 'unknown', action: 'retry' } } })
      } else {
        expect(result.status, `${method} ${route || '/'}`).toBe(503)
        expect(result.body).toMatchObject({ ok: false, error: { code: failure === 'credentials missing' && route === '/key' ? 'unavailable' : code } })
        expect(result.body).not.toHaveProperty('data')
      }
    }
    expect(f.llm.stream).not.toHaveBeenCalled()
    if (settingsFailure || failure === 'credentials missing') {
      expect(f.credentials.set).not.toHaveBeenCalled()
      expect(f.credentials.unset).not.toHaveBeenCalled()
    }
  })

  it('写删返回原生describe结果，环境凭据不能被误报成已清除', async () => {
    const f = await fixture()
    f.credentials.describe.mockImplementation(async () => ({ configured: true, writable: false, source: 'env', key: FIXTURE_KEY }))
    const cleared = await f.request('/key', 'DELETE', { provider: PROVIDER })
    expect(cleared).toEqual({ status: 200, body: { ok: true, data: { provider: PROVIDER, configured: true } } })
    expect((await f.request()).body.data.providers[0]).toMatchObject({ configured: true, writable: false, keySource: 'env' })
    expect(f.credentials.unset).toHaveBeenCalledExactlyOnceWith(REF)
    f.credentials.describe.mockImplementation(async () => ({ configured: false, writable: true, source: 'store', key: FIXTURE_KEY }))
    const saved = await f.request('/key', 'PUT', { provider: PROVIDER, key: FIXTURE_KEY })
    expect(saved.body).toEqual({ ok: true, data: { provider: PROVIDER, configured: false } })
  })

  it('原生写删异常脱敏为503，不回显fixture Key或底层诊断', async () => {
    const f = await fixture()
    f.credentials.set.mockRejectedValue(new Error(`${PRIVATE_DETAIL} ${FIXTURE_KEY}`))
    f.credentials.unset.mockRejectedValue(new Error(`${PRIVATE_DETAIL} ${FIXTURE_KEY}`))
    for (const method of ['PUT', 'DELETE']) {
      const result = await f.request('/key', method, { provider: PROVIDER, key: FIXTURE_KEY })
      expect(result.status).toBe(503)
      expect(result.body).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    }
    expect(f.credentials.describe).not.toHaveBeenCalled()
  })

  it('本机会话admission先于目录/凭据查询及写操作，其他路径交fallback', async () => {
    const f = await fixture()
    f.reject(403)
    for (const [route, method, body] of [['', 'GET', undefined], ['/verify', 'POST', {}], ['/key', 'PUT', { provider: PROVIDER, key: FIXTURE_KEY }]] as const) {
      const result = await f.request(route, method, body)
      expect(result).toMatchObject({ status: 403, body: { ok: false, error: { code: 'local_admission_required' } } })
    }
    expect(f.llm.listProviders).not.toHaveBeenCalled()
    expect(f.settings.describe).not.toHaveBeenCalled()
    expect(f.credentials.describe).not.toHaveBeenCalled()
    expect(f.credentials.set).not.toHaveBeenCalled()
    expect(f.llm.stream).not.toHaveBeenCalled()
    expect((await fetch(f.base.replace('/workforce/models', '/unrelated'))).status).toBe(404)
    expect(f.fallback).toHaveBeenCalledTimes(1)
  })
})
