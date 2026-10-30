/** Public type-only extension contract. Runtime services are installed by the core implementation. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/cordis'

/** Idempotent, synchronous removal of a registration; does not delete persisted data. */
export type ExtensionDisposer = () => void

export interface Admission {
  readonly peer?: unknown
  readonly rejection?: 401 | 403
}
export type AdmitFn = (request: IncomingMessage) => Admission

export interface HttpError {
  readonly code: string
  readonly message: string
}

/** Shared transport; file paths must already have been authorized by the caller. */
export interface WorkbenchHttp {
  readonly admit: AdmitFn
  readJson(request: IncomingMessage): Promise<unknown>
  sendJson(response: ServerResponse, status: number, body: unknown): void
  sendError(response: ServerResponse, status: number, error: HttpError): void
  serveFile(request: IncomingMessage, response: ServerResponse, path: string, name: string, contentType: string): Promise<void>
}

export interface WorkbenchRoute {
  readonly id: string
  /** Canonical segment prefix relative to /wb/api, e.g. /tools; never /wb/api itself. */
  readonly prefix: string
  /** Original URL and untouched body stream; local admission has already succeeded. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>
}

export interface EmployeeScopeView {
  readonly kind: 'leader' | 'child' | 'direct' | 'dm'
  readonly employeeId: string
}

export interface EmployeeScopeContribution {
  readonly id: string
  readonly deniedTools?: readonly string[]
  systemPrompt?(view: EmployeeScopeView): string
}

export interface WorkbenchHost {
  /** Resolved Config.root, defaulting to <DSH_HOME>/workbench. Not an extension-owned directory. */
  readonly root: string
  readonly http: WorkbenchHttp
  registerRoute(route: WorkbenchRoute): ExtensionDisposer
  registerEmployeeScopeContribution(value: EmployeeScopeContribution): ExtensionDisposer
}

export interface EmployeeSeed {
  readonly name: string
  readonly title: string
  readonly persona: string
  readonly skills: readonly string[]
  readonly model?: string
  readonly isLeader?: boolean
  readonly avatarColor?: string
  readonly imageGeneration?: boolean
  readonly webSearch?: boolean
}

export type McpValue =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'credential'; readonly ref: string }

/** Suggested configuration, never automatically installed or populated with secret values. */
export interface McpSeed {
  readonly serverName: string
  readonly label: string
  readonly transport: 'stdio' | 'streamable-http'
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly url?: string
  readonly env?: Readonly<Record<string, McpValue>>
  readonly headers?: Readonly<Record<string, McpValue>>
}

export interface TemplateContribution {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly skills: readonly string[]
  readonly employees: readonly EmployeeSeed[]
  readonly mcpServers?: readonly McpSeed[]
  readonly notes?: string
}

export interface TemplateListing extends TemplateContribution {
  readonly enabled: boolean
}

export interface TemplateProvider {
  readonly id: string
  list(): Promise<readonly TemplateListing[]>
  /** The provider persists enablement and invalidates its official skill provider before resolving. */
  setEnabled(id: string, enabled: boolean): Promise<void>
}

export interface WorkbenchTemplates {
  registerProvider(provider: TemplateProvider): ExtensionDisposer
  list(): Promise<readonly TemplateListing[]>
  setEnabled(id: string, enabled: boolean): Promise<void>
  /** Existing employees with the same name are skipped; only newly created ids are returned. */
  apply(id: string): Promise<readonly string[]>
}

export interface UserSkill {
  readonly name: string
  readonly description: string
  /** Open provenance identifier; never interpreted as a permission or writable root. */
  readonly origin: string
}

export interface UserSkillContent extends UserSkill {
  readonly content: string
}

export interface UserSkillInput {
  /** Complete SKILL.md, including name/description frontmatter. */
  readonly content: string
  readonly origin?: string
}

/** User-root operations only; project and bundled skills are not writable through this service. */
export interface WorkbenchSkills {
  userRoot(): string
  list(): Promise<readonly UserSkill[]>
  read(name: string): Promise<UserSkillContent>
  create(name: string, input: UserSkillInput): Promise<UserSkillContent>
  update(name: string, input: UserSkillInput): Promise<UserSkillContent>
  remove(name: string): Promise<void>
  /** Refresh catalog/hash state after an extension finishes a checked installation. */
  changed(names: readonly string[]): Promise<void>
}

export type MaintenanceResult =
  | { readonly ok: false; readonly reason: 'busy' }
  | { readonly ok: true; release(): void }

/** Acquisition atomically closes this participant's ingress and verifies quiescence. */
export interface MaintenanceParticipant {
  readonly id: string
  idle(): Promise<boolean>
  enterMaintenance(): Promise<MaintenanceResult>
}

export interface WorkbenchInfo {
  readonly apiVersion: 1
  /** Actual running host package version, not the installation or release-combination version. */
  readonly version: string
  idle(): Promise<boolean>
  enterMaintenance(): Promise<MaintenanceResult>
  registerParticipant(participant: MaintenanceParticipant): ExtensionDisposer
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workbenchHost: WorkbenchHost
    workbenchTemplates: WorkbenchTemplates
    workbenchSkills: WorkbenchSkills
    workbenchInfo: WorkbenchInfo
  }
}
