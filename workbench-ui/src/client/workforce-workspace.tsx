/**
 * 数字员工工作区整页：频道与员工私信的消息流、线程面板，以及独立员工管理页。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Input as LobeInput, TextArea as LobeTextArea } from '@lobehub/ui'
import { Button as LobeButton, Select as LobeSelect, Switch as LobeSwitch } from 'antd'
import { cx, Dialog, Toast } from './ui/index.tsx'
import { Icon } from './ui/icons.tsx'
import { WF } from './workforce-strings.ts'
import { DEFAULT_CHANNEL, type WorkbenchView } from './nav.ts'
import type { Employee, EmployeeAgent, EmployeeInput, McpServer, SkillSummary, WorkforceSnapshot, WorkforceTemplate, WorkforceUserSkill } from './workforce-types.ts'
import type { WorkforceSource } from './workforce-source.ts'
import { WorkforceMain, type WorkforceSurface } from './workforce.tsx'
import { WorkforceCanvasView } from './workforce-canvas-view.tsx'
import css from './workforce.module.css'
import { useWorkforcePrefs } from './workforce-prefs.ts'
import { classifyModelError, useWorkforceModels } from './workforce-models.tsx'
import { WorkforceMemoryEditor, type MemorySourceNavigation } from './workforce-memory.tsx'; import { EmployeeAccess } from './workforce-employee-access.tsx'
import { ImageGenerationField, useImageProvider } from './workforce-image-provider.tsx'
import { ExternalAgentField, RolePresets, WebSearchField, rolePresets, uniqueEmployeeName, useAgentClis, useWebSearchStatus, type RolePreset, type RolePresetId } from './workforce-role-presets.tsx'
import { AvatarColorField } from './workforce-avatar-color-field.tsx'
import { EmployeeList } from './workforce-employee-list.tsx'
import { EmployeeResourceDrawer, EmployeeResourceLinks, type EmployeeResource } from './workforce-employee-resources.tsx'
import { EmployeeSkillsField } from './workforce-employee-skills.tsx'
import { formKey, formOf, useLeaveGuard, type EmployeeForm } from './workforce-employee-form.ts'

/** 员工管理页：左侧员工与共享设置，右侧新建/编辑表单；有未保存的修改时，切换前先确认。 */
export function EmployeesPage({ source, snapshot, onOpenMemorySource, navigate }: {
  readonly source: WorkforceSource
  readonly snapshot: WorkforceSnapshot
  readonly onOpenMemorySource?: MemorySourceNavigation | undefined
  readonly navigate: (view: WorkbenchView) => void
}) {
  const [selectedId, setSelectedId] = useState<string | 'new'>('new')
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [persona, setPersona] = useState('')
  const [model, setModel] = useState(''); const [toolAccess, setToolAccess] = useState<'office' | 'development'>('office')
  const [skills, setSkills] = useState<string[]>([])
  const [imageGeneration, setImageGeneration] = useState(false)
  const [webSearch, setWebSearch] = useState(false)
  const [agent, setAgent] = useState<EmployeeAgent | null>(null)
  const [lead, setLead] = useState(false)
  const [avatarColor, setAvatarColor] = useState('')
  const [mcpLimited, setMcpLimited] = useState(false)
  const [mcpIds, setMcpIds] = useState<readonly string[]>([])
  const [presetId, setPresetId] = useState<RolePresetId | undefined>()
  const [baseline, setBaseline] = useState(() => formKey(formOf('new')))
  const [pending, setPending] = useState<{ readonly select: Employee | 'new' } | { readonly leave: WorkbenchView } | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [deleting, setDeleting] = useState<Employee | undefined>()
  const [mcpServers, setMcpServers] = useState<readonly McpServer[] | undefined>()
  const [templates, setTemplates] = useState<readonly WorkforceTemplate[] | undefined>()
  const [catalogSkills, setCatalogSkills] = useState<readonly SkillSummary[] | undefined>()
  const [userSkills, setUserSkills] = useState<readonly WorkforceUserSkill[] | undefined>()
  const [resourcesVersion, setResourcesVersion] = useState(0)
  const [resource, setResource] = useState<EmployeeResource | undefined>()
  const [imageSignal, setImageSignal] = useState(0)
  const [toast, setToast] = useState<string | undefined>()
  const dismissToast = useCallback(() => setToast(undefined), [])
  const { state: modelsState, selectableModels } = useWorkforceModels(source.models)
  const [imageStatus, setImageStatus] = useImageProvider(source, resourcesVersion)
  const [agentClis, recheckAgentClis] = useAgentClis(source, resourcesVersion)
  const webSearchStatus = useWebSearchStatus(source, resourcesVersion)
  const presets = rolePresets(agentClis)

  const currentEmployee = selectedId === 'new'
    ? 'new'
    : snapshot.employees.find(e => e.id === selectedId) ?? snapshot.employees[0]
  const current: EmployeeForm = { name, title, persona, model, toolAccess, skills, imageGeneration, webSearch, agent, lead, avatarColor, mcpLimited, mcpIds }
  const dirty = formKey(current) !== baseline
  const duplicateName = name.trim() !== '' && snapshot.employees.some(e => e.id !== selectedId && e.name.trim() === name.trim())
  const deletable = currentEmployee !== 'new' && currentEmployee !== undefined && !currentEmployee.isLeader && !lead ? currentEmployee : undefined

  const selectEmployee = (employee: Employee | 'new' | undefined): void => {
    const form = formOf(employee)
    setError(undefined); setPresetId(undefined)
    setSelectedId(employee !== undefined && employee !== 'new' ? employee.id : 'new')
    setName(form.name); setTitle(form.title); setPersona(form.persona); setModel(form.model); setToolAccess(form.toolAccess)
    setSkills([...form.skills]); setImageGeneration(form.imageGeneration); setWebSearch(form.webSearch); setAgent(form.agent)
    setLead(form.lead); setAvatarColor(form.avatarColor); setMcpLimited(form.mcpLimited); setMcpIds(form.mcpIds)
    setBaseline(formKey(form))
  }
  const requestSelect = (target: Employee | 'new'): void => {
    if (target !== 'new' && target.id === selectedId) return
    if (dirty) setPending({ select: target })
    else selectEmployee(target)
  }

  const leave = useLeaveGuard(dirty, next => setPending({ leave: next }), navigate)

  const initializedRef = useRef(false)
  useEffect(() => {
    if (!initializedRef.current && snapshot.employees.length > 0) {
      initializedRef.current = true
      selectEmployee(snapshot.employees[0]!)
    }
  }, [snapshot.employees])

  useEffect(() => {
    let alive = true
    void source.mcpServers().then(list => { if (alive) setMcpServers(list) }).catch(() => { if (alive) setMcpServers([]) })
    void source.templates().then(list => { if (alive) setTemplates(list) }).catch(() => { if (alive) setTemplates([]) })
    void source.listSkills().then(list => { if (alive) setCatalogSkills(list) })
    void source.userSkills().then(list => { if (alive) setUserSkills(list) })
    return () => { alive = false }
  }, [source, resourcesVersion])

  const pickPreset = (preset: RolePreset): void => {
    const taken = snapshot.employees.map(e => e.name)
    const filled = presets.flatMap(item => [item.name, uniqueEmployeeName(item.name, taken)])
    setName(value => !value.trim() || filled.includes(value.trim()) ? uniqueEmployeeName(preset.name, taken) : value)
    setTitle(preset.title); setPersona(preset.persona); setToolAccess(preset.toolAccess); setSkills([...preset.skills])
    setImageGeneration(preset.imageGeneration); setWebSearch(preset.webSearch); setAgent(preset.agent)
    setPresetId(preset.id)
  }

  const openResource = (next: EmployeeResource, configure = false): void => {
    setImageSignal(value => configure ? value + 1 : 0)
    setResource(next)
  }

  const save = async (): Promise<void> => {
    if (name.trim() === '') { setError(WF.workspace.nameRequired); return }
    const input: EmployeeInput = {
      name: name.trim(),
      title: title.trim(),
      persona: persona.trim(),
      skills,
      model: model.trim(), toolAccess, imageGeneration, webSearch, agent,
      mcpServers: mcpLimited ? [...mcpIds] : null,
      isLeader: lead,
      avatarColor: avatarColor.trim() || undefined,
    }
    setBusy(true)
    setError(undefined)
    try {
      if (selectedId === 'new') {
        // 建好后切到这名员工，再点保存是修改它，不会重复新建。
        selectEmployee(await source.createEmployee(input))
        setToast(WF.workspace.createdSuccess(input.name))
      } else {
        await source.updateEmployee(selectedId, input)
        setBaseline(formKey(current))
        setToast(WF.workspace.savedSuccess(input.name))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async (): Promise<void> => {
    if (deleting === undefined) return
    setBusy(true)
    try {
      await source.deleteEmployee(deleting.id)
      const remaining = snapshot.employees.filter(e => e.id !== deleting.id)
      setDeleting(undefined)
      selectEmployee(remaining[0] ?? 'new')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.empPage} data-workforce-employees>
      <div className={css.empSplitLayout}>
        <EmployeeList
          employees={snapshot.employees}
          selectedId={selectedId}
          draft={selectedId === 'new' ? { name, color: avatarColor, lead } : undefined}
          onSelect={requestSelect}
          onAdd={() => requestSelect('new')}
        >
          <EmployeeResourceLinks mcpCount={mcpServers?.length} imageStatus={imageStatus} templateCount={templates?.length ?? 0} onOpen={next => openResource(next)} />
        </EmployeeList>

        <div className={css.empMainForm}>
          <div className={css.empFormHeader}>
            <h3 className={css.empFormTitle}>
              {selectedId === 'new' ? WF.workspace.newDigitalEmployee : WF.workspace.editEmployeePrefix(name || (currentEmployee !== 'new' && currentEmployee !== undefined ? currentEmployee.name : ''))}
            </h3>
          </div>

          {snapshot.error && <div className={css.streamError} role="alert">{snapshot.error}</div>}
          {modelsState.providers.length > 0 &&
            !modelsState.providers.some(p => p.configured || p.requiresApiKey === false) && (
              <div className={css.streamError} role="alert">
                <span>{WF.employeesPage.noModel}</span>
                <LobeButton onClick={() => source.models.open()}>
                  {WF.employeesPage.noModelAction}
                </LobeButton>
              </div>
            )}

          <div className={css.empForm} data-workforce-employee-form>
            {selectedId === 'new' && (
              <div className={css.empCardSection}>
                <h4 className={css.empCardSectionTitle}>{WF.roles.presets}</h4>
                <RolePresets presets={presets} selected={presetId} onPick={pickPreset} />
              </div>
            )}

            <div className={css.empCardSection}>
              <h4 className={css.empCardSectionTitle}>{WF.workspace.profileSectionTitle}</h4>
              <div className={css.empFormGrid}>
                <div className={css.empField}>
                  <label htmlFor="wf-emp-name">{WF.employeesPage.name}</label>
                  <LobeInput id="wf-emp-name" type="block" className={cx('wb-input', css.empInput)} value={name} onChange={e => setName(e.target.value)}
                    status={duplicateName ? 'warning' : ''} aria-describedby={duplicateName ? 'wf-emp-name-hint' : undefined} />
                  {duplicateName && <span id="wf-emp-name-hint" className={cx(css.empModelHint, css.imageWarning)}>{WF.workspace.duplicateName}</span>}
                </div>
                <div className={css.empField}>
                  <label htmlFor="wf-emp-title">{WF.employeesPage.role}</label>
                  <LobeInput id="wf-emp-title" type="block" className={cx('wb-input', css.empInput)} value={title} onChange={e => setTitle(e.target.value)} placeholder={WF.workspace.rolePlaceholder} />
                </div>
              </div>

              <div className={css.empField}>
                <label htmlFor="wf-emp-persona">{WF.workspace.roleDescription}</label>
                <LobeTextArea id="wf-emp-persona" type="block" autoSize={{ minRows: 2, maxRows: 8 }} value={persona} onChange={e => setPersona(e.target.value)} />
              </div>

              <AvatarColorField name={name} value={avatarColor} onChange={setAvatarColor} />

              <div className={css.empField}>
                <label className={css.empCheckboxLabel}>
                  <LobeSwitch size="small" checked={lead} onChange={setLead} />
                  {WF.employeesPage.lead}
                </label>
              </div>
            </div>

            <div className={css.empCardSection}>
              <h4 className={css.empCardSectionTitle}>{WF.workspace.coreCapabilitiesSection}</h4>
              <div className={css.empField}>
                <label htmlFor="wf-emp-model">{WF.employeesPage.model}</label>
                <LobeSelect
                  id="wf-emp-model"
                  className={css.empInput ?? ''}
                  value={model}
                  onChange={setModel}
                  options={[
                    { value: '', label: WF.models.defaultOption(modelsState.defaultModel
                      ? `${modelsState.defaultModel.provider}/${modelsState.defaultModel.model}`
                      : undefined) },
                    ...(model && !selectableModels.some(m => m.value === model)
                      ? [{ value: model, label: `${model} (${WF.workspace.currentTag})` }]
                      : []),
                    ...modelsState.providers.map(provider => ({
                      label: provider.displayName,
                      options: provider.models.map(m => ({ value: `${provider.id}/${m.id}`, label: m.name ?? m.id })),
                    })),
                  ]}
                />
              </div>

              {!lead && <EmployeeAccess value={toolAccess} onChange={setToolAccess} />}
              <ImageGenerationField value={imageGeneration} onChange={setImageGeneration} status={imageStatus} onConfigure={() => openResource('image', true)} />
              {!lead && toolAccess === 'office' && <WebSearchField value={webSearch} onChange={setWebSearch} status={webSearchStatus} />}
              <ExternalAgentField value={agent} onChange={setAgent} clis={agentClis} onRecheck={recheckAgentClis} />
              <EmployeeSkillsField skills={skills} onChange={setSkills} catalog={catalogSkills} user={userSkills} />

              <div className={css.empField}>
                <label className={css.empCheckboxLabel}>
                  <LobeSwitch size="small" checked={mcpLimited} onChange={setMcpLimited} />
                  {WF.workspace.limitMcpServersLabel}
                </label>
                {mcpLimited && (
                  <div className={css.empMcpPicks}>
                    {(mcpServers ?? []).map(server => (
                      <label key={server.id} className={css.empCheckboxLabel}>
                        <LobeSwitch
                          size="small"
                          checked={mcpIds.includes(server.id)}
                          onChange={checked => setMcpIds(checked ? [...mcpIds, server.id] : mcpIds.filter(id => id !== server.id))}
                        />
                        {server.label}（{server.transport === 'stdio' ? WF.workspace.localCommand : 'HTTP'}）
                      </label>
                    ))}
                    {mcpServers !== undefined && mcpServers.length === 0 && <span className={css.empModelHint}>{WF.workspace.noMcpServersConfigured}</span>}
                  </div>
                )}
                <span className={css.empModelHint}>{WF.workspace.mcpServersUncheckedHint}</span>
              </div>
            </div>

            <div className={css.empCardSection}>
              <h4 className={css.empCardSectionTitle}>{WF.workspace.instructionsTitle}</h4>
              {selectedId === 'new' ? (
                <p className={css.empModelHint}>{WF.workspace.saveFirstHint}</p>
              ) : (
                <WorkforceMemoryEditor
                  key={selectedId}
                  scope="employee"
                  scopeId={selectedId}
                  employees={snapshot.employees}
                  onOpenSource={onOpenMemorySource}
                />
              )}
            </div>

            {/* 操作条贴在视口底部：左侧删除，右侧是修改状态、取消和保存。 */}
            <div className={css.empSaveBar} data-dirty={dirty ? 'true' : undefined}>
              {deletable !== undefined && (
                <LobeButton danger type="text" onClick={() => setDeleting(deletable)}>
                  {WF.workspace.deleteEmployeeBtn}
                </LobeButton>
              )}
              <span className={css.empFormStatus}>
                {error !== undefined ? <span className={css.empFormError} role="alert">{error}</span> : dirty ? WF.workspace.unsavedChanges : null}
              </span>
              <LobeButton disabled={!dirty || busy} onClick={() => selectEmployee(currentEmployee)}>
                {WF.workspace.cancelChanges}
              </LobeButton>
              <LobeButton type="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>
                {busy ? WF.workspace.saving : WF.employeesPage.save}
              </LobeButton>
            </div>
          </div>
        </div>

        {deleting !== undefined && (
          <Dialog title={WF.employeesPage.deleteTitle} closeLabel={WF.employeesPage.cancel} onClose={() => setDeleting(undefined)} busy={busy}>
            <p className={css.empDeletePrompt}>
              {WF.workspace.deleteEmployeeConfirm(deleting.name, deleting.title || WF.workspace.noTitle)}
            </p>
            {error && <p className={css.empFormError} role="alert">{error}</p>}
            <div className={css.empDialogActions}>
              <LobeButton onClick={() => setDeleting(undefined)}>{WF.employeesPage.cancel}</LobeButton>
              <LobeButton type="primary" danger loading={busy} onClick={() => void doDelete()}>{WF.employeesPage.delete}</LobeButton>
            </div>
          </Dialog>
        )}

        {pending !== undefined && (
          <Dialog title={WF.workspace.discardTitle} closeLabel={WF.workspace.keepEditing} onClose={() => setPending(undefined)}>
            <p className={css.empDeletePrompt}>{WF.workspace.discardBody(name.trim() || WF.workspace.newEmployee)}</p>
            <div className={css.empDialogActions}>
              <LobeButton onClick={() => setPending(undefined)}>{WF.workspace.keepEditing}</LobeButton>
              <LobeButton type="primary" danger onClick={() => { setPending(undefined); if ('leave' in pending) leave(pending.leave); else selectEmployee(pending.select) }}>
                {WF.workspace.discardConfirm}
              </LobeButton>
            </div>
          </Dialog>
        )}

        <EmployeeResourceDrawer
          resource={resource}
          onClose={() => setResource(undefined)}
          source={source}
          employees={snapshot.employees}
          mcpServers={mcpServers}
          onMcpSaved={() => setResourcesVersion(v => v + 1)}
          imageStatus={imageStatus}
          onImageSaved={setImageStatus}
          imageSignal={imageSignal}
          templates={templates}
          onToggleTemplate={async (id, enabled) => { await source.patchTemplate(id, enabled); setResourcesVersion(v => v + 1) }}
          onApplyTemplate={async id => {
            const result = await source.applyTemplate(id)
            setToast(WF.workspace.templateApplyNotice(result.created.length, result.skipped.length))
            setResourcesVersion(v => v + 1)
          }}
        />
        <Toast id="workforce-employee-saved" message={toast ?? ''} open={toast !== undefined} onDismiss={dismissToast} tone="success" />
      </div>
    </div>
  )
}

/**
 * 数字员工工作区整页。view 来自 workbench nav store；DM thread 用 ensureDm
 * 建立/复用后进入。导航由宿主 sidebar 提供，不在主区重复列表。
 */
export function WorkforceWorkspace({ source, view, setView, onNavigation }: {
  readonly source: WorkforceSource
  readonly view: Extract<WorkbenchView, { kind: 'channel' } | { kind: 'dm' } | { kind: 'employees' } | { kind: 'home' } | { kind: 'canvas' }>
  readonly setView: (view: WorkbenchView) => void
  readonly onNavigation: () => void
}) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const [prefs] = useWorkforcePrefs()
  const [dmThread, setDmThread] = useState<{ employeeId: string; threadId: string } | undefined>()
  const [openThreadId, setOpenThreadId] = useState<string | undefined>()
  const [sourceMessageId, setSourceMessageId] = useState<string>()
  const pendingMemorySource = useRef<{ threadId: string; messageId?: string | undefined }>()
  const [dmError, setDmError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setOpenThreadId(pendingMemorySource.current?.threadId)
    setSourceMessageId(pendingMemorySource.current?.messageId)
    pendingMemorySource.current = undefined
  }, [view.kind, 'id' in view ? view.id : ''])
  const openMemorySource: MemorySourceNavigation = (threadId, messageId) => {
    const thread = snapshot.threads.find(item => item.id === threadId)
    if (!thread) throw new Error(WF.workspace.sourceSessionNotLoaded)
    if (thread.kind === 'dm' && thread.employeeId) {
      pendingMemorySource.current = { threadId, messageId }
      if (view.kind === 'dm' && view.id === thread.employeeId) { setSourceMessageId(messageId); pendingMemorySource.current = undefined }
      else setView({ kind: 'dm', id: thread.employeeId })
    } else if (thread.channelId) {
      if (view.kind === 'channel' && view.id === thread.channelId) { setOpenThreadId(threadId); setSourceMessageId(messageId) }
      else { pendingMemorySource.current = { threadId, messageId }; setView({ kind: 'channel', id: thread.channelId }) }
    } else throw new Error(WF.workspace.sourceSessionNoOwner)
  }

  // home = 默认频道。
  useEffect(() => {
    if (view.kind === 'home') setView({ kind: 'channel', id: DEFAULT_CHANNEL })
  }, [view.kind, setView])

  // 当前频道或 DM 聚焦通知 source 优先拉取
  useEffect(() => {
    if (view.kind === 'channel') {
      source.setFocusedThread(view.id)
    }
  }, [view.kind, view.kind === 'channel' ? view.id : '', source])

  useEffect(() => {
    if (dmThread?.threadId) {
      source.setFocusedThread(dmThread.threadId)
    }
  }, [dmThread?.threadId, source])
  // DM ensure：view.kind==='dm' 时确保 thread 存在。
  useEffect(() => {
    if (view.kind !== 'dm') { setDmThread(undefined); return }
    if (dmThread?.employeeId === view.id) return
    let current = true
    setDmThread(undefined)
    setDmError(undefined)
    const previous = source.getSnapshot().threads.find(thread => thread.kind === 'dm' && thread.employeeId === view.id)
    const resolved = previous ? Promise.resolve(previous) : source.ensureDm(view.id)
    resolved.then(thread => {
      if (current) setDmThread({ employeeId: view.id, threadId: thread.id })
    }).catch(error => { if (current) setDmError(error instanceof Error ? error.message : String(error)) })
    return () => { current = false }
  }, [view.kind, view.kind === 'dm' ? view.id : '', source, attempt])

  const isSidebarWide = () => {
    if (typeof document === 'undefined') return false
    const el = document.querySelector('[data-workforce-sidebar]')
    return (el?.getBoundingClientRect().width ?? 0) > 100
  }
  const autoCollapsedRef = useRef(false)

  if (view.kind === 'canvas') {
    return (
      <div className={css.canvasWorkspaceWrap}>
        <WorkforceCanvasView
          source={source}
          snapshot={snapshot}
          onCloseCanvas={() => {
            if (autoCollapsedRef.current) {
              autoCollapsedRef.current = false
              if (!isSidebarWide()) onNavigation()
            }
            setView({ kind: 'channel', id: DEFAULT_CHANNEL })
          }}
          onDrawerChange={open => {
            if (open && isSidebarWide()) {
              autoCollapsedRef.current = true
              onNavigation()
            } else if (!open && autoCollapsedRef.current && !isSidebarWide()) {
              autoCollapsedRef.current = false
              onNavigation()
            }
          }}
        />
      </div>
    )
  }

  if (view.kind === 'employees') {
    return (
      <div className={css.employeeSurface} data-wb-style={prefs.style}>
        <div className={css.streamHead} data-section="stream-head">
          <div className={css.streamHeadRow}>
            <button type="button" className={css.navigationToggle} aria-label={WF.workspace.expandChannelNav} onClick={onNavigation}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="4" y1="6" x2="20" y2="6"/>
                <line x1="4" y1="12" x2="20" y2="12"/>
                <line x1="4" y1="18" x2="20" y2="18"/>
              </svg>
            </button>
            <h2 className={css.streamTitle}>{WF.brand}</h2>
            <div className={css.streamSettingsWrap}>
              <button
                type="button"
                className={css.streamHeadActionBtn}
                title={WF.models.title}
                aria-label={WF.models.title}
                onClick={() => source.models.open()}
              >
                <Icon name="settings" width={18} height={18} />
              </button>
            </div>
          </div>
        </div>
        <EmployeesPage source={source} snapshot={snapshot} onOpenMemorySource={openMemorySource} navigate={setView} />
      </div>
    )
  }

  const surface: WorkforceSurface | undefined = view.kind === 'channel'
    ? { kind: 'channel', id: view.id }
    : dmThread !== undefined && dmThread.employeeId === (view.kind === 'dm' ? view.id : '')
      ? { kind: 'dm', threadId: dmThread.threadId, employeeId: dmThread.employeeId }
      : undefined

  if (surface === undefined) {
    const failure = dmError ?? snapshot.error
    const modelError = classifyModelError(undefined, failure)
    return <div className={css.root} data-workforce-root>
      <div className={css.streamEmpty}>
        {modelError?.message ?? failure ?? WF.employee.loading}
        {modelError && modelError.action !== 'retry' && <button type="button" className={css.empAction} onClick={() => source.models.open({ provider: modelError.action === 'addKey' ? modelError.provider : undefined })}>{modelError.action === 'addKey' ? WF.errorActions.addKey : WF.errorActions.changeModel}</button>}
        {failure && <button type="button" className={css.empAction} onClick={() => { setAttempt(value => value + 1); source.refresh() }}>{WF.status.retry}</button>}
      </div>
    </div>
  }

  return (
    <div className={css.root} data-workforce-root>
      <WorkforceMain
        source={source}
        snapshot={snapshot}
        surface={surface}
        onDm={employeeId => { setOpenThreadId(undefined); setView({ kind: 'dm', id: employeeId }) }}
        openThreadId={surface.kind === 'channel' ? openThreadId : undefined}
        onCloseThread={() => setOpenThreadId(undefined)}
        onOpenThread={threadId => setOpenThreadId(threadId)}
        enableMaterial={true}
        onNavigation={onNavigation}
        onOpenMemorySource={openMemorySource}
        sourceMessageId={sourceMessageId}
      />
    </div>
  )
}
