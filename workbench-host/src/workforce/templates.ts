import type { ExtensionDisposer, TemplateListing, TemplateProvider, WorkbenchTemplates } from '../extension.ts'
import type { WorkbenchLifecycle } from '../info.ts'
import type { WorkforceStore } from './store.ts'
import { WorkforceError } from './types.ts'

/** Metadata only. Resource loading and durable enabled state belong to each provider. */
export class WorkbenchTemplateService implements WorkbenchTemplates {
  private providers = new Map<string, TemplateProvider>()
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly store: WorkforceStore, private readonly lifecycle?: WorkbenchLifecycle) {}

  registerProvider(provider: TemplateProvider): ExtensionDisposer {
    this.lifecycle?.assertRegistrationAllowed()
    if (!provider.id || typeof provider.list !== 'function' || typeof provider.setEnabled !== 'function') throw new WorkforceError('bad_request', '模板提供者无效')
    if (this.providers.has(provider.id)) throw new WorkforceError('conflict', '模板提供者 id 已注册')
    const retained = Object.freeze({ id: provider.id, list: provider.list.bind(provider), setEnabled: provider.setEnabled.bind(provider) })
    this.providers.set(retained.id, retained)
    let active = true
    return () => { if (active) { this.providers.delete(retained.id); active = false } }
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const release = this.lifecycle?.operation()
    const operation = this.pending.then(action)
    this.pending = operation.catch(() => {})
    return operation.finally(() => release?.())
  }

  private async catalog(): Promise<Map<string, { provider: TemplateProvider; listing: TemplateListing }>> {
    const snapshot = [...this.providers.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const batches: { provider: TemplateProvider; listings: readonly TemplateListing[] }[] = []
    for (const provider of snapshot) batches.push({ provider, listings: await provider.list() })
    const catalog = new Map<string, { provider: TemplateProvider; listing: TemplateListing }>()
    for (const { provider, listings } of batches) {
      // A removed provider's async list must not resurrect its catalog entries.
      if (this.providers.get(provider.id) !== provider) continue
      for (const value of listings) {
        if (!value.id || typeof value.label !== 'string' || typeof value.description !== 'string' || typeof value.enabled !== 'boolean' || !Array.isArray(value.skills) || !Array.isArray(value.employees)) {
          throw new WorkforceError('bad_request', `模板提供者 ${provider.id} 返回了无效目录`)
        }
        if (catalog.has(value.id)) throw new WorkforceError('conflict', `模板 id 重复：${value.id}`)
        catalog.set(value.id, { provider, listing: structuredClone(value) })
      }
    }
    return catalog
  }

  list(): Promise<readonly TemplateListing[]> {
    return this.run(async () => [...(await this.catalog()).values()].map(item => item.listing))
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.run(async () => {
      if (typeof enabled !== 'boolean') throw new WorkforceError('bad_request', 'enabled 必须是布尔值')
      const item = (await this.catalog()).get(id)
      if (!item) throw new WorkforceError('not_found', '模板不存在')
      await item.provider.setEnabled(id, enabled)
    })
  }

  apply(id: string): Promise<readonly string[]> {
    return this.run(async () => (await this.applyEmployees(id, true)).created)
  }

  /** Existing HTTP schema reports employee names, including the seeds skipped by the transaction. */
  applyResult(id: string): Promise<{ created: string[]; skipped: string[] }> {
    return this.run(() => this.applyEmployees(id, false))
  }

  private async applyEmployees(id: string, ids: boolean): Promise<{ created: string[]; skipped: string[] }> {
    const item = (await this.catalog()).get(id)
    if (!item) throw new WorkforceError('not_found', '模板不存在')
    const seeds = item.listing.employees
    return this.store.applyTemplateEmployees(seeds, ids ? { ids: true } : undefined)
  }
}
