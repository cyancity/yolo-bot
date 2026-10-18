/**
 * 数字员工主工作区：频道消息流 / 员工 DM / thread 面板 / 底部 composer。
 * 数据来自 WorkforceSource（Host 轮询 API），组件不感知 ctx；消息左对齐
 * 署名+头像+时间（不做两方气泡）；工具调用/产物折叠可开。
 */
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type ComponentProps } from 'react'
import { FileTypeIcon, IconCloseOutlineRegular, IconDeliverDocRegular, IconRefreshOutlineRegular, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { Icon } from './ui/icons.tsx'
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, useExternalStoreRuntime, type CreateAttachment, type ThreadMessageLike } from '@assistant-ui/react'
import { WorkforceAssistantRuntime, AssistantMessageScope, AssistantMessageParts, AssistantToolParts, dshAttachmentAdapter } from './assistant-runtime.tsx'
import { WorkbenchExtensionPreview, readExtensionPreview } from './extension-preview.tsx'
import { Button } from './ui/button.tsx'
import { Checkbox, RadioGroup } from './ui/choice.tsx'
import { useUserProfile } from './workforce-profile.tsx'
import { WF } from './workforce-strings.ts'
import { WorkforceMessageText } from './workforce-message-text.tsx'
import { ReplyGroupCard } from './workforce-reply-group.tsx'
import { ReplyPreviewDialog } from './workforce-reply-preview.tsx'
import { WorkforceQuestionCard } from './workforce-question-card.tsx'
import type { Employee, SkillSummary, Task, WorkforceActivity, WorkforceMessage, WorkforceSkillDraft, WorkforceSnapshot } from './workforce-types.ts'
import type { HostChannel } from './workforce-api.ts'
import type { PendingReply, WorkforceSource } from './workforce-source.ts'
import { channelStream, isLeaderNoReplyDraft, mentionsEveryone, replyGroups, threadTask, threadView, visibleReplyCounts } from './workforce-source.ts'
import { WorkforceAvatar } from './workforce-avatar.tsx'
import type { AvatarMotionState } from './workforce-avatar-motion.ts'
import { useWorkforcePrefs, type AvatarStyle, type ReplyGrouping, type TypingEffect } from './workforce-prefs.ts'
import css from './workforce.module.css'
import { attachmentKind, formatFileSize, AttachmentBar, gateAttachment } from './workforce-attachments.tsx'
import { AnchoredDeliverablesContext, DeliverableChips, anchoredDeliverables, messageDeliverableNames } from './workforce-deliverables.tsx'
import { attachmentMessage, MAX_ATTACHMENT_BYTES, type UploadedAttachment } from './workforce-upload.ts'
import attachmentCss from './workforce-composer-attachments.module.css'
import { classifyModelError, parseModelErrorAction } from './workforce-models.tsx'
import { MessageStreamSkeleton, useDelayedLoading } from './workforce-skeleton.tsx'
import { WorkforceMemoryDialog, RememberedMemoryCard, readRememberedMemory, type RememberedMemory, type MemorySourceNavigation } from './workforce-memory.tsx'
import { WorkforceDiagnosticsDialog } from './workforce-diagnostics.tsx'
import { WorkforceBackupDialog } from './workforce-backup.tsx'
import { WorkforceSkillDraftsDialog } from './workforce-skill-drafts.tsx'
import { WorkforceFilesDrawer, WorkforceFilesTimeline, workforceContextFiles } from './workforce-files.tsx'
import { threadHasWebSearch, WebSearchBatch, WorkforceWebSearch } from './workforce-websearch.tsx'
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
  return <div className={css.msgFooter} data-message-footer data-task-id={task.id}>
    {task.deliverables.length > 0 && <DeliverableChips task={task} employees={employees} source={source} />}
    {task.status === 'running' && <div className={css.taskActions}>
      <Button variant="plain" type="button" className={css.taskCancel} disabled={busy} onClick={() => void cancel()}>{busy ? WF.employee.cancelling : WF.employee.cancel}</Button>
      <span className={css.taskStatus} data-state={task.status}>{WF.employee.running}</span>
    </div>}
    {stopped && <div className={css.taskActions}>
      <span className={css.taskStatus} data-state={task.status}>{WF.taskStatus.stopped(quiet)}</span>
      {onSelectContinuation && (
        <Button variant="plain"
          type="button"
          className={isCurrentContinuation ? css.taskContinueActive : css.taskContinue}
          onClick={() => onSelectContinuation(task)}
          title={WF.taskStatus.continueTitle}
        >
          {isCurrentContinuation ? WF.taskStatus.continuingTask : WF.taskStatus.continueTask}
        </Button>
      )}
    </div>}
    {task.status === 'failed' && <div className={css.taskActions}>
      <span className={css.taskStatus} data-state="failed">✕ {WF.employee.failed}</span>
      {onSelectContinuation && (
        <Button variant="plain"
          type="button"
          className={isCurrentContinuation ? css.taskContinueActive : css.taskContinue}
          onClick={() => onSelectContinuation(task)}
          title={WF.taskStatus.continueTitle}
        >
          {isCurrentContinuation ? WF.taskStatus.continuingTask : WF.taskStatus.continueTask}
        </Button>
      )}
    </div>}
    {task.status !== 'running' && !stopped && task.status !== 'failed' && onSelectContinuation && (
      <div className={css.taskActions}>
        <Button variant="plain"
          type="button"
          className={isCurrentContinuation ? css.taskContinueActive : css.taskContinue}
          onClick={() => onSelectContinuation(task)}
          title={WF.taskStatus.continueTitle}
        >
          {isCurrentContinuation ? WF.taskStatus.continuingTask : WF.taskStatus.continueTask}
        </Button>
      </div>
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
                {step.tool ? <AssistantToolParts message={step} /> : step.text ? <div className={css.stepItemText}>{step.text}</div> : null}
              </div>
            )
          })}
        </div>
      )}
      {open && <Button variant="plain" type="button" className={css.stepsCollapse} onClick={toggle}>{WF.steps.collapseSteps}</Button>}
    </div>
  )
}

/** 接收方的回复骨架气泡（占位，含打字点与当前活动状态）。 */
function SkeletonBubble({
  employee,
  employees,
  activity,
  style,
  typingEffect,
  task,
  source,
}: {
  readonly employee: Employee
  readonly employees: readonly Employee[]
  readonly activity?: WorkforceActivity | undefined
  readonly style?: AvatarStyle | undefined
  readonly typingEffect?: TypingEffect | undefined
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
  if (activity?.state === 'tool') {
    avatarMotionState = 'searching'
    statusText = activity.tool ? humanizeToolActivity(activity.tool) : WF.skeleton.processing
  } else if (activity?.state === 'thinking') {
    avatarMotionState = 'thinking'
    statusText = WF.skeleton.thinking
  } else if (activity?.state === 'typing') {
    avatarMotionState = 'working'
    statusText = WF.skeleton.typing
  } else if (!woken) {
    avatarMotionState = 'waking'
    statusText = WF.taskStatus.wakingEmployee
  } else {
    avatarMotionState = 'listening'
    statusText = WF.taskStatus.taskReceivedWaiting
  }

  return (
    <div className={css.msg} data-msg-role="agent" data-skeleton="true">
      <WorkforceAvatar
        name={name}
        isUser={false}
        color={employee.avatarColor}
        role={employee.role}
        style={style}
        typingEffect={typingEffect}
        state={avatarMotionState}
        activityState={avatarMotionState}
        live={true}
        size={36}
      />
      <div className={css.msgBody}>
        <div className={css.msgHead}>
          <span className={css.msgName}>{name}</span>
        </div>
        <div className={css.msgBubble}>
          <div className={css.skeletonContent}>
            <span className={css.liveRadarDot} data-state={activity?.state ?? 'typing'} aria-hidden="true">
              <span className={css.liveRadarCore} />
              <span className={css.liveRadarRipple} />
              <span className={`${css.liveRadarRipple} ${css.liveRadarRippleDelay}`} />
            </span>
            <span className={css.skeletonStatus}>{statusText}</span>
          </div>
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
    const remembered = readRememberedMemory(message)
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
      <Button variant="plain" type="button" className={css.earlierRetry} aria-label={WF.employee.older} title={WF.employee.older} onClick={onEarlier}>
        <IconRefreshOutlineRegular size={14} />
      </Button>
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
  avatarStyle,
  typingEffect,
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
  readonly avatarStyle?: AvatarStyle | undefined
  readonly typingEffect?: TypingEffect | undefined
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
      const limit = Number.parseFloat(getComputedStyle(node).getPropertyValue('--wb-message-clamp-height')) || 0
      if (limit <= 0) { setOverflowing(false); return }
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
      <Button variant="plain" type="button" title={copied ? WF.message.copied : WF.message.copy} aria-label={copied ? WF.message.copied : WF.message.copy} onClick={() => void copy()}>
        <svg viewBox="0 0 20 20" aria-hidden="true">{copied ? <path d="m4 10 4 4 8-9" /> : <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M12 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h2" /></>}</svg>
      </Button>
      <Button variant="plain" type="button" title={regenerating ? WF.message.regenerating : WF.message.regenerate} aria-label={regenerating ? WF.message.regenerating : WF.message.regenerate} disabled={regenerating || message.running === true} onClick={() => void regenerate()}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 7a6 6 0 1 0 0 6M16 3v4h-4" /></svg>
      </Button>
      <Button variant="plain" type="button" disabled title={WF.message.deleteReserved} aria-label={WF.message.deleteReserved}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6M12 8v6" /></svg>
      </Button>
      <Button variant="plain" type="button" disabled title={WF.message.collapseReserved} aria-label={WF.message.collapseReserved}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5-5 5 5M5 12l5 5 5-5" /></svg>
      </Button>
    </div>
  ) : undefined
  return (
    <AssistantMessageScope message={message}><MessagePrimitive.Root className={`${css.msg} ${isConsecutive ? css.msgConsecutive : ''} ${message.running === true || message.delivery === 'sending' ? css.msgPending : ''}`} data-msg-role={message.role} data-message-id={message.id} data-delivery={message.delivery}>
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
          style={avatarStyle}
          typingEffect={typingEffect}
          state={resolvedState}
          activityState={resolvedState}
          live={isLatest && (isWorking || message.delivery === 'sending')}
          size={36}
        />
      )}
      <div className={css.msgBody}>
        {!isConsecutive && (
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
          <div className={css.msgBubble} data-clamped={clamped || undefined}>
            <div className={css.msgClamp} ref={clampRef}>
              <AssistantMessageParts renderText={text => {
                const fallback = <WorkforceMessageText assistant text={formatErrorReason(text)} employees={employees} onDm={onDm} tasks={tasks}
                  hasAttachments={message.attachments !== undefined && message.attachments.length > 0}
                  hasDeliverables={task !== undefined && task.deliverables.length > 0} />
                return messagePreview ? <WorkbenchExtensionPreview preview={messagePreview} fallback={fallback} /> : fallback
              }} />
            </div>
            {clampable && (
              <Button variant="plain" type="button" className={css.msgClampToggle} aria-expanded={!clamped} onClick={() => setExpandedText(value => !value)}>
                {clamped ? WF.message.expandFull : WF.message.collapseFull}
              </Button>
            )}
            {actionBar}
          </div>
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
    </MessagePrimitive.Root></AssistantMessageScope>
  )
}, (prev, next) =>
  prev.message === next.message
  && prev.isLatest === next.isLatest && prev.isConsecutive === next.isConsecutive
  && prev.working === next.working && prev.activityState === next.activityState
  && prev.avatarStyle === next.avatarStyle && prev.typingEffect === next.typingEffect
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
    {failure?.action === 'addKey' && <Button variant="plain" type="button" className={css.empAction} onClick={() => onOpenKey(failure.provider)}>{WF.errorActions.addKey}</Button>}
    {failure?.action === 'changeModel' && <Button variant="plain" type="button" className={css.empAction} onClick={onOpenModels}>{WF.errorActions.changeModel}</Button>}
    <Button variant="plain" type="button" className={css.empAction} onClick={onRetry}>{WF.status.retry}</Button>
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
                <Button variant="plain" type="button" className={css.msgErrorActionBtn} onClick={() => onOpenKeyModal?.(errorAction.provider)}>
                  🔑 {errorAction.label}
                </Button>
              )}
              {errorAction.kind === 'retry' && (
                <Button variant="plain" type="button" className={css.msgErrorActionBtn} disabled={busy || retryTarget === undefined} onClick={() => void retry()}>
                  🔄 {errorAction.label}
                </Button>
              )}
              {(errorAction.kind === 'changeModel' || errorAction.kind === 'editEmployee' || errorAction.kind === 'checkModels') && (
                <Button variant="plain" type="button" className={css.msgErrorActionBtn} onClick={() => onOpenModelsModal?.()}>
                  ⚙️ {errorAction.label}
                </Button>
              )}
            </div>
          )}
          {actionError !== undefined && <div className={css.msgFailed} role="alert">{actionError}</div>}
        </div>
      )}
    </div>
  )
}

/** Composer 触发词状态：@ 员工与 / skill 共用一套浮层、键盘与失焦规则。 */
type ComposerTrigger = { readonly kind: 'at' | 'slash'; readonly query: string }

/** 浮层一行候选：label 是展示文本，insert 是回填到输入框的 token。 */
interface TriggerItem {
  readonly key: string
  readonly label: string
  readonly insert: string
  readonly meta?: string
  readonly icon?: ReactNode
}

/** @ 与 / 共用的候选浮层；loading/empty 也在同一壳内呈现。 */
function TriggerMenu({ items, activeIndex, loading, onPick }: {
  readonly items: readonly TriggerItem[]
  readonly activeIndex: number
  readonly loading: boolean
  readonly onPick: (item: TriggerItem) => void
}) {
  const activeItemRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (typeof activeItemRef.current?.scrollIntoView === 'function') {
      activeItemRef.current.scrollIntoView({
        block: 'nearest',
      })
    }
  }, [activeIndex])

  if (loading) return <div className={css.atMenu} role="listbox" aria-label={WF.composer.atPlaceholder}><div className={css.atItem}>{WF.common.loading}</div></div>
  if (items.length === 0) return <div className={css.atMenu} role="listbox" aria-label={WF.composer.atPlaceholder}><div className={css.atItem}>{WF.composer.atEmpty}</div></div>
  return (
    <div className={css.atMenu} role="listbox" aria-label={WF.composer.atPlaceholder}>
      {items.map((item, index) => (
        <Button variant="plain"
          key={item.key}
          ref={index === activeIndex ? activeItemRef : null}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`${css.atItem} ${index === activeIndex ? css.atItemActive : ''}`}
          onMouseDown={event => { event.preventDefault(); onPick(item) }}
        >
          {item.icon}
          <span className={css.atItemName}>{item.label}</span>
          <span className={css.atItemRole}>{item.meta}</span>
        </Button>
      ))}
    </div>
  )
}

export interface ComposerProps {
  readonly employees: readonly Employee[]
  /** @ 浮层候选：群聊限定成员名单；缺省 = 全部员工。正文里手写 @ 仍按全员工解析，由宿主校验成员范围。 */
  readonly mentionable?: readonly Employee[] | undefined
  /** 频道输入框支持 @所有人，发送时展开为当前频道成员。私信和任务线程不启用。 */
  readonly allowMentionAll?: boolean
  readonly onSend: (text: string, employeeIds: readonly string[]) => Promise<void>
  /** 限定当前会话/私信目标员工的可用技能；undefined 表示不限制（如公共频道）。 */
  readonly allowedSkills?: readonly string[] | undefined
  /** Slash 浮层的 skill 目录加载器；缺省时 / 不触发浮层。 */
  readonly listSkills?: () => Promise<SkillSummary[]>
  readonly onUploadMaterial: ((name: string, content: string) => Promise<{ id: string; name: string; url: string }>) | undefined
  readonly onUploadFile?: ((file: File) => Promise<UploadedAttachment>) | undefined
  readonly autoFocus?: boolean
  readonly initialDraft?: string | undefined
  readonly draftKey: string
  readonly hint?: string | undefined
  readonly continuationTask?: Task | undefined
  readonly onContinueThread?: ((text: string, employeeIds: readonly string[]) => Promise<void>) | undefined
  readonly onResetContinuation?: (() => void) | undefined
  /** 吸附的任务当前是否存在未应答的提问/审批 */
  readonly continuationHasPendingQuestion?: boolean | undefined
}

/** 10 分钟内完成的任务仍默认延续 */
const CONTINUATION_RECENT_WINDOW_MS = 10 * 60 * 1000

/**
 * 任务大厅默认延续策略：
 * 1. 吸附的任务处于 running 或等待用户回复/提问时，默认延续；
 * 2. 任务 done 且完成在 10 分钟内，默认延续；
 * 3. 其他（done 超过 10 分钟、cancelled、failed 等）默认「新任务」，吸附条仍显示，用户可一键切回延续。
 */
export function resolveDefaultContinuationMode(
  task: Task | undefined,
  hasPendingQuestion = false,
  now = Date.now(),
): 'continue' | 'new' {
  if (!task) return 'new'
  if (task.status === 'running' || hasPendingQuestion) return 'continue'
  if (task.status === 'done' && task.updatedAt) {
    const elapsed = now - Date.parse(task.updatedAt)
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= CONTINUATION_RECENT_WINDOW_MS) {
      return 'continue'
    }
  }
  return 'new'
}

interface ComposerAttachment {
  readonly key: number
  readonly name: string
  readonly sizeBytes: number
  readonly mime: string
  readonly previewUrl?: string
  readonly uploaded?: UploadedAttachment
  readonly error?: string
}

/**
 * Enter 发送、Shift+Enter 换行；@ 选择员工。文件先上传，成功后附到消息正文。
 * 发送失败保留正文和附件；发送期间新增的草稿与附件不随旧消息清空。
 */
export function WorkforceComposer(props: ComposerProps) {
  const [prefs] = useWorkforcePrefs()
  const isContinuationActive = props.continuationTask !== undefined && props.onContinueThread !== undefined
  const [continuationMode, setContinuationMode] = useState<'continue' | 'new'>(() =>
    resolveDefaultContinuationMode(props.continuationTask, props.continuationHasPendingQuestion)
  )
  // 只在任务、状态或待答提问变化时重算默认值；运行中 updatedAt 频繁变化，不能覆盖用户手动切换。
  const continuationFingerprint = props.continuationTask
    ? `${props.continuationTask.id}:${props.continuationTask.status}:${props.continuationHasPendingQuestion ?? false}`
    : ''
  const prevFingerprintRef = useRef(continuationFingerprint)
  useEffect(() => {
    if (continuationFingerprint !== prevFingerprintRef.current) {
      prevFingerprintRef.current = continuationFingerprint
      setContinuationMode(resolveDefaultContinuationMode(props.continuationTask, props.continuationHasPendingQuestion))
    }
  }, [continuationFingerprint])
  // done 任务的 10 分钟延续窗口到期时切到新任务；用户期间手动切过也以到期为准，吸附条可一键切回。
  const continuationDoneAt = props.continuationTask?.status === 'done' && !props.continuationHasPendingQuestion ? Date.parse(props.continuationTask.updatedAt ?? '') : NaN
  useEffect(() => {
    if (!Number.isFinite(continuationDoneAt)) return
    const remaining = continuationDoneAt + CONTINUATION_RECENT_WINDOW_MS - Date.now()
    if (remaining <= 0) return
    const timer = setTimeout(() => setContinuationMode('new'), remaining)
    return () => clearTimeout(timer)
  }, [continuationDoneAt])
  const [draft, setDraft] = useState(() => {
    try { return localStorage.getItem(`workforce.draft.${props.draftKey}`) ?? props.initialDraft ?? '' } catch { return props.initialDraft ?? '' }
  })
  useEffect(() => { try { localStorage.setItem(`workforce.draft.${props.draftKey}`, draft) } catch {} }, [draft, props.draftKey])
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ draftKey?: string; text?: string }>).detail
      if (detail && detail.draftKey === props.draftKey && typeof detail.text === 'string') {
        setDraft(detail.text)
        inputRef.current?.focus()
      }
    }
    window.addEventListener('workforce:fill-draft', handler)
    return () => window.removeEventListener('workforce:fill-draft', handler)
  }, [props.draftKey])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [trigger, setTrigger] = useState<ComposerTrigger | undefined>()
  const [triggerIndex, setTriggerIndex] = useState(0)
  const [skills, setSkills] = useState<readonly SkillSummary[] | undefined>()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sendRef = useRef(props.onSend)
  const retrySendRef = useRef<ComposerProps['onSend'] | undefined>(undefined)
  const draftRevision = useRef(0)
  sendRef.current = props.onSend
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([])
  const attachmentsRef = useRef<readonly ComposerAttachment[]>([])
  const nextAttachmentKey = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sendingRef = useRef(false)
  const mountedRef = useRef(true)
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const attachment of attachmentsRef.current) {
        if (attachment.previewUrl !== undefined) URL.revokeObjectURL(attachment.previewUrl)
      }
      attachmentsRef.current = []
    }
  }, [])

  const updateAttachments = (next: readonly ComposerAttachment[]): void => {
    attachmentsRef.current = next
    setAttachments(next)
  }

  const removeAttachment = (key: number): void => {
    const attachment = attachmentsRef.current.find(item => item.key === key)
    if (attachment?.previewUrl !== undefined) URL.revokeObjectURL(attachment.previewUrl)
    updateAttachments(attachmentsRef.current.filter(item => item.key !== key))
  }

  const addFiles = (files: FileList | readonly File[] | null): void => {
    const upload = props.onUploadFile
    if (upload === undefined || files === null) return
    for (const file of Array.from(files)) {
      const key = nextAttachmentKey.current++
      const tooLarge = file.size > MAX_ATTACHMENT_BYTES
      const attachment: ComposerAttachment = {
        key,
        name: file.name,
        sizeBytes: file.size,
        mime: file.type || 'application/octet-stream',
        ...(!tooLarge && attachmentKind(file.name, file.type) === 'image' ? { previewUrl: URL.createObjectURL(file) } : {}),
        ...(tooLarge ? { error: WF.taskStatus.attachmentSizeLimit } : {}),
      }
      updateAttachments([...attachmentsRef.current, attachment])
      if (tooLarge) continue
      void (async () => {
        try {
          const result = await upload(file)
          if (!mountedRef.current || !attachmentsRef.current.some(item => item.key === key)) return
          const uploaded: UploadedAttachment = {
            ...result,
            sizeBytes: result.sizeBytes ?? file.size,
            mime: result.mime || file.type || 'application/octet-stream',
          }
          updateAttachments(attachmentsRef.current.map(item => item.key === key ? { ...item, uploaded } : item))
        } catch (cause) {
          if (!mountedRef.current || !attachmentsRef.current.some(item => item.key === key)) return
          const reason = cause instanceof Error ? cause.message : String(cause)
          updateAttachments(attachmentsRef.current.map(item => item.key === key ? { ...item, error: reason } : item))
        }
      })()
    }
  }

  const uploading = attachments.some(attachment => attachment.uploaded === undefined && attachment.error === undefined)
  const sendDisabled = sending || attachments.some(attachment => attachment.uploaded === undefined)
    || (draft.trim() === '' && attachments.length === 0)

  // @ 与 / 共用同一触发词状态机：取光标前最近的触发词，两种候选共用一套导航。
  // / 只在词首（行首或空白后）生效，URL、路径与分数里的斜杠不触发。
  const refreshTrigger = (value: string, caret: number): void => {
    const before = value.slice(0, caret)
    const at = /@([^\s@]*)$/.exec(before)
    const slash = props.listSkills === undefined ? null : /(?:^|\s)\/([a-z0-9-]*)$/.exec(before)
    const atIndex = at === null ? -1 : before.length - (at[1] ?? '').length - 1
    const slashIndex = slash === null ? -1 : before.length - (slash[1] ?? '').length - 1
    if (slash !== null && slashIndex > atIndex) setTrigger({ kind: 'slash', query: slash[1] ?? '' })
    else if (at !== null && props.employees.length > 0) setTrigger({ kind: 'at', query: at[1] ?? '' })
    else setTrigger(undefined)
    setTriggerIndex(0)
  }

  useEffect(() => {
    if (trigger?.kind !== 'slash' || skills !== undefined || props.listSkills === undefined) return
    let alive = true
    void props.listSkills().then(list => { if (alive) setSkills(list) }).catch(() => { if (alive) setSkills([]) })
    return () => { alive = false }
  }, [trigger?.kind, skills, props.listSkills])

  const candidates = useMemo<TriggerItem[]>(() => {
    if (trigger === undefined) return []
    const q = trigger.query.toLowerCase()
    if (trigger.kind === 'at') {
      const members = props.mentionable ?? props.employees
      const matchEveryone = '所有人'.includes(q) || 'everyone'.includes(q) || 'all'.includes(q)
      const everyone: TriggerItem[] = props.allowMentionAll && members.length > 0 && matchEveryone
        ? [{
            key: 'mention:all',
            label: WF.composer.atEveryone,
            insert: `${WF.composer.atEveryone} `,
            meta: WF.composer.atEveryoneMeta(members.length),
            icon: <Icon name="users" width={22} height={22} />,
          }]
        : []
      return [...everyone, ...members
        .filter(employee => employee.name.toLowerCase().includes(q) || employee.title.toLowerCase().includes(q))
        .map(employee => ({
          key: employee.id, label: `@${employee.name}`, insert: `@${employee.name} `,
          meta: employee.title,
          icon: <WorkforceAvatar name={employee.name} isUser={false} color={employee.avatarColor} role={employee.role} style={prefs.avatarStyle} typingEffect={prefs.typingEffect} size={22} state="listening" live={true} />,
        }))]
    }
    // /name 走 dsh 原生 skill 手势：若指定了 allowedSkills，严格限制在当前员工绑定的技能范围内
    const allowed = props.allowedSkills !== undefined ? new Set(props.allowedSkills) : undefined
    return (skills ?? [])
      .filter(skill => skill.invocation?.userInvocable !== false)
      .filter(skill => allowed === undefined || allowed.has(skill.name))
      .filter(skill => skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q))
      .slice(0, 12)
      .map(skill => ({ key: skill.name, label: `/${skill.name}`, insert: `/${skill.name} `, meta: skill.description }))
  }, [trigger, props.employees, props.mentionable, props.allowMentionAll, props.allowedSkills, skills, prefs.avatarStyle, prefs.typingEffect])

  const applyTrigger = (item: TriggerItem): void => {
    const input = inputRef.current
    if (input === null || trigger === undefined) return
    const caret = input.selectionStart ?? draft.length
    const before = trigger.kind === 'at'
      ? draft.slice(0, caret).replace(/@[^\s@]*$/, item.insert)
      : draft.slice(0, caret).replace(/\/[a-z0-9-]*$/, item.insert)
    draftRevision.current += 1
    setDraft(before + draft.slice(caret))
    setTrigger(undefined)
    requestAnimationFrame(() => { input.focus(); const pos = before.length; input.setSelectionRange(pos, pos) })
  }

  const doSend = async (continueThread = false, retry = false, propagate = false): Promise<void> => {
    const text = draft.trim()
    const sentAttachments = attachmentsRef.current
    if (sendingRef.current || sentAttachments.some(attachment => attachment.uploaded === undefined)
      || (text === '' && sentAttachments.length === 0)) return
    // 收集全部 @ 提及：按在正文中的出现位置排序去重成收件人列表（正文仍带 "@名字"）。
    const boundary = /[\s,，。;；:：!！?？()（）]/
    const mentionPosition = (name: string, caseInsensitive = false): number => {
      const marker = `@${name}`
      const target = caseInsensitive ? text.toLowerCase() : text
      const search = caseInsensitive ? marker.toLowerCase() : marker
      for (let at = target.indexOf(search); at >= 0; at = target.indexOf(search, at + 1)) {
        const next = text[at + marker.length]
        if (next === undefined || boundary.test(next)) return at
      }
      return -1
    }
    const posZh = mentionPosition('所有人')
    const posEn = mentionPosition('everyone', true)
    const everyoneAt = props.allowMentionAll
      ? (posZh >= 0 && posEn >= 0 ? Math.min(posZh, posEn) : Math.max(posZh, posEn))
      : -1
    const everyoneRecipients = everyoneAt >= 0
      ? (props.mentionable ?? props.employees).map(employee => ({ id: employee.id, at: everyoneAt }))
      : []
    const mentionedIds = [...new Set([...props.employees
      .map(employee => ({ id: employee.id, at: mentionPosition(employee.name) }))
      .filter(item => item.at >= 0), ...everyoneRecipients]
      .sort((a, b) => a.at - b.at)
      .map(item => item.id))]
    const sentRevision = draftRevision.current
    const sentKeys = new Set(sentAttachments.map(attachment => attachment.key))
    sendingRef.current = true
    setSending(true)
    setError(undefined)
    try {
      const isContinuing = continuationMode === 'continue' && isContinuationActive
      const send = retry ? retrySendRef.current : (continueThread || isContinuing) ? props.onContinueThread : sendRef.current
      if (send === undefined) return
      retrySendRef.current = send
      await send(attachmentMessage(text, sentAttachments.map(attachment => attachment.uploaded!)), mentionedIds)
      retrySendRef.current = undefined
      if (!mountedRef.current) return
      for (const attachment of attachmentsRef.current) {
        if (sentKeys.has(attachment.key) && attachment.previewUrl !== undefined) URL.revokeObjectURL(attachment.previewUrl)
      }
      updateAttachments(attachmentsRef.current.filter(attachment => !sentKeys.has(attachment.key)))
      if (draftRevision.current === sentRevision) {
        setDraft('')
        setTrigger(undefined)
      }
    } catch (e) {
      // 发送失败：draft 和附件原样保留，可重试。
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e))
      if (propagate) throw e
    } finally {
      sendingRef.current = false
      if (mountedRef.current) setSending(false)
    }
  }
  // The composer keeps the host's draft/upload transaction and delegates sending through assistant-ui.
  const runtimeAttachments = useMemo(() => props.onUploadFile ? dshAttachmentAdapter(props.onUploadFile) : undefined, [props.onUploadFile])
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [], convertMessage: message => message, isRunning: sending, isSendDisabled: sendDisabled,
    onNew: async () => { await doSend(continuationMode === 'continue' && isContinuationActive, false, true) },
    ...(runtimeAttachments ? { adapters: { attachments: runtimeAttachments } } : {}),
  })
  useLayoutEffect(() => {
    const composer = runtime.thread.composer
    if (composer.getState().text !== draft) composer.setText(draft)
    const ready = attachments.filter(attachment => attachment.uploaded !== undefined)
    const nextIds = new Set(ready.map(attachment => `wb-upload-${attachment.key}`))
    for (const attachment of composer.getState().attachments) {
      if (!nextIds.has(attachment.id)) void composer.getAttachmentByIndex(composer.getState().attachments.findIndex(item => item.id === attachment.id)).remove()
    }
    const ids = new Set(composer.getState().attachments.map(attachment => attachment.id))
    for (const attachment of ready) {
      const id = `wb-upload-${attachment.key}`
      if (!ids.has(id)) void composer.addAttachment({
        id, name: attachment.name, type: attachment.mime.startsWith('image/') ? 'image' : 'file',
        contentType: attachment.mime, content: [{ type: 'text', text: attachmentMessage('', [attachment.uploaded!]) }],
      } satisfies CreateAttachment)
    }
  }, [runtime, draft, attachments, error])
  const continuationPrompt = props.continuationTask?.prompt?.trim() || props.continuationTask?.title || WF.taskStatus.currentTask
  const continuationFirstLine = continuationPrompt.split(/\r?\n/)[0]?.trim() || continuationPrompt
  return (
    <AssistantRuntimeProvider runtime={runtime}><div
      className={`${css.composerWrap}${dragging ? ` ${attachmentCss.dropActive}` : ''}`}
      onDragOver={event => {
        if (props.onUploadFile === undefined || !Array.from(event.dataTransfer.types).includes('Files')) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDragLeave={event => {
        const related = event.relatedTarget
        if (related instanceof Node && event.currentTarget.contains(related)) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom) return
        setDragging(false)
      }}
      onDrop={event => {
        if (props.onUploadFile === undefined || event.dataTransfer.files.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        setDragging(false)
        addFiles(event.dataTransfer.files)
      }}
      onPaste={event => {
        if (props.onUploadFile === undefined || event.clipboardData.files.length === 0) return
        event.preventDefault()
        addFiles(event.clipboardData.files)
      }}
    >
      {isContinuationActive && (
        continuationMode === 'continue' ? (
          <div className={css.contextRibbon}>
            <div className={css.contextRibbonPill}>
              <span className={css.contextRibbonLabel}>{WF.taskStatus.continueLabel}</span>
              <span className={css.contextRibbonIcon} aria-hidden="true">
                <Icon name="reply" width={13} height={13} />
              </span>
              <span className={css.contextRibbonTitle} title={continuationPrompt}>
                {continuationFirstLine}
              </span>
            </div>
            <Button variant="plain"
              type="button"
              className={css.contextRibbonBtn}
              onClick={() => {
                setContinuationMode('new')
                props.onResetContinuation?.()
              }}
              title={WF.taskStatus.startNewTaskTitle}
            >
              {WF.taskStatus.startNewTask}
            </Button>
          </div>
        ) : (
          <div className={css.contextRibbonNew}>
            <div className={css.contextRibbonPillNew}>
              <span className={css.contextRibbonIcon}>✨</span>
              <span className={css.contextRibbonLabel}>{WF.taskStatus.newTaskLabel}</span>
            </div>
            <Button variant="plain"
              type="button"
              className={css.contextRibbonBtn}
              onClick={() => setContinuationMode('continue')}
              title={WF.taskStatus.switchBackContinuationTitle}
            >
              {WF.taskStatus.switchBackContinuation}
            </Button>
          </div>
        )
      )}
      {trigger !== undefined && (
        <TriggerMenu
          items={candidates}
          activeIndex={Math.min(Math.max(0, triggerIndex), Math.max(0, candidates.length - 1))}
          loading={trigger.kind === 'slash' && skills === undefined}
          onPick={applyTrigger}
        />
      )}
      <ComposerPrimitive.Root className={css.composer} data-section="composer">
        {attachments.length > 0 && (
          <div className={attachmentCss.attachments} aria-label={WF.taskStatus.attachmentsToSendAria}>
            {attachments.map(attachment => {
              const kind = attachmentKind(attachment.name, attachment.mime)
              const label = kind === 'image' ? WF.taskStatus.typeImage : kind === 'video' ? WF.taskStatus.typeVideo : kind === 'audio' ? WF.taskStatus.typeAudio
                : attachment.name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toUpperCase() ?? WF.taskStatus.typeFile
              return (
                <div key={attachment.key} className={attachmentCss.chip} data-attachment-name={attachment.name}>
                  {attachment.previewUrl !== undefined
                    ? <img className={attachmentCss.preview} src={attachment.previewUrl} alt={attachment.name} />
                    : <span className={attachmentCss.kind} title={label}><FileTypeIcon path={attachment.name} size={24} /></span>}
                  <div className={attachmentCss.details}>
                    <span className={attachmentCss.name} title={attachment.name}>{attachment.name}</span>
                    <span className={attachmentCss.meta}>{formatFileSize(attachment.sizeBytes)} · {attachment.mime}</span>
                    {attachment.error !== undefined
                      ? <span className={attachmentCss.error} role="alert">{WF.taskStatus.uploadFailedPrefix}{attachment.error}</span>
                      : <span className={attachmentCss.meta} role="status">{attachment.uploaded === undefined ? WF.ui.uploadingState : WF.taskStatus.uploadSuccess}</span>}
                  </div>
                  <Button variant="plain" type="button" className={attachmentCss.remove} aria-label={WF.ui.removeAttachmentAria(attachment.name)} onClick={() => removeAttachment(attachment.key)}>×</Button>
                </div>
              )
            })}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={event => { addFiles(event.target.files); event.target.value = '' }}
        />
        <ComposerPrimitive.Input
          ref={inputRef}
          submitMode="none"
          addAttachmentOnPaste={false}
          cancelOnEscape={false}
          className={css.composerInput}
          aria-label={WF.composer.placeholder}
          placeholder={props.hint ?? (isContinuationActive ? (continuationMode === 'continue' ? WF.composer.replyToTask : WF.composer.startNewTaskHint) : WF.composer.placeholder)}
          value={draft}
          minRows={2}
          autoFocus={props.autoFocus === true}
          onChange={event => { draftRevision.current += 1; setDraft(event.target.value); refreshTrigger(event.target.value, event.target.selectionStart ?? 0) }}
          onFocus={event => { refreshTrigger(event.target.value, event.target.selectionStart ?? 0) }}
          onBlur={() => { setTrigger(undefined) }}
          onClick={event => { refreshTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? 0) }}
          onKeyUp={event => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              refreshTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)
            }
          }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (trigger !== undefined && candidates.length > 0) {
              if (event.key === 'ArrowDown') { event.preventDefault(); setTriggerIndex(i => (i + 1) % candidates.length); return }
              if (event.key === 'ArrowUp') { event.preventDefault(); setTriggerIndex(i => (i - 1 + candidates.length) % candidates.length); return }
              if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); applyTrigger(candidates[Math.min(triggerIndex, candidates.length - 1)]!); return }
              if (event.key === 'Escape') {
                if (draft.trim() === '' && continuationMode === 'continue' && isContinuationActive) {
                  event.preventDefault()
                  setContinuationMode('new')
                  props.onResetContinuation?.()
                  return
                }
                event.preventDefault()
                setTrigger(undefined)
                return
              }
            }
            if (event.key === 'Escape' && draft.trim() === '' && continuationMode === 'continue' && isContinuationActive) {
              event.preventDefault()
              setContinuationMode('new')
              props.onResetContinuation?.()
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); runtime.thread.composer.send() }
          }}
        />
        <div className={css.composerTools}>
          {props.onUploadFile !== undefined && (
            <Button variant="ghost" type="button" className={css.composerAttach} aria-label={WF.ui.attachmentsAria} title={WF.ui.attachmentsAria} onClick={() => fileInputRef.current?.click()}><Icon name="plus" /></Button>
          )}
          <span className={css.composerHint}>{WF.composer.placeholderTask}</span>
          <ComposerPrimitive.Send asChild><Button variant="primary" className={css.composerSend} disabled={sendDisabled} aria-label={sending ? WF.composer.sending : uploading ? WF.ui.uploadingState : WF.composer.send} title={WF.composer.send}>
            <Icon name={sending || uploading ? 'refresh' : 'send'} />
          </Button></ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
      {error !== undefined && (
        <div className={css.composerError} role="alert">
          <span>{WF.composer.sendFailed}：{error}</span>
          <Button variant="plain" type="button" className={css.composerErrorRetry} disabled={sendDisabled} onClick={() => void doSend(false, true)}>{WF.composer.retry}</Button>
        </div>
      )}
    </div></AssistantRuntimeProvider>
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
            <Button variant="plain"
              type="button"
              className={css.threadActionBtn}
              title={WF.taskStatus.threadFiles}
              aria-label={WF.taskStatus.threadFiles}
              onClick={() => setFilesOpen(true)}
            >
              <IconDeliverDocRegular size={14} />
            </Button>
            <Button variant="plain"
              type="button"
              className={css.threadClose}
              aria-label={WF.thread.close}
              onClick={onClose}
            >
              <IconCloseOutlineRegular size={16} />
            </Button>
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
      {view.error && <div className={css.streamError} role="alert">{view.error}<Button variant="plain" type="button" className={css.empAction} onClick={() => source.refresh()}>{WF.common.retry}</Button></div>}
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
              avatarStyle={prefs.avatarStyle}
              typingEffect={prefs.typingEffect}
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
            style={prefs.avatarStyle}
            typingEffect={prefs.typingEffect}
            source={source}
            task={footers.get(skeletonKey(sk))}
          />
        ))}
        </div>
      </div>
        {hasNewMessages && <Button variant="plain" type="button" className={css.newMessages} onClick={jumpToBottom}>{WF.message.newMessages}</Button>}
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

function generateStartersForEmployee(emp: Employee): readonly string[] {
  const role = (emp.role || '').toLowerCase()
  const title = emp.title || ''
  const name = emp.name || ''

  if (role.includes('analyst') || title.includes('分析') || name.includes('分析')) {
    return WF.dmStarters.analyst
  }

  if (role.includes('writer') || title.includes('文案') || title.includes('执行') || name.includes('文案') || name.includes('执行')) {
    return WF.dmStarters.writer
  }

  if (role.includes('leader') || emp.isLeader || title.includes('协调') || title.includes('负责')) {
    return WF.dmStarters.leader
  }

  return WF.dmStarters.generic(name)
}

function EmptyBotCard({ employee, channelTitle, avatarStyle, onSelectStarter }: {
  readonly employee: Employee | undefined
  readonly channelTitle?: string | undefined
  readonly avatarStyle: AvatarStyle
  readonly onSelectStarter: (text: string) => void
}) {
  const starters = useMemo(() => employee ? generateStartersForEmployee(employee) : WF.dmStarters.generic(channelTitle || ''), [employee, channelTitle])
  return (
    <div className={css.streamEmptyCard}>
      <div className={css.emptyCardAvatarWrap}>
        {employee ? (
          <WorkforceAvatar
            name={employee.name}
            color={employee.avatarColor}
            role={employee.role}
            size={40}
            style={avatarStyle}
          />
        ) : (
          <div className={css.emptyCardChannelIcon}>
            #
          </div>
        )}
      </div>
      <div className={css.emptyCardMeta}>
        <h3 className={css.emptyCardName}>{employee?.name ?? (channelTitle ? `# ${channelTitle}` : WF.brand)}</h3>
      </div>
      {starters.length > 0 && (
        <div className={css.emptyCardStarters}>
          {starters.map((starter, idx) => (
            <Button variant="plain"
              key={idx}
              type="button"
              className={css.emptyCardStarterBtn}
              onClick={() => onSelectStarter(starter)}
            >
              <span className={css.emptyCardStarterIcon} aria-hidden="true"><Icon name="chat" /></span>
              <span className={css.emptyCardStarterText}>{starter}</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

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
  const showStreamSkeleton = useDelayedLoading(
    (snapshot.phase === 'loading' || visibleThreads.some(thread => snapshot.messages[thread.id] === undefined)) && displayItems.length === 0,
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
  const targetEmployee = dmEmployee ?? (surface.kind === 'channel'
    ? (employees.find(e => (snapshot.channels.find(c => c.id === surface.id) as HostChannel | undefined)?.memberIds?.includes(e.id)) ?? employees[0])
    : undefined)
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
            {hasMessages && (
              <>
                <Button variant="plain" type="button" className={css.navigationToggle} aria-label={WF.workspace.expandChannelNav} onClick={onNavigation}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <line x1="4" y1="6" x2="20" y2="6"/>
                    <line x1="4" y1="12" x2="20" y2="12"/>
                    <line x1="4" y1="18" x2="20" y2="18"/>
                  </svg>
                </Button>
                <h2 className={css.streamTitle}>{surface.kind === 'channel' ? `# ${title}` : title}</h2>
                <span className={css.streamHeadDivider} aria-hidden="true" />
                <span className={css.streamDesc}>{desc}</span>
              </>
            )}
            <div className={css.streamSettingsWrap} ref={settingsRef} style={!hasMessages ? { marginLeft: 'auto' } : undefined}>
              <Button variant="plain"
                type="button"
                className={css.streamHeadActionBtn}
                title={WF.settings.menuLabel}
                aria-label={WF.settings.menuLabel}
                aria-expanded={actionMenuOpen}
                onClick={() => {
                  setActionMenuOpen(o => !o)
                  setSettingsOpen(false)
                }}
              >
                <Icon name="more" width={18} height={18} />
              </Button>
              {actionMenuOpen && (
                <div className={css.headActionDropdown} role="menu" aria-label={WF.taskStatus.actionsAndSettingsAria}>
                  {surface.kind === 'channel' && (
                    <Button variant="plain"
                      type="button"
                      className={css.dropdownItem}
                      role="menuitem"
                      onClick={() => {
                        setActionMenuOpen(false)
                        setMemoryScope('channel')
                      }}
                    >
                      <Icon name="memory" width={15} height={15} />
                      <span>{WF.taskStatus.channelMemoryTab}</span>
                    </Button>
                  )}
                  <Button variant="plain"
                    type="button"
                    className={css.dropdownItem}
                    role="menuitem"
                    onClick={() => {
                      setActionMenuOpen(false)
                      setFilesOpen(true)
                    }}
                  >
                    <Icon name="file" width={15} height={15} />
                    <span>{WF.taskStatus.sessionFilesTab}</span>
                  </Button>
                  <Button variant="plain"
                    type="button"
                    className={css.dropdownItem}
                    role="menuitem"
                    onClick={() => {
                      setActionMenuOpen(false)
                      openModels()
                    }}
                  >
                    <Icon name="settings" width={15} height={15} />
                    <span>{WF.models.title}</span>
                  </Button>
                  <div className={css.dropdownDivider} />
                  <Button variant="plain"
                    type="button"
                    className={css.dropdownItem}
                    role="menuitem"
                    onClick={() => {
                      setActionMenuOpen(false)
                      setSettingsOpen(true)
                    }}
                  >
                    <Icon name="settings" width={15} height={15} />
                    <span>{WF.settings.preferences}</span>
                  </Button>
                </div>
              )}
              {settingsOpen && (
                <div className={css.settingsMenu} role="group" aria-label={WF.settings.menuLabel}>
                  <div className={css.settingsSection}>
                    <div className={css.settingsSectionTitle}>{WF.replyGroup.settingsTitle}</div>
                    <RadioGroup label={WF.replyGroup.settingsTitle} value={prefs.replyGrouping ?? 'summary'} onValueChange={value => setPrefs({ replyGrouping: value as ReplyGrouping })} items={[{ value: 'summary', label: WF.replyGroup.summary }, { value: 'expanded', label: WF.replyGroup.expanded }, { value: 'collapsed', label: WF.replyGroup.collapsed }]} /><div className={css.settingsHint}>{WF.replyGroup.summaryDesc}</div>
                  </div>
                  <div className={css.settingsDivider} />
                  <div className={css.settingsSection}>
                    <div className={css.settingsSectionTitle}>{WF.settings.monitoringTitle}</div>
                    <label className={css.settingsCheckbox}>
                      <Checkbox
                        checked={prefs.showTokenStats !== false}
                        onCheckedChange={value => setPrefs({ showTokenStats: value === true })}
                      />
                      <span>{WF.settings.showTokens}</span>
                    </label>
                  </div>
                  <div className={css.settingsSection}>
                    <div className={css.settingsSectionTitle}>{WF.settings.schemeTitle}</div>
                    <RadioGroup label={WF.settings.schemeTitle} value={prefs.scheme} onValueChange={value => setPrefs({ scheme: value as typeof prefs.scheme })} items={[{ value: 'system', label: WF.settings.schemeSystem }, { value: 'light', label: WF.settings.schemeLight }, { value: 'dark', label: WF.settings.schemeDark }]} />
                  </div>
                  <div className={css.settingsDivider} />
                  <div className={css.settingsSection}>
                    <div className={css.settingsSectionTitle}>{WF.settings.avatarStyleTitle}</div>
                    <RadioGroup label={WF.settings.avatarStyleTitle} value={prefs.avatarStyle} onValueChange={value => setPrefs({ avatarStyle: value as AvatarStyle })} items={[{ value: 'circle', label: WF.settings.avatarStyleCircle }, { value: 'terminal', label: WF.settings.avatarStyleTerminal }]} />
                  </div>
                  <div className={css.settingsDivider} />
                  <div className={css.settingsSection}>
                    <div className={css.settingsSectionTitle}>{WF.settings.typingEffectTitle}</div>
                    <RadioGroup label={WF.settings.typingEffectTitle} value={prefs.typingEffect} onValueChange={value => setPrefs({ typingEffect: value as TypingEffect })} items={[{ value: 'hash', label: WF.settings.typingEffectHash }, { value: 'binary', label: WF.settings.typingEffectBinary }, { value: 'cli', label: WF.settings.typingEffectCli }]} />
                  </div>
                  <div className={css.settingsDivider} />
                  <div className={css.settingsSection}>
                    <div className={css.settingsSectionTitle}>{WF.settings.showStepsTitle}</div>
                    <label className={css.settingsCheckbox}>
                      <Checkbox
                        checked={prefs.showSteps}
                        onCheckedChange={value => setPrefs({ showSteps: value === true })}
                      />
                      <span>{WF.settings.showSteps}</span>
                    </label>
                    <div className={css.settingsHint}>{WF.settings.showStepsDesc}</div>
                  </div>
                  <div className={css.settingsDivider} />
                  <div className={css.settingsSection}>
                    <Button variant="plain" type="button" className={css.settingsMenuAction} onClick={() => { setSettingsOpen(false); setMemoryScope('global') }}>{WF.taskStatus.globalMemoryTitle}</Button>
                    <Button variant="plain" type="button" className={css.settingsMenuAction} onClick={() => { setSettingsOpen(false); setSkillDraftsOpen(true) }}>
                      {WF.skillDrafts.menuTitle}{pendingDraftCount > 0 ? `（${WF.skillDrafts.pendingBadge(pendingDraftCount)}）` : ''}
                    </Button>
                    <Button variant="plain" type="button" className={css.settingsMenuAction} onClick={() => { setSettingsOpen(false); setDiagnosticsOpen(true) }}>{WF.diagnostics.title}</Button>
                    <Button variant="plain" type="button" className={css.settingsMenuAction} onClick={() => { setSettingsOpen(false); setBackupOpen(true) }}>{WF.backup.title}</Button>
                  </div>
                  <div className={css.settingsDivider} />
                  <div className={css.settingsSection}>
                    <div className={css.settingsSectionTitle}>{WF.models.title} (BYOK)</div>
                    <Button variant="plain"
                      type="button"
                      className={css.settingsMenuAction}
                      onClick={() => {
                        setSettingsOpen(false)
                        openModels()
                      }}
                    >
                      <span>{WF.models.title}</span>
                      <Icon name="settings" width={14} height={14} />
                    </Button>
                    <Button variant="plain" type="button" className={css.settingsMenuAction} onClick={() => { setSettingsOpen(false); openModels() }}>{WF.models.openGuide}</Button>
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
          <div className={css.messageList} ref={contentRef}>
          <EarlierMessages loading={earlierLoading} errors={earlierErrors} onEarlier={requestEarlier} />
          {showStreamSkeleton ? (
            <MessageStreamSkeleton />
          ) : !hasMessages ? (
            <div className={css.streamEmptyArea}>
              <EmptyBotCard
                employee={targetEmployee}
                channelTitle={surface.kind === 'channel' ? title : undefined}
                avatarStyle={prefs.avatarStyle}
                onSelectStarter={text => {
                  window.dispatchEvent(new CustomEvent('workforce:fill-draft', { detail: { draftKey: activeThreadId, text } }))
                }}
              />
            </div>
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
                    avatarStyle={prefs.avatarStyle}
                    typingEffect={prefs.typingEffect}
                    source={source}
                    task={task}
                    taskQuiet={task !== undefined && quietTaskIds.has(task.id)}
                    tasks={tasksStable}
                    onSelectContinuation={surface.kind === 'channel' ? (t => setSelectedContinuationTaskId(t.id)) : undefined}
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
                      avatarStyle={prefs.avatarStyle}
                      typingEffect={prefs.typingEffect}
                      activities={activities}
                      onToggleExpanded={() => toggleGroup(messageGroup.parentId)}
                      onOpenPreview={messageId => setPreviewTarget({ groupId: messageGroup.parentId, messageId })}
                      footer={groupTask === undefined ? undefined : (
                        <TaskFooter
                          task={groupTask}
                          employees={employeesStable}
                          source={source}
                          quiet={quietTaskIds.has(groupTask.id)}
                          onSelectContinuation={surface.kind === 'channel' ? (t => setSelectedContinuationTaskId(t.id)) : undefined}
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
                          avatarStyle={prefs.avatarStyle}
                          typingEffect={prefs.typingEffect}
                          source={source}
                          task={footers.get(member.id)}
                          taskQuiet={footers.get(member.id) !== undefined && quietTaskIds.has(footers.get(member.id)!.id)}
                          tasks={tasksStable}
                          onSelectContinuation={surface.kind === 'channel' ? (t => setSelectedContinuationTaskId(t.id)) : undefined}
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
              style={prefs.avatarStyle}
              typingEffect={prefs.typingEffect}
              source={source}
              task={footers.get(skeletonKey(sk))}
            />
          ))}
          </div>
        </div>
          {hasNewMessages && <Button variant="plain" type="button" className={css.newMessages} onClick={jumpToBottom}>{WF.message.newMessages}</Button>}
          {replyJump.notice !== undefined && <div className={css.replyJumpNotice} role="status">{replyJump.notice}</div>}
        </div>
        {deletedDm && <div className={css.taskActions}>{WF.taskStatus.deletedEmployeeNotice}</div>}
        {activeThreadId !== undefined && !deletedDm && (
          <WorkforceComposer
            key={activeThreadId}
            draftKey={activeThreadId}
            hint={surface.kind === 'channel'
              ? WF.composer.messageChannel(title)
              : WF.composer.messageDm(dmEmployee?.name || title)}
            employees={employees}
            mentionable={mentionable}
            allowMentionAll={surface.kind === 'channel'}
            allowedSkills={surface.kind === 'dm' ? employees.find(e => e.id === surface.employeeId)?.skills : undefined}
            onSend={(text, employeeIds) => source.send(activeThreadId, text, employeeIds)}
            continuationTask={surface.kind === 'channel' ? activeContinuationTask : undefined}
            continuationHasPendingQuestion={surface.kind === 'channel' && activeContinuationTask !== undefined && (
              (snapshot.messages[activeContinuationTask.threadId]?.list ?? messages).some(m =>
                m.threadId === activeContinuationTask.threadId && (
                  (m.question !== undefined && m.question.answered === undefined && m.question.status !== 'answered' && m.question.status !== 'inactive') ||
                  (m.approval !== undefined && m.approval.answered === undefined && m.approval.status !== 'answered' && m.approval.status !== 'inactive')
                )
              )
            )}
            onContinueThread={surface.kind === 'channel' && activeContinuationTask ? async (text, employeeIds) => {
              await source.send(activeContinuationTask.threadId, text, employeeIds)
            } : undefined}
            onResetContinuation={() => setSelectedContinuationTaskId(null)}
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
  const { source, snapshot, surface } = props
  const view = useMemo(() => surface.kind === 'channel'
    ? channelStream(snapshot, surface.id)
    : { messages: threadView(snapshot, surface.threadId).list, threads: snapshot.threads.filter(thread => thread.id === surface.threadId) }, [snapshot, surface])
  const target = surface.kind === 'dm' ? surface.threadId : view.threads.find(thread => thread.kind === 'channel')?.id
  return <WorkforceAssistantRuntime key={`${surface.kind}:${surface.kind === 'channel' ? surface.id : surface.threadId}`} source={source} snapshot={snapshot} messages={view.messages} threadIds={view.threads.map(thread => thread.id)} targetThreadId={target}>
    <WorkforceMainContent {...props} />
  </WorkforceAssistantRuntime>
}

export function ThreadPanel(props: ComponentProps<typeof ThreadPanelContent>) {
  const snapshot = useSyncExternalStore(props.source.subscribe, props.source.getSnapshot, props.source.getSnapshot)
  return <WorkforceAssistantRuntime key={props.threadId} source={props.source} snapshot={snapshot} messages={threadView(snapshot, props.threadId).list} threadIds={[props.threadId]} targetThreadId={props.threadId}>
    <ThreadPanelContent {...props} />
  </WorkforceAssistantRuntime>
}
