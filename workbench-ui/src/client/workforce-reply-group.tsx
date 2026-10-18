/**
 * ReplyGroupCard：同一句人类消息的多条员工回复（频道 @所有人 时每人各回一条）。
 * 默认每人一行摘要 + 状态，整行是 button，点开由调用方在右侧预览看全文；
 * 「全部展开」就地还原成完整气泡序列（复用同一套 MessageRow，不另做渲染）。
 * 高度可控是唯一目的：三条 1000 字回复从 3 屏压到一张卡。
 */
import { Badge, Button, Card, CardContent, CardFooter, CardHeader } from './ui/index.tsx'
import { memo, type ReactNode } from 'react'
import css from './workforce-reply-group.module.css'
import { Icon } from './ui/icons.tsx'
import { WorkforceAvatar } from './workforce-avatar.tsx'
import type { AvatarStyle, ReplyGrouping, TypingEffect } from './workforce-prefs.ts'
import { replyCharCount, replyExcerpt, type ReplyGroup } from './workforce-source.ts'
import type { Employee, WorkforceActivity, WorkforceMessage } from './workforce-types.ts'
import { WF } from './workforce-strings.ts'

export interface ReplyGroupCardProps {
  readonly group: ReplyGroup
  /** 偏好里的呈现方式：summary 摘要 / expanded 就地展开 / collapsed 只留标题。 */
  readonly mode: ReplyGrouping
  readonly employees: readonly Employee[]
  readonly avatarStyle?: AvatarStyle | undefined
  readonly typingEffect?: TypingEffect | undefined
  readonly activities: readonly WorkforceActivity[]
  /** 就地展开时渲染的真实消息行（调用方注入，保持原有 memo 与行行为）。 */
  readonly renderMember: (message: WorkforceMessage) => ReactNode
  /** 任务页脚等挂在组上的内容（展开态由真实行自带，不重复）。 */
  readonly footer?: ReactNode | undefined
  readonly onToggleExpanded: () => void
  readonly onOpenPreview: (messageId: string) => void
}

export const ReplyGroupCard = memo(function ReplyGroupCard({
  group, mode, employees, avatarStyle, typingEffect, activities, renderMember, footer, onToggleExpanded, onOpenPreview,
}: ReplyGroupCardProps) {
  const expanded = mode === 'expanded'
  const collapsed = mode === 'collapsed'
  const runningCount = group.members.filter(member => {
    // 员工的实时活动只属于进行中的这一轮，旧组卡不跟着亮「正在回复」。
    const activity = group.live ? activities.find(item => item.employeeId === member.employeeId) : undefined
    return member.running || activity !== undefined
  }).length
  const isRunning = runningCount > 0
  const stateText = isRunning ? WF.replyGroup.running(runningCount, group.members.length) : WF.replyGroup.done
  return (
    <Card className={css.group} data-reply-group={group.parentId} data-mode={collapsed ? 'collapsed' : 'summary'}>
      <CardHeader className={css.groupHead}>
        <span className={css.groupTitle}>
          <Icon name="users" width={15} height={15} />
          {WF.replyGroup.title(group.members.length)}
        </span>
        <Badge variant="pill" tone={isRunning ? 'accent' : 'neutral'} className={css.groupState} data-running={isRunning}>
          <span className={css.groupStateDot} aria-hidden="true" />
          {stateText}
        </Badge>
        <Button variant="plain"
          type="button"
          className={css.groupAction}
          aria-expanded={expanded}
          onClick={onToggleExpanded}
        >
          {expanded ? WF.replyGroup.collapse : WF.replyGroup.expand}
        </Button>
      </CardHeader>
      {expanded ? (
        <CardContent className={css.groupContent}>
          <div>{group.members.map(member => <div key={member.message.id}>{renderMember(member.message)}</div>)}</div>
        </CardContent>
      ) : (
        <CardContent className={css.groupContent}>
          <ul className={css.memberList}>
          {group.members.map(member => {
            const message = member.message
            const employee = employees.find(item => item.id === member.employeeId)
            const activity = group.live ? activities.find(item => item.employeeId === member.employeeId) : undefined
            const running = member.running || activity !== undefined
            const excerpt = replyExcerpt(message.text)
            return (
              <li key={message.id}>
                <Button variant="plain"
                  type="button"
                  className={css.member}
                  onClick={() => onOpenPreview(message.id)}
                  aria-label={WF.replyGroup.openPreview(message.senderName)}
                >
                  <WorkforceAvatar
                    name={message.senderName}
                    color={employee?.avatarColor}
                    role={employee?.role}
                    style={avatarStyle}
                    typingEffect={typingEffect}
                    state={running ? (activity?.state === 'tool' ? 'searching' : activity?.state === 'thinking' ? 'thinking' : 'working') : 'idle'}
                    live={running}
                    size={28}
                  />
                  <span className={css.memberBody}>
                    <span className={css.memberTop}>
                      <span className={css.memberName}>{message.senderName}</span>
                      <span className={css.memberMeta}>
                        <span>{running ? WF.replyGroup.memberRunning : WF.replyGroup.memberDone}</span>
                        <span aria-hidden="true">·</span>
                        <span>{WF.replyGroup.charCount(replyCharCount(message.text))}</span>
                      </span>
                    </span>
                    <span className={css.memberExcerpt} data-running={running}>
                      {excerpt !== '' ? excerpt : running ? (activity?.state === 'typing' ? WF.skeleton.typing : WF.skeleton.thinking) : WF.replyGroup.emptyExcerpt}
                    </span>
                  </span>
                  <Icon name="chevronRight" width={16} height={16} className={css.memberArrow} />
                </Button>
              </li>
            )
          })}
          </ul>
        </CardContent>
      )}
      {!expanded && footer !== undefined && <CardFooter className={css.groupFoot}>{footer}</CardFooter>}
    </Card>
  )
})
