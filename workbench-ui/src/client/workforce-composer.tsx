/**
 * 工作区输入区：@ 员工与 / skill 触发浮层、附件上传、任务延续吸附条与发送状态机。
 * 从 workforce.tsx 拆出；消费方只有 WorkforceMain 与 composer 测试。
 */
import { MaterialFileTypeIcon } from '@lobehub/ui'
import { Button as LobeButton } from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
import { attachmentKind, formatFileSize } from './workforce-attachments.tsx'
import { WorkforceAvatar } from './workforce-avatar.tsx'
import { Icon } from './ui/icons.tsx'
import css from './workforce.module.css'
import attachmentCss from './workforce-composer-attachments.module.css'
import { WF } from './workforce-strings.ts'
import { TriggerMenu, type ComposerTrigger, type ContinuationMode, type TriggerItem } from './workforce-composer-helpers.tsx'
import type { Employee, SkillSummary, Task } from './workforce-types.ts'
import { attachmentMessage, MAX_ATTACHMENT_BYTES, type UploadedAttachment } from './workforce-upload.ts'

export interface ComposerAttachment {
  readonly key: number
  readonly name: string
  readonly sizeBytes: number
  readonly mime: string
  readonly previewUrl?: string
  readonly uploaded?: UploadedAttachment
  readonly error?: string
}

export interface ComposerProps {
  readonly employees: readonly Employee[]
  /** @ 浮层候选：群聊限定成员名单；缺省 = 全部员工。正文里手写 @ 仍按全员工解析，由宿主校验成员范围。 */
  readonly mentionable?: readonly Employee[] | undefined
  /** 频道输入框支持 @所有人，发送时展开为当前频道成员。私信和任务线程不启用。 */
  readonly allowMentionAll?: boolean
  readonly onSend: (text: string, employeeIds: readonly string[]) => Promise<void>
  /** 当前员工绑定的偏好技能优先展示；宿主已有技能仍可搜索和调用。 */
  readonly preferredSkills?: readonly string[] | undefined
  /** 当前会话可调用的技能；线程与私信由目标员工的技能表限定。 */
  readonly allowedSkills?: readonly string[] | undefined
  /** Slash 浮层的 skill 目录加载器；缺省时 / 不触发浮层。 */
  readonly listSkills?: () => Promise<SkillSummary[]>
  readonly onUploadMaterial: ((name: string, content: string) => Promise<{ id: string; name: string; url: string }>) | undefined
  readonly onUploadFile?: ((file: File) => Promise<UploadedAttachment>) | undefined
  readonly autoFocus?: boolean
  readonly initialDraft?: string | undefined
  readonly draftKey: string
  /** 当前会话的一次预填请求；只追加草稿并聚焦，不触发发送。 */
  readonly prefillRequest?: ComposerPrefillRequest | undefined
  readonly onPrefillApplied?: ((request: ComposerPrefillRequest) => void) | undefined
  readonly hint?: string | undefined
  readonly continuationTask?: Task | undefined
  readonly onContinueThread?: ((text: string, employeeIds: readonly string[]) => Promise<void>) | undefined
  /** 任务大厅的延续模式由页面持有，消息流的上下文分隔线与它同步。 */
  readonly continuationMode?: ContinuationMode | undefined
  readonly onContinuationModeChange?: ((mode: ContinuationMode) => void) | undefined
}

export interface ComposerPrefillRequest {
  readonly draftKey: string
  readonly id: number
  readonly text: string
}

/**
 * Enter 发送、Shift+Enter 换行；@ 选择员工。文件先上传，成功后附到消息正文。
 * 发送失败保留正文和附件；发送期间新增的草稿与附件不随旧消息清空。
 */
export function WorkforceComposer(props: ComposerProps) {
  const isContinuationActive = props.continuationTask !== undefined && props.onContinueThread !== undefined
  const continuationMode = props.continuationMode ?? 'new'
  const setContinuationMode = (mode: ContinuationMode) => props.onContinuationModeChange?.(mode)
  const [draft, setDraft] = useState(() => {
    try { return localStorage.getItem(`workforce.draft.${props.draftKey}`) ?? props.initialDraft ?? '' } catch { return props.initialDraft ?? '' }
  })
  useEffect(() => { try { localStorage.setItem(`workforce.draft.${props.draftKey}`, draft) } catch {} }, [draft, props.draftKey])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [trigger, setTrigger] = useState<ComposerTrigger | undefined>()
  const [triggerIndex, setTriggerIndex] = useState(0)
  const [skills, setSkills] = useState<readonly SkillSummary[] | undefined>()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sendRef = useRef(props.onSend)
  const retrySendRef = useRef<ComposerProps['onSend'] | undefined>(undefined)
  const draftRevision = useRef(0)
  const appliedPrefillRef = useRef<{ readonly draftKey: string; readonly id: number }>()
  useEffect(() => {
    const request = props.prefillRequest
    if (request === undefined || request.draftKey !== props.draftKey) return
    const applied = appliedPrefillRef.current
    if (applied?.draftKey === request.draftKey && applied.id === request.id) return
    // 在更新草稿前记住请求；StrictMode 重放 effect 时不能追加第二遍。
    appliedPrefillRef.current = { draftKey: request.draftKey, id: request.id }
    draftRevision.current += 1
    setDraft(current => current.trim() === ''
      ? request.text
      : `${current}${current.endsWith('\n') ? '' : '\n'}${request.text}`)
    setTrigger(undefined)
    setError(undefined)
    props.onPrefillApplied?.(request)
    window.requestAnimationFrame(() => {
      const input = inputRef.current
      if (input === null) return
      input.focus({ preventScroll: true })
      input.setSelectionRange(input.value.length, input.value.length)
    })
  }, [props.prefillRequest, props.draftKey, props.onPrefillApplied])
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
      const everyone: TriggerItem[] = props.allowMentionAll && members.length > 0 && ('所有人'.includes(q) || 'all'.includes(q))
        ? [{ key: 'mention:all', label: WF.composer.atEveryone, insert: '@所有人 ', meta: WF.composer.atEveryoneMeta(members.length), icon: <Icon name="users" width={22} height={22} /> }]
        : []
      return [...everyone, ...members
        .filter(employee => employee.name.toLowerCase().includes(q) || employee.title.toLowerCase().includes(q))
        .map(employee => ({
          key: employee.id, label: `@${employee.name}`, insert: `@${employee.name} `,
          meta: employee.title,
          icon: <WorkforceAvatar name={employee.name} isUser={false} color={employee.avatarColor} role={employee.role} size={22} state="listening" live={true} />,
        }))]
    }
    // /name 走 dsh 原生 skill 手势：员工绑定用于排序，不隔离宿主已有技能。
    const preferred = new Set(props.preferredSkills ?? [])
    const allowed = props.allowedSkills === undefined ? undefined : new Set(props.allowedSkills)
    return (skills ?? [])
      .filter(skill => skill.invocation?.userInvocable !== false)
      .filter(skill => allowed === undefined || allowed.has(skill.name))
      .filter(skill => skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q))
      .sort((a, b) => Number(preferred.has(b.name)) - Number(preferred.has(a.name)))
      .slice(0, 12)
      .map(skill => ({ key: skill.name, label: `/${skill.name}`, insert: `/${skill.name} `, meta: skill.description }))
  }, [trigger, props.employees, props.mentionable, props.allowMentionAll, props.preferredSkills, props.allowedSkills, skills])

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

  const doSend = async (continueThread = false, retry = false): Promise<void> => {
    const text = draft.trim()
    const sentAttachments = attachmentsRef.current
    if (sendingRef.current || sentAttachments.some(attachment => attachment.uploaded === undefined)
      || (text === '' && sentAttachments.length === 0)) return
    // 收集全部 @ 提及：按在正文中的出现位置排序去重成收件人列表（正文仍带 "@名字"）。
    const boundary = /[\s,，。;；:：!！?？()（）]/
    const mentionPosition = (name: string): number => {
      const marker = `@${name}`
      for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + 1)) {
        const next = text[at + marker.length]
        if (next === undefined || boundary.test(next)) return at
      }
      return -1
    }
    const everyoneAt = props.allowMentionAll ? mentionPosition('所有人') : -1
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
    } finally {
      sendingRef.current = false
      if (mountedRef.current) setSending(false)
    }
  }
  return (
    <div
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
      {trigger !== undefined && (
        <TriggerMenu
          items={candidates}
          activeIndex={Math.min(Math.max(0, triggerIndex), Math.max(0, candidates.length - 1))}
          loading={trigger.kind === 'slash' && skills === undefined}
          onPick={applyTrigger}
        />
      )}
      <div className={css.composer} data-section="composer">
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
                    : <span className={attachmentCss.kind} title={label}><MaterialFileTypeIcon filename={attachment.name} size={24} /></span>}
                  <div className={attachmentCss.details}>
                    <span className={attachmentCss.name} title={attachment.name}>{attachment.name}</span>
                    <span className={attachmentCss.meta}>{formatFileSize(attachment.sizeBytes)} · {attachment.mime}</span>
                    {attachment.error !== undefined
                      ? <span className={attachmentCss.error} role="alert">{WF.taskStatus.uploadFailedPrefix}{attachment.error}</span>
                      : <span className={attachmentCss.meta} role="status">{attachment.uploaded === undefined ? `${WF.ui.uploadingState}…` : WF.taskStatus.uploadSuccess}</span>}
                  </div>
                  <LobeButton type="text" size="small" className={attachmentCss.remove ?? ''} aria-label={WF.ui.removeAttachmentAria(attachment.name)} onClick={() => removeAttachment(attachment.key)}><Icon name="close" width={14} height={14} /></LobeButton>
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
        <textarea
          ref={inputRef}
          className={css.composerInput}
          aria-label={WF.composer.placeholder}
          placeholder={props.hint ?? (isContinuationActive ? (continuationMode === 'continue' ? WF.taskStatus.replyTaskPlaceholder : WF.taskStatus.startNewTaskPlaceholder) : WF.composer.placeholder)}
          value={draft}
          rows={2}
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
                event.preventDefault()
                setTrigger(undefined)
                return
              }
            }
            if (event.key === 'Escape' && continuationMode === 'new' && isContinuationActive) {
              event.preventDefault()
              setContinuationMode('continue')
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void doSend(continuationMode === 'continue' && isContinuationActive) }
          }}
        />
        <div className={css.composerTools}>
          {isContinuationActive && (
            <button
              type="button"
              className={css.newTaskToggle}
              aria-pressed={continuationMode === 'new'}
              onClick={() => setContinuationMode(continuationMode === 'new' ? 'continue' : 'new')}
              title={continuationMode === 'new' ? WF.taskStatus.cancelNewTaskTitle : WF.taskStatus.newModeTitle}
            >
              <Icon name={continuationMode === 'new' ? 'close' : 'plus'} width={14} height={14} />
              {WF.taskStatus.newModeLabel}
            </button>
          )}
          <span className={css.composerHint}>{WF.composer.placeholderTask}</span>
          {props.onUploadFile !== undefined && (
            <button
              type="button"
              className={css.composerAttach}
              onClick={() => fileInputRef.current?.click()}
              aria-label={WF.ui.attachmentsAria}
              title={WF.ui.attachmentsAria}
            >
              <Icon name="paperclip" />
            </button>
          )}
          <button
            type="button"
            className={css.composerSend}
            disabled={sendDisabled}
            onClick={() => void doSend(continuationMode === 'continue' && isContinuationActive)}
            aria-label={sending ? WF.composer.sending : uploading ? `${WF.ui.uploadingState}…` : WF.composer.send}
            title={sending ? WF.composer.sending : uploading ? `${WF.ui.uploadingState}…` : WF.composer.send}
          >
            <Icon name="send" />
          </button>
        </div>
      </div>
      {error !== undefined && (
        <div className={css.composerError} role="alert">
          <span>{WF.composer.sendFailed}：{error}</span>
          <LobeButton type="text" size="small" className={css.composerErrorRetry ?? ''} disabled={sendDisabled} onClick={() => void doSend(false, true)}>{WF.composer.retry}</LobeButton>
        </div>
      )}
    </div>
  )
}
