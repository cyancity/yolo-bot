import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdmitFn, EmployeeScopeContribution, WorkbenchHost, WorkbenchHttp, WorkbenchRoute } from './extension.ts'
import type { WorkbenchLifecycle } from './info.ts'
import { serveFile } from './http-files.ts'
import { WorkforceError } from './workforce/types.ts'

export const API_PREFIX = '/wb/api'
const MAX_BODY_BYTES = 256 * 1024

/** One local-admitted front door for core and extension routes. */
export class WorkbenchRouter implements WorkbenchHost {
  readonly http: WorkbenchHttp
  private readonly routes = new Map<string, WorkbenchRoute>()

  constructor(
    readonly root: string,
    admit: AdmitFn,
    private readonly lifecycle: WorkbenchLifecycle,
    private readonly contribute: (value: EmployeeScopeContribution) => () => void,
  ) {
    this.http = {
      admit,
      async readJson(request) {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            request.resume()
            throw new WorkforceError('bad_request', '请求体过大')
          }
          chunks.push(Buffer.from(chunk))
        }
        try { return size === 0 ? {} : JSON.parse(Buffer.concat(chunks, size).toString('utf8')) }
        catch { throw new WorkforceError('bad_request', '请求体不是合法 JSON') }
      },
      sendJson(response, status, body) {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(body))
      },
      sendError: (response, status, error) => this.http.sendJson(response, status, { ok: false, error }),
      serveFile,
    }
  }

  registerRoute(route: WorkbenchRoute): () => void {
    this.lifecycle.assertRegistrationAllowed()
    if (!route.id || this.routes.has(route.id)) throw new WorkforceError('conflict', '路由标识已注册或为空')
    const segments = route.prefix.split('/')
    if (!route.prefix.startsWith('/') || segments.length < 2 || segments.slice(1).some(segment => !segment || segment === '.' || segment === '..')
      || /[%?#\\\s]/.test(route.prefix) || route.prefix === API_PREFIX || route.prefix.startsWith(API_PREFIX + '/')) {
      throw new WorkforceError('bad_request', '路由前缀必须是相对 API 根的完整路径段')
    }
    if ([...this.routes.values()].some(existing => existing.prefix === route.prefix)) throw new WorkforceError('conflict', '路由前缀已注册')
    // Capture registration facts; a caller cannot later mutate its route to bypass duplicate checks.
    const registered = { id: route.id, prefix: route.prefix, handle: route.handle.bind(route) }
    this.routes.set(route.id, registered)
    return () => { if (this.routes.get(registered.id) === registered) this.routes.delete(registered.id) }
  }

  registerEmployeeScopeContribution(value: EmployeeScopeContribution): () => void {
    this.lifecycle.assertRegistrationAllowed()
    return this.contribute(value)
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const rejection = this.http.admit(request).rejection
      if (rejection) return this.http.sendError(response, rejection, { code: 'local_admission_required', message: '本机会话未授权' })
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== API_PREFIX && !url.pathname.startsWith(API_PREFIX + '/')) {
        return this.http.sendError(response, 404, { code: 'not_found', message: '接口不存在' })
      }
      const path = url.pathname.slice(API_PREFIX.length) || '/'
      if (/%(?:2f|5c)|\\/i.test(path)) throw new WorkforceError('bad_request', '路径分隔符编码无效')
      let route: WorkbenchRoute | undefined
      for (const candidate of this.routes.values()) {
        if ((path === candidate.prefix || path.startsWith(candidate.prefix + '/')) && (!route || candidate.prefix.length > route.prefix.length)) route = candidate
      }
      if (!route) return this.http.sendError(response, 404, { code: 'not_found', message: '接口不存在' })
      // Backup owns maintenance acquisition itself; counting that request would make it busy forever.
      const backup = route.id === 'core.workforce' && path === '/workforce/backup' && request.method === 'POST'
      const release = route.id === 'core.health' || backup ? undefined : this.lifecycle.operation()
      if (release) {
        const completed = () => {
          response.off('finish', completed)
          response.off('close', completed)
          release()
        }
        response.once('finish', completed)
        response.once('close', completed)
        if (response.destroyed || response.writableFinished) completed()
      }
      await route.handle(request, response)
    } catch (error) {
      if (response.headersSent) { response.destroy(error instanceof Error ? error : undefined); return }
      const code = error instanceof WorkforceError ? error.code : 'internal'
      const status = code === 'bad_request' ? 400 : code === 'not_found' ? 404 : code === 'conflict' ? 409 : code === 'unavailable' ? 503 : 500
      this.http.sendError(response, status, { code, message: error instanceof WorkforceError ? error.message : '服务暂不可用' })
    }
  }
}
