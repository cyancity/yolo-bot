import { useState } from 'react'
import { Input as LobeInput, TextArea as LobeTextArea } from '@lobehub/ui'
import { Button as LobeButton, Drawer, Select as LobeSelect, Switch as LobeSwitch } from 'antd'
import { ChevronRight, Image as ImageIcon, LayoutTemplate, Plug, Plus } from 'lucide-react'
import { cx, Dialog, useOverlayTarget } from './ui/index.tsx'
import { WF } from './workforce-strings.ts'
import type { Employee, ImageProviderStatus, McpServer, McpServerInput, WorkforceTemplate } from './workforce-types.ts'
import type { WorkforceSource } from './workforce-source.ts'
import { ImageProviderSection, imageReadiness, providerSummary } from './workforce-image-provider.tsx'
import css from './workforce.module.css'

/** Shared settings every employee draws on; each opens in its own drawer from the employee list. */
export type EmployeeResource = 'mcp' | 'image' | 'templates'

export function EmployeeResourceLinks({ mcpCount, imageStatus, templateCount, onOpen }: {
  readonly mcpCount: number | undefined
  readonly imageStatus: ImageProviderStatus | undefined
  readonly templateCount: number
  readonly onOpen: (resource: EmployeeResource) => void
}) {
  const imageReady = imageReadiness(imageStatus)
  const imageWarning = imageReady !== 'ready' && imageReady !== 'unknown'
  return (
    <div className={css.empResources}>
      <button type="button" className={css.empResourceRow} onClick={() => onOpen('mcp')}>
        <Plug size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className={css.empResourceName}>{WF.workspace.mcpServersTitle}</span>
        <span className={css.empResourceMeta}>{mcpCount === undefined ? '' : WF.workspace.countItems(mcpCount)}</span>
        <ChevronRight size={14} aria-hidden="true" />
      </button>
      <button type="button" className={css.empResourceRow} onClick={() => onOpen('image')}>
        <ImageIcon size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className={css.empResourceName}>{WF.image.title}</span>
        <span className={cx(css.empResourceMeta, imageWarning && css.imageWarning)}>
          {imageWarning ? WF.image.notReadyShort : imageStatus ? providerSummary(imageStatus.effective) : ''}
        </span>
        <ChevronRight size={14} aria-hidden="true" />
      </button>
      {templateCount > 0 && (
        <button type="button" className={css.empResourceRow} onClick={() => onOpen('templates')}>
          <LayoutTemplate size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className={css.empResourceName}>{WF.workspace.employeePresetsTitle}</span>
          <span className={css.empResourceMeta}>{WF.workspace.countItems(templateCount)}</span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

export function EmployeeResourceDrawer({ resource, onClose, source, employees, mcpServers, onMcpSaved, imageStatus, onImageSaved, imageSignal, templates, onToggleTemplate, onApplyTemplate }: {
  readonly resource: EmployeeResource | undefined
  readonly onClose: () => void
  readonly source: WorkforceSource
  readonly employees: readonly Employee[]
  readonly mcpServers: readonly McpServer[] | undefined
  readonly onMcpSaved: () => void
  readonly imageStatus: ImageProviderStatus | undefined
  readonly onImageSaved: (status: ImageProviderStatus) => void
  readonly imageSignal: number
  readonly templates: readonly WorkforceTemplate[] | undefined
  readonly onToggleTemplate: (id: string, enabled: boolean) => Promise<void>
  readonly onApplyTemplate: (id: string) => Promise<void>
}) {
  // 抽屉挂在工作台 token 根下，正文才能拿到 --wb-* 变量。
  const overlay = useOverlayTarget()
  const title = resource === 'mcp' ? WF.workspace.mcpServersTitle : resource === 'image' ? WF.image.title : WF.workspace.employeePresetsTitle
  return (
    <Drawer open={resource !== undefined} onClose={onClose} title={title} width={560} destroyOnHidden getContainer={overlay ?? false} rootClassName={css.resourceDrawer ?? ''}>
      {resource === 'mcp' && <McpServersSection servers={mcpServers} employees={employees} source={source} onSaved={onMcpSaved} />}
      {resource === 'image' && <ImageProviderSection source={source} status={imageStatus} onSaved={onImageSaved} openSignal={imageSignal} />}
      {resource === 'templates' && templates !== undefined && <TemplatesSection templates={templates} onToggle={onToggleTemplate} onApply={onApplyTemplate} />}
    </Drawer>
  )
}

/** 注册模板卡片区：启停由模板提供者管理，「应用员工配置」按种子建员工（同名跳过）。 */
export function TemplatesSection({ templates, onToggle, onApply }: {
  readonly templates: readonly WorkforceTemplate[]
  readonly onToggle: (id: string, enabled: boolean) => Promise<void>
  readonly onApply: (id: string) => Promise<void>
}) {
  const [busy, setBusy] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const run = async (id: string, action: () => Promise<void>): Promise<void> => {
    setBusy(id); setError(undefined)
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(undefined) }
  }
  return (
    <div className={css.empForm} data-workforce-templates>
      <p className={css.empIntro}>{WF.workspace.employeePresetsIntro}</p>
      {error !== undefined && <div className={css.empFormError} role="alert">{error}</div>}
      {templates.map(template => (
        <div key={template.id} className={css.empCard}>
          <div className={css.empCardBody}>
            <div className={css.empCardName}>{template.label}</div>
            <div className={css.empCardRole}>{template.description}</div>
            <div className={css.empCardMeta}>
              <span className={css.empModelHint}>{WF.workspace.templateStats(template.skills.length, template.employees.length)}</span>
            </div>
          </div>
          <div className={css.empCardActions}>
            <label className={css.empAction}>
              <LobeSwitch size="small" checked={template.enabled} disabled={busy === template.id} onChange={checked => void run(template.id, () => onToggle(template.id, checked))} /> {WF.workspace.enable}
            </label>
            <LobeButton disabled={busy === template.id} onClick={() => void run(template.id, () => onApply(template.id))}>{WF.workspace.applyTemplateBtn}</LobeButton>
          </div>
        </div>
      ))}
    </div>
  )
}

/** env/header 行的文本约定：KEY=value 为明文，KEY=@REF 为凭据引用名。 */
function pairsText(values: Readonly<Record<string, { kind: 'literal' | 'credential'; value?: string; ref?: string }>> | undefined): string {
  return Object.entries(values ?? {}).map(([key, row]) => row.kind === 'credential' ? `${key}=@${row.ref}` : `${key}=${row.value}`).join('\n')
}
function parsePairs(text: string): Record<string, { kind: 'literal'; value: string } | { kind: 'credential'; ref: string }> | undefined {
  const out: Record<string, { kind: 'literal'; value: string } | { kind: 'credential'; ref: string }> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) throw new Error(`行「${trimmed}」缺少 KEY=`)
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    out[key] = value.startsWith('@') ? { kind: 'credential', ref: value.slice(1) } : { kind: 'literal', value }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** MCP 服务器管理：列表（凭据/挂载状态）+ 内联新建/编辑表单。密钥只存凭据引用名。 */
export function McpServersSection({ servers, employees, source, onSaved }: {
  readonly servers: readonly McpServer[] | undefined
  readonly employees: readonly Employee[]
  readonly source: WorkforceSource
  readonly onSaved: () => void
}) {
  const [editing, setEditing] = useState<McpServer | 'new' | undefined>()
  const [serverName, setServerName] = useState('')
  const [label, setLabel] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'streamable-http'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [cwd, setCwd] = useState('')
  const [url, setUrl] = useState('')
  const [envText, setEnvText] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [confirmDelete, setConfirmDelete] = useState<McpServer | undefined>()

  const beginEdit = (server: McpServer | 'new'): void => {
    setEditing(server)
    setError(undefined)
    if (server === 'new') {
      setServerName(''); setLabel(''); setTransport('stdio'); setCommand(''); setArgs(''); setCwd(''); setUrl(''); setEnvText(''); setHeadersText('')
    } else {
      setServerName(server.serverName); setLabel(server.label); setTransport(server.transport)
      setCommand(server.command ?? ''); setArgs((server.args ?? []).join(' ')); setCwd(server.cwd ?? '')
      setUrl(server.url ?? ''); setEnvText(pairsText(server.env)); setHeadersText(pairsText(server.headers))
    }
  }

  const save = async (): Promise<void> => {
    if (serverName.trim() === '' || label.trim() === '') { setError(WF.workspace.mcpServerNameRequired); return }
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName.trim())) { setError(WF.workspace.mcpServerNameFormat); return }
    let env: ReturnType<typeof parsePairs>, headers: ReturnType<typeof parsePairs>
    try { env = parsePairs(envText); headers = parsePairs(headersText) } catch (e) { setError(e instanceof Error ? e.message : String(e)); return }
    const input: McpServerInput = {
      serverName: serverName.trim(), label: label.trim(), transport, enabled: true,
      ...(transport === 'stdio'
        ? { command: command.trim(), args: args.trim() === '' ? [] : args.trim().split(/\s+/), ...(cwd.trim() !== '' ? { cwd: cwd.trim() } : {}), ...(env !== undefined ? { env } : {}) }
        : { url: url.trim(), ...(headers !== undefined ? { headers } : {}) }),
    }
    setBusy(true); setError(undefined)
    try {
      await source.saveMcpServer(input, editing === 'new' ? undefined : editing?.id)
      setEditing(undefined)
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const assigned = (server: McpServer): readonly Employee[] =>
    employees.filter(employee => employee.mcpServers === undefined || employee.mcpServers.includes(server.id))

  return (
    <div className={css.empForm} data-workforce-mcp-servers>
      <div className={css.resourceHead}>
        <p className={css.empIntro}>{WF.workspace.mcpServersIntro}</p>
        <LobeButton type="primary" icon={<Plus size={14} aria-hidden="true" />} onClick={() => beginEdit('new')}>{WF.workspace.addServer}</LobeButton>
      </div>
      {servers !== undefined && servers.length === 0 && editing === undefined && <p className={css.empIntro}>{WF.workspace.mcpNoServersHint}</p>}
      {(servers ?? []).map(server => (
        <div key={server.id} className={css.empCard}>
          <div className={css.empCardBody}>
            <div className={css.empCardName}>
              {server.label}
              {!server.enabled && <span className={css.msgLead}>{WF.skillDrafts.statusDisabled}</span>}
            </div>
            <div className={css.empCardRole}>
              {server.transport === 'stdio' ? `${WF.workspace.localCommand} ${server.command} ${(server.args ?? []).join(' ')}` : `HTTP ${server.url}`}
              {` · mcp__${server.serverName}__*`}
            </div>
            <div className={css.empCardMeta}>
              <span className={css.empModelHint}>{WF.workspace.assignedEmployeesCount(assigned(server).length)}</span>
              {server.status?.credentials.map(cred => (
                <span key={cred.key} className={css.empModelHint}>{cred.key}→@{cred.ref} {cred.configured ? WF.models.configured : WF.models.notConfigured}</span>
              ))}
              {server.status?.errors.map((message, index) => <span key={index} className={css.empFormError}>{message}</span>)}
              {server.status !== undefined && !server.status.available && <span className={css.empModelHint}>{WF.workspace.mcpClientUnavailable}</span>}
            </div>
          </div>
          <div className={css.empCardActions}>
            <LobeButton onClick={() => void (async () => { await source.patchMcpServer(server.id, { enabled: !server.enabled }); onSaved() })()}>{server.enabled ? WF.workspace.disable : WF.workspace.enable}</LobeButton>
            <LobeButton onClick={() => beginEdit(server)}>{WF.employeesPage.edit}</LobeButton>
            <LobeButton danger onClick={() => setConfirmDelete(server)}>{WF.employeesPage.delete}</LobeButton>
          </div>
        </div>
      ))}

      {editing !== undefined && (
        <div className={css.empForm} data-workforce-mcp-form>
          <div className={css.empFormGrid}>
            <div className={css.empField}>
              <label htmlFor="wf-mcp-name">{WF.workspace.serverNameLabel}</label>
              <LobeInput id="wf-mcp-name" type="block" className={cx('wb-input', css.empInput)} value={serverName} onChange={e => setServerName(e.target.value)} placeholder="filesystem" />
            </div>
            <div className={css.empField}>
              <label htmlFor="wf-mcp-label">{WF.workspace.displayNameLabel}</label>
              <LobeInput id="wf-mcp-label" type="block" className={cx('wb-input', css.empInput)} value={label} onChange={e => setLabel(e.target.value)} />
            </div>
            <div className={css.empField}>
              <label htmlFor="wf-mcp-transport">{WF.workspace.transportLabel}</label>
              <LobeSelect id="wf-mcp-transport" className={css.empInput ?? ''} value={transport} onChange={setTransport} options={[
                { value: 'stdio', label: WF.workspace.transportStdio },
                { value: 'streamable-http', label: WF.workspace.transportHttp },
              ]} />
            </div>
            {transport === 'stdio' ? (
              <>
                <div className={css.empField + ' ' + css.empFieldRow}>
                  <label htmlFor="wf-mcp-command">{WF.workspace.startCommand}</label>
                  <LobeInput id="wf-mcp-command" type="block" className={cx('wb-input', css.empInput)} value={command} onChange={e => setCommand(e.target.value)} placeholder={WF.workspace.commandPlaceholder} />
                </div>
                <div className={css.empField}>
                  <label htmlFor="wf-mcp-args">{WF.workspace.argsPlaceholder}</label>
                  <LobeInput id="wf-mcp-args" type="block" className={cx('wb-input', css.empInput)} value={args} onChange={e => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem" />
                </div>
                <div className={css.empField}>
                  <label htmlFor="wf-mcp-cwd">{WF.workspace.cwdLabel}</label>
                  <LobeInput id="wf-mcp-cwd" type="block" className={cx('wb-input', css.empInput)} value={cwd} onChange={e => setCwd(e.target.value)} />
                </div>
                <div className={css.empField + ' ' + css.empFieldRow}>
                  <label htmlFor="wf-mcp-env">{WF.workspace.envLabel}</label>
                  <LobeTextArea id="wf-mcp-env" type="block" rows={2} value={envText} onChange={e => setEnvText(e.target.value)} placeholder={'API_KEY=@MY_MCP_KEY\nDEBUG=false'} />
                </div>
              </>
            ) : (
              <>
                <div className={css.empField + ' ' + css.empFieldRow}>
                  <label htmlFor="wf-mcp-url">{WF.workspace.urlLabel}</label>
                  <LobeInput id="wf-mcp-url" type="block" className={cx('wb-input', css.empInput)} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
                </div>
                <div className={css.empField + ' ' + css.empFieldRow}>
                  <label htmlFor="wf-mcp-headers">{WF.workspace.headersLabel}</label>
                  <LobeTextArea id="wf-mcp-headers" type="block" rows={2} value={headersText} onChange={e => setHeadersText(e.target.value)} placeholder={'Authorization=@MCP_TOKEN'} />
                </div>
              </>
            )}
          </div>
          <div className={css.empFormActions}>
            <LobeButton type="primary" loading={busy} onClick={() => void save()}>{WF.employeesPage.save}</LobeButton>
            <LobeButton onClick={() => setEditing(undefined)}>{WF.employeesPage.cancel}</LobeButton>
            {error !== undefined && <span className={css.empFormError} role="alert">{error}</span>}
          </div>
        </div>
      )}

      {confirmDelete !== undefined && (
        <Dialog title={WF.workspace.deleteMcpServerTitle} closeLabel={WF.employeesPage.cancel} onClose={() => setConfirmDelete(undefined)} busy={busy}>
          <p className={css.empIntro}>
            {WF.workspace.deleteMcpServerConfirm(confirmDelete.label, assigned(confirmDelete).length, assigned(confirmDelete).map(e => e.name).join('、'))}
          </p>
          {error && <p className={css.empFormError} role="alert">{error}</p>}
          <div className={css.empFormActions}>
            <LobeButton type="primary" danger loading={busy} onClick={() => void (async () => {
              setBusy(true); setError(undefined)
              try { await source.deleteMcpServer(confirmDelete.id); setConfirmDelete(undefined); onSaved() }
              catch (e) { setError(e instanceof Error ? e.message : String(e)) }
              finally { setBusy(false) }
            })()}>{WF.employeesPage.delete}</LobeButton>
            <LobeButton onClick={() => setConfirmDelete(undefined)}>{WF.employeesPage.cancel}</LobeButton>
          </div>
        </Dialog>
      )}
    </div>
  )
}
