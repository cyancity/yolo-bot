/**
 * 数字员工主工作区：频道消息流 / 员工 DM / thread 面板 / 底部 composer。
 * 数据来自 WorkforceSource（Host 轮询 API），组件不感知 ctx；消息左对齐
 * 署名+头像+时间（不做两方气泡）；工具调用/产物折叠可开。
 */
import { IconCloseOutlineRegular, IconDeliverDocRegular, IconRefreshOutlineRegular, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { Button as LobeButton, Checkbox, Radio } from 'antd'
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react'
import { WorkbenchExtensionPreview, readExtensionPreview } from './extension-preview.tsx'
import { Button } from './ui/button.tsx'
import { Bubble } from './ui/bubble.tsx'
import { RadioGroup } from './ui/choice.tsx'
import { Icon } from './ui/icons.tsx'
import type { HostChannel } from './workforce-api.ts'
import { AttachmentBar, gateAttachment } from './workforce-attachments.tsx'
import type { AvatarMotionState } from './workforce-avatar-motion.ts'
import { WorkforceAvatar } from './workforce-avatar.tsx'
import { WorkforceBackupDialog } from './workforce-backup.tsx'
import { WorkforceComposer, type ComposerPrefillRequest } from './workforce-composer.tsx'
import { useContinuationMode } from './workforce-composer-helpers.tsx'
import { ContextDivider } from './workforce-context-divider.tsx'
import { AnchoredDeliverablesContext, DeliverableChips, anchoredDeliverables, messageDeliverableNames } from './workforce-deliverables.tsx'
import { WorkforceDiagnosticsDialog } from './workforce-diagnostics.tsx'
import { workforceContextFiles, WorkforceFilesDrawer, WorkforceFilesTimeline } from './workforce-files.tsx'
import { readRememberedMemory, RememberedMemoryCard, WorkforceMemoryDialog, type MemorySourceNavigation, type RememberedMemory } from './workforce-memory.tsx'
import { WorkforceMessageText } from './workforce-message-text.tsx'
import { classifyModelError, parseModelErrorAction } from './workforce-models.tsx'
import { useWorkforcePrefs, type ReplyGrouping } from './workforce-prefs.ts'
import { useUserProfile } from './workforce-profile.tsx'; import { ProjectDirectory } from './workforce-project-directory.tsx'; import { agentRunMessage } from './workforce-agent-run.ts'
import { WorkforceQuestionCard } from './workforce-question-card.tsx'
import { ReplyGroupCard } from './workforce-reply-group.tsx'
import { ReplyPreviewDialog } from './workforce-reply-preview.tsx'
import { MessageStreamSkeleton, useDelayedLoading } from './workforce-skeleton.tsx'
import { WorkforceSkillDraftsDialog } from './workforce-skill-drafts.tsx'
import type { PendingReply, WorkforceSource } from './workforce-source.ts'
import { channelStream, isLeaderNoReplyDraft, mentionsEveryone, replyGroups, threadTask, threadView, visibleReplyCounts } from './workforce-source.ts'
import { WF } from './workforce-strings.ts'
import type { Employee, Task, WorkforceActivity, WorkforceMessage, WorkforceSkillDraft, WorkforceSnapshot } from './workforce-types.ts'
import { threadHasWebSearch, WebSearchBatch, WorkforceWebSearch } from './workforce-websearch.tsx'
import { WorkforceWelcome } from './workforce-welcome.tsx'
import css from './workforce.module.css'
/** 联网搜索披露：插件平台 web loader 只有单 chunk 模块表（多文件 require 会让插件整体拒载），
 *  因此不做网络分包；「按需」落在渲染层——hasWebSearch 为假时零挂载零渲染。 */
/** web_search 工具消息渲染成披露行；同 turn 多条紧凑成一行批量块，独立成行不进 MessageRow（保其 memo）。 */
function WebSearchRow({ messages }: { readonly messages: readonly WorkforceMessage[] }) {
  if (messages.length === 0) return null
  const tool = messages[0]!.tool
  if (messages.length === 1) {
    if (tool === undefined) return null
    return (
      <div className={css.webSearchRow} data-message-id={messages[0]!.id}>
        <WorkforceWebSearch status={tool.status} query={tool.searchQuery} sources={tool.searchSources} />
      </div>
    )
  }
  return (
    <div className={css.webSearchRow} data-message-id={messages[0]!.id}>
      <WebSearchBatch entries={messages.map(m => ({ id: m.id, status: m.tool?.status ?? 'done', query: m.tool?.searchQuery, sources: m.tool?.searchSources, error: m.error }))} />
    </div>
  )
}

/** 值按 JSON 签名保持稳定引用：轮询每次都换数组/对象引用的快照字段，
 *  以此供 memo props——内容没变就沿用旧引用，不触发下游重渲染。 */
function useJsonStable<T>(value: T): T {
  const ref = useRef<{ sig: string | undefined; value: T }>()
  const sig = JSON.stringify(value) as string | undefined
  const held = ref.current
  if (held === undefined || held.sig !== sig) {
    ref.current = { sig, value }
    return value
  }
  return held.value
}

/** 最新值 ref：回调经它转发，保持函数身份稳定（memo props 需要）。 */
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value)
  ref.current = value
  return ref
}

/** 数组逐项 === 等值：notices 这类每轮新建的数组只要元素引用不变就算相等。 */
function equalArray(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => x === b[i]))
}

/** 内容级等值：task/remembered 这类小对象按 JSON 内容比对，防止新引用误判变化。 */
function equalJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/** 引用条展示的 40 字摘要；找不到原文回退「原消息」。 */
function replySnippetOf(messagesById: ReadonlyMap<string, WorkforceMessage>, replyTo: string): string | undefined {
  const replied = messagesById.get(replyTo)
  if (replied?.text === undefined || replied.text === '') return undefined
  return replied.text.length > 40 ? `${replied.text.slice(0, 40)}…` : replied.text
}


function fmtTime(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return sameDay ? hm : `${date.getMonth() + 1}/${date.getDate()} ${hm}`
}

function fmtHm(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatErrorReason(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(/\binterrupted\b/gi, WF.taskStatus.taskInterrupted)
    .replace(/\btimeout\b/gi, WF.taskStatus.executionTimeout)
    .replace(/\bcancelled\b|\bcanceled\b/gi, WF.taskStatus.taskCancelled)
    .replace(/\baborted\b|\babort\b/gi, WF.taskStatus.executionAborted)
    .replace(/执行停止：\s*/g, WF.taskStatus.executionStopped)
}
function isStoppedReason(raw: string): boolean {
  return /^\s*(?:执行(?:已)?停止[：:]\s*)?(?:aborted|abort|cancelled|canceled|执行已中止|任务已取消|已停止)\s*$/i.test(raw)
}
/** 任务页脚：单行辅助状态（执行中带停止；已停止浅红）与成果卡片；token 用量与技能沉淀不在此展示。 */
function TaskFooter({ task, employees, source, quiet = false, onSelectContinuation, isCurrentContinuation }: {
  readonly task: Task
  readonly employees: readonly Employee[]
  readonly source: WorkforceSource
  /** 任务已停止且本轮没有可见回复。 */
  readonly quiet?: boolean
  readonly onSelectContinuation?: ((task: Task) => void) | undefined
  readonly isCurrentContinuation?: boolean | undefined
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const cancel = async (): Promise<void> => {
    setBusy(true); setError(undefined)
    try { await source.cancelTask(task.id) } catch (error) { setError(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  const stopped = task.status === 'cancelled' || task.status === 'interrupted'
  // 输入框顶部的模式切换已经说明当前接着哪个任务，这里只给其他任务一个「接着」入口。
  const continueButton = onSelectContinuation && !isCurrentContinuation ? (
    <LobeButton type="text" className={css.taskContinue ?? ''} onClick={() => onSelectContinuation(task)} title={WF.taskStatus.continueTitle}>
      {WF.taskStatus.continueTask}
    </LobeButton>
  ) : null
  return <div className={css.msgFooter} data-message-footer data-task-id={task.id}>
    {task.deliverables.length > 0 && <DeliverableChips task={task} employees={employees} source={source} />}
    {task.status === 'running' && <div className={css.taskActions}>
      <span className={css.taskStatus} data-state={task.status}>{WF.employee.running}</span>
      <LobeButton className={css.taskCancel ?? ''} disabled={busy} loading={busy} onClick={() => void cancel()}>{busy ? WF.employee.cancelling : WF.employee.cancel}</LobeButton>
    </div>}
    {stopped && <div className={css.taskActions}>
      <span className={css.taskStatus} data-state={task.status}>{WF.taskStatus.stopped(quiet)}</span>
      {continueButton}
    </div>}
    {task.status === 'failed' && <div className={css.taskActions}>
      <span className={css.taskStatus} data-state="failed">✕ {WF.employee.failed}</span>
      {continueButton}
    </div>}
    {task.status !== 'running' && !stopped && task.status !== 'failed' && continueButton && (
      <div className={css.taskActions}>{continueButton}</div>
    )}
    {error && <span className={css.msgFailed} role="alert">{formatErrorReason(error)}</span>}
  </div>
}

function humanizeToolActivity(toolName: string): string {
  switch (toolName) {
    case 'wb_delegate_employee': return WF.toolActivity.delegate
    case 'wb_create_employee': return WF.toolActivity.createEmployee
    case 'wb_read_material': return WF.toolActivity.readMaterial
    case 'wb_read_deliverable': return WF.toolActivity.readDeliverable
    case 'wb_save_deliverable': return WF.toolActivity.saveDeliverable
    case 'wb_publish_deliverable': return WF.toolActivity.publishDeliverable
    case 'wb_save_skill_draft': return WF.toolActivity.saveSkillDraft
    case 'wb_install_skill_draft': return WF.toolActivity.installSkillDraft
    case 'wb_remember': return WF.toolActivity.remember
    case 'wb_forget': return WF.toolActivity.forget
    case 'wb_recall': return WF.toolActivity.recall
    case 'wb_check_arithmetic': return WF.toolActivity.checkArithmetic
    case 'web_search': return WF.toolActivity.webSearch
    default: return WF.skeleton.tool(toolName)
  }
}

function StepsRow({ steps, onToggle }: { readonly steps: readonly WorkforceMessage[]; readonly onToggle: () => void }) {
  const [open, setOpen] = useState(false)
  const hasRunning = steps.some(s => s.running === true || s.tool?.status === 'running')
  const hasError = steps.some(s => s.error !== undefined || s.tool?.status === 'error')
  const state: 'running' | 'error' | 'done' = hasRunning ? 'running' : hasError ? 'error' : 'done'
  const stateIcon = state === 'running' ? '⏳' : state === 'error' ? '✕' : '✓'
  const toggle = (): void => { onToggle(); setOpen(value => !value) }

  return (
    <div className={css.stepsRow}>
      <Button variant="plain"
        type="button"
        className={css.stepsToggle}
        aria-expanded={open}
        onClick={toggle}
      >
        <span className={css.stepsStateIcon} data-state={state} aria-hidden="true">{stateIcon}</span>
        <span className={css.stepsTitle}>
          {hasRunning ? WF.steps.running(steps.length) : WF.steps.summary(steps.length)}
        </span>
        <span className={css.stepsArrow} aria-hidden="true">{open ? '▾' : '▸'}</span>
      </Button>
      {open && (
        <div className={css.stepsDetail}>
          {steps.map((step, idx) => {
            const stepState = step.tool?.status ?? (step.running ? 'running' : step.error ? 'error' : 'done')
            const stepLabel = step.tool !== undefined
              ? `${WF.employee.tool} · ${step.tool.name}`
              : `${WF.steps.thought} #${idx + 1}`
            return (
              <div key={step.id} className={css.stepItem}>
                <div className={css.stepItemHead}>
                  <span className={css.stepsStateIcon} data-state={stepState}>
                    {stepState === 'running' ? '⏳' : stepState === 'error' ? '✕' : '✓'}
                  </span>
                  <span>{step.tool ? WF.employee.tool : stepLabel}</span>
                </div>
                {step.text ? <div className={css.stepItemText}>{step.text}</div> : null}
              </div>
            )
          })}
        </div>
      )}
      {open && <Button variant="plain" type="button" className={css.stepsCollapse} onClick={toggle}>{WF.steps.collapseSteps}</Button>}
    </div>
  )
}

/** 接收方的回复状态占位（思考时不渲染卡片与正在思考文字，仅保留头像动画与名字）。 */
function SkeletonBubble({
  employee,
  employees,
  activity,
  task,
  source,
}: {
  readonly employee: Employee
  readonly employees: readonly Employee[]
  readonly activity?: WorkforceActivity | undefined
  readonly task?: Task | undefined
  readonly source: WorkforceSource
}) {
  const name = employee.name
  const [woken, setWoken] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setWoken(true), 1000)
    return () => clearTimeout(timer)
  }, [])

  let avatarMotionState: AvatarMotionState = 'listening'
  let statusText: string = WF.skeleton.processing
  let showStatusText = false
  if (activity?.state === 'tool') {
    avatarMotionState = 'searching'
    statusText = activity.tool ? humanizeToolActivity(activity.tool) : WF.skeleton.processing
    showStatusText = true
  } else if (activity?.state === 'thinking') {
    avatarMotionState = 'thinking'
    statusText = WF.skeleton.thinking
    showStatusText = false
  } else if (activity?.state === 'typing') {
    avatarMotionState = 'working'
    statusText = WF.skeleton.typing
    showStatusText = false
  } else if (!woken) {
    avatarMotionState = 'waking'
    statusText = WF.taskStatus.wakingEmployee
    showStatusText = true
  } else {
    avatarMotionState = 'listening'
    statusText = WF.taskStatus.taskReceivedWaiting
    showStatusText = true
  }

  return (
    <div className={css.msg} data-msg-role="agent" data-skeleton="true" aria-live="polite" aria-label={statusText}>
      <WorkforceAvatar
        name={name}
        isUser={false}
        color={employee.avatarColor}
        role={employee.role}
        state={avatarMotionState}
        activityState={avatarMotionState}
        live={true}
        size={36}
      />
      <div className={css.msgBody}>
        <div className={css.msgHead}>
          <span className={css.msgName}>{name}</span>
          {showStatusText && <span className={css.skeletonStatusInline}>{statusText}</span>}
        </div>
        {task && <TaskFooter task={task} employees={employees} source={source} />}
      </div>
    </div>
  )
}

interface PendingSend {
  readonly threadId: string
  readonly recipientIds: readonly string[]
}

function pendingSendFor(messages: readonly WorkforceMessage[]): PendingSend | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'user') continue
    return (message.delivery === 'sending' || message.delivery === 'waiting') && (message.recipientIds?.length ?? 0) > 0
      ? { threadId: message.threadId, recipientIds: message.recipientIds ?? [] }
      : undefined
  }
  return undefined
}

/** 群内默认收件人（与宿主 sendToThread 同口径）：成员内负责人→首个成员；
 *  memberIds 未配置=全局负责人，明确空名单→undefined（不伪造群外收件人）。 */
function channelDefaultRecipient(channels: readonly { readonly id: string }[], employees: readonly Employee[], channelId: string | undefined): Employee | undefined {
  const memberIds = (channels.find(channel => channel.id === channelId) as HostChannel | undefined)?.memberIds
  if (memberIds === undefined) return employees.find(employee => employee.isLeader)
  const members = memberIds
    .map(id => employees.find(employee => employee.id === id))
    .filter((employee): employee is Employee => employee !== undefined)
  return members.find(employee => employee.isLeader) ?? members[0]
}

function hasAgentReplyToLatestUserMessage(
  messages: readonly WorkforceMessage[],
  employeeId?: string,
): boolean {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx === -1) return false
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === 'agent') {
      if (employeeId && m.senderId !== employeeId) continue
      // running 草稿已代表这条回复开始增量展示，旁边不再补「正在输入」骨架。
      if (m.intermediate !== true && m.tool === undefined && (m.running === true || m.text.trim() !== '')) {
        return true
      }
    }
  }
  return false
}

interface SkeletonItem {
  readonly threadId: string
  readonly employee: Employee
  readonly activity?: WorkforceActivity | undefined
}

function resolveSkeletons({
  employees,
  threadId,
  pendingReplies,
  messages,
  activities,
  threadStatus,
  pendingSend,
  fallbackRecipient,
}: {
  readonly employees: readonly Employee[]
  readonly threadId: string
  readonly pendingReplies: readonly PendingReply[]
  readonly messages: readonly WorkforceMessage[]
  readonly activities: readonly WorkforceActivity[]
  readonly threadStatus: string | undefined
  readonly pendingSend: PendingSend | undefined
  readonly fallbackRecipient: Employee | undefined
}): readonly SkeletonItem[] {
  const waiting = pendingReplies.filter(pending => pending.threadId === threadId)
  const items: SkeletonItem[] = waiting.flatMap(pending => {
    const employee = employees.find(item => item.id === pending.employeeId)
    return employee ? [{ threadId, employee, activity: activities.find(item => item.employeeId === employee.id) }] : []
  })
  if (activities.length > 0) {
    const seen = new Set(items.map(item => item.employee.id))
    for (const act of activities) {
      if (seen.has(act.employeeId)) continue
      seen.add(act.employeeId)
      const emp = employees.find(e => e.id === act.employeeId)
      if (emp && !hasAgentReplyToLatestUserMessage(messages, emp.id)) {
        items.push({ threadId, employee: emp, activity: act })
      }
    }
  }
  if (items.length > 0) return items

  const isPending = pendingSend !== undefined
  const isRunning = threadStatus === 'running'
  if (isPending || isRunning) {
    // 每位收件人一条骨架；已给出可见回复的收件人不再挂骨架。投递完成后仍按最近一条人类消息的收件人算，
    // 单独 @ 某位员工时不回落到任务负责人。
    let latestUser: WorkforceMessage | undefined
    for (let index = messages.length - 1; index >= 0 && latestUser === undefined; index--) {
      if (messages[index]!.role === 'user') latestUser = messages[index]
    }
    const mentioned = (pendingSend?.recipientIds ?? latestUser?.recipientIds ?? [])
      .map(id => employees.find(employee => employee.id === id))
      .filter((employee): employee is Employee => employee !== undefined)
    // 收件人不详而这一轮已有员工开口（正在输入或已回复），说明负责人不是这一轮的接收方，不再补负责人骨架。
    if (mentioned.length === 0 && hasAgentReplyToLatestUserMessage(messages)) return []
    const targets = (mentioned.length > 0 ? mentioned : fallbackRecipient === undefined ? [] : [fallbackRecipient])
      .filter(employee => !hasAgentReplyToLatestUserMessage(messages, employee.id))
    if (targets.length > 0) return targets.map(employee => ({ threadId, employee }))
  }

  return []
}

type RenderItem =
  | { readonly kind: 'message'; readonly message: WorkforceMessage; readonly notices: WorkforceMessage[]; readonly remembered?: RememberedMemory }
  | { readonly kind: 'steps'; readonly id: string; readonly threadId: string; readonly turnId: string | undefined; readonly steps: readonly WorkforceMessage[]; readonly websearches: readonly WorkforceMessage[]; readonly notices: WorkforceMessage[] }
  /** web_search 工具消息：披露块独立成行，不进 steps 聚合，showSteps 关也显示；同 turn 多条合并一行批量披露。 */
  | { readonly kind: 'websearch'; readonly id: string; readonly threadId: string; readonly turnId: string | undefined; readonly messages: readonly WorkforceMessage[]; readonly notices: WorkforceMessage[] }
  | { readonly kind: 'notice'; readonly id: string; readonly notices: WorkforceMessage[] }
  | { readonly kind: 'tip'; readonly id: string; readonly text: string }

function processMessagesForDisplay(
  messages: readonly WorkforceMessage[],
  showSteps: boolean,
): readonly RenderItem[] {
  const items: RenderItem[] = []
  let currentSteps: WorkforceMessage[] = []
  let currentWebsearches: WorkforceMessage[] = []
  let currentTurnId: string | undefined

  const flush = () => {
    if (currentSteps.length === 0 && currentWebsearches.length === 0) return
    const first = (currentSteps[0] ?? currentWebsearches[0])!
    if (currentSteps.length > 0) {
      // steps 组带上同 turn 的搜索披露（渲染在折叠行旁），web_search 本身不进 steps 列表。
      items.push({
        kind: 'steps',
        id: `steps-${first.id}`,
        threadId: first.threadId,
        turnId: first.turnId,
        steps: [...currentSteps],
        websearches: [...currentWebsearches],
        notices: [],
      })
    } else {
      // 没有可见步骤（如 showSteps 关闭）：搜索披露独立成行，同 turn 合并一行。
      items.push({ kind: 'websearch', id: `websearch-${first.id}`, threadId: first.threadId, turnId: first.turnId, messages: [...currentWebsearches], notices: [] })
    }
    currentSteps = []
    currentWebsearches = []
    currentTurnId = undefined
  }

  // system 行（中断/执行失败）不画成消息气泡：挂到同 turnId 的最后条目下，
  // turnId 对不上时退到该员工最近一条消息，再挂不上才独立成行。
  const attach = (notice: WorkforceMessage): void => {
    let fallback: Extract<RenderItem, { kind: 'message' }> | undefined
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!
      if (item.kind === 'notice' || item.kind === 'tip') continue
      const itemThreadId = item.kind === 'message' ? item.message.threadId : item.threadId
      if (itemThreadId !== notice.threadId) continue
      const itemTurnId = item.kind === 'message' ? item.message.turnId : item.turnId
      if (notice.turnId !== undefined && itemTurnId === notice.turnId) {
        item.notices.push(notice)
        return
      }
      if (fallback === undefined && item.kind === 'message' && item.message.senderId === notice.senderId) fallback = item
    }
    if (fallback !== undefined) {
      fallback.notices.push(notice)
      return
    }
    items.push({ kind: 'notice', id: `notice-${notice.id}`, notices: [notice] })
  }

  for (const message of messages) {
    // 负责人核对后无需补充时只输出约定标记，宿主落盘后不再投影；流式草稿阶段同样不出气泡。
    if (message.role === 'agent' && isLeaderNoReplyDraft(message)) continue
    if (message.role === 'system') {
      // tip 行（如「已中断 · 回复可继续」）不是聊天内容：居中纯文本，无状态、不挂载到任何消息。
      if (message.tip === true) {
        flush()
        items.push({ kind: 'tip', id: message.id, text: message.text })
        continue
      }
      // 停止类系统提醒不进消息流：停止状态已由任务页脚单行呈现，重复展示只会造成恐慌。
      if (isStoppedReason(message.error ?? message.text)) continue
      flush()
        attach(message)
      continue
    }
    if (message.tool?.name === 'wb_run_agent') { flush(); items.push({ kind: 'message', message: agentRunMessage(message), notices: [] }); continue }; const remembered = readRememberedMemory(message)
    if (remembered !== undefined) {
      flush()
      items.push({ kind: 'message', message, notices: [], remembered })
      continue
    }
    // 联网搜索不进 steps 列表：与同 turn 的步骤共属一组（披露块渲染在折叠行旁），
    // showSteps 关闭时 flush 落成独立披露行，两种偏好下都展示。
    const turn = message.turnId ?? message.threadId
    const continuing = (currentSteps.length > 0 || currentWebsearches.length > 0) && currentTurnId === turn
    if (message.tool?.name === 'web_search') {
      if (!continuing) { flush(); currentTurnId = turn }
      currentWebsearches.push(message)
      continue
    }
    const isStep = showSteps && (message.tool !== undefined || message.intermediate === true)
    if (isStep) {
      if (continuing) {
        currentSteps.push(message)
      } else {
        flush()
        currentTurnId = turn
        currentSteps.push(message)
      }
    } else {
      if (message.tool !== undefined || message.intermediate === true) continue
      flush()
      items.push({ kind: 'message', message, notices: [] })
    }
  }
  flush()
  return items
}

function skeletonKey(item: SkeletonItem): string {
  return `skeleton:${item.threadId}:${item.employee.id}`
}

/** Finished tasks belong to the owner's last visible reply, never to a human row. */
function taskFooterTargets(tasks: readonly Task[], items: readonly RenderItem[], skeletons: readonly SkeletonItem[]): ReadonlyMap<string, Task> {
  const targets = new Map<string, Task>()
  for (const task of tasks) {
    if (task.status === 'running') {
      const skeleton = skeletons.find(item => item.threadId === task.threadId && item.employee.id === task.assigneeId)
        ?? skeletons.find(item => item.threadId === task.threadId)
      if (skeleton) { targets.set(skeletonKey(skeleton), task); continue }
    }
    let target: string | undefined
    // 优先：该任务对应 thread 中负责人的最后一条可见回复
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!
      if (item.kind !== 'message') continue
      const message = item.message
      if (message.threadId === task.threadId && message.role === 'agent' && message.tool === undefined
        && message.intermediate !== true && message.question === undefined && message.approval === undefined
        && (message.text.trim() !== '' || message.error !== undefined)) {
        target = message.id
        break
      }
    }
    // 兜底：若该 thread 尚无 agent 回复，挂在用户发起任务的那条根消息下
    if (!target) {
      for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index]!
        if (item.kind === 'message' && item.message.threadId === task.threadId) {
          target = item.message.id
          break
        }
      }
    }
    // 仅当找到对话上下文中的消息时挂载，绝不堆在消息流底部作为孤立状态
    if (target) {
      targets.set(target, task)
    }
  }
  return targets
}

/** 消息区滚动模型：滚动容器 `flex-direction: column-reverse`，滚动原点在底部（scrollTop=0 即最新，
 *  上滑为负）。由浏览器原生完成三件事，不再用 JS 追底：
 *  - 打开会话直接停在最新消息，无「先渲染再滚到底」的跳动；
 *  - 贴底时新消息/流式增长自动保持贴底；
 *  - 上滑阅读时，顶部插入历史、底部来新消息、行内高度变化都由 overflow-anchor 锚住视口。
 *  容器必须保持 overflow-anchor: auto（禁锚定会让上滑阅读时底部增长把视口顶走）。
 *  初始只渲染最新 RENDER_PAGE 条；读者滚到顶端附近再扩一页，窗口耗尽才向宿主拉更早分页。
 *  内容不足一屏时同样会补，直到填满或没有更早历史。 */
const RENDER_PAGE = 24
/** 距顶端多少像素内触发「展开/补载更早」的下限；实际按视口高度度量（见 revealDistance）。 */
const TOP_REVEAL_PX = 320
/** 距底部多少像素内算「在看最新」：新消息不提示、自动跟随。 */
const BOTTOM_STICK_PX = 120

/** 历史补页操作的输入：自动/手动两条路径各自的许可，以及补一页的动作。 */
interface EarlierRequest {
  /** 滚动近顶自动补页许可：有 hasMore、无在途、无错误，避免滚动触发重试风暴。 */
  readonly canFetch: boolean
  /** 手动点按许可：还有更早页可拉（含错误页重试）。 */
  readonly canRequest: boolean
  readonly request: () => Promise<boolean>
}

const renderItemKey = (item: RenderItem): string => item.kind === 'message' ? item.message.id : item.id
const renderItemTs = (item: RenderItem): string | undefined => item.kind === 'message' ? item.message.ts
  : item.kind === 'websearch' ? item.messages[0]?.ts
  : item.kind === 'steps' ? item.steps[0]?.ts : item.kind === 'notice' ? item.notices[0]?.ts : undefined
const distanceFromBottom = (node: HTMLElement): number => Math.abs(node.scrollTop)
const distanceFromTop = (node: HTMLElement): number => node.scrollHeight - node.clientHeight - Math.abs(node.scrollTop)
/** 近顶触发距离按视口高度度量：内容补到约 1.8 屏（视口 + 0.8 倍视口）才停手；上滑快到顶时提前预取。 */
const revealDistance = (node: HTMLElement): number => Math.max(TOP_REVEAL_PX, node.clientHeight * 0.8)

function useMessageScroll(scope: string, messages: readonly WorkforceMessage[], items: readonly RenderItem[], earlier: EarlierRequest, keyboardDefer?: () => boolean) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // 窗口按 scope 记：切换会话即回到最新一页，不经过一次旧窗口的渲染。
  // 读者扩过窗后用最旧一行的 key 钉住窗口起点：底部来新消息不会把顶部的行挤出 DOM；
  // 未扩窗时按条数从底部数（跟随最新，DOM 不随会话变长而增长）。
  // 起点行的 key 可能变（steps 组并入更早步骤、local/live 行换成落盘 id），按起点时间回退到插入位。
  const [windowState, setWindowState] = useState<{ scope: string; startKey?: string; startTs?: string; count: number }>({ scope, count: RENDER_PAGE })
  const windowNow = windowState.scope === scope ? windowState : { scope, count: RENDER_PAGE }
  const startIndex = windowNow.startKey === undefined ? -1 : (() => {
    const exact = items.findIndex(item => renderItemKey(item) === windowNow.startKey)
    if (exact >= 0 || windowNow.startTs === undefined) return exact
    return items.findIndex(item => (renderItemTs(item) ?? '') >= windowNow.startTs!)
  })()
  const hidden = startIndex >= 0 ? startIndex : Math.max(0, items.length - windowNow.count)
  const renderLimit = items.length - hidden
  const [hasNewMessages, setHasNewMessages] = useState(false)
  const fetchingEarlier = useRef(false)
  const lastSeen = useRef<{ scope: string; id: string | undefined; text: string | undefined }>()
  const stateRef = useLatest({ scope, renderLimit, total: items.length, items, earlier })

  const growWindow = (count: number): void => {
    const { scope: current, items: list } = stateRef.current
    const start = Math.max(0, list.length - count)
    const first = list[start]
    const startTs = first === undefined ? undefined : renderItemTs(first)
    setWindowState({ scope: current, count: list.length - start, ...(first !== undefined ? { startKey: renderItemKey(first) } : {}), ...(startTs !== undefined ? { startTs } : {}) })
  }
  /** 一轮并行请求全部零新增（历史页没长且没有新页可加载）才置 stalled 停手；任一路有新增就继续补，
   *  直到填满触发距离或供给耗尽。读者再滚动或切换会话即复位。 */
  const stalled = useRef(false)
  const fetchEarlier = async (): Promise<void> => {
    if (fetchingEarlier.current) return
    fetchingEarlier.current = true
    try { if (!await stateRef.current.earlier.request()) stalled.current = true } finally {
      fetchingEarlier.current = false
      // 请求落地引发的那次提交可能仍带着在途标志被复核跳过（publish→commit 先于 finally），
      // 清标志后主动复核一次近顶，补载节奏不再被 2s 轮询对齐。
      const node = scrollRef.current
      if (node && node.clientHeight > 0 && !stalled.current && distanceFromTop(node) <= revealDistance(node)) revealEarlier()
    }
  }
  /** 近顶自动补一段：窗口内还有未渲染先扩窗，耗尽才按许可向历史分页。 */
  const revealEarlier = (): void => {
    const { renderLimit: limit, total, earlier: request } = stateRef.current
    if (total > limit) growWindow(limit + RENDER_PAGE)
    else if (request.canFetch && !stalled.current) void fetchEarlier()
  }
  /** 手动「加载更早」：同样先扩窗；耗尽后无论错误态都可补页（即错误重试入口）。 */
  const requestEarlier = (): void => {
    const { renderLimit: limit, total, earlier: request } = stateRef.current
    if (total > limit) growWindow(limit + RENDER_PAGE)
    else if (request.canRequest) void fetchEarlier()
  }
  /** 把目标消息纳入渲染窗口（扩窗才返回 true；找不到或已在窗口内返回 false）。 */
  const revealMessage = (messageId: string): boolean => {
    const index = items.findIndex(item => item.kind === 'message' && item.message.id === messageId)
    if (index < 0) return false
    const needed = items.length - index + 8
    if (needed <= renderLimit) return false
    growWindow(needed)
    return true
  }
  const jumpToBottom = (): void => {
    const node = scrollRef.current
    if (node) node.scrollTop = 0
    setHasNewMessages(false)
  }
  /** 展开执行步骤等读者操作：原生锚定已保证视口稳定，保留入口给调用方。 */
  const pauseFollowing = (): void => {}

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (node) {
      node.scrollTop = 0
      // 切面即聚焦滚动容器（不可聚焦元素收不到浏览器键滚），键盘翻页无需先点进消息区。
      node.focus({ preventScroll: true })
    }
    setHasNewMessages(false)
    fetchingEarlier.current = false
    stalled.current = false
  }, [scope])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const nearTop = (): void => { if (node.clientHeight > 0 && distanceFromTop(node) <= revealDistance(node)) revealEarlier() }
    const onScroll = (): void => {
      if (distanceFromBottom(node) <= BOTTOM_STICK_PX) setHasNewMessages(false)
      stalled.current = false
      nearTop()
    }
    // 容器尺寸变化（窗口拉高、面板开合）也可能让顶端进入触发区。
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(nearTop)
    observer?.observe(node)
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => { node.removeEventListener('scroll', onScroll); observer?.disconnect() }
  }, [scope])

  // 键盘翻页：滚动容器不聚焦时浏览器 PageUp/PageDown/Space 落在外层文档上滚不动这里；
  // 切面已自动聚焦容器，此处兜住焦点在侧栏等非输入元素上的情况。column-reverse 里 scrollTop=0 是底部，向历史为负。
  const deferRef = useLatest(keyboardDefer)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      if (deferRef.current?.()) return
      const node = scrollRef.current
      if (!node || node.clientWidth === 0) return
      const target = event.target instanceof HTMLElement ? event.target : document.body
      // 输入控件与其激活键（Space 点按钮）不接管；焦点在宿主其他区域也不抢。
      if (target !== document.body && target !== node) {
        if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
        if (target.closest('button, a, [role="button"]')) return
        const root = node.closest('[data-workforce-root]')
        if (!(root && root.contains(target))) return
      }
      const page = node.clientHeight * 0.9
      if (event.key === 'PageUp') node.scrollTop -= page
      else if (event.key === 'PageDown') node.scrollTop += page
      else if (event.key === ' ') node.scrollTop += event.shiftKey ? -page : page
      else if (event.key === 'Home') {
        node.scrollTop = -(node.scrollHeight - node.clientHeight)
        // 顶到头后窗口在上方增长会把顶边推出近顶触发区，Home 额外主动补一段。
        revealEarlier()
      }
      else if (event.key === 'End') node.scrollTop = 0
      else return
      event.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [scope, deferRef])

  // 每次提交后复核：顶端仍在触发区（内容不足目标屏数，或刚补完仍未填满）就继续补，直到填满或没有更早历史。
  // 容器不可见（clientHeight=0）时不补，否则隐藏的消息区会在轮询中把历史一页页拉完。
  useEffect(() => {
    const node = scrollRef.current
    if (!node || fetchingEarlier.current || node.clientHeight === 0) return
    if (distanceFromTop(node) <= revealDistance(node)) revealEarlier()
  })

  // 读者离开底部时来了新的正文（新消息或末条文本变化）：提示「有新消息」。
  // 用户自己刚发出的消息例外：直接回到底部，发出去的话要看得见。
  useEffect(() => {
    const last = [...messages].reverse().find(message => message.tool === undefined && message.intermediate !== true)
    const seen = lastSeen.current
    lastSeen.current = { scope, id: last?.id, text: last?.text }
    if (seen === undefined || seen.scope !== scope || last === undefined) return
    if (seen.id === last.id && seen.text === last.text) return
    const node = scrollRef.current
    if (!node || distanceFromBottom(node) <= BOTTOM_STICK_PX) return
    if (last.role === 'user' && last.delivery !== undefined) jumpToBottom()
    else setHasNewMessages(true)
  }, [scope, messages])

  return { scrollRef, contentRef, hasNewMessages, jumpToBottom, revealEarlier, requestEarlier, revealMessage, pauseFollowing, hidden }
}

/** 引用跳转高亮 class（CSS module 哈希名）；缺失时跳转仍可用，只是不高亮。 */
const REPLY_FLASH_CLASS = css['replyFlash'] ?? ''

/**
 * 引用跳转：按显式 replyTo 真实父消息 id 定位滚动容器内的 [data-message-id]。
 * 未命中时逐页向历史方向补载（限定父消息所在 thread），每页等 React 提交后
 * 重新查找，直到命中或确认没有更早历史；仍找不到才给 missing 提示，不做
 * 相似文本错跳。命中后滚动居中并短暂高亮；切换 surface / 面板关闭 / 再次
 * 点击时，迟到的跳转与旧高亮作废。reduced-motion 下即时滚动、高亮静态描边。
 */
function useReplyJump({ scrollRef, scope, source, revealItem, extendHistory }: {
  readonly scrollRef: { readonly current: HTMLDivElement | null }
  /** 当前上下文标识（channel:id / dm:threadId / thread:threadId），变化即作废在途跳转。 */
  readonly scope: string
  readonly source: WorkforceSource
  /** 目标已加载但在渲染窗口外时先扩窗；返回 true 表示本次触发了扩窗。 */
  readonly revealItem?: ((messageId: string) => boolean) | undefined
  /** 频道流：目标已在所属 thread 加载、却在连续下界之下时，补卡住下界的 thread（见 channelStream）。返回是否补到新消息。 */
  readonly extendHistory?: (() => Promise<boolean>) | undefined
}) {
  const [notice, setNotice] = useState<string>()
  const seq = useRef(0)
  const mounted = useRef(true)
  const scopeRef = useRef(scope)
  const flashed = useRef<HTMLElement>()
  const flashTimer = useRef<number>()
  const noticeTimer = useRef<number>()
  const revealItemRef = useLatest(revealItem)
  const extendHistoryRef = useLatest(extendHistory)

  useEffect(() => {
    scopeRef.current = scope
    seq.current += 1
    setNotice(undefined)
    if (noticeTimer.current) { window.clearTimeout(noticeTimer.current); noticeTimer.current = undefined }
    if (flashTimer.current) { window.clearTimeout(flashTimer.current); flashTimer.current = undefined }
    if (REPLY_FLASH_CLASS !== '') flashed.current?.classList.remove(REPLY_FLASH_CLASS)
    flashed.current = undefined
  }, [scope])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      seq.current += 1
      if (flashTimer.current) window.clearTimeout(flashTimer.current)
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
      if (REPLY_FLASH_CLASS !== '') flashed.current?.classList.remove(REPLY_FLASH_CLASS)
      flashed.current = undefined
    }
  }, [])

  const jumpTo = useCallback(async (messageId: string, threadId: string): Promise<void> => {
    const mySeq = ++seq.current
    const myScope = scopeRef.current
    const alive = (): boolean => mounted.current && seq.current === mySeq && scopeRef.current === myScope
    setNotice(undefined)
    if (noticeTimer.current) { window.clearTimeout(noticeTimer.current); noticeTimer.current = undefined }
    if (flashTimer.current) { window.clearTimeout(flashTimer.current); flashTimer.current = undefined }
    if (REPLY_FLASH_CLASS !== '') flashed.current?.classList.remove(REPLY_FLASH_CLASS)
    flashed.current = undefined

    const find = (): HTMLElement | undefined => Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])
      .find(node => node.dataset['messageId'] === messageId)

    const waitForCommit = async (): Promise<HTMLElement | undefined> => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const node = find()
        if (node) return node
        // 目标可能已加载但在渲染窗口外（含刚补到的更早页）：先扩窗再等提交。
        revealItemRef.current?.(messageId)
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        if (!alive()) return undefined
      }
      return find()
    }

    const waitForSettle = async (): Promise<void> => {
      for (let attempt = 0; attempt < 60; attempt++) {
        if (!alive()) return
        const p = source.getSnapshot().messages[threadId]
        if (!p?.loadingEarlier) break
        await new Promise<void>(resolve => window.setTimeout(resolve, 50))
      }
    }

    let node = find()
    if (node === undefined) {
      // 已加载但未渲染（窗口外）的目标先扩窗命中，不急着向历史分页。
      revealItemRef.current?.(messageId)
      node = await waitForCommit()
    }
    let loadCount = 0
    let lastError: string | undefined
    let hitLimit = false

    while (node === undefined) {
      if (!alive()) return
      const page = source.getSnapshot().messages[threadId]

      // 若当前正在加载更早历史，等待其 settle 与 React 提交，绝不提前报 missing
      if (page?.loadingEarlier) {
        await waitForSettle()
        if (!alive()) return
        node = await waitForCommit()
        if (node || !alive()) break
        continue
      }

      // 若上一次加载出错且未重试，尝试一次重新拉取
      if (page?.earlierError && lastError === undefined) {
        lastError = page.earlierError
        const retried = await source.loadEarlierMessages(threadId)
        if (!alive()) return
        if (retried) {
          lastError = undefined
          loadCount += 1
          node = await waitForCommit()
          if (node || !alive()) break
          continue
        } else {
          break
        }
      }

      // 频道流：目标已加载但被连续下界滤掉，补的是卡住下界的 thread，不是目标 thread。
      const extend = extendHistoryRef.current
      if (extend !== undefined && page?.list.some(message => message.id === messageId)) {
        if (loadCount >= 100) { hitLimit = true; break }
        const extended = await extend()
        if (!alive()) return
        if (!extended) break
        loadCount += 1
        node = await waitForCommit()
        if (node || !alive()) break
        continue
      }

      // 真实耗尽
      if (page && !page.hasMore) {
        break
      }

      // 防循环保护（100 页）
      if (loadCount >= 100) {
        hitLimit = true
        break
      }

      const added = await source.loadEarlierMessages(threadId)
      if (!alive()) return
      if (!added) {
        const latestPage = source.getSnapshot().messages[threadId]
        if (latestPage?.earlierError) {
          lastError = latestPage.earlierError
        }
        break
      }
      loadCount += 1
      node = await waitForCommit()
      if (node || !alive()) break
    }

    if (!alive()) return

    if (node === undefined) {
      if (lastError !== undefined) {
        setNotice(WF.reply.loadFailed)
      } else if (hitLimit) {
        setNotice(WF.reply.tooDeep)
      } else {
        setNotice(WF.reply.missing)
      }
      noticeTimer.current = window.setTimeout(() => setNotice(undefined), 4000)
      return
    }

    const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    node.scrollIntoView({ block: 'center', ...(reduced ? {} : { behavior: 'smooth' as const }) })
    if (REPLY_FLASH_CLASS !== '') {
      node.classList.add(REPLY_FLASH_CLASS)
      flashed.current = node
      flashTimer.current = window.setTimeout(() => {
        node.classList.remove(REPLY_FLASH_CLASS)
        if (flashed.current === node) flashed.current = undefined
      }, 1800)
    }
  }, [scrollRef, source])
  return { jumpTo, notice }
}

/** 列表顶部「更早」入口：loading 只给顶部居中的小 spinner，失败给仅图标的重试按钮，无文字。
 *  onEarlier 由 useMessageScroll.revealEarlier 统一裁决走哪条路（扩窗优先，耗尽才分页）。 */
function EarlierMessages({ loading, errors, onEarlier }: {
  readonly loading: boolean
  readonly errors: readonly string[]
  readonly onEarlier: () => void
}) {
  // 容器不参与滚动锚定（见 .earlierRow）：它在新插入的历史行上方，被选为锚点会让补页后视口跳回顶端。
  if (errors.length > 0) return (
    <div className={css.earlierRow}>
      <LobeButton type="text" className={css.earlierRetry ?? ''} aria-label={WF.employee.older} title={WF.employee.older} onClick={onEarlier}>
        <IconRefreshOutlineRegular size={14} />
      </LobeButton>
    </div>
  )
  // 不加载时也保留这一行的高度，只隐藏 spinner：读者停在最顶时若整行卸载，内容会上跳一个行高。
  if (!loading) return <div className={css.earlierRow} aria-hidden="true"><span className={`${css.earlierSpinner} ${css.earlierSpinnerIdle}`} /></div>
  return <div className={css.earlierRow} aria-label={WF.employee.older}><span className={css.earlierSpinner} /></div>
}

/** 一条消息行。React.memo：流式期间未变化行零重渲染——props 全部传原始值或
 *  父级稳定引用（useJsonStable/useLatest 处理过的），自定义比较兜底内容等值对象。 */
const MessageRow = memo(function MessageRow({
  message,
  employees,
  onDm,
  openThreadId,
  onOpenThread,
  replyCount,
  repliedSnippet,
  working,
  activityState,
  isLatest,
  isConsecutive,
  source,
  task,
  taskQuiet,
  tasks,
  remembered,
  notices,
  onJumpToReply,
  resolveRetryTarget,
  onOpenKeyModal,
  onOpenModelsModal,
  onSelectContinuation,
  isCurrentContinuation,
}: {
  readonly message: WorkforceMessage
  /** 挂在本条消息下方的 system 短提醒（中断/执行失败），不画员工气泡。 */
  readonly notices?: readonly WorkforceMessage[] | undefined
  readonly employees: readonly Employee[]
  readonly onDm: (employeeId: string) => void
  /** 「N 条回复/查看任务」要打开的 thread；undefined = 本条不可打开线程。 */
  readonly openThreadId?: string | undefined
  readonly onOpenThread?: ((threadId: string) => void) | undefined
  readonly replyCount?: number | undefined
  /** 点击引用条跳转到被引用的父消息（真实 replyTo id + 所在 thread）。 */
  readonly onJumpToReply?: ((messageId: string, threadId: string) => void) | undefined
  /** 引用条 40 字摘要；父级按 replyTo 预算好，行内不持全量消息。 */
  readonly repliedSnippet?: string | undefined
  /** 发送者当前在活动集合里（不含 message.running 自身标记）。 */
  readonly working?: boolean | undefined
  readonly activityState?: WorkforceActivity['state'] | undefined
  readonly isLatest?: boolean | undefined
  readonly isConsecutive?: boolean | undefined
  readonly source: WorkforceSource
  readonly task?: Task | undefined
  /** 任务已终结且无交付、无后续可见回复——页脚弱化展示。 */
  readonly taskQuiet?: boolean | undefined
  readonly tasks: readonly Task[]
  readonly remembered?: RememberedMemory | undefined
  /** 提醒的重试目标查找（父级注入，行内不持全量消息列表）。 */
  readonly resolveRetryTarget: (notice: WorkforceMessage) => WorkforceMessage | undefined
  readonly onOpenKeyModal?: ((provider?: string) => void) | undefined
  readonly onOpenModelsModal?: (() => void) | undefined
  readonly onSelectContinuation?: ((task: Task) => void) | undefined
  readonly isCurrentContinuation?: boolean | undefined
}) {
  const isUser = message.role === 'user'
  const [prefs] = useWorkforcePrefs()
  const profile = useUserProfile()
  const name = isUser ? profile.name : message.senderName
  const emp = isUser ? undefined : employees.find(e => e.id === message.senderId)
  const isWorking = !isUser && (message.running === true || working === true)
  let resolvedState: AvatarMotionState = 'idle'
  if (!emp && !isUser) {
    resolvedState = 'sleeping'
  } else if (isWorking && activityState !== undefined) {
    if (activityState === 'tool') resolvedState = 'searching'
    else if (activityState === 'thinking') resolvedState = 'thinking'
    else if (activityState === 'typing') resolvedState = 'working'
  } else if (isWorking) {
    resolvedState = 'working'
  } else if (message.delivery === 'sending') {
    resolvedState = 'listening'
  }
  // 单条超长正文限高：阈值只有 tokens 里一份（--wb-message-clamp-height）；
  // 流式输出中不折叠，输出结束后按自然高度判定。
  const [expandedText, setExpandedText] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const clampRef = useRef<HTMLDivElement>(null)
  const streamFinished = message.running !== true && message.delivery !== 'sending'
  const clamped = overflowing && !expandedText && streamFinished
  const clampable = streamFinished && overflowing && message.tool === undefined
    && message.question === undefined && message.approval === undefined && message.intermediate !== true
  useEffect(() => {
    const node = clampRef.current
    if (node === null) return
    const measure = () => {
      const rawLimit = getComputedStyle(node).getPropertyValue('--wb-message-clamp-height').trim()
      let limit = 0
      if (rawLimit.endsWith('rem')) {
        const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
        limit = Number.parseFloat(rawLimit) * rootFontSize
      } else {
        limit = Number.parseFloat(rawLimit) || 0
      }
      if (limit <= 0) limit = 320
      setOverflowing(node.scrollHeight > limit + 1)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [message.text, message.running, message.delivery, expandedText])
  const [copied, setCopied] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const copyTimer = useRef<number>()
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])
  const canAct = message.role === 'agent' && message.tool === undefined && message.intermediate !== true
    && message.question === undefined && message.approval === undefined && message.text.trim() !== ''
  // D2：审批/提问卡的行没有文字正文——msgBubble 画空框，正文容器整体不渲染。
  const hasText = message.text.trim() !== ''
  // 成果卡固定在产出它的回复上，不随任务页脚移到后续消息或进行中的行。
  const deliverableNames = useMemo(() => messageDeliverableNames(message), [message])
  const deliverableTask = deliverableNames.size > 0 ? tasks.find(item => item.threadId === message.threadId) : undefined
  const messagePreview = useMemo(() => {
    if (message.extensionPreview) return message.extensionPreview
    if (message.tool || !message.text.trim().startsWith('{')) return undefined
    try { return readExtensionPreview(JSON.parse(message.text)) } catch { return undefined }
  }, [message.extensionPreview, message.tool, message.text])
  const copy = async (): Promise<void> => {
    setActionError(undefined)
    setCopied(false)
    if (!await writeClipboard(message.text)) { setActionError(WF.message.copyFailed); return }
    if (copyTimer.current) clearTimeout(copyTimer.current)
    setCopied(true)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600)
  }
  const regenerate = async (): Promise<void> => {
    if (regenerating) return
    setRegenerating(true); setActionError(undefined)
    try { await source.regenerateMessage(message.threadId, message.id, message.senderId) }
    catch (error) { setActionError(formatErrorReason(error instanceof Error ? error.message : String(error))) }
    finally { setRegenerating(false) }
  }
  if (remembered) return <div>
    <RememberedMemoryCard memory={remembered} />
    {notices !== undefined && notices.length > 0 && <div className={css.msgNoticeOrphan}><MessageNotices notices={notices} anchor={message} resolveRetryTarget={resolveRetryTarget} source={source} onOpenKeyModal={onOpenKeyModal} onOpenModelsModal={onOpenModelsModal} /></div>}
  </div>
  const actionBar = canAct ? (
    <div className={css.messageActions} role="group" aria-label={WF.message.actions}>
      <LobeButton type="text" title={copied ? WF.message.copied : WF.message.copy} aria-label={copied ? WF.message.copied : WF.message.copy} onClick={() => void copy()}>
        <svg viewBox="0 0 20 20" aria-hidden="true">{copied ? <path d="m4 10 4 4 8-9" /> : <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M12 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h2" /></>}</svg>
      </LobeButton>
      <LobeButton type="text" title={regenerating ? WF.message.regenerating : WF.message.regenerate} aria-label={regenerating ? WF.message.regenerating : WF.message.regenerate} disabled={regenerating || message.running === true} onClick={() => void regenerate()}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 7a6 6 0 1 0 0 6M16 3v4h-4" /></svg>
      </LobeButton>
      <LobeButton type="text" disabled title={WF.message.deleteReserved} aria-label={WF.message.deleteReserved}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6M12 8v6" /></svg>
      </LobeButton>
      <LobeButton type="text" disabled title={WF.message.collapseReserved} aria-label={WF.message.collapseReserved}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5-5 5 5M5 12l5 5 5-5" /></svg>
      </LobeButton>
    </div>
  ) : undefined
  return (
    <div className={`${css.msg} ${isConsecutive ? css.msgConsecutive : ''} ${message.running === true || message.delivery === 'sending' ? css.msgPending : ''}`} data-msg-role={message.role} data-message-id={message.id} data-delivery={message.delivery}>
      {isConsecutive ? (
        <div className={css.avatarPlaceholder}>
          <span className={css.consecutiveHoverTime}>{fmtHm(message.ts)}</span>
        </div>
      ) : (
        <WorkforceAvatar
          name={name}
          isUser={isUser}
          color={emp?.avatarColor}
          role={emp?.role}
          state={resolvedState}
          activityState={resolvedState}
          live={isLatest && (isWorking || message.delivery === 'sending')}
          size={36}
        />
      )}
      <div className={css.msgBody}>
        {!isConsecutive && !isUser && (
          <div className={css.msgHead}>
            <span className={css.msgName}>{name}</span>
          </div>
        )}
        {message.replyTo !== undefined && (
          onJumpToReply !== undefined ? (
            <Button variant="plain"
              type="button"
              className={css.replyQuote}
              title={WF.reply.jump}
              onClick={() => onJumpToReply(message.replyTo!, message.threadId)}
            >
              <span className={css.replyTarget}>@{profile.name}</span>
              <span className={css.replyDivider}>·</span>
              <span className={css.replySnippet}>
                {repliedSnippet ? `${WF.reply.quotePrefix}${repliedSnippet}` : WF.reply.original}
              </span>
            </Button>
          ) : (
            <div className={css.replyQuote} title={repliedSnippet ? WF.reply.quoteSnippet(repliedSnippet) : undefined}>
              <span className={css.replyTarget}>@{profile.name}</span>
              <span className={css.replyDivider}>·</span>
              <span className={css.replySnippet}>
                {repliedSnippet ? `${WF.reply.quotePrefix}${repliedSnippet}` : WF.reply.original}
              </span>
            </div>
          )
        )}
        {hasText && (
          <Bubble side={isUser ? 'self' : 'peer'} className={css.msgBubble} data-clamped={clamped || undefined}>
            <div className={css.msgClamp} ref={clampRef}>
              {(() => {
                const fallback = <WorkforceMessageText text={formatErrorReason(message.text)} employees={employees} onDm={onDm} tasks={tasks}
                  hasAttachments={message.attachments !== undefined && message.attachments.length > 0}
                  hasDeliverables={task !== undefined && task.deliverables.length > 0} />
                return messagePreview ? <WorkbenchExtensionPreview preview={messagePreview} fallback={fallback} /> : fallback
              })()}
            </div>
            {clampable && (
              <Button variant="plain" type="button" className={css.msgClampToggle} aria-expanded={!clamped} onClick={() => setExpandedText(value => !value)}>
                {clamped ? WF.message.expandFull : WF.message.collapseFull}
              </Button>
            )}
            {actionBar}
          </Bubble>
        )}
        {message.attachments !== undefined && message.attachments.length > 0 && (
          <AttachmentBar
            label={WF.attachments.currentRoundFiles}
            items={message.attachments.map(file => ({ url: file.url, locationUrl: file.locationUrl, name: file.name, sizeBytes: file.sizeBytes, mime: file.mime }))}
          />
        )}
        {deliverableTask !== undefined && (
          <DeliverableChips task={deliverableTask} employees={employees} source={source} only={deliverableNames} />
        )}
        {(message.question !== undefined || message.approval !== undefined) && (
          <WorkforceQuestionCard
            question={message.question}
            approval={message.approval}
            onAnswer={(requestId, payload) => source.answerAsk(message.threadId, requestId, payload, message.senderId)}
          />
        )}
        {notices !== undefined && notices.length > 0 && (
          <MessageNotices notices={notices} anchor={message} resolveRetryTarget={resolveRetryTarget} source={source} onOpenKeyModal={onOpenKeyModal} onOpenModelsModal={onOpenModelsModal} />
        )}
        {!hasText && actionBar}
        {actionError && <div className={css.msgFailed} role="alert">{actionError}</div>}
        {message.error && <div className={css.msgFailed} role="alert">{formatErrorReason(message.error)}</div>}
        {isUser ? (
          <div className={css.userMsgMeta}>
            {(replyCount ?? 0) > 0 ? (
              openThreadId !== undefined && onOpenThread !== undefined ? (
                <Button variant="plain" type="button" className={css.threadLink} onClick={() => onOpenThread(openThreadId)}>
                  {WF.thread.count(replyCount!)} →
                </Button>
              ) : (
                <span className={css.threadLink}>{WF.thread.count(replyCount!)}</span>
              )
            ) : (
              openThreadId !== undefined && onOpenThread !== undefined && (task !== undefined || tasks.some(t => t.threadId === message.threadId || t.id === message.threadId)) ? (
                <Button variant="plain" type="button" className={css.threadLink} onClick={() => onOpenThread(openThreadId)}>
                  {WF.thread.open}
                </Button>
              ) : null
            )}
            {message.reactions && message.reactions.length > 0 && (
              <div className={css.reactions}>
                {message.reactions.map((reaction, index) => {
                  const emp = employees.find(e => e.id === reaction.employeeId)
                  return (
                    <span
                      key={`${reaction.employeeId}-${reaction.emoji}-${index}`}
                      className={css.reactionPill}
                      title={emp ? `${emp.name} ${reaction.emoji}` : reaction.emoji}
                    >
                      <span className={css.reactionEmoji}>{reaction.emoji}</span>
                      {emp !== undefined && <span className={css.reactionWho}>{emp.name}</span>}
                    </span>
                  )
                })}
              </div>
            )}
            <span className={css.userMsgTime}>{fmtTime(message.ts)}</span>
          </div>
        ) : (
          <div className={css.botMsgMeta}>
            <span className={css.botMsgTime}>{fmtTime(message.ts)}</span>
            {message.usage && prefs.showTokenStats !== false && (() => {
              const u = message.usage
              const cached = u.cacheReadTokens ?? 0
              const uncached = u.inputTokens
              const totalIn = cached + uncached
              const hitRate = totalIn > 0 && cached > 0 ? Math.round((cached / totalIn) * 100) : 0
              const formatK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
              return (
                <span className={css.tokenHitBadge} title={WF.canvas.cacheTitle(totalIn, cached, u.outputTokens)}>
                  {WF.canvas.cacheBadge(hitRate, formatK(totalIn))}
                </span>
              )
            })()}
            {message.reactions && message.reactions.length > 0 && (
              <div className={css.reactions}>
                {message.reactions.map((reaction, index) => {
                  const emp = employees.find(e => e.id === reaction.employeeId)
                  return (
                    <span
                      key={`${reaction.employeeId}-${reaction.emoji}-${index}`}
                      className={css.reactionPill}
                      title={emp ? `${emp.name} ${reaction.emoji}` : reaction.emoji}
                    >
                      <span className={css.reactionEmoji}>{reaction.emoji}</span>
                      {emp !== undefined && <span className={css.reactionWho}>{emp.name}</span>}
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        )}
        {message.delivery === 'sending' && <span className={css.deliveryStatus} role="status">{WF.ui.sendingDelivery}…</span>}
        {message.delivery === 'failed' && (
          <div className={css.sendFailure} role="alert">
            <span>{WF.common.failed}</span><span aria-hidden="true">·</span>
            <Button variant="plain" type="button" disabled={source === undefined} onClick={() => {
              if (message.clientId) void source?.retryMessage(message.clientId).catch(() => { /* Failure remains visible on this message. */ })
            }}>{WF.common.retry}</Button>
            {message.deliveryError && <span>{formatErrorReason(message.deliveryError)}</span>}
          </div>
        )}
        {task !== undefined && (
          <TaskFooter
            task={task}
            employees={employees}
            source={source}
            quiet={taskQuiet === true}
            onSelectContinuation={onSelectContinuation}
            isCurrentContinuation={isCurrentContinuation}
          />
        )}
      </div>
    </div>
  )
}, (prev, next) =>
  prev.message === next.message
  && prev.isLatest === next.isLatest && prev.isConsecutive === next.isConsecutive
  && prev.working === next.working && prev.activityState === next.activityState
  && prev.openThreadId === next.openThreadId && prev.replyCount === next.replyCount
  && prev.repliedSnippet === next.repliedSnippet && prev.taskQuiet === next.taskQuiet
  && equalArray(prev.notices, next.notices)
  && prev.employees === next.employees && prev.tasks === next.tasks
  && equalJson(prev.task, next.task) && equalJson(prev.remembered, next.remembered)
  && prev.onDm === next.onDm && prev.onOpenThread === next.onOpenThread
  && prev.onJumpToReply === next.onJumpToReply && prev.resolveRetryTarget === next.resolveRetryTarget
  && prev.onOpenKeyModal === next.onOpenKeyModal && prev.onOpenModelsModal === next.onOpenModelsModal
  && prev.isCurrentContinuation === next.isCurrentContinuation && prev.onSelectContinuation === next.onSelectContinuation
  && prev.source === next.source)

/** 提醒的重试目标：锚点是可见员工回复就重答它，否则取该提醒之前同线程最后一条可见回复。 */
function lastAgentBefore(messages: readonly WorkforceMessage[], threadId: string, ts: string): WorkforceMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.threadId !== threadId || message.ts > ts) continue
    if (message.role === 'agent' && message.tool === undefined && message.intermediate !== true
      && message.question === undefined && message.approval === undefined && message.text.trim() !== '') {
      return message
    }
  }
  return undefined
}

function MessageNotices({ notices, anchor, resolveRetryTarget, source, onOpenKeyModal, onOpenModelsModal }: {
  readonly notices: readonly WorkforceMessage[]
  readonly anchor?: WorkforceMessage | undefined
  /** 锚点不是可见员工回复时，按线程+时间找提醒之前最后一条可见回复。 */
  readonly resolveRetryTarget: (notice: WorkforceMessage) => WorkforceMessage | undefined
  readonly source: WorkforceSource
  readonly onOpenKeyModal?: ((provider?: string) => void) | undefined
  readonly onOpenModelsModal?: (() => void) | undefined
}) {
  return (
    <>
      {notices.map(notice => (
        <SystemNotice
          key={notice.id}
          notice={notice}
          retryTarget={anchor !== undefined && anchor.role === 'agent' ? anchor : resolveRetryTarget(notice)}
          source={source}
          onOpenKeyModal={onOpenKeyModal}
          onOpenModelsModal={onOpenModelsModal}
        />
      ))}
    </>
  )
}

function ModelFailureBanner({ message, onRetry, onOpenKey, onOpenModels }: {
  readonly message: string
  readonly onRetry: () => void
  readonly onOpenKey: (provider?: string) => void
  readonly onOpenModels: () => void
}) {
  const failure = classifyModelError(undefined, message)
  return <div className={css.streamError} role="alert">
    <span>{failure?.message ?? message}</span>
    {failure?.action === 'addKey' && <LobeButton type="text" onClick={() => onOpenKey(failure.provider)}>{WF.errorActions.addKey}</LobeButton>}
    {failure?.action === 'changeModel' && <LobeButton type="text" onClick={onOpenModels}>{WF.errorActions.changeModel}</LobeButton>}
    <LobeButton type="text" onClick={onRetry}>{WF.status.retry}</LobeButton>
  </div>
}

/** role=system 的中断/错误提醒：一行短文案贴在对应消息下方，点开展开详情与修复入口。 */
function SystemNotice({ notice, retryTarget, source, onOpenKeyModal, onOpenModelsModal }: {
  readonly notice: WorkforceMessage
  readonly retryTarget?: WorkforceMessage | undefined
  readonly source: WorkforceSource
  readonly onOpenKeyModal?: ((provider?: string) => void) | undefined
  readonly onOpenModelsModal?: (() => void) | undefined
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const raw = notice.error ?? notice.text
  const stopped = isStoppedReason(raw)
  const isError = notice.error !== undefined && !stopped
  const modelError = classifyModelError(notice.errorCode, raw)
  const detail = modelError?.message ?? formatErrorReason(raw).replace(/^(?:执行(?:已)?停止|执行失败)[：:]\s*/, '')
  const summary = isError ? `${WF.taskStatus.executionFailedPrefix}${detail}` : detail
  const errorAction = parseModelErrorAction(notice.errorCode, raw)
  const retry = async (): Promise<void> => {
    if (busy || retryTarget === undefined) return
    setBusy(true)
    setActionError(undefined)
    try { await source.regenerateMessage(retryTarget.threadId, retryTarget.id, retryTarget.senderId) }
    catch (error) { setActionError(formatErrorReason(error instanceof Error ? error.message : String(error))) }
    finally { setBusy(false) }
  }
  if (stopped) return <div className={css.msgNotice} data-kind="info"><div className={css.msgNoticeLine}><span className={css.msgNoticeIcon} aria-hidden="true">■</span><span className={css.msgNoticeText}>{WF.taskStatus.taskStoppedStatus}</span></div></div>
  return (
    <div className={css.msgNotice} data-kind={isError ? 'error' : 'info'}>
      <Button variant="plain" type="button" className={css.msgNoticeLine} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className={css.msgNoticeIcon} aria-hidden="true">{isError ? '✕' : 'ℹ'}</span>
        <span className={css.msgNoticeText}>{summary}</span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </Button>
      {open && (
        <div className={css.msgNoticeDetail}>
          <div>{detail}</div>
          {errorAction !== undefined && (
            <div className={css.msgErrorActions}>
              {errorAction.kind === 'addKey' && (
                <LobeButton type="text" onClick={() => onOpenKeyModal?.(errorAction.provider)}>
                  🔑 {errorAction.label}
                </LobeButton>
              )}
              {errorAction.kind === 'retry' && (
                <LobeButton type="text" disabled={busy || retryTarget === undefined} loading={busy} onClick={() => void retry()}>
                  🔄 {errorAction.label}
                </LobeButton>
              )}
              {(errorAction.kind === 'changeModel' || errorAction.kind === 'editEmployee' || errorAction.kind === 'checkModels') && (
                <LobeButton type="text" onClick={() => onOpenModelsModal?.()}>
                  ⚙️ {errorAction.label}
                </LobeButton>
              )}
            </div>
          )}
          {actionError !== undefined && <div className={css.msgFailed} role="alert">{actionError}</div>}
        </div>
      )}
    </div>
  )
}


/** DM/线程的 thread 面板（右列）：消息 + composer + 产物。 */
function ThreadPanelContent({ source, threadId, title, employees: employeesProp, onClose, onDm, onOpenKeyModal, onOpenModelsModal, sourceMessageId }: {
  readonly source: WorkforceSource
  readonly threadId: string
  readonly title?: string
  readonly employees?: readonly Employee[]
  readonly onClose: () => void
  readonly onDm: (employeeId: string) => void
  readonly onOpenKeyModal?: ((provider?: string) => void) | undefined
  readonly onOpenModelsModal?: (() => void) | undefined
  readonly sourceMessageId?: string | undefined
}) {
  const [prefs] = useWorkforcePrefs()
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const employees = employeesProp ?? snapshot.employees
  // 频道打开不再整频道预热，面板目标线程可能还没页：开面板时按需拉。
  useEffect(() => { void source.ensureThreadLoaded(threadId) }, [source, threadId, snapshot.messages])
  const view = threadView(snapshot, threadId)
  const task = threadTask(snapshot, threadId)
  const thread = useMemo(() => snapshot.threads.find(item => item.id === threadId), [snapshot.threads, threadId])
  const resolvedTitle = title || task?.title || thread?.title || WF.thread.title
  // 群聊成员名单约束 @ 候选：任务线程沿用其所属频道的 memberIds；未配置则全员。
  const mentionable = useMemo(() => {
    const memberIds = (snapshot.channels.find(channel => channel.id === thread?.channelId) as HostChannel | undefined)?.memberIds
    if (memberIds === undefined) return employees
    const set = new Set(memberIds)
    return employees.filter(employee => set.has(employee.id))
  }, [snapshot.channels, thread, employees])
  const displayItems = useMemo(
    () => processMessagesForDisplay(view.list, prefs.showSteps),
    [view.list, prefs.showSteps],
  )
  // 本 surface 已加载消息里出现过 web_search 才挂载披露块的懒加载边界，无搜索线程零开销。
  const hasWebSearch = useMemo(() => threadHasWebSearch(view.list), [view.list])
  const { scrollRef, contentRef, hasNewMessages, jumpToBottom, requestEarlier, revealMessage, pauseFollowing, hidden } = useMessageScroll(threadId, view.list, displayItems, {
    canFetch: view.hasMore === true && view.loadingEarlier !== true && view.earlierError === undefined,
    canRequest: view.hasMore === true,
    request: () => source.loadEarlierMessages(threadId),
  })
  const locatedSource = useRef<string>()
  useEffect(() => {
    if (sourceMessageId === undefined || locatedSource.current === sourceMessageId) return
    const row = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []).find(node => node.dataset['messageId'] === sourceMessageId)
    if (row) { row.scrollIntoView({ block: 'center' }); locatedSource.current = sourceMessageId }
    // 已加载但在渲染窗口外：扩窗后本 effect 因 hidden 变化重查；未加载才向历史分页。
    else if (!revealMessage(sourceMessageId) && view.hasMore && !view.loadingEarlier && !view.earlierError) void source.loadEarlierMessages(threadId)
  }, [sourceMessageId, view.list, view.hasMore, view.loadingEarlier, view.earlierError, hidden])
  const replyJump = useReplyJump({ scrollRef, scope: threadId, source, revealItem: revealMessage })
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ messageId: string; threadId: string }>).detail
      if (detail?.messageId && detail.threadId === threadId) {
        void replyJump.jumpTo(detail.messageId, detail.threadId)
      }
    }
    window.addEventListener('workforce:jump-to-message', handler)
    return () => window.removeEventListener('workforce:jump-to-message', handler)
  }, [replyJump, threadId])

  const [threadVw, setThreadVw] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('wb:thread-vw'))
      if (saved >= 20 && saved <= 50) return saved
    } catch {}
    return 36
  })
  const resizingRef = useRef<{ startX: number; startVw: number } | null>(null)

  const handleResizeStart = (e: React.PointerEvent) => {
    e.preventDefault()
    resizingRef.current = { startX: e.clientX, startVw: threadVw }
    const onPointerMove = (moveEvent: PointerEvent) => {
      if (!resizingRef.current) return
      const deltaPx = resizingRef.current.startX - moveEvent.clientX
      const deltaVw = (deltaPx / window.innerWidth) * 100
      const minVw = Math.max(20, (320 / window.innerWidth) * 100)
      const nextVw = Math.max(minVw, Math.min(50, resizingRef.current.startVw + deltaVw))
      setThreadVw(Math.round(nextVw * 10) / 10)
    }
    const onPointerUp = () => {
      resizingRef.current = null
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      setThreadVw(current => {
        try { localStorage.setItem('wb:thread-vw', String(current)) } catch {}
        return current
      })
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }
  const [filesOpen, setFilesOpen] = useState(false)
  const threadFiles = useMemo(() => workforceContextFiles([view.files], view.list), [view.files, view.list])
  const visibleThreadFiles = useMemo(() => threadFiles.filter(file => gateAttachment(file.name, file.mime).visible), [threadFiles])

  const activities = view.activity ?? []
  const activeEmployeeIds = useMemo(() => new Set(activities.map(a => a.employeeId)), [activities])
  const pendingSend = useMemo(() => pendingSendFor(view.list), [view.list])
  const fallbackRecipient = employees.find(employee => employee.id === task?.assigneeId)
    ?? channelDefaultRecipient(snapshot.channels, employees, thread?.channelId ?? task?.channelId)
  useEffect(() => {
    source.setFocusedThread(threadId)
  }, [source, threadId])
  const showThreadSkeleton = useDelayedLoading(
    (snapshot.phase === 'loading' || (view.status === 'idle' && view.list.length === 0)) && displayItems.length === 0,
    150,
  )

  const skeletons = useMemo(() => resolveSkeletons({
    employees,
    threadId,
    pendingReplies: source.getPendingReplies(),
    messages: view.list,
    activities,
    threadStatus: view.status,
    pendingSend,
    fallbackRecipient,
  }), [employees, threadId, source, snapshot, view.list, activities, view.status, pendingSend, fallbackRecipient])


  const footers = useMemo(() => taskFooterTargets(task ? [task] : [], displayItems, skeletons), [task, displayItems, skeletons])
  const anchored = useMemo(() => anchoredDeliverables(view.list), [view.list])

  const hasSkeleton = skeletons.length > 0
  const latestAgentMessageId = useMemo(() => {
    if (hasSkeleton) return undefined
    for (let i = displayItems.length - 1; i >= 0; i--) {
      const it = displayItems[i]!
      if (it.kind === 'message' && it.message.role === 'agent') {
        return it.message.id
      }
    }
    return undefined
  }, [hasSkeleton, displayItems])
  // 渲染窗口只切尾部最新一段；窗口外条目不挂载但分页数据仍在。
  const visibleItems = useMemo(() => hidden > 0 ? displayItems.slice(hidden) : displayItems, [displayItems, hidden])
  // 行级稳定 props：快照轮询每次都换数组/函数引用，memo 全靠这一层保住。
  const employeesStable = useJsonStable(employees)
  const tasksStable = useJsonStable(snapshot.tasks)
  const messagesById = useMemo(() => new Map(view.list.map(item => [item.id, item])), [view.list])
  const listRef = useLatest(view.list)
  const resolveRetryTarget = useCallback(
    (notice: WorkforceMessage) => lastAgentBefore(listRef.current, notice.threadId, notice.ts),
    [listRef],
  )
  const onDmRef = useLatest(onDm)
  const stableDm = useCallback((employeeId: string) => onDmRef.current(employeeId), [onDmRef])
  // 终结且无交付、其后无可见回复的任务页脚弱化（原判据依赖全量消息，行外预算）。
  const quietTaskIds = useMemo(() => new Set(snapshot.tasks
    .filter(item => (item.status === 'cancelled' || item.status === 'interrupted') && item.deliverables.length === 0
      && !view.list.some(m => m.threadId === item.threadId && m.role === 'agent' && m.tool === undefined && m.intermediate !== true && m.text.trim() !== ''))
    .map(item => item.id)), [snapshot.tasks, view.list])
  return (
    <AnchoredDeliverablesContext.Provider value={anchored}>
    <aside
      className={css.thread}
      style={{
        width: `${threadVw}vw`,
        minWidth: '320px',
        maxWidth: '50vw',
      }}
      data-workforce-thread
      data-wb-style={prefs.style}
      aria-label={WF.thread.title}
    >
      <div
        className={css.threadResizeHandle}
        onPointerDown={handleResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label={WF.taskStatus.resizeSidebarAria}
      />
      <div className={css.threadHead}>
        <div className={css.threadHeadTop}>
          <div className={css.threadHeadTitleGroup}>
            <h3 className={css.threadHeadTitle}>{resolvedTitle}</h3>
            {task !== undefined && (
              <span className={css.taskStatus} data-state={task.status}>
                {task.status === 'running' ? WF.employee.running
                  : task.status === 'done' ? WF.common.done
                  : task.status === 'failed' ? WF.employee.failed
                  : WF.taskStatus.taskStoppedStatus}
              </span>
            )}
            {view.usage && prefs.showTokenStats !== false && (() => {
              const u = view.usage
              const cached = u.cacheReadTokens ?? 0
              const totalIn = cached + u.inputTokens
              const hitRate = totalIn > 0 && cached > 0 ? Math.round((cached / totalIn) * 100) : 0
              return (
                <span className={css.threadTokenStats} title={WF.canvas.cacheTitle(totalIn, cached, u.outputTokens)}>
                  {WF.canvas.cacheBadge(hitRate, String(totalIn))}
                </span>
              )
            })()}
          </div>
          <div className={css.threadHeadActions}>
            <LobeButton
              type="text"
              className={css.threadActionBtn ?? ''}
              title={WF.taskStatus.threadFiles}
              aria-label={WF.taskStatus.threadFiles}
              onClick={() => setFilesOpen(true)}
            >
              <IconDeliverDocRegular size={14} />
            </LobeButton>
            <LobeButton
              type="text"
              className={css.threadClose ?? ''}
              aria-label={WF.thread.close}
              onClick={onClose}
            >
              <IconCloseOutlineRegular size={16} />
            </LobeButton>
          </div>
        </div>
      </div>
      {sourceMessageId !== undefined && messagesById.get(sourceMessageId) !== undefined && (() => {
        const m = messagesById.get(sourceMessageId)!
        return (
          <div className={css.threadSource}>
            <span>{WF.activity.fromSender(m.senderName)}</span>
            <p>{m.text}</p>
          </div>
        )
      })()}
      {view.error && <div className={css.streamError} role="alert">{view.error}<LobeButton type="text" onClick={() => source.refresh()}>{WF.common.retry}</LobeButton></div>}
      <div className={css.scrollArea}>
      <div className={css.threadScroll} ref={scrollRef} tabIndex={-1}>
        <div className={css.messageList} ref={contentRef}>
        <EarlierMessages loading={view.loadingEarlier === true} errors={view.earlierError !== undefined ? [view.earlierError] : []} onEarlier={requestEarlier} />
        {showThreadSkeleton ? (
          <MessageStreamSkeleton />
        ) : (
          visibleItems.map((item, index) => {
          if (item.kind === 'steps') {
            return (
              <div key={item.id} className={css.stepsGroup}>
                <StepsRow steps={item.steps} onToggle={pauseFollowing} />
                {hasWebSearch && <WebSearchRow messages={item.websearches} />}
                {item.notices.length > 0 && (
                  <MessageNotices notices={item.notices} resolveRetryTarget={resolveRetryTarget} source={source} onOpenKeyModal={onOpenKeyModal} onOpenModelsModal={onOpenModelsModal} />
                )}
              </div>
            )
          }
          if (item.kind === 'websearch') {
            return (
              <div key={item.id}>
                {hasWebSearch && <WebSearchRow messages={item.messages} />}
                {item.notices.length > 0 && (
                  <MessageNotices notices={item.notices} resolveRetryTarget={resolveRetryTarget} source={source} onOpenKeyModal={onOpenKeyModal} onOpenModelsModal={onOpenModelsModal} />
                )}
              </div>
            )
          }
          if (item.kind === 'notice') {
            return (
              <div key={item.id} className={css.msgNoticeOrphan}>
                <MessageNotices notices={item.notices} resolveRetryTarget={resolveRetryTarget} source={source} onOpenKeyModal={onOpenKeyModal} onOpenModelsModal={onOpenModelsModal} />
              </div>
            )
          }
          if (item.kind === 'tip') {
            return <div key={item.id} className={css.systemTip}>{item.text}</div>
          }
          const message = item.message
          const isUser = message.role === 'user'
          const prevItem = index > 0 ? visibleItems[index - 1] : undefined
          const prevMsg = prevItem?.kind === 'message' ? prevItem.message : undefined
          // 连续消息合并（同作者同 thread ≤5 分钟）：省略重复署名与头像。
          const isConsecutive = (
            prevMsg !== undefined &&
            prevMsg.role === message.role &&
            prevMsg.senderId === message.senderId &&
            message.replyTo === undefined &&
            Math.abs(new Date(message.ts).getTime() - new Date(prevMsg.ts).getTime()) < 5 * 60 * 1000
          )
          const working = !isUser && activeEmployeeIds.has(message.senderId)
          const task = footers.get(message.id)
          return (
            <MessageRow
              key={message.clientId ?? message.streamKey ?? message.id}
              message={message}
              employees={employeesStable}
              onDm={stableDm}
              working={working}
              activityState={working || message.running === true ? activities.find(a => a.employeeId === message.senderId)?.state : undefined}
              repliedSnippet={message.replyTo !== undefined ? replySnippetOf(messagesById, message.replyTo) : undefined}
              isLatest={message.id === latestAgentMessageId}
              isConsecutive={isConsecutive}
              source={source}
              task={task}
              taskQuiet={task !== undefined && quietTaskIds.has(task.id)}
              tasks={tasksStable}
              remembered={item.remembered}
              notices={item.notices}
              onJumpToReply={replyJump.jumpTo}
              resolveRetryTarget={resolveRetryTarget}
              onOpenKeyModal={onOpenKeyModal}
              onOpenModelsModal={onOpenModelsModal}
            />
          )
        }))}
        {skeletons.map(sk => (
          <SkeletonBubble
            key={skeletonKey(sk)}
            employee={sk.employee}
            employees={employees}
            activity={sk.activity}
            source={source}
            task={footers.get(skeletonKey(sk))}
          />
        ))}
        </div>
      </div>
        {hasNewMessages && <LobeButton className={css.newMessages ?? ''} onClick={jumpToBottom}>{WF.message.newMessages}</LobeButton>}
        {replyJump.notice !== undefined && <div className={css.replyJumpNotice} role="status">{replyJump.notice}</div>}
      </div>
      <WorkforceComposer
        key={threadId}
        draftKey={threadId}
        hint={WF.taskStatus.replyTaskHint}
        employees={employees}
        mentionable={mentionable}
        allowedSkills={thread?.kind === 'dm' && thread.employeeId ? employees.find(e => e.id === thread.employeeId)?.skills : task?.assigneeId ? employees.find(e => e.id === task.assigneeId)?.skills : undefined}
        onSend={(text, employeeIds) => source.send(threadId, text, employeeIds)}
        listSkills={() => source.listSkills()}
        onUploadMaterial={(name, content) => source.uploadMaterial(name, content)}
        onUploadFile={file => source.uploadFile(file)}
      />
      {filesOpen && (
        <WorkforceFilesDrawer
          title={WF.taskStatus.threadFiles}
          contextLabel={title}
          status={snapshot.phase === 'loading' && visibleThreadFiles.length === 0 ? 'loading' : visibleThreadFiles.length === 0 ? 'empty' : 'ready'}
          onClose={() => setFilesOpen(false)}
        >
          <WorkforceFilesTimeline files={threadFiles} employees={employees} />
        </WorkforceFilesDrawer>
      )}
    </aside>
    </AnchoredDeliverablesContext.Provider>
  )
}

export type WorkforceSurface =
  | { readonly kind: 'channel'; readonly id: string }
  | { readonly kind: 'dm'; readonly threadId: string; readonly employeeId: string }

/** 主工作区：surface 决定中列内容；thread 面板由页面态选中。 */
function WorkforceMainContent({ source, snapshot, surface, onDm, openThreadId, onCloseThread, onOpenThread, onNavigation, onOpenMemorySource, sourceMessageId }: {
  readonly source: WorkforceSource
  readonly snapshot: WorkforceSnapshot
  readonly surface: WorkforceSurface
  readonly onDm: (employeeId: string) => void
  /** 频道流中选中的任务 thread（右列追问面板）。 */
  readonly openThreadId: string | undefined
  readonly onCloseThread: () => void
  readonly onOpenThread: (threadId: string) => void
  /** 历史调用参数；文件附件始终在频道、私信和线程中可用。 */
  readonly enableMaterial?: boolean
  readonly onNavigation: () => void
  readonly onOpenMemorySource?: MemorySourceNavigation | undefined
  readonly sourceMessageId?: string | undefined
}) {
  const [prefs, setPrefs] = useWorkforcePrefs()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)
  const openModels = useCallback(() => source.models.open(), [source])
  const openKey = useCallback((provider?: string) => source.models.open({ provider }), [source])
  const [memoryScope, setMemoryScope] = useState<'channel' | 'global'>()
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  // 诊断弹窗的任务候选：快照不变就保持同一数组，避免父组件每次渲染都让弹窗重装列表
  const diagnosticTasks = useMemo(() => [...snapshot.tasks].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).map(task => ({ id: task.id, title: task.title })), [snapshot.tasks])
  const [backupOpen, setBackupOpen] = useState(false)
  const [skillDraftsOpen, setSkillDraftsOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [skillDraftList, setSkillDraftList] = useState<readonly WorkforceSkillDraft[] | undefined>()
  const [draftsVersion, setDraftsVersion] = useState(0)
  const [composerPrefill, setComposerPrefill] = useState<ComposerPrefillRequest>()
  const nextPrefillId = useRef(0)
  const finishPrefill = useCallback((request: ComposerPrefillRequest) => {
    setComposerPrefill(current => current?.draftKey === request.draftKey && current.id === request.id ? undefined : current)
  }, [])

  useEffect(() => {
    if (!settingsOpen && !actionMenuOpen) return
    const handleOutside = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false)
        setActionMenuOpen(false)
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSettingsOpen(false)
        setActionMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [settingsOpen, actionMenuOpen])

  // 「我的工作流技能」入口的待审核数：菜单或审核框打开时拉取；框内动作经 draftsVersion 触发重拉。
  useEffect(() => {
    if (!settingsOpen && !skillDraftsOpen) return
    let alive = true
    void source.skillDrafts().then(list => { if (alive) setSkillDraftList(list) }).catch(() => { if (alive) setSkillDraftList([]) })
    return () => { alive = false }
  }, [settingsOpen, skillDraftsOpen, draftsVersion, source])
  const pendingDraftCount = (skillDraftList ?? []).filter(draft => draft.status === 'drafted').length

  const { messages, threads: visibleThreads, earlierThreads } = useMemo(() => {
    if (surface.kind === 'channel') return channelStream(snapshot, surface.id)
    const threads = snapshot.threads.filter(thread => thread.id === surface.threadId)
    return { messages: threadView(snapshot, surface.threadId).list, threads, earlierThreads: threads }
  }, [snapshot, surface])
  useEffect(() => {
    if (surface.kind === 'channel') {
      const channel = snapshot.channels.find(c => c.id === surface.id)
      const hasUnread = Boolean(channel && typeof channel === 'object' && 'unread' in channel && channel.unread === true)
        || Boolean(channel && typeof channel === 'object' && 'unreadCount' in channel && typeof channel.unreadCount === 'number' && channel.unreadCount > 0)
      if (hasUnread) {
        void source.markChannelRead(surface.id).catch(() => {})
      }
    } else if (surface.kind === 'dm') {
      const thread = snapshot.threads.find(t => t.id === surface.threadId)
      const hasUnread = Boolean(thread && typeof thread === 'object' && 'unread' in thread && thread.unread === true)
        || Boolean(thread && typeof thread === 'object' && 'unreadCount' in thread && typeof thread.unreadCount === 'number' && thread.unreadCount > 0)
      if (hasUnread) {
        void source.patchThread(surface.threadId, { markRead: true }).catch(() => {})
      }
    }
  }, [surface, snapshot.channels, snapshot.threads, source, messages.length])
  const mainScope = `${surface.kind}:${surface.kind === 'channel' ? surface.id : surface.threadId}`
  const displayItems = useMemo(
    () => processMessagesForDisplay(messages, prefs.showSteps),
    [messages, prefs.showSteps],
  )
  // 本 surface 已加载消息里出现过 web_search 才挂载披露块的懒加载边界，无搜索线程零开销。
  const hasWebSearch = useMemo(() => threadHasWebSearch(messages), [messages])
  // 频道流跨多个 thread 分页：优先补卡住连续下界的 thread（见 channelStream）；前沿线程耗尽后
  // 把下一个未加载的同频道 task 拉进来继续向下扩——真滑动窗口，打开频道不整频道预热。
  // 未加载或首屏页拉失败的 task 都算「待按需加载」，滚到前沿时拉进来。
  const nextUnloadedThreads = useMemo(() => visibleThreads
    .filter(thread => {
      if (thread.kind !== 'task') return false
      const page = snapshot.messages[thread.id]
      return page === undefined || page.error !== undefined
    })
    .sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt)), [visibleThreads, snapshot.messages])
  const hasUnloaded = nextUnloadedThreads.length > 0
  const earlierCanRequest = earlierThreads.some(thread => snapshot.messages[thread.id]?.hasMore === true) || hasUnloaded
  const earlierCanFetch = earlierThreads.some(thread => {
    const page = snapshot.messages[thread.id]
    return (page?.hasMore === true && page.loadingEarlier !== true && page.earlierError === undefined)
  }) || hasUnloaded
  // 一轮并行发：前沿线程的历史页 + 至多两个未加载线程首屏页。真实数据一页 30 个事件
  // 常只折出两三条可见正文，逐线程串行追要很多轮才够两屏；每路各自回报「有无新增」，
  // 全部零新增（loadEarlierMessages 没长、ensureThreadLoaded 没页）才算一轮空转。
  const requestEarlierThreads = async (): Promise<boolean> => {
    const jobs = [
      ...earlierThreads.filter(thread => snapshot.messages[thread.id]?.hasMore === true)
        .map(thread => source.loadEarlierMessages(thread.id)),
      ...nextUnloadedThreads.slice(0, 2).map(thread => source.ensureThreadLoaded(thread.id)),
    ]
    return jobs.length > 0 ? (await Promise.all(jobs)).some(Boolean) : false
  }
  const { scrollRef, contentRef, hasNewMessages, jumpToBottom, requestEarlier, revealMessage, pauseFollowing, hidden } = useMessageScroll(mainScope, messages, displayItems, {
    canFetch: earlierCanFetch,
    canRequest: earlierCanRequest,
    request: requestEarlierThreads,
  // 线程面板开着时键盘翻页让给面板的滚动区，主区不抢。
  }, () => document.querySelector('[data-workforce-thread]') !== null)
  const locatedSource = useRef<string>()
  useEffect(() => {
    if (sourceMessageId === undefined || openThreadId !== undefined || locatedSource.current === sourceMessageId) return
    const row = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []).find(node => node.dataset['messageId'] === sourceMessageId)
    if (row) { row.scrollIntoView({ block: 'center' }); locatedSource.current = sourceMessageId }
    // 已加载但在渲染窗口外：扩窗后本 effect 因 hidden 变化重查；未加载才向历史分页。
    else if (!revealMessage(sourceMessageId)) {
      if (surface.kind === 'dm') {
        const page = snapshot.messages[surface.threadId]
        if (page?.hasMore && !page.loadingEarlier && !page.earlierError) void source.loadEarlierMessages(surface.threadId)
      } else if (earlierCanFetch) void requestEarlierThreads()
    }
  }, [sourceMessageId, messages, openThreadId, surface, snapshot.messages, hidden])
  const replyJump = useReplyJump({ scrollRef, scope: mainScope, source, revealItem: revealMessage, extendHistory: surface.kind === 'channel' ? requestEarlierThreads : undefined })
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ messageId: string; threadId: string }>).detail
      if (detail?.messageId) {
        void replyJump.jumpTo(detail.messageId, detail.threadId)
      }
    }
    window.addEventListener('workforce:jump-to-message', handler)
    return () => window.removeEventListener('workforce:jump-to-message', handler)
  }, [replyJump])
  const [selectedContinuationTaskId, setSelectedContinuationTaskId] = useState<string | null>(null)
  const recentTask = useMemo(() => surface.kind === 'channel'
    ? snapshot.tasks.filter(task => task.channelId === surface.id).reduce<Task | undefined>((latest, task) =>
      latest === undefined || (task.updatedAt ?? '') > (latest.updatedAt ?? '') ? task : latest, undefined)
    : undefined, [snapshot.tasks, surface])
  const activeContinuationTask = useMemo(() => {
    if (surface.kind !== 'channel') return undefined
    if (selectedContinuationTaskId) {
      const found = snapshot.tasks.find(task => task.id === selectedContinuationTaskId)
      if (found) return found
    }
    return recentTask
  }, [surface, selectedContinuationTaskId, snapshot.tasks, recentTask])
  const continuationHasPendingQuestion = activeContinuationTask !== undefined && (snapshot.messages[activeContinuationTask.threadId]?.list ?? messages).some(m => m.threadId === activeContinuationTask.threadId && (
    (m.question !== undefined && m.question.answered === undefined && m.question.status !== 'answered' && m.question.status !== 'inactive') ||
    (m.approval !== undefined && m.approval.answered === undefined && m.approval.status !== 'answered' && m.approval.status !== 'inactive')))
  const continuation = useContinuationMode(activeContinuationTask, continuationHasPendingQuestion)
  const selectContinuation = useCallback((task: Task) => {
    setSelectedContinuationTaskId(task.id)
    continuation.pin(task.id)
  }, [continuation.pin])
  const pendingNewContext = surface.kind === 'channel' && activeContinuationTask !== undefined && continuation.mode === 'new'
  const activities = useMemo(() => visibleThreads.flatMap(thread => snapshot.messages[thread.id]?.activity ?? []), [visibleThreads, snapshot.messages])

  const activeEmployeeIds = useMemo(() => new Set(activities.map(a => a.employeeId)), [activities])

  const employees = snapshot.employees
  const dmEmployee = surface.kind === 'dm' ? employees.find(employee => employee.id === surface.employeeId) : undefined
  const deletedDm = surface.kind === 'dm' && snapshot.phase !== 'loading' && dmEmployee === undefined
  const title = surface.kind === 'channel'
    ? (snapshot.channels.find(c => c.id === surface.id)?.name ?? surface.id)
    : (dmEmployee?.name ?? snapshot.threads.find(thread => thread.id === surface.threadId)?.title ?? WF.taskStatus.employeeHistory)
  const desc = deletedDm ? WF.taskStatus.deletedEmployeeHistoryDesc : surface.kind === 'channel' ? WF.channels.generalDesc : WF.dm.empty

  // 频道发送：POST 到频道 thread（Host 语义：channel thread 发消息=建任务）。
  // 频道 thread id 由 threads 列表给出（kind==='channel'）；暂缺时 composer 不挂。
  const channelThread = surface.kind === 'channel'
    ? snapshot.threads.find(t => t.kind === 'channel' && t.channelId === surface.id)
    : undefined
  const activeThreadId = surface.kind === 'dm' ? surface.threadId : channelThread?.id
  useEffect(() => { setComposerPrefill(undefined) }, [activeThreadId])
  const prefillSuggestion = (text: string): void => {
    if (activeThreadId === undefined || deletedDm) return
    nextPrefillId.current += 1
    setComposerPrefill({ draftKey: activeThreadId, id: nextPrefillId.current, text })
  }
  // 群聊成员名单约束 @ 候选：频道 surface 按其 memberIds 过滤；未配置或私信 = 全员。
  const mentionable = useMemo(() => {
    if (surface.kind !== 'channel') return employees
    const memberIds = (snapshot.channels.find(channel => channel.id === surface.id) as HostChannel | undefined)?.memberIds
    if (memberIds === undefined) return employees
    const set = new Set(memberIds)
    return employees.filter(employee => set.has(employee.id))
  }, [surface, snapshot.channels, employees])
  // 同一句人类消息发给 ≥3 位员工（频道 @所有人 或多 @）时，这一轮从发出起就合成一张组卡：
  // 默认每人两行摘要，点开右侧预览看全文；两位及以下保持普通气泡。
  const groups = useMemo(() => {
    const memberIds = mentionable.map(employee => employee.id)
    return replyGroups(messages, {
      order: employees.map(employee => employee.id),
      names: new Map(employees.map(employee => [employee.id, employee.name])),
      recipients: parent => parent.recipientIds !== undefined && parent.recipientIds.length > 0
        ? parent.recipientIds
        : surface.kind === 'channel' && mentionsEveryone(parent.text) ? memberIds : undefined,
    })
  }, [messages, employees, mentionable, surface.kind])
  const groupOfMessage = useMemo(() => {
    const map = new Map<string, string>()
    for (const group of groups.values()) for (const member of group.members) map.set(member.message.id, group.parentId)
    return map
  }, [groups])

  useEffect(() => {
    if (activeThreadId) {
      source.setFocusedThread(activeThreadId)
    }
  }, [source, activeThreadId])
  // 面内线程已有元数据但消息页未拉到（切换到冷频道/私信，phase 已 ready）也按装载中给骨架，
  // 否则批量等页期间会先闪「还没有消息」空态。
  const streamLoading = snapshot.phase === 'loading' || visibleThreads.some(thread => snapshot.messages[thread.id] === undefined)
  const showStreamSkeleton = useDelayedLoading(
    streamLoading && displayItems.length === 0,
    150,
  )
  const pendingReplies = source.getPendingReplies()
  const skeletons = useMemo(() => visibleThreads.flatMap(thread => {
    const view = threadView(snapshot, thread.id)
    const recipient = thread.kind === 'dm' ? employees.find(employee => employee.id === thread.employeeId)
      : employees.find(employee => employee.id === threadTask(snapshot, thread.id)?.assigneeId)
        ?? channelDefaultRecipient(snapshot.channels, employees, thread.channelId)
    return resolveSkeletons({
      employees, threadId: thread.id, pendingReplies, messages: view.list,
      activities: view.activity ?? [],
      threadStatus: thread.kind === 'channel' ? undefined : view.status,
      pendingSend: pendingSendFor(view.list), fallbackRecipient: recipient,
    })
  // 进行中的组卡已给每位收件人留了成员行，组内员工不再另挂骨架气泡。
  }).filter(item => ![...groups.values()].some(group => group.live
    && group.members.some(member => member.employeeId === item.employee.id && member.message.threadId === item.threadId))),
  [visibleThreads, snapshot, employees, pendingReplies, groups])
  const footers = useMemo(() => taskFooterTargets(snapshot.tasks.filter(task => surface.kind === 'channel'
    ? task.channelId === surface.id : task.threadId === surface.threadId), displayItems, skeletons),
  [snapshot.tasks, surface, displayItems, skeletons])
  // 只有真实任务 thread 才给「N 条回复」入口，普通频道消息点开没有 thread。
  const threadTaskIds = useMemo(() => new Set(snapshot.tasks.filter(task => surface.kind === 'channel'
    ? task.channelId === surface.id : task.threadId === surface.threadId).map(task => task.threadId)),
  [snapshot.tasks, surface])
  const isThreadLoading = snapshot.phase === 'loading'
    || (surface.kind === 'dm' && snapshot.messages[surface.threadId] === undefined)
    || (surface.kind === 'channel' && visibleThreads.some(t => snapshot.messages[t.id] === undefined))

  const threadMetadataHasMessages = surface.kind === 'dm'
    ? Boolean(snapshot.threads.find(t => t.id === surface.threadId)?.lastMessageAt)
    : visibleThreads.some(t => Boolean(t.lastMessageAt))

  const hasMessages = displayItems.length > 0
    || skeletons.length > 0
    || isThreadLoading
    || threadMetadataHasMessages
  const hasSkeleton = skeletons.length > 0
  const showWelcome = displayItems.length === 0 && snapshot.phase === 'ready' && !streamLoading && !hasSkeleton && !deletedDm
  const welcomeEmployee = surface.kind === 'dm' ? dmEmployee : channelDefaultRecipient(snapshot.channels, employees, surface.id)
  const latestAgentMessageId = useMemo(() => {
    if (hasSkeleton) return undefined
    for (let i = displayItems.length - 1; i >= 0; i--) {
      const it = displayItems[i]!
      if (it.kind === 'message' && it.message.role === 'agent') {
        return it.message.id
      }
    }
    return undefined
  }, [hasSkeleton, displayItems])
  // thread 面板：频道流中选中某条任务 thread 追问。
  const openThread = openThreadId !== undefined
    ? snapshot.threads.find(t => t.id === openThreadId && t.kind === 'task')
    : undefined

  const taskRoots = useMemo(() => {
    const roots = new Map<string, string>()
    for (const message of messages) if (message.role === 'user' && !roots.has(message.threadId)) roots.set(message.threadId, message.id)
    return roots
  }, [messages])
  const replies = useMemo(() => visibleReplyCounts(messages), [messages])
  const anchored = useMemo(() => anchoredDeliverables(messages), [messages])
  // 手动展开/收起：默认态由偏好决定，用户这一次的点击优先。
  const [toggledGroups, setToggledGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [previewTarget, setPreviewTarget] = useState<{ readonly groupId: string; readonly messageId: string } | undefined>()
  const groupMode = useCallback((groupId: string): ReplyGrouping => {
    const base = prefs.replyGrouping ?? 'summary'
    const toggled = toggledGroups.has(groupId)
    if (base === 'expanded') return toggled ? 'collapsed' : 'expanded'
    if (base === 'collapsed') return toggled ? 'expanded' : 'collapsed'
    return toggled ? 'expanded' : 'summary'
  }, [prefs.replyGrouping, toggledGroups])
  const toggleGroup = useCallback((groupId: string) => {
    setToggledGroups(current => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])
  // 预览抽屉：上一条/下一条在组内循环。
  const previewGroup = previewTarget === undefined ? undefined : groups.get(previewTarget.groupId)
  const previewIndex = previewTarget === undefined || previewGroup === undefined
    ? -1
    : previewGroup.members.findIndex(member => member.message.id === previewTarget.messageId)
  const previewMember = previewIndex >= 0 ? previewGroup!.members[previewIndex] : undefined
  const movePreview = useCallback((delta: number) => {
    setPreviewTarget(current => {
      if (current === undefined) return current
      const group = groups.get(current.groupId)
      if (group === undefined) return undefined
      const index = group.members.findIndex(member => member.message.id === current.messageId)
      if (index < 0) return undefined
      const next = group.members[(index + delta + group.members.length) % group.members.length]
      return next === undefined ? current : { groupId: current.groupId, messageId: next.message.id }
    })
  }, [groups])
  // 渲染窗口只切尾部最新一段；窗口外条目不挂载但分页数据仍在。
  const visibleItems = useMemo(() => hidden > 0 ? displayItems.slice(hidden) : displayItems, [displayItems, hidden])
  const firstRootIndex = surface.kind === 'channel' ? visibleItems.findIndex(item => item.kind === 'message' && taskRoots.get(item.message.threadId) === item.message.id) : -1
  // 行级稳定 props：快照轮询每次都换数组/函数引用，memo 全靠这一层保住。
  const employeesStable = useJsonStable(employees)
  const tasksStable = useJsonStable(snapshot.tasks)
  const messagesById = useMemo(() => new Map(messages.map(item => [item.id, item])), [messages])
  const messagesRef = useLatest(messages)
  const resolveRetryTarget = useCallback(
    (notice: WorkforceMessage) => lastAgentBefore(messagesRef.current, notice.threadId, notice.ts),
    [messagesRef],
  )
  const onDmRef = useLatest(onDm)
  const stableDm = useCallback((employeeId: string) => onDmRef.current(employeeId), [onDmRef])
  const onOpenThreadRef = useLatest(onOpenThread)
  const stableOpenThread = useCallback((threadId: string) => onOpenThreadRef.current(threadId), [onOpenThreadRef])
  // 终结且无交付、其后无可见回复的任务页脚弱化（原判据依赖全量消息，行外预算）。
  const quietTaskIds = useMemo(() => new Set(snapshot.tasks
    .filter(item => (item.status === 'cancelled' || item.status === 'interrupted') && item.deliverables.length === 0
      && !messages.some(m => m.threadId === item.threadId && m.role === 'agent' && m.tool === undefined && m.intermediate !== true && m.text.trim() !== ''))
    .map(item => item.id)), [snapshot.tasks, messages])
  const earlierLoading = earlierThreads.some(thread => snapshot.messages[thread.id]?.loadingEarlier === true)
  const earlierErrors = earlierThreads.flatMap(thread => {
    const error = snapshot.messages[thread.id]?.earlierError
    return error !== undefined ? [error] : []
  })
  // 上下文文件：thread 级 files（宿主权威全历史，含分页外的）+ 消息行 attachments，
  // 频道包含本频道全部 channel/task thread；DM/线程按当前 thread。
  const contextFiles = useMemo(() => workforceContextFiles(
    (surface.kind === 'channel'
      ? snapshot.threads.filter(thread => thread.channelId === surface.id && (thread.kind === 'channel' || thread.kind === 'task'))
      : visibleThreads).map(thread => snapshot.messages[thread.id]?.files),
    messages,
  ), [surface, snapshot.threads, visibleThreads, snapshot.messages, messages])
  const visibleContextFiles = useMemo(() => contextFiles.filter(file => gateAttachment(file.name, file.mime).visible), [contextFiles])

  return (
    <AnchoredDeliverablesContext.Provider value={anchored}>
      <section
        className={`${css.stream} ${openThread ? css.streamWithThread : ''}`}
        data-workforce-surface={surface.kind}
        data-wb-style={prefs.style}

      >
        <div className={`${css.streamHead} ${!hasMessages ? css.streamHeadEmpty : ''}`} data-section="stream-head">
          <div className={css.streamHeadRow}>
            <LobeButton type="text" className={css.navigationToggle ?? ''} aria-label={WF.workspace.expandChannelNav} onClick={onNavigation}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="4" y1="6" x2="20" y2="6"/>
                <line x1="4" y1="12" x2="20" y2="12"/>
                <line x1="4" y1="18" x2="20" y2="18"/>
              </svg>
            </LobeButton>
            <h2 className={css.streamTitle}>{surface.kind === 'channel' ? `# ${title}` : title}</h2>
            <span className={css.streamHeadDivider} aria-hidden="true" />
            <span className={css.streamDesc}>{desc}</span>
            <div className={css.streamSettingsWrap} ref={settingsRef}>{surface.kind === 'channel' && <LobeButton type="text" title={WF.settings.projectDirectory} aria-label={WF.settings.projectDirectory} onClick={() => { setSettingsOpen(open => !open); setActionMenuOpen(false) }}><Icon name="folder" width={15} height={15} /> {(snapshot.channels.find(channel => channel.id === surface.id) as HostChannel | undefined)?.projectDirectory?.split(/[\\/]/).at(-1) || WF.settings.projectDirectory}</LobeButton>}
              <LobeButton
                type="text"
                className={css.streamHeadActionBtn ?? ''}
                title={WF.settings.menuLabel}
                aria-label={WF.settings.menuLabel}
                aria-expanded={actionMenuOpen}
                onClick={() => {
                  setActionMenuOpen(o => !o)
                  setSettingsOpen(false)
                }}
              >
                <Icon name="more" width={18} height={18} />
              </LobeButton>
              {actionMenuOpen && (
                <div className={css.headActionDropdown} role="menu" aria-label={WF.taskStatus.actionsAndSettingsAria}>
                  {surface.kind === 'channel' && (
                    <LobeButton
                      type="text"
                      className={css.dropdownItem ?? ''}
                      role="menuitem"
                      onClick={() => {
                        setActionMenuOpen(false)
                        setMemoryScope('channel')
                      }}
                    >
                      <Icon name="memory" width={15} height={15} />
                      <span>{WF.taskStatus.channelMemoryTab}</span>
                    </LobeButton>
                  )}
                  <LobeButton
                    type="text"
                    className={css.dropdownItem ?? ''}
                    role="menuitem"
                    onClick={() => {
                      setActionMenuOpen(false)
                      setFilesOpen(true)
                    }}
                  >
                    <Icon name="file" width={15} height={15} />
                    <span>{WF.taskStatus.sessionFilesTab}</span>
                  </LobeButton>
                  <LobeButton
                    type="text"
                    className={css.dropdownItem ?? ''}
                    role="menuitem"
                    onClick={() => {
                      setActionMenuOpen(false)
                      openModels()
                    }}
                  >
                    <Icon name="settings" width={15} height={15} />
                    <span>{WF.models.title}</span>
                  </LobeButton>
                  <div className={css.dropdownDivider} />
                  <LobeButton
                    type="text"
                    className={css.dropdownItem ?? ''}
                    role="menuitem"
                    onClick={() => {
                      setActionMenuOpen(false)
                      setSettingsOpen(true)
                    }}
                  >
                    <Icon name="settings" width={15} height={15} />
                    <span>{WF.settings.preferences}</span>
                  </LobeButton>
                </div>
              )}
              {settingsOpen && (
                <div className={css.settingsMenu} role="group" aria-label={WF.settings.menuLabel}>{surface.kind === 'channel' && <ProjectDirectory source={source} channelId={surface.id} value={(snapshot.channels.find(channel => channel.id === surface.id) as HostChannel | undefined)?.projectDirectory} />}
                  <div className={css.settingsSection}>
                    <div className={css.settingsSectionTitle}>{WF.settings.monitoringTitle}</div>
                    <Checkbox className={css.settingsCheckbox ?? ''} checked={prefs.showTokenStats !== false} onChange={e => setPrefs({ showTokenStats: e.target.checked })}>{WF.settings.showTokens}</Checkbox>
                  </div>
                  <div className={css.settingsDivider} />
                  <div className={css.settingsSection}>
                    <div className={css.settingsSectionTitle}>{WF.settings.layoutTitle}</div>
                    <Radio className={css.settingsRadio ?? ''} name="wf-layout" value="discord" checked={prefs.style === 'discord'} onChange={() => setPrefs({ style: 'discord' })}>{WF.settings.layoutDiscord}</Radio>
                    <Radio className={css.settingsRadio ?? ''} name="wf-layout" value="wechat" checked={prefs.style === 'wechat'} onChange={() => setPrefs({ style: 'wechat' })}>{WF.settings.layoutWechat}</Radio>
                  </div>
                  <div className={css.settingsSection}>
                    <div className={css.settingsSectionTitle}>{WF.replyGroup.settingsTitle}</div>
                    <RadioGroup label={WF.replyGroup.settingsTitle} value={prefs.replyGrouping} onValueChange={value => setPrefs({ replyGrouping: value as ReplyGrouping })} items={[{ value: 'summary', label: WF.replyGroup.summary }, { value: 'expanded', label: WF.replyGroup.expanded }, { value: 'collapsed', label: WF.replyGroup.collapsed }]} />
                    <div className={css.settingsHint}>{WF.replyGroup.summaryDesc}</div>
                  </div>
                  <div className={css.settingsSection}>
                    <div className={css.settingsSectionTitle}>{WF.settings.schemeTitle}</div>
                    <RadioGroup label={WF.settings.schemeTitle} value={prefs.scheme} onValueChange={value => setPrefs({ scheme: value as typeof prefs.scheme })} items={[{ value: 'system', label: WF.settings.schemeSystem }, { value: 'light', label: WF.settings.schemeLight }, { value: 'dark', label: WF.settings.schemeDark }]} />
                  </div>
                  <div className={css.settingsDivider} />
                  <div className={css.settingsSection}>
                    <div className={css.settingsSectionTitle}>{WF.settings.showStepsTitle}</div>
                    <label className={css.settingsCheckbox}>
                      <Checkbox
                        checked={prefs.showSteps}
                        onChange={event => setPrefs({ showSteps: event.target.checked })}
                      />
                      <span>{WF.settings.showSteps}</span>
                    </label>
                    <div className={css.settingsHint}>{WF.settings.showStepsDesc}</div>
                  </div>
                  <div className={css.settingsDivider} />
                  <div className={css.settingsSection}>
                    <LobeButton className={css.settingsMenuAction ?? ''} onClick={() => { setSettingsOpen(false); setMemoryScope('global') }}>{WF.taskStatus.globalMemoryTitle}</LobeButton>
                    <LobeButton className={css.settingsMenuAction ?? ''} onClick={() => { setSettingsOpen(false); setSkillDraftsOpen(true) }}>
                      {WF.skillDrafts.menuTitle}{pendingDraftCount > 0 ? `（${WF.skillDrafts.pendingBadge(pendingDraftCount)}）` : ''}
                    </LobeButton>
                    <LobeButton className={css.settingsMenuAction ?? ''} onClick={() => { setSettingsOpen(false); setDiagnosticsOpen(true) }}>{WF.diagnostics.title}</LobeButton>
                    <LobeButton className={css.settingsMenuAction ?? ''} onClick={() => { setSettingsOpen(false); setBackupOpen(true) }}>{WF.backup.title}</LobeButton>
                  </div>
                  <div className={css.settingsDivider} />
                  <div className={css.settingsSection}>
                    <div className={css.settingsSectionTitle}>{WF.models.title}</div>
                    <LobeButton
                      className={css.settingsMenuAction ?? ''}
                      onClick={() => {
                        setSettingsOpen(false)
                        openModels()
                      }}
                    >
                      <span>{WF.models.title}</span>
                      <span>⚙️</span>
                    </LobeButton>
                    <LobeButton className={css.settingsMenuAction ?? ''} onClick={() => { setSettingsOpen(false); openModels() }}>{WF.models.openGuide}</LobeButton>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        {snapshot.error && <ModelFailureBanner message={snapshot.error} onRetry={() => source.refresh()} onOpenKey={openKey} onOpenModels={openModels} />}
        {surface.kind === 'dm' && snapshot.messages[surface.threadId]?.error && <ModelFailureBanner message={snapshot.messages[surface.threadId]!.error!} onRetry={() => source.refresh()} onOpenKey={openKey} onOpenModels={openModels} />}
        <div className={css.scrollArea}>
        <div className={css.streamScroll} ref={scrollRef} tabIndex={-1} data-section="main-stream">
          <div className={css.messageList} ref={contentRef} data-empty={showWelcome ? 'true' : undefined}>
          <EarlierMessages loading={earlierLoading} errors={earlierErrors} onEarlier={requestEarlier} />
          {showStreamSkeleton ? (
            <MessageStreamSkeleton />
          ) : showWelcome ? (
            <WorkforceWelcome
              kind={surface.kind}
              employee={welcomeEmployee}
              title={title}
              onSuggestion={prefillSuggestion}
              disabled={activeThreadId === undefined}
            />
          ) : (
            visibleItems.map((item, index) => {
              if (item.kind === 'steps') {
                return (
                  <div key={item.id} className={css.stepsGroup}>
                    <StepsRow steps={item.steps} onToggle={pauseFollowing} />
                    {hasWebSearch && <WebSearchRow messages={item.websearches} />}
                    {item.notices.length > 0 && (
                      <MessageNotices notices={item.notices} resolveRetryTarget={resolveRetryTarget} source={source} onOpenKeyModal={openKey} onOpenModelsModal={openModels} />
                    )}
                  </div>
                )
              }
              if (item.kind === 'websearch') {
                return (
                  <div key={item.id}>
                    {hasWebSearch && <WebSearchRow messages={item.messages} />}
                    {item.notices.length > 0 && (
                      <MessageNotices notices={item.notices} resolveRetryTarget={resolveRetryTarget} source={source} onOpenKeyModal={openKey} onOpenModelsModal={openModels} />
                    )}
                  </div>
                )
              }
              if (item.kind === 'notice') {
                return (
                  <div key={item.id} className={css.msgNoticeOrphan}>
                    <MessageNotices notices={item.notices} resolveRetryTarget={resolveRetryTarget} source={source} onOpenKeyModal={openKey} onOpenModelsModal={openModels} />
                  </div>
                )
              }
              if (item.kind === 'tip') {
                return <div key={item.id} className={css.systemTip}>{item.text}</div>
              }
              const message = item.message
              // 组内成员统一由组卡渲染（摘要态不渲染、展开态由组卡注入真实行），主循环跳过，
              // 否则同一行会出现两次。
              if (groupOfMessage.has(message.id)) return null
              const messageGroup = groups.get(message.id)
              const isUser = message.role === 'user'
              const isRoot = surface.kind === 'channel' && taskRoots.get(message.threadId) === message.id
              const task = footers.get(message.id)
              const prevItem = index > 0 ? visibleItems[index - 1] : undefined
              const prevMsg = prevItem?.kind === 'message' ? prevItem.message : undefined
              const isConsecutive = (
                !isRoot &&
                prevMsg !== undefined &&
                prevMsg.role === message.role &&
                prevMsg.senderId === message.senderId &&
                message.replyTo === undefined &&
                Math.abs(new Date(message.ts).getTime() - new Date(prevMsg.ts).getTime()) < 5 * 60 * 1000
              )
              const working = !isUser && activeEmployeeIds.has(message.senderId)
              const messageRow = (
                <div key={message.clientId ?? message.streamKey ?? message.id} className={isRoot ? css.taskStart : undefined}>
                  {isRoot && index > firstRootIndex && <ContextDivider />}
                  <MessageRow
                    message={message}
                    employees={employeesStable}
                    onDm={stableDm}
                    replyCount={messageGroup !== undefined ? undefined : replies.get(message.id)}
                    onJumpToReply={replyJump.jumpTo}
                    openThreadId={surface.kind === 'channel' && threadTaskIds.has(message.threadId) ? message.threadId : undefined}
                    onOpenThread={surface.kind === 'channel' ? stableOpenThread : undefined}
                    working={working}
                    activityState={working || message.running === true ? activities.find(a => a.employeeId === message.senderId)?.state : undefined}
                    repliedSnippet={message.replyTo !== undefined ? replySnippetOf(messagesById, message.replyTo) : undefined}
                    isLatest={message.id === latestAgentMessageId}
                    isConsecutive={isConsecutive}
                    source={source}
                    task={task}
                    taskQuiet={task !== undefined && quietTaskIds.has(task.id)}
                    tasks={tasksStable}
                    onSelectContinuation={surface.kind === 'channel' ? selectContinuation : undefined}
                    isCurrentContinuation={surface.kind === 'channel' && task !== undefined && activeContinuationTask?.id === task.id}
                    remembered={item.remembered}
                    notices={item.notices}
                    resolveRetryTarget={resolveRetryTarget}
                    onOpenKeyModal={openKey}
                    onOpenModelsModal={openModels}
                  />
                </div>
              )
              if (messageGroup !== undefined) {
                const groupTask = messageGroup.members
                  .map(member => footers.get(member.message.id))
                  .find(item => item !== undefined)
                return (
                  <Fragment key={`group:${messageGroup.parentId}`}>
                    {messageRow}
                    <ReplyGroupCard
                      group={messageGroup}
                      mode={groupMode(messageGroup.parentId)}
                      employees={employeesStable}
                      activities={activities}
                      onToggleExpanded={() => toggleGroup(messageGroup.parentId)}
                      onOpenPreview={messageId => setPreviewTarget({ groupId: messageGroup.parentId, messageId })}
                      footer={groupTask === undefined ? undefined : (
                        <TaskFooter
                          task={groupTask}
                          employees={employeesStable}
                          source={source}
                          quiet={quietTaskIds.has(groupTask.id)}
                          onSelectContinuation={surface.kind === 'channel' ? selectContinuation : undefined}
                          isCurrentContinuation={surface.kind === 'channel' && activeContinuationTask?.id === groupTask.id}
                        />
                      )}
                      renderMember={member => (
                        <MessageRow
                          key={member.clientId ?? member.streamKey ?? member.id}
                          message={member}
                          employees={employeesStable}
                          onDm={stableDm}
                          working={activeEmployeeIds.has(member.senderId)}
                          activityState={activities.find(a => a.employeeId === member.senderId)?.state}
                          repliedSnippet={member.replyTo !== undefined ? replySnippetOf(messagesById, member.replyTo) : undefined}
                          isLatest={member.id === latestAgentMessageId}
                          isConsecutive={false}
                                  source={source}
                          task={footers.get(member.id)}
                          taskQuiet={footers.get(member.id) !== undefined && quietTaskIds.has(footers.get(member.id)!.id)}
                          tasks={tasksStable}
                          onSelectContinuation={surface.kind === 'channel' ? selectContinuation : undefined}
                          isCurrentContinuation={surface.kind === 'channel' && footers.get(member.id) !== undefined && activeContinuationTask?.id === footers.get(member.id)!.id}
                          notices={[]}
                          onJumpToReply={replyJump.jumpTo}
                          resolveRetryTarget={resolveRetryTarget}
                          onOpenKeyModal={openKey}
                          onOpenModelsModal={openModels}
                        />
                      )}
                    />
                  </Fragment>
                )
              }
              return messageRow
            })
          )}
          {skeletons.map(sk => (
            <SkeletonBubble
              key={skeletonKey(sk)}
              employee={sk.employee}
              employees={employees}
              activity={sk.activity}
              source={source}
              task={footers.get(skeletonKey(sk))}
            />
          ))}
          {pendingNewContext && (
            <ContextDivider
              resumeTitle={activeContinuationTask.title || activeContinuationTask.prompt?.slice(0, 30) || WF.taskStatus.currentTask}
              onResume={() => continuation.setMode('continue')}
            />
          )}
          </div>
        </div>
          {hasNewMessages && <LobeButton className={css.newMessages ?? ''} onClick={jumpToBottom}>{WF.message.newMessages}</LobeButton>}
          {replyJump.notice !== undefined && <div className={css.replyJumpNotice} role="status">{replyJump.notice}</div>}
        </div>
        {deletedDm && <div className={css.taskActions}>{WF.taskStatus.deletedEmployeeNotice}</div>}
        {activeThreadId !== undefined && !deletedDm && (
          <WorkforceComposer
            key={activeThreadId}
            draftKey={activeThreadId}
            prefillRequest={composerPrefill}
            onPrefillApplied={finishPrefill}
            hint={surface.kind === 'channel' ? undefined : WF.taskStatus.sendDmHint}
            employees={employees}
            mentionable={mentionable}
            allowMentionAll={surface.kind === 'channel'}
            allowedSkills={surface.kind === 'dm' ? employees.find(e => e.id === surface.employeeId)?.skills : undefined}
            onSend={async (text, employeeIds) => {
              await source.send(activeThreadId, text, employeeIds)
              // 新任务发出后，最近的任务就是它；不再停在之前手动选中的旧任务。
              setSelectedContinuationTaskId(null)
            }}
            continuationTask={surface.kind === 'channel' ? activeContinuationTask : undefined}
            continuationMode={continuation.mode}
            onContinuationModeChange={continuation.setMode}
            onContinueThread={surface.kind === 'channel' && activeContinuationTask ? async (text, employeeIds) => {
              await source.send(activeContinuationTask.threadId, text, employeeIds)
            } : undefined}
            listSkills={() => source.listSkills()}
            onUploadMaterial={(name, content) => source.uploadMaterial(name, content)}
            onUploadFile={file => source.uploadFile(file)}
            autoFocus={false}
          />
        )}
      </section>
      {previewMember !== undefined && previewGroup !== undefined && (
        <ReplyPreviewDialog
          title={previewMember.message.senderName}
          subtitle={`${WF.replyGroup.title(previewGroup.members.length)} · ${fmtTime(previewMember.message.ts)}`}
          onClose={() => setPreviewTarget(undefined)}
          onPrevious={previewGroup.members.length > 1 ? () => movePreview(-1) : undefined}
          onNext={previewGroup.members.length > 1 ? () => movePreview(1) : undefined}
          footer={previewGroup.members.length > 1 ? <span>{previewIndex + 1} / {previewGroup.members.length}</span> : undefined}
        >
          <WorkforceMessageText
            text={formatErrorReason(previewMember.message.text)}
            employees={employees}
            onDm={stableDm}
            tasks={tasksStable}
            hasAttachments={previewMember.message.attachments !== undefined && previewMember.message.attachments.length > 0}
            hasDeliverables={false}
          />
        </ReplyPreviewDialog>
      )}
      {openThread !== undefined && (
        <ThreadPanel
          source={source}
          key={openThread.id}
          threadId={openThread.id}
          title={openThread.title}
          employees={employees}
          onClose={onCloseThread}
          onDm={onDm}
          sourceMessageId={sourceMessageId}
          onOpenKeyModal={openKey}
          onOpenModelsModal={openModels}
        />
      )}
      {memoryScope !== undefined && <WorkforceMemoryDialog
        title={memoryScope === 'channel' ? WF.taskStatus.channelMemoryTitle(title) : WF.taskStatus.globalMemoryTitle}
        scope={memoryScope}
        scopeId={memoryScope === 'channel' && surface.kind === 'channel' ? surface.id : undefined}
        employees={employees}
        drawer={memoryScope === 'channel'}
        onClose={() => setMemoryScope(undefined)}
        onOpenSource={(threadId, messageId) => { if (onOpenMemorySource) onOpenMemorySource(threadId, messageId); else onOpenThread(threadId); setMemoryScope(undefined) }}
      />}
      {diagnosticsOpen && <WorkforceDiagnosticsDialog
        tasks={diagnosticTasks}
        onClose={() => setDiagnosticsOpen(false)}
      />}
      {backupOpen && <WorkforceBackupDialog onClose={() => setBackupOpen(false)} />}
      {skillDraftsOpen && <WorkforceSkillDraftsDialog
        source={source}
        employees={employees}
        tasks={snapshot.tasks}
        onChanged={() => { source.invalidateSkillCaches(); source.refresh(); setDraftsVersion(v => v + 1) }}
        onClose={() => { setSkillDraftsOpen(false); setDraftsVersion(v => v + 1) }}
      />}
      {filesOpen && (
        <WorkforceFilesDrawer
          title={WF.taskStatus.chatFiles}
          contextLabel={surface.kind === 'channel' ? WF.taskStatus.channelFilesContext(title) : WF.taskStatus.dmFilesContext(title)}
          status={snapshot.phase === 'loading' && visibleContextFiles.length === 0 ? 'loading' : visibleContextFiles.length === 0 ? 'empty' : 'ready'}
          onClose={() => setFilesOpen(false)}
        >
          <WorkforceFilesTimeline files={contextFiles} employees={employees} />
        </WorkforceFilesDrawer>
      )}
    </AnchoredDeliverablesContext.Provider>
  )
}

export function WorkforceMain(props: ComponentProps<typeof WorkforceMainContent>) {
  return <WorkforceMainContent {...props} />
}

export function ThreadPanel(props: ComponentProps<typeof ThreadPanelContent>) {
  return <ThreadPanelContent {...props} />
}
