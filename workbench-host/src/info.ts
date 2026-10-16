import type { ExtensionDisposer, MaintenanceParticipant, MaintenanceResult, WorkbenchInfo } from './extension.ts'
import { WorkforceError } from './workforce/types.ts'

/** One synchronous ingress barrier shared by HTTP, employees and extension participants. */
export class WorkbenchLifecycle implements WorkbenchInfo {
  readonly apiVersion = 1 as const
  private participants = new Map<string, MaintenanceParticipant>()
  private phase: 'open' | 'acquiring' | 'held' = 'open'
  private operations = 0

  constructor(readonly version: string, private readonly coreIdle: () => Promise<boolean>) {}

  get maintenanceHeld(): boolean { return this.phase === 'held' }

  operation(): ExtensionDisposer {
    if (this.phase !== 'open') throw new WorkforceError('conflict', '工作台正在维护，暂不接受新操作')
    this.operations++
    let active = true
    return () => { if (active) { active = false; this.operations-- } }
  }

  assertRegistrationAllowed(): void {
    if (this.phase !== 'open') throw new WorkforceError('conflict', '维护期间不能注册扩展')
  }

  registerParticipant(participant: MaintenanceParticipant): ExtensionDisposer {
    this.assertRegistrationAllowed()
    if (!participant.id || typeof participant.idle !== 'function' || typeof participant.enterMaintenance !== 'function') {
      throw new WorkforceError('bad_request', '维护参与者无效')
    }
    if (this.participants.has(participant.id)) throw new WorkforceError('conflict', '维护参与者 id 已注册')
    const retained = Object.freeze({ id: participant.id, idle: participant.idle.bind(participant), enterMaintenance: participant.enterMaintenance.bind(participant) })
    this.participants.set(retained.id, retained)
    let active = true
    return () => {
      if (!active) return
      if (!this.maintenanceHeld) throw new WorkforceError('conflict', '请先取得维护门再卸载参与者')
      this.participants.delete(retained.id)
      active = false
    }
  }

  async idle(): Promise<boolean> {
    if (this.operations !== 0 || !await this.coreIdle()) return false
    const snapshot = [...this.participants.values()]
    for (const participant of snapshot) {
      if (!await participant.idle() || this.participants.get(participant.id) !== participant) return false
    }
    return this.operations === 0 && snapshot.length === this.participants.size && await this.coreIdle()
  }

  async enterMaintenance(): Promise<MaintenanceResult> {
    if (this.phase !== 'open') return { ok: false, reason: 'busy' }
    // No await before closing ingress: an operation cannot slip past the idle observation.
    this.phase = 'acquiring'
    const releases: ExtensionDisposer[] = []
    const release = () => {
      const failures: unknown[] = []
      for (const dispose of releases.splice(0).reverse()) {
        try { dispose() } catch (error) { failures.push(error) }
      }
      this.phase = 'open'
      if (failures.length) throw new AggregateError(failures, '维护门释放失败')
    }
    try {
      if (this.operations !== 0 || !await this.coreIdle()) { release(); return { ok: false, reason: 'busy' } }
      const snapshot = [...this.participants.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      for (const participant of snapshot) {
        const result = await participant.enterMaintenance()
        if (!result.ok) { release(); return { ok: false, reason: 'busy' } }
        releases.push(result.release.bind(result))
        if (this.participants.get(participant.id) !== participant) { release(); return { ok: false, reason: 'busy' } }
      }
      if (this.operations !== 0 || !await this.coreIdle()) { release(); return { ok: false, reason: 'busy' } }
      this.phase = 'held'
      let held = true
      return { ok: true, release: () => { if (held) { held = false; release() } } }
    } catch (error) {
      try { release() } catch (rollback) { throw new AggregateError([error, rollback], '维护门获取与回滚失败') }
      throw error
    }
  }
}
