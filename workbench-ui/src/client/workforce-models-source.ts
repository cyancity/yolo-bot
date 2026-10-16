/** 工作台生命期内唯一的模型接入入口；只查目录/凭据状态，不隐式测试模型。 */
import { WorkforceApi, type DefaultModelSelection, type ModelProviderInfo, type WorkforceModelsState } from './workforce-api.ts'
import type { Employee } from './workforce-types.ts'

export function requiresModelKey(provider: ModelProviderInfo): boolean {
  return provider.requiresApiKey !== false
}

export function canEditModelKey(provider: ModelProviderInfo): boolean {
  return requiresModelKey(provider) && provider.writable !== false
}

export interface ModelAccessRequest {
  readonly provider?: string | undefined
  readonly message?: string | undefined
}

interface ModelsSnapshot {
  readonly state: WorkforceModelsState
  readonly loaded: boolean
  readonly loading: boolean
  readonly error?: string | undefined
  readonly access?: ModelAccessRequest | undefined
}

export class WorkforceModelsSource {
  private current: ModelsSnapshot = { state: { providers: [] }, loaded: false, loading: false }
  private listeners = new Set<() => void>()
  private pending: Promise<WorkforceModelsState> | undefined

  constructor(readonly api = new WorkforceApi()) {}

  getSnapshot = (): ModelsSnapshot => this.current
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(next: ModelsSnapshot): void {
    this.current = next
    for (const listener of this.listeners) listener()
  }

  open = (request: ModelAccessRequest = {}): void => {
    // 已显示时保留正在编辑的内页；并发动作不会重置 Key 输入。
    if (this.current.access !== undefined) return
    this.publish({ ...this.current, access: request })
  }
  close = (): void => { this.publish({ ...this.current, access: undefined }) }

  refresh = (): Promise<WorkforceModelsState> => {
    if (this.pending) return this.pending
    this.publish({ ...this.current, loading: true, error: undefined })
    this.pending = this.api.models().then(state => {
      this.publish({ ...this.current, state, loaded: true, loading: false, error: undefined })
      return state
    }).catch(() => {
      const error = '无法读取 DSH 模型与凭据状态，请检查工作台连接后重试。输入已保留。'
      this.publish({ ...this.current, loading: false, error })
      throw new Error(error)
    }).finally(() => { this.pending = undefined })
    return this.pending
  }

  /** 实际 LLM 操作前调用。缺配置时拒绝当前操作，接入完成后由用户重新发送。 */
  async require(employees: readonly (Pick<Employee, 'name' | 'model'> | undefined)[] = [undefined]): Promise<void> {
    const state = await this.refresh()
    for (const employee of employees) {
      const override = employee?.model?.trim()
      const slash = override?.indexOf('/') ?? -1
      const selection: DefaultModelSelection | undefined = override
        ? slash > 0 ? { provider: override.slice(0, slash), model: override.slice(slash + 1) }
          : state.defaultModel ? { ...state.defaultModel, model: override } : undefined
        : state.defaultModel
      const provider = state.providers.find(item => item.id === selection?.provider)
      const target = employee ? `${employee.name}使用的模型` : '默认模型'
      if (!selection?.provider || !selection.model || !provider) {
        const message = `${target}尚未选择或已不可用，请选择可用模型后再次操作。输入已保留。`
        this.open({ message })
        throw new Error(message)
      }
      // 无需 Key 的原生认证交给宿主调用；configured 不等于经过真实测试。
      if (requiresModelKey(provider) && !provider.configured) {
        const message = `${target}需要 ${provider.displayName} 的凭据，请接入后再次操作。输入已保留。`
        this.open({ provider: provider.id, message })
        throw new Error(message)
      }
    }
  }
}
