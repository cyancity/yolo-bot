import { useState, useRef } from 'react'
import css from './workforce-question-card.module.css'
import { Input, Tag } from '@lobehub/ui'
import { Button } from 'antd'
import { IconButton, Menu } from './ui/index.tsx'
import { Icon } from './ui/icons.tsx'
import { WF } from './workforce-strings.ts'

/** One option of a question item (mirrors host WorkforceQuestionOption). */
export interface QuestionCardOption {
  label: string
  description?: string
}

/** One question inside the card (mirrors host WorkforceQuestionItem). */
export interface QuestionCardItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: QuestionCardOption[]
  multiSelect?: boolean
}

/** One submitted answer item (mirrors host WorkforceQuestionAnswerItem). */
export interface QuestionCardAnswer {
  id: string
  selected: string[]
  custom?: string
}

/** Lifecycle/wire status of a question or approval request. */
export type QuestionCardStatus = 'active' | 'continued' | 'answered' | 'inactive'

/** Answerable question payload carried on a message row (`message.question`). */
export interface QuestionCardQuestion {
  requestId: string
  callId?: string
  status?: QuestionCardStatus
  /** Timed question whose foreground wait ended; still answerable. */
  continued?: boolean
  items: QuestionCardItem[]
  answered?: QuestionCardAnswer[]
}

/** Answerable approval payload carried on a message row (`message.approval`). */
export interface QuestionCardApproval {
  requestId: string
  toolName: string
  callId?: string
  status?: QuestionCardStatus
  reason?: string
  /** 原生权限说明（displayReason），缺省时只显示 reason。 */
  displayReason?: string
  /** 同 session 同 callId 的真实调用参数摘要，已脱敏、限长；取不到时缺省，不用模型理由代替。 */
  detail?: { text: string; truncated: boolean }
  answered?: 'allowed-once' | 'rejected'
}

export interface WorkforceQuestionCardProps {
  question?: QuestionCardQuestion | undefined
  approval?: QuestionCardApproval | undefined
  /**
   * Submit the user's answer. Wire it to
   * `POST /wb/api/workforce/threads/<threadId>/asks/<requestId>` with body
   * `{ answers: QuestionCardAnswer[] }` for questions or `{ outcome }` for approvals.
   */
  onAnswer(requestId: string, payload: { answers?: QuestionCardAnswer[]; outcome?: 'allowed-once' | 'rejected' }): Promise<unknown> | unknown
}

const approvalLabel = (outcome: 'allowed-once' | 'rejected') => outcome === 'allowed-once' ? WF.questions.allowedOnce : WF.questions.rejected

/** Question/approval card an employee raises to the user; answered state is read-only. */
export function WorkforceQuestionCard({ question, approval, onAnswer }: WorkforceQuestionCardProps) {
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [customs, setCustoms] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [answered, setAnswered] = useState<QuestionCardAnswer[] | 'allowed-once' | 'rejected' | undefined>(question?.answered ?? approval?.answered)
  const [error, setError] = useState('')

  const requestId = question?.requestId ?? approval?.requestId ?? ''
  const isInactiveProp = question?.status === 'inactive' || approval?.status === 'inactive'
  const [latchedInactive, setLatchedInactive] = useState(isInactiveProp)
  const [prevRequestId, setPrevRequestId] = useState(requestId)
  const generationRef = useRef(0)
  const activeRequestIdRef = useRef(requestId)
  activeRequestIdRef.current = requestId

  if (requestId !== prevRequestId) {
    setPrevRequestId(requestId)
    generationRef.current += 1
    setSubmitting(false)
    setLatchedInactive(isInactiveProp)
    setSelected({})
    setCustoms({})
    setError('')
    setAnswered(question?.answered ?? approval?.answered)
  } else if (isInactiveProp && !latchedInactive) {
    setLatchedInactive(true)
  }

  const inactive = isInactiveProp || latchedInactive
  const isAnswered = Boolean(
    answered !== undefined ||
    (approval ? approval.answered !== undefined || approval.status === 'answered' : question?.answered !== undefined || question?.status === 'answered')
  )

  const submit = async (payload: { answers?: QuestionCardAnswer[]; outcome?: 'allowed-once' | 'rejected' }) => {
    if (submitting || inactive || isAnswered) return
    const callGen = generationRef.current
    const callRequestId = requestId
    setSubmitting(true)
    setError('')
    try {
      await onAnswer(callRequestId, payload)
      if (generationRef.current !== callGen || activeRequestIdRef.current !== callRequestId) return
      if (payload.outcome !== undefined) setAnswered(payload.outcome)
      else setAnswered(payload.answers ?? [])
    } catch (cause) {
      if (generationRef.current !== callGen || activeRequestIdRef.current !== callRequestId) return
      setError(cause instanceof Error ? cause.message : WF.questions.submitFailed)
    } finally {
      if (generationRef.current === callGen && activeRequestIdRef.current === callRequestId) {
        setSubmitting(false)
      }
    }
  }

  if (approval) {
    const done = answered === 'allowed-once' || answered === 'rejected' ? answered : approval.answered
    const isApprovalAnswered = done !== undefined || approval.status === 'answered'
    const disabled = submitting || inactive || isApprovalAnswered
    return (
      <div className={css.card} data-ask-card="approval">
        <div className={css.title}>{inactive ? WF.questions.requestEnded : WF.questions.requestApproval}</div>
        <div className={css.questionText}>{WF.questions.needsApproval(approval.toolName)}</div>
        {approval.displayReason ? <div className={css.detail}>{approval.displayReason}</div> : null}
        {/* 原生 reason 是英文前缀 + 同一段理由，有本地化 displayReason 时不重复显示 */}
        {approval.reason && !approval.displayReason ? <div className={css.detail}>{approval.reason}</div> : null}
        {approval.detail ? (
          <details className={css.detailDisclosure}>
            <summary className={css.detailToggle}>{WF.questions.operationDetail(Boolean(approval.detail.truncated))}</summary>
            <pre className={css.detailBody}>{approval.detail.text}</pre>
          </details>
        ) : (
          <div className={css.detailMissing}>{WF.questions.detailUnavailable}</div>
        )}
        {done !== undefined ? (
          <div className={css.answeredWrap}>
            <Tag color={done === 'allowed-once' ? 'success' : 'default'} className={css.answeredTag ?? ''}>{approvalLabel(done)}</Tag>
          </div>
        ) : (
          <div className={css.approvalActions}>
            {/* 单主按钮：本卡唯一实底动作是「允许一次」，拒绝收进更多菜单（danger）。 */}
            <Button
              type="primary"
              disabled={disabled}
              loading={submitting}
              onClick={() => { if (!disabled) void submit({ outcome: 'allowed-once' }) }}
            >
              {WF.questions.allowOnce}
            </Button>
            <Menu
              label={WF.questions.moreApprovalActions}
              side="top"
              trigger={<IconButton label={WF.questions.moreApprovalActions} icon={<Icon name="more" />} size="sm" disabled={disabled} />}
              items={[{ id: 'reject', label: WF.questions.reject, tone: 'danger', onSelect: () => { if (!disabled) void submit({ outcome: 'rejected' }) } }]}
            />
          </div>
        )}
        {error ? <div className={css.error}>{error}</div> : null}
      </div>
    )
  }
  if (!question) return null

  const done = answered !== undefined && answered !== 'allowed-once' && answered !== 'rejected' ? answered : question.answered
  const isQuestionAnswered = done !== undefined || question.status === 'answered'
  const disabled = submitting || inactive || isQuestionAnswered
  const isContinued = Boolean(question.continued || question.status === 'continued')
  const toggle = (item: QuestionCardItem, label: string) => {
    if (disabled) return
    const current = new Set(selected[item.id] ?? [])
    if (item.multiSelect) current.has(label) ? current.delete(label) : current.add(label)
    else {
      current.clear()
      current.add(label)
    }
    setSelected({ ...selected, [item.id]: [...current] })
  }
  const complete = question.items.every(item => (selected[item.id] ?? []).length > 0 || (customs[item.id] ?? '').trim().length > 0)
  const answersOf = (items: QuestionCardItem[]): QuestionCardAnswer[] => items.map(item => ({
    id: item.id,
    selected: selected[item.id] ?? [],
    ...((customs[item.id] ?? '').trim() ? { custom: customs[item.id] } : {}),
  }))

  return (
    <div className={css.card} data-ask-card="question">
      <div className={css.title}>{inactive ? WF.questions.questionEnded : isContinued ? WF.questions.additionalQuestion : WF.questions.askQuestion}</div>
      {question.items.map(item => {
        const answeredItem = done?.find(answer => answer.id === item.id)
        const itemSelected = selected[item.id] ?? []
        return (
          <div className={css.item} key={item.id}>
            {item.header ? <div className={css.header}>{item.header}</div> : null}
            <div className={css.questionText}>{item.question}</div>
            {item.detail ? <div className={css.detail}>{item.detail}</div> : null}
            {done !== undefined ? (
              <div className={css.answeredList}>
                {(answeredItem?.selected ?? []).map(label => <Tag color="processing" className={css.answeredTag ?? ''} key={label}>{label}</Tag>)}
                {answeredItem?.custom ? <span className={css.answeredCustom}>{answeredItem.custom}</span> : null}
                {answeredItem !== undefined && answeredItem.selected.length === 0 && !answeredItem.custom ? <Tag className={css.answeredTag ?? ''}>{WF.questions.skipped}</Tag> : null}
              </div>
            ) : (
              <>
                {item.options?.length ? (
                  <div className={css.options} role={item.multiSelect ? 'group' : 'radiogroup'} aria-label={item.question}>
                    {item.options.map(option => {
                      const isSelected = itemSelected.includes(option.label)
                      return (
                        <button
                          type="button"
                          key={option.label}
                          role={item.multiSelect ? 'checkbox' : 'radio'}
                          aria-checked={isSelected}
                          className={`${css.option}${isSelected ? ` ${css.optionSelected}` : ''}`}
                          disabled={disabled}
                          onClick={() => toggle(item, option.label)}
                        >
                          <span className={`${css.optionIndicator} ${item.multiSelect ? css.optionCheckbox : css.optionRadio}`} aria-hidden="true">
                            {item.multiSelect ? (
                              isSelected ? <Icon name="check" className={css.checkIcon} width={11} height={11} strokeWidth={2.5} /> : null
                            ) : (
                              isSelected ? <span className={css.radioDot} /> : null
                            )}
                          </span>
                          <span className={css.optionContent}>
                            <span className={css.optionLabel}>{option.label}</span>
                            {option.description ? <span className={css.optionDesc}>{option.description}</span> : null}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ) : null}
                <Input
                  type="block"
                  className={css.customInput}
                  placeholder={item.options?.length ? WF.questions.customPlaceholderWithOptions : WF.questions.customPlaceholder}
                  value={customs[item.id] ?? ''}
                  disabled={disabled}
                  readOnly={inactive || isQuestionAnswered}
                  onChange={event => {
                    if (disabled) return
                    setCustoms({ ...customs, [item.id]: event.target.value })
                  }}
                />
              </>
            )}
          </div>
        )
      })}
      {done === undefined ? (
        <div className={css.actions}>
          <Button
            type="primary"
            disabled={disabled || !complete}
            loading={submitting}
            onClick={() => { if (!disabled) void submit({ answers: answersOf(question.items) }) }}
          >
            {submitting ? WF.questions.submitting : WF.questions.submitAnswer}
          </Button>
        </div>
      ) : null}
      {error ? <div className={css.error}>{error}</div> : null}
    </div>
  )
}
