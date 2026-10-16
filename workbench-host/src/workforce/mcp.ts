/**
 * Per-employee MCP mounting: each configured server becomes one
 * `@deepseek-ai/dsh-mcp-client` plugin instance inside the employee agent's own
 * scope (`agent/created` listener, awaited before the first prompt assembles).
 * Tools (`mcp__<serverName>__*`) and server instructions then exist only for
 * employees that have the server enabled. Credential references resolve at
 * mount time; secret values never touch state, API responses, or logs.
 */

import type { WorkforceMcpServer, WorkforceMcpValue } from './types.ts'
import type { WorkforceRuntime } from './runtime.ts'

const MCP_CLIENT_SPEC = '@deepseek-ai/dsh-mcp-client'
const TOOL_CALL_TIMEOUT_MS = 60_000

/** Structural slice of the credentials service; resolved through ctx.get like other native services. */
export interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
  describe(ref: string): Promise<unknown>
  set(ref: string, value: string): Promise<void>
}

/** Structural view of the mcp-client namespace module as consumed by ctx.plugin. */
interface McpClientModule {
  name: string
  apply(ctx: unknown, config: Record<string, unknown>): Promise<void>
}

interface ScopedAgent {
  id: string
  ctx: {
    plugin(module: unknown, config: Record<string, unknown>): { await(): Promise<unknown> }
  }
  session: { id: string }
}

/** The sliver of the host context this module consumes; kept structural so Cordis typing churn cannot leak in. */
interface HostEvents {
  on(event: 'agent/created', listener: (arg: { agent: ScopedAgent }) => unknown, options: { global: true }): unknown
}

export type McpServiceGetter = (name: 'credentials' | 'agents' | 'skills' | 'agentPresets') => unknown

/** Connection-relevant digest of one employee's assigned+enabled servers; secret values are never included. */
export function mcpSignature(state: { mcpServers: WorkforceMcpServer[] }, employee: { mcpServers?: string[] }): string {
  const servers = state.mcpServers
    .filter(server => server.enabled && (employee.mcpServers === undefined || employee.mcpServers.includes(server.id)))
    .map(server => {
      const refs = (values: Record<string, WorkforceMcpValue> | undefined) => Object.fromEntries(Object.entries(values ?? {}).map(([key, row]) => [key, row.kind === 'literal' ? { k: 'l', v: row.value } : { k: 'c', r: row.ref }]))
      return server.transport === 'stdio'
        ? { id: server.id, t: 'stdio', n: server.serverName, c: server.command, a: server.args, w: server.cwd, e: refs(server.env) }
        : { id: server.id, t: 'http', n: server.serverName, u: server.url, h: refs(server.headers) }
    })
  return JSON.stringify(servers.sort((a, b) => a.id.localeCompare(b.id)))
}

async function loadMcpClient(): Promise<McpClientModule | undefined> {
  try {
    // Variable specifier keeps tsc from resolving the peer package, which the
    // consuming dsh app provides at runtime rather than this repo's node_modules.
    const specifier: string = MCP_CLIENT_SPEC
    const module = await import(specifier) as { apply?: unknown; name?: unknown }
    if (typeof module?.apply !== 'function') return undefined
    return module as McpClientModule
  } catch {
    return undefined
  }
}

/** Flatten literal/credential rows into a plain string map, resolving refs and collecting misses. */
async function resolveValues(values: Record<string, WorkforceMcpValue> | undefined, credentials: CredentialsLike | undefined, errors: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [key, row] of Object.entries(values ?? {})) {
    if (row.kind === 'literal') { out[key] = row.value; continue }
    const resolved = credentials ? await credentials.resolve(row.ref).catch(() => undefined) : undefined
    if (resolved === undefined) { errors.push(`凭据 ${row.ref} 未配置（${key}）`); continue }
    out[key] = resolved.value
  }
  return out
}

/** Live mount/error state for the status route; keyed by server id. */
export class EmployeeMcp {
  private mounted = new WeakMap<object, Set<string>>()
  private signatures = new WeakMap<object, string>()
  private errors = new Map<string, string[]>()
  private pluginPromise: Promise<McpClientModule | undefined> | undefined
  constructor(private readonly runtime: WorkforceRuntime, private readonly get: McpServiceGetter) {}

  /** The signature recorded at mount time for one agent; undefined when it never mounted through us. */
  mountedSignature(agent: object): string | undefined {
    return this.signatures.get(agent)
  }

  private plugin(): Promise<McpClientModule | undefined> {
    return this.pluginPromise ??= loadMcpClient()
  }

  /** Build the mcp-client Config for one stored server; returns undefined config plus reasons on hard failure. */
  private async resolveConfig(server: WorkforceMcpServer): Promise<{ config?: Record<string, unknown>; errors: string[] }> {
    const credentials = this.get('credentials') as CredentialsLike | undefined
    const errors: string[] = []
    const base = {
      serverName: server.serverName,
      toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: false,
    }
    if (server.transport === 'stdio') {
      if (!server.command) { errors.push('缺少 command'); return { errors } }
      return {
        config: {
          ...base, transport: 'stdio', command: server.command,
          args: server.args ?? [], cwd: server.cwd ?? '',
          env: await resolveValues(server.env, credentials, errors),
        },
        errors,
      }
    }
    if (!server.url) { errors.push('缺少 url'); return { errors } }
    return {
      config: {
        ...base, transport: 'streamable-http', url: server.url,
        headers: await resolveValues(server.headers, credentials, errors),
      },
      errors,
    }
  }

  /** Mount the employee's enabled servers onto one freshly created agent, inside its scope. */
  private async mount(agent: ScopedAgent): Promise<void> {
    let address
    try { address = await this.runtime.address(agent.session.id) } catch { return }
    const state = await this.runtime.store.read()
    const employee = state.employees.find(item => item.id === address.employeeId)
    if (!employee) return
    // Record the assigned signature even when mounting is unavailable so
    // stale-composition checks compare assignment, not mount success.
    this.signatures.set(agent, mcpSignature(state, employee))
    if (await this.runtime.employeeToolsRestricted(agent.session.id)) {
      for (const server of state.mcpServers.filter(server => server.enabled && (employee.mcpServers === undefined || employee.mcpServers.includes(server.id)))) {
        this.errors.set(server.id, ['员工受限工具策略未批准此 MCP 能力；未启动连接或解析凭据'])
      }
      return
    }
    const module = await this.plugin()
    if (module === undefined) return
    const servers = state.mcpServers.filter(server =>
      server.enabled && (employee.mcpServers === undefined || employee.mcpServers.includes(server.id)))
    if (servers.length === 0) return
    let mounted = this.mounted.get(agent)
    if (mounted === undefined) { mounted = new Set(); this.mounted.set(agent, mounted) }
    for (const server of servers) {
      if (mounted.has(server.id)) continue
      mounted.add(server.id)
      const { config, errors } = await this.resolveConfig(server)
      this.errors.set(server.id, errors)
      if (config === undefined) continue
      try {
        const fiber = agent.ctx.plugin(module, config)
        await fiber.await()
      } catch (error) {
        this.errors.set(server.id, [...errors, `挂载失败：${error instanceof Error ? error.message : String(error)}`])
      }
    }
  }

  /** Wire the serial agent/created listener; mounts complete before the first prompt assembles. */
  install(ctx: HostEvents): void {
    ctx.on('agent/created', async ({ agent }) => {
      try { await this.mount(agent) } catch { /* mount failure must never veto agent creation */ }
    }, { global: true })
  }

  /** Credential readiness + last mount errors for one stored server; values are never returned. */
  async status(server: WorkforceMcpServer): Promise<{ credentials: { key: string; ref: string; configured: boolean }[]; errors: string[]; available: boolean }> {
    const credentials = this.get('credentials') as CredentialsLike | undefined
    const rows: { key: string; ref: string; configured: boolean }[] = []
    for (const [key, row] of Object.entries({ ...server.env, ...server.headers })) {
      if (row.kind !== 'credential') continue
      const info = credentials ? await credentials.describe(row.ref).catch(() => undefined) : undefined
      rows.push({ key, ref: row.ref, configured: info !== undefined && (info as { configured?: boolean }).configured === true })
    }
    return { credentials: rows, errors: this.errors.get(server.id) ?? [], available: (await this.plugin()) !== undefined }
  }
}
