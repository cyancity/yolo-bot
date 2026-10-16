import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Trusted binding facts. Native metadata is never rewritten to impersonate the business root. */
export interface EmployeeWorkspace {
  threadId: string
  employeeId: string
  sessionId: string
  nativeCwd: string
  root: string
  layout: 'session-v1' | 'scoped-v2'
}
export type EmployeeToolProvider = 'local' | 'native' | 'pass-through'
export type PathAccess = 'read' | 'search' | 'write' | 'move-source' | 'move-target' | 'delete'
export interface CheckedPath {
  absolutePath: string
  existingAncestor: string
  root: string
  type: 'file' | 'directory' | 'absent'
}
export interface EmployeeToolCall {
  name: string
  arguments: unknown
  agent: unknown
  token: symbol
  signal: AbortSignal
}
export interface CheckedCallPlan { searchTarget?: CheckedPath }
export type EmployeeToolDecision = { kind: 'allow'; plan: CheckedCallPlan } | { kind: 'deny'; reason: string }
export interface EmployeeExecutionPolicy {
  mode: 'workspace-write' | 'read-only' | 'danger-full-access'
  workspaceRoot: string
  sessionId?: string
  [key: string]: unknown
}
/** Structural native shell DTO: adapters preserve all fields not owned by the policy. */
export interface EmployeeShellRequest {
  command: string
  workdir?: string
  signal?: AbortSignal
  sandboxPolicy?: EmployeeExecutionPolicy
  env?: Record<string, string>
  [key: string]: unknown
}
export interface EmployeeToolPolicy {
  readonly provider: EmployeeToolProvider
  evaluate(call: EmployeeToolCall, workspace: EmployeeWorkspace): Promise<EmployeeToolDecision>
  resolvePath(input: { raw: string; cwd?: string; access: PathAccess }, workspace: EmployeeWorkspace, signal: AbortSignal): Promise<CheckedPath>
  prepareShell(request: EmployeeShellRequest, workspace: EmployeeWorkspace, signal: AbortSignal): Promise<EmployeeShellRequest>
  executionPolicy(workspace: EmployeeWorkspace): EmployeeExecutionPolicy
}
export interface EmployeePolicyDependencies {
  /** Future host capability must implement logical-root confinement, not merely session cwd. */
  native?: EmployeeToolPolicy
  /** Actual PowerShell Parser/AST classification, run outside the model's tool surface. */
  parseShell?: (command: string, signal: AbortSignal) => Promise<{ command: string; parameters: Record<string, string | boolean> }>
  nativePolicy?: (workspace: EmployeeWorkspace) => EmployeeExecutionPolicy
  nativeResolvePath?: (raw: string, cwd: string, signal: AbortSignal) => Promise<CheckedPath>
}
export interface EmployeeToolInstallation {
  workspace: EmployeeWorkspace
  policy: EmployeeToolPolicy
  definitions: ReadonlyMap<string, ToolDefinition>
  /** Refuses disposal while tools or this employee's jobs are running. */
  dispose(): Promise<void>
}
