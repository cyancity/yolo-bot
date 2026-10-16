/**
 * 数字员工工作区整页：频道与员工私信的消息流、线程面板，以及独立员工管理页。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { cx, Dialog } from './ui/index.tsx'
import { Icon } from './ui/icons.tsx'
import { WF } from './workforce-strings.ts'
import { DEFAULT_CHANNEL, type WorkbenchView } from './nav.ts'
import type { Employee, EmployeeInput, McpServer, McpServerInput, SkillSummary, WorkforceSnapshot, WorkforceTemplate, WorkforceUserSkill } from './workforce-types.ts'
import type { WorkforceSource } from './workforce-source.ts'
import { WorkforceMain, type WorkforceSurface } from './workforce.tsx'
import { WorkforceCanvasView } from './workforce-canvas-view.tsx'
import css from './workforce.module.css'
import { WorkforceAvatar, AVATAR_PALETTES } from './workforce-avatar.tsx'
import { useWorkforcePrefs } from './workforce-prefs.ts'
import { classifyModelError, useWorkforceModels } from './workforce-models.tsx'
import { WorkforceMemoryEditor, type MemorySourceNavigation } from './workforce-memory.tsx'

/** 员工管理页：列表 + 新建/编辑表单（名字/头衔/职责/模型/skill/负责人）。 */
export function EmployeesPage({ source, snapshot, onOpenMemorySource }: {
  readonly source: WorkforceSource
  readonly snapshot: WorkforceSnapshot
  readonly onOpenMemorySource?: MemorySourceNavigation | undefined
}) {
  const [selectedId, setSelectedId] = useState<string | 'new'>('new')
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [persona, setPersona] = useState('')
  const [model, setModel] = useState('')
  const [skills, setSkills] = useState<string[]>([])
  const [customSkillInput, setCustomSkillInput] = useState('')
  const [lead, setLead] = useState(false)
  const [avatarColor, setAvatarColor] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [deleting, setDeleting] = useState<Employee | undefined>()
  const [mcpLimited, setMcpLimited] = useState(false)
  const [mcpIds, setMcpIds] = useState<readonly string[]>([])
  const [mcpServers, setMcpServers] = useState<readonly McpServer[] | undefined>()
  const [templates, setTemplates] = useState<readonly WorkforceTemplate[] | undefined>()
  const [catalogSkills, setCatalogSkills] = useState<readonly SkillSummary[] | undefined>()
  const [userSkills, setUserSkills] = useState<readonly WorkforceUserSkill[] | undefined>()
  const [resourcesVersion, setResourcesVersion] = useState(0)
  const [notice, setNotice] = useState<string | undefined>()
  const { state: modelsState, selectableModels } = useWorkforceModels(source.models)

  const currentEmployee = selectedId === 'new'
    ? 'new'
    : snapshot.employees.find(e => e.id === selectedId) ?? snapshot.employees[0]

  const selectEmployee = (employee: Employee | 'new' | undefined): void => {
    setError(undefined)
    if (!employee || employee === 'new') {
      setSelectedId('new')
      setName(''); setTitle(''); setPersona(''); setModel(''); setSkills([]); setLead(false); setAvatarColor('')
      setMcpLimited(false); setMcpIds([])
    } else {
      setSelectedId(employee.id)
      setName(employee.name); setTitle(employee.title); setPersona(employee.persona)
      setModel(employee.model ?? ''); setSkills(employee.skills ? [...employee.skills] : []); setLead(employee.isLeader)
      setAvatarColor(employee.avatarColor ?? '')
      setMcpLimited(employee.mcpServers !== undefined); setMcpIds(employee.mcpServers ?? [])
    }
  }

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

  const addSkill = (skillName: string): void => {
    const trimmed = skillName.trim()
    if (!trimmed) return
    setSkills(prev => prev.includes(trimmed) ? prev : [...prev, trimmed])
  }

  const removeSkill = (skillName: string): void => {
    setSkills(prev => prev.filter(s => s !== skillName))
  }

  const toggleSkill = (skillName: string): void => {
    const trimmed = skillName.trim()
    if (!trimmed) return
    setSkills(prev => prev.includes(trimmed) ? prev.filter(s => s !== trimmed) : [...prev, trimmed])
  }

  const save = async (): Promise<void> => {
    if (name.trim() === '') { setError('名字不能为空'); return }
    const input: EmployeeInput = {
      name: name.trim(),
      title: title.trim(),
      persona: persona.trim(),
      skills,
      model: model.trim(),
      mcpServers: mcpLimited ? [...mcpIds] : null,
      isLeader: lead,
      avatarColor: avatarColor.trim() || undefined,
    }
    setBusy(true)
    setError(undefined)
    try {
      if (selectedId === 'new') {
        await source.createEmployee(input)
        setNotice(`员工「${input.name}」创建成功`)
      } else if (currentEmployee !== 'new' && currentEmployee !== undefined) {
        await source.updateEmployee(currentEmployee.id, input)
        setNotice(`员工「${input.name}」配置已保存`)
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
      if (remaining.length > 0) {
        selectEmployee(remaining[0]!)
      } else {
        selectEmployee('new')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.empPage} data-workforce-employees>
      <div className={css.empSplitLayout}>
        {/* 左侧：员工列表 + MCP + 模板 */}
        <div className={css.empSidebarList}>
          <div className={css.empSidebarHead}>
            <span className={css.empSidebarTitle}>员工列表 ({snapshot.employees.length})</span>
            <button
              type="button"
              className={css.empBtnAdd}
              style={{ padding: '3px 10px', fontSize: 12 }}
              onClick={() => selectEmployee('new')}
            >
              ＋ 新建
            </button>
          </div>
          {selectedId === 'new' && (
            <div className={css.empCompactCard} data-selected="true">
              <WorkforceAvatar
                name={name.trim() || '新员工'}
                isUser={false}
                color={avatarColor || undefined}
                live={false}
                size={28}
              />
              <div className={css.empCompactCardBody}>
                <div className={css.empCompactCardName}>
                  {name.trim() || '新建员工'}
                  {lead && <span className={css.msgLead}>{WF.employee.lead}</span>}
                </div>
                <div className={css.empCompactCardTitle}>{title.trim() || '正在创建…'}</div>
              </div>
            </div>
          )}
          {snapshot.employees.map(employee => {
            const isSelected = selectedId === employee.id
            return (
              <div
                key={employee.id}
                className={css.empCompactCard}
                data-selected={isSelected ? 'true' : undefined}
                onClick={() => selectEmployee(employee)}
              >
                <WorkforceAvatar
                  name={employee.name}
                  isUser={false}
                  color={employee.avatarColor}
                  role={employee.role}
                  live={false}
                  size={28}
                />
                <div className={css.empCompactCardBody}>
                  <div className={css.empCompactCardName}>
                    {employee.name}
                    {employee.isLeader && <span className={css.msgLead}>{WF.employee.lead}</span>}
                  </div>
                  <div className={css.empCompactCardTitle}>{employee.title || employee.persona || '无职责说明'}</div>
                </div>
              </div>
            )
          })}

          {/* MCP 服务器在左侧列表下方展示 */}
          <McpServersSection
            servers={mcpServers}
            employees={snapshot.employees}
            onSaved={() => setResourcesVersion(v => v + 1)}
            source={source}
          />

          {templates !== undefined && templates.length > 0 && (
            <TemplatesSection
              templates={templates}
              onToggle={async (id, enabled) => { await source.patchTemplate(id, enabled); setResourcesVersion(v => v + 1) }}
              onApply={async id => {
                const result = await source.applyTemplate(id)
                setNotice(`已创建 ${result.created.length} 名员工${result.skipped.length > 0 ? `，跳过同名 ${result.skipped.length} 名` : ''}`)
                setResourcesVersion(v => v + 1)
              }}
            />
          )}
        </div>

        {/* 右侧：编辑/配置表单 */}
        <div className={css.empMainForm}>
          <div className={css.empFormHeader}>
            <h3 className={css.empFormTitle}>
              {selectedId === 'new' ? '新建数字员工' : `编辑员工：${name || (currentEmployee !== 'new' && currentEmployee !== undefined ? currentEmployee.name : '')}`}
            </h3>
          </div>

          {notice !== undefined && <div className={css.empIntro} role="status">{notice}</div>}
          {(snapshot.error || error) && <div className={css.streamError} role="alert">{snapshot.error ?? error}</div>}
          {modelsState.providers.length > 0 &&
            !modelsState.providers.some(p => p.configured || p.requiresApiKey === false) && (
              <div className={css.streamError} role="alert">
                <span>{WF.employeesPage.noModel}</span>
                <button type="button" className={css.empAction} onClick={() => source.models.open()}>
                  {WF.employeesPage.noModelAction}
                </button>
              </div>
            )}

          <div className={css.empForm} data-workforce-employee-form>
            {/* Card 1: 基础档案与头像 */}
            <div className={css.empCardSection}>
              <h4 className={css.empCardSectionTitle}>基础档案与头像</h4>
              <div className={css.empField}>
                <label>{WF.employeesPage.avatarColor}</label>
                <div className={css.avatarColorPicker}>
                  <WorkforceAvatar
                    name={name.trim() || '员工'}
                    isUser={false}
                    color={avatarColor || undefined}
                    live={false}
                    size={42}
                  />
                  <div className={css.colorSwatches}>
                    <button
                      type="button"
                      className={`${css.colorDefaultBtn} ${avatarColor === '' ? css.colorDefaultBtnActive : ''}`}
                      onClick={() => setAvatarColor('')}
                      title="默认配色（根据员工角色或姓名自动分配）"
                    >
                      {WF.employeesPage.avatarColorDefault}
                    </button>
                    {AVATAR_PALETTES.map(palette => {
                      const isSelected = avatarColor === `palette:${palette.id}` || avatarColor === palette.id
                      return (
                        <button
                          key={palette.id}
                          type="button"
                          className={`${css.paletteSwatchBtn} ${isSelected ? css.paletteSwatchActive : ''}`}
                          title={`${palette.label} · ${palette.description}`}
                          aria-label={`${palette.label}：${palette.description}`}
                          onClick={() => setAvatarColor(`palette:${palette.id}`)}
                        >
                          <WorkforceAvatar
                            name={name.trim() || '员工'}
                            isUser={false}
                            palette={palette.id}
                            live={false}
                            size={28}
                          />
                          <span className={css.paletteSwatchLabel}>{palette.label}</span>
                        </button>
                      )
                    })}
                    <label className={`${css.colorCustomWrap} ${avatarColor.startsWith('#') ? css.colorCustomActive : ''}`} title={WF.employeesPage.avatarColorCustom}>
                      <input
                        type="color"
                        className={css.colorCustomInput}
                        value={avatarColor && /^#[0-9a-f]{6}$/i.test(avatarColor) ? avatarColor : '#3b5bdb'}
                        onChange={e => setAvatarColor(e.target.value)}
                        aria-label={WF.employeesPage.avatarColorCustom}
                      />
                      <span className={css.colorCustomLabel}>
                        {avatarColor.startsWith('#') ? avatarColor.toUpperCase() : '自定义'}
                      </span>
                    </label>
                  </div>
                </div>
              </div>

              <div className={css.empFormGrid}>
                <div className={css.empField}>
                  <label htmlFor="wf-emp-name">{WF.employeesPage.name}</label>
                  <input id="wf-emp-name" className={cx('wb-input', css.empInput)} value={name} onChange={e => setName(e.target.value)} />
                </div>
                <div className={css.empField}>
                  <label htmlFor="wf-emp-title">{WF.employeesPage.role}</label>
                  <input id="wf-emp-title" className={cx('wb-input', css.empInput)} value={title} onChange={e => setTitle(e.target.value)} placeholder="负责人 / 分析员 / 文案员…" />
                </div>
              </div>

              <div className={css.empField}>
                <label htmlFor="wf-emp-persona">职责说明</label>
                <textarea id="wf-emp-persona" rows={2} value={persona} onChange={e => setPersona(e.target.value)} />
              </div>

              <div className={css.empField}>
                <label className={css.empCheckboxLabel}>
                  <input type="checkbox" checked={lead} onChange={e => setLead(e.target.checked)} />
                  {WF.employeesPage.lead}
                </label>
              </div>
            </div>

            {/* Card 2: 核心能力与模型 */}
            <div className={css.empCardSection}>
              <h4 className={css.empCardSectionTitle}>核心能力与模型</h4>
              <div className={css.empField}>
                <label htmlFor="wf-emp-model">{WF.employeesPage.model}</label>
                <select
                  id="wf-emp-model"
                  className={cx('wb-input', css.empInput)}
                  value={model}
                  onChange={e => setModel(e.target.value)}
                >
                  <option value="">
                    {WF.models.defaultOption(
                      modelsState.defaultModel
                        ? `${modelsState.defaultModel.provider}/${modelsState.defaultModel.model}`
                        : undefined,
                    )}
                  </option>
                  {model && !selectableModels.some(m => m.value === model) && (
                    <option value={model}>{model} (当前)</option>
                  )}
                  {modelsState.providers.map(provider => (
                    <optgroup key={provider.id} label={provider.displayName}>
                      {provider.models.map(m => (
                        <option key={`${provider.id}/${m.id}`} value={`${provider.id}/${m.id}`}>
                          {m.name ?? m.id}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <span className={css.empModelHint}>{WF.employeesPage.modelHint}</span>
              </div>

              {/* 技能配置：Chip 标签墙与自定义添加，绝不截断 */}
              <div className={css.empField}>
                <label>技能配置 (已选 {skills.length})</label>
                <div className={css.skillChipsContainer}>
                  {skills.length === 0 ? (
                    <span className={css.skillEmptyHint}>暂未配置专属技能，可从下方技能库点选或手动输入添加</span>
                  ) : (
                    skills.map(skillName => (
                      <span key={skillName} className={css.skillChipSelected}>
                        <span className={css.skillChipIcon}>⚡</span>
                        <span className={css.skillChipText}>{skillName}</span>
                        <button
                          type="button"
                          className={css.skillChipRemove}
                          title={`移除 ${skillName}`}
                          aria-label={`移除 ${skillName}`}
                          onClick={() => removeSkill(skillName)}
                        >
                          ×
                        </button>
                      </span>
                    ))
                  )}
                </div>
                <div className={css.customSkillRow}>
                  <input
                    type="text"
                    className={cx('wb-input', css.customSkillInput)}
                    placeholder="输入自定义技能名后按 Enter 添加…"
                    value={customSkillInput}
                    onChange={e => setCustomSkillInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addSkill(customSkillInput)
                        setCustomSkillInput('')
                      }
                    }}
                  />
                  <button
                    type="button"
                    className={css.empBtnAdd}
                    disabled={!customSkillInput.trim()}
                    onClick={() => {
                      addSkill(customSkillInput)
                      setCustomSkillInput('')
                    }}
                  >
                    添加
                  </button>
                </div>
                {(catalogSkills ?? []).length + (userSkills ?? []).length > 0 && (
                  <div className={css.skillLibraryWrap}>
                    <span className={css.skillLibraryTitle}>从系统/用户技能库点选添加：</span>
                    <div className={css.skillPickList} aria-label={WF.employeesPage.skillPickerLabel}>
                      {(catalogSkills ?? []).map(skill => {
                        const isAdded = skills.includes(skill.name)
                        return (
                          <button
                            key={`catalog:${skill.name}`}
                            type="button"
                            className={`${css.skillPick} ${isAdded ? css.skillPickActive : ''}`}
                            title={`${skill.description || skill.name} · ${WF.employeesPage.skillOriginBuiltin}`}
                            onClick={() => toggleSkill(skill.name)}
                          >
                            {isAdded ? `✓ ${skill.name}` : `＋ ${skill.name}`}
                          </button>
                        )
                      })}
                      {(userSkills ?? [])
                        .filter(skill => !(catalogSkills ?? []).some(item => item.name === skill.name))
                        .map(skill => {
                          const isAdded = skills.includes(skill.name)
                          return (
                            <button
                              key={`user:${skill.name}`}
                              type="button"
                              className={`${css.skillPick} ${isAdded ? css.skillPickActive : ''}`}
                              data-origin={skill.origin}
                              title={`${skill.description || skill.name} · ${skill.origin === 'workflow' ? WF.employeesPage.skillOriginWorkflow : WF.employeesPage.skillOriginUser}`}
                              onClick={() => toggleSkill(skill.name)}
                            >
                              {isAdded ? `✓ ${skill.name}` : `＋ ${skill.name}`}
                            </button>
                          )
                        })}
                    </div>
                  </div>
                )}
              </div>

              <div className={css.empField}>
                <label className={css.empCheckboxLabel}>
                  <input type="checkbox" checked={mcpLimited} onChange={e => setMcpLimited(e.target.checked)} />
                  限定可用 MCP 服务器（高级）
                </label>
                {mcpLimited && (
                  <div className={css.empFieldRow}>
                    {(mcpServers ?? []).map(server => (
                      <label key={server.id} className={css.empModelHint} style={{ display: 'inline-flex', gap: 4, marginRight: 12 }}>
                        <input
                          type="checkbox"
                          checked={mcpIds.includes(server.id)}
                          onChange={e => setMcpIds(e.target.checked ? [...mcpIds, server.id] : mcpIds.filter(id => id !== server.id))}
                        />
                        {server.label}（{server.transport === 'stdio' ? '本地命令' : 'HTTP'}）
                      </label>
                    ))}
                    {mcpServers !== undefined && mcpServers.length === 0 && <span className={css.empModelHint}>暂无已配置服务器，在左侧「MCP 服务器」添加</span>}
                  </div>
                )}
                <span className={css.empModelHint}>不勾选时该员工可用全部已启用服务器；改动在该员工下次会话生效。</span>
              </div>
            </div>

            {/* Card 3: 长期记忆交代 */}
            <div className={css.empCardSection}>
              <h4 className={css.empCardSectionTitle}>对 TA 的交代（长期记忆）</h4>
              {selectedId === 'new' ? (
                <p className={css.empModelHint}>先保存员工，再添加长期交代。</p>
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

            {/* 底部操作区：全部靠右排列 */}
            <div className={css.empFormActions}>
              {currentEmployee !== 'new' && currentEmployee !== undefined && (
                currentEmployee.isLeader || lead ? (
                  <button
                    type="button"
                    className={css.empBtnDelete}
                    disabled
                    title="负责人为工作台核心角色，默认无法删除"
                    style={{ opacity: 0.4, cursor: 'not-allowed' }}
                  >
                    删除员工
                  </button>
                ) : (
                  <button
                    type="button"
                    className={css.empBtnDelete}
                    onClick={() => setDeleting(currentEmployee)}
                  >
                    {WF.employeesPage.delete}
                  </button>
                )
              )}
              <button
                type="button"
                className={css.empBtnCancel}
                onClick={() => selectEmployee(currentEmployee)}
              >
                取消修改
              </button>
              <button
                type="button"
                className={css.empBtnSave}
                disabled={busy}
                onClick={() => void save()}
              >
                {busy ? '保存中…' : WF.employeesPage.save}
              </button>
              {error !== undefined && <span className={css.empFormError} role="alert">{error}</span>}
            </div>
          </div>
        </div>

        {deleting !== undefined && (
          <Dialog title={WF.employeesPage.deleteTitle} closeLabel={WF.employeesPage.cancel} onClose={() => setDeleting(undefined)} busy={busy}>
            <p className={css.empDeletePrompt}>
              确定要删除数字员工「<strong>{deleting.name}</strong>」（{deleting.title || '无头衔'}）吗？删除后此员工绑定的任务和历史数据将解除关联，此操作不可撤销。
            </p>
            {error && <p className={css.empFormError} role="alert">{error}</p>}
            <div className={css.empFormActions} style={{ marginTop: 16 }}>
              <button type="button" className={css.empBtnDelete} disabled={busy} onClick={() => void doDelete()}>{WF.employeesPage.delete}</button>
              <button type="button" className={css.empBtnCancel} onClick={() => setDeleting(undefined)}>{WF.employeesPage.cancel}</button>
            </div>
          </Dialog>
        )}
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
    if (!thread) throw new Error('来源会话尚未加载，请刷新后重试。')
    if (thread.kind === 'dm' && thread.employeeId) {
      pendingMemorySource.current = { threadId, messageId }
      if (view.kind === 'dm' && view.id === thread.employeeId) { setSourceMessageId(messageId); pendingMemorySource.current = undefined }
      else setView({ kind: 'dm', id: thread.employeeId })
    } else if (thread.channelId) {
      if (view.kind === 'channel' && view.id === thread.channelId) { setOpenThreadId(threadId); setSourceMessageId(messageId) }
      else { pendingMemorySource.current = { threadId, messageId }; setView({ kind: 'channel', id: thread.channelId }) }
    } else throw new Error('来源会话没有频道或员工归属。')
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
            <button type="button" className={css.navigationToggle} aria-label="展开频道导航" onClick={onNavigation}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="4" y1="6" x2="20" y2="6"/>
                <line x1="4" y1="12" x2="20" y2="12"/>
                <line x1="4" y1="18" x2="20" y2="18"/>
              </svg>
            </button>
            <h2 className={css.streamTitle}>数字员工</h2>
            <span className={css.streamHeadDivider} aria-hidden="true" />
            <span className={css.streamDesc}>管理工作台的数字员工与技能配置</span>
            <div className={css.streamSettingsWrap}>
              <button
                type="button"
                className={css.streamHeadActionBtn}
                title="模型设置"
                aria-label="模型设置"
                onClick={() => source.models.open()}
              >
                <Icon name="settings" width={18} height={18} />
              </button>
            </div>
          </div>
        </div>
        <EmployeesPage source={source} snapshot={snapshot} onOpenMemorySource={openMemorySource} />
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

/** 注册模板卡片区：启停由模板提供者管理，「应用员工配置」按种子建员工（同名跳过）。 */
function TemplatesSection({ templates, onToggle, onApply }: {
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
      <h2 className={css.empTitle}>员工预设</h2>
      <p className={css.empIntro}>模板提供者管理预设及技能来源；「应用员工配置」按预设批量创建员工（不覆盖同名）。</p>
      {error !== undefined && <div className={css.empFormError} role="alert">{error}</div>}
      {templates.map(template => (
        <div key={template.id} className={css.empCard}>
          <div className={css.empCardBody}>
            <div className={css.empCardName}>{template.label}</div>
            <div className={css.empCardRole}>{template.description}</div>
            <div className={css.empCardMeta}>
              <span className={css.empModelHint}>{template.skills.length} 个 skill · {template.employees.length} 个员工配置</span>
            </div>
          </div>
          <div className={css.empCardActions}>
            <label className={css.empAction}>
              <input type="checkbox" checked={template.enabled} disabled={busy === template.id} onChange={e => void run(template.id, () => onToggle(template.id, e.target.checked))} /> 启用
            </label>
            <button type="button" className={css.empAction} disabled={busy === template.id} onClick={() => void run(template.id, () => onApply(template.id))}>应用员工配置</button>
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
function McpServersSection({ servers, employees, source, onSaved }: {
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
    if (serverName.trim() === '' || label.trim() === '') { setError('服务器名与显示名不能为空'); return }
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName.trim())) { setError('服务器名只能包含字母、数字、下划线与连字符（≤32）'); return }
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
      <div className={css.empHead}>
        <h2 className={css.empTitle}>MCP 服务器</h2>
        <button type="button" className={css.listAdd} onClick={() => beginEdit('new')}>＋ 添加服务器</button>
      </div>
      <p className={css.empIntro}>服务器在对应员工的会话里启动（scoped 挂载）；密码与密钥填凭据引用名（@NAME），不落盘。改动在员工下次会话生效。</p>
      {servers !== undefined && servers.length === 0 && editing === undefined && <p className={css.empIntro}>尚未配置服务器。员工默认可用全部已启用服务器。</p>}
      {(servers ?? []).map(server => (
        <div key={server.id} className={css.empCard}>
          <div className={css.empCardBody}>
            <div className={css.empCardName}>
              {server.label}
              {!server.enabled && <span className={css.msgLead}>已停用</span>}
            </div>
            <div className={css.empCardRole}>
              {server.transport === 'stdio' ? `本地命令 ${server.command} ${(server.args ?? []).join(' ')}` : `HTTP ${server.url}`}
              {` · mcp__${server.serverName}__*`}
            </div>
            <div className={css.empCardMeta}>
              <span className={css.empModelHint}>{assigned(server).length} 名员工可用</span>
              {server.status?.credentials.map(cred => (
                <span key={cred.key} className={css.empModelHint}>{cred.key}→@{cred.ref} {cred.configured ? '已配置' : '未配置'}</span>
              ))}
              {server.status?.errors.map((message, index) => <span key={index} className={css.empFormError}>{message}</span>)}
              {server.status !== undefined && !server.status.available && <span className={css.empModelHint}>MCP 客户端不可用</span>}
            </div>
          </div>
          <div className={css.empCardActions}>
            <button type="button" className={css.empAction} onClick={() => void (async () => { await source.patchMcpServer(server.id, { enabled: !server.enabled }); onSaved() })()}>{server.enabled ? '停用' : '启用'}</button>
            <button type="button" className={css.empAction} onClick={() => beginEdit(server)}>{WF.employeesPage.edit}</button>
            <button type="button" className={`${css.empAction} ${css.empActionDanger}`} onClick={() => setConfirmDelete(server)}>{WF.employeesPage.delete}</button>
          </div>
        </div>
      ))}

      {editing !== undefined && (
        <div className={css.empForm} data-workforce-mcp-form>
          <div className={css.empFormGrid}>
            <div className={css.empField}>
              <label htmlFor="wf-mcp-name">服务器名（工具命名空间）</label>
              <input id="wf-mcp-name" className={cx('wb-input', css.empInput)} value={serverName} onChange={e => setServerName(e.target.value)} placeholder="filesystem" />
            </div>
            <div className={css.empField}>
              <label htmlFor="wf-mcp-label">显示名</label>
              <input id="wf-mcp-label" className={cx('wb-input', css.empInput)} value={label} onChange={e => setLabel(e.target.value)} />
            </div>
            <div className={css.empField}>
              <label htmlFor="wf-mcp-transport">连接方式</label>
              <select id="wf-mcp-transport" className={cx('wb-input', css.empInput)} value={transport} onChange={e => setTransport(e.target.value as 'stdio' | 'streamable-http')}>
                <option value="stdio">本地命令（stdio）</option>
                <option value="streamable-http">远程 HTTP</option>
              </select>
            </div>
            {transport === 'stdio' ? (
              <>
                <div className={css.empField + ' ' + css.empFieldRow}>
                  <label htmlFor="wf-mcp-command">启动命令</label>
                  <input id="wf-mcp-command" className={cx('wb-input', css.empInput)} value={command} onChange={e => setCommand(e.target.value)} placeholder="npx / uvx / 可执行文件" />
                </div>
                <div className={css.empField}>
                  <label htmlFor="wf-mcp-args">参数（空格分隔）</label>
                  <input id="wf-mcp-args" className={cx('wb-input', css.empInput)} value={args} onChange={e => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem" />
                </div>
                <div className={css.empField}>
                  <label htmlFor="wf-mcp-cwd">工作目录（可选）</label>
                  <input id="wf-mcp-cwd" className={cx('wb-input', css.empInput)} value={cwd} onChange={e => setCwd(e.target.value)} />
                </div>
                <div className={css.empField + ' ' + css.empFieldRow}>
                  <label htmlFor="wf-mcp-env">环境变量（每行 KEY=value；凭据引用写 KEY=@NAME）</label>
                  <textarea id="wf-mcp-env" rows={2} value={envText} onChange={e => setEnvText(e.target.value)} placeholder={'API_KEY=@MY_MCP_KEY\nDEBUG=false'} />
                </div>
              </>
            ) : (
              <>
                <div className={css.empField + ' ' + css.empFieldRow}>
                  <label htmlFor="wf-mcp-url">服务地址</label>
                  <input id="wf-mcp-url" className={cx('wb-input', css.empInput)} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
                </div>
                <div className={css.empField + ' ' + css.empFieldRow}>
                  <label htmlFor="wf-mcp-headers">请求头（每行 KEY=value；凭据引用写 KEY=@NAME）</label>
                  <textarea id="wf-mcp-headers" rows={2} value={headersText} onChange={e => setHeadersText(e.target.value)} placeholder={'Authorization=@MCP_TOKEN'} />
                </div>
              </>
            )}
          </div>
          <div className={css.empFormActions}>
            <button type="button" className={css.composerSend} disabled={busy} onClick={() => void save()}>{WF.employeesPage.save}</button>
            <button type="button" className={css.empAction} onClick={() => setEditing(undefined)}>{WF.employeesPage.cancel}</button>
            {error !== undefined && <span className={css.empFormError} role="alert">{error}</span>}
          </div>
        </div>
      )}

      {confirmDelete !== undefined && (
        <Dialog title="删除 MCP 服务器" closeLabel={WF.employeesPage.cancel} onClose={() => setConfirmDelete(undefined)} busy={busy}>
          <p className={css.empIntro}>
            确定删除「{confirmDelete.label}」？
            {assigned(confirmDelete).length > 0 && ` ${assigned(confirmDelete).length} 名员工（${assigned(confirmDelete).map(e => e.name).join('、')}）的限定列表会移除该服务器。`}
          </p>
          {error && <p className={css.empFormError} role="alert">{error}</p>}
          <div className={css.empFormActions}>
            <button type="button" className={css.composerSend} disabled={busy} onClick={() => void (async () => {
              setBusy(true); setError(undefined)
              try { await source.deleteMcpServer(confirmDelete.id); setConfirmDelete(undefined); onSaved() }
              catch (e) { setError(e instanceof Error ? e.message : String(e)) }
              finally { setBusy(false) }
            })()}>{WF.employeesPage.delete}</button>
            <button type="button" className={css.empAction} onClick={() => setConfirmDelete(undefined)}>{WF.employeesPage.cancel}</button>
          </div>
        </Dialog>
      )}
    </div>
  )
}
