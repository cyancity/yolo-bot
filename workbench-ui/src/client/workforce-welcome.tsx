import { Tag, Typography } from 'antd'
import { createStyles } from 'antd-style'
import { WorkforceAvatar } from './workforce-avatar.tsx'
import type { Employee } from './workforce-types.ts'
import css from './workforce-welcome.module.css'
import { WELCOME } from './workforce-welcome-strings.ts'

interface WelcomeSuggestion {
  readonly label: string
  readonly prompt: string
}

// Follow LobeChat's QuestionSuggest pattern; read the Lobe theme directly so
// legacy workbench CSS aliases cannot restyle these recommendation controls.
const useStyles = createStyles(({ css, token }) => ({
  suggestion: css`
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: ${token.controlHeightLG}px;
    padding: 12px 24px;
    border: 0;
    border-radius: 48px;
    font-family: ${token.fontFamily};
    font-size: ${token.fontSize}px;
    line-height: ${token.lineHeight};
    color: ${token.colorText};
    text-align: start;
    background: ${token.colorBgContainer};
    cursor: pointer;
    transition: background-color ${token.motionDurationFast} ${token.motionEaseOut};

    &:hover:not(:disabled) {
      background: ${token.colorFillTertiary};
    }

    &:active:not(:disabled) {
      background: ${token.colorFillSecondary};
    }

    &:focus-visible {
      outline: ${token.lineWidthFocus}px solid ${token.colorPrimary};
      outline-offset: 2px;
    }

    &:disabled {
      color: ${token.colorTextDisabled};
      cursor: not-allowed;
    }

    @media (max-width: 540px) {
      padding: 8px 16px;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
}))

function suggestionsFor(employee: Employee | undefined): readonly WelcomeSuggestion[] {
  if (employee?.role === 'analyst') return WELCOME.analyst
  if (employee?.role === 'writer') return WELCOME.writer
  return WELCOME.generic
}

/** 空会话的工作入口：推荐项只预填，发送仍由用户决定。 */
export function WorkforceWelcome({ kind, employee, title, onSuggestion, disabled = false }: {
  readonly kind: 'channel' | 'dm'
  readonly employee: Employee | undefined
  readonly title: string
  readonly onSuggestion: (prompt: string) => void
  readonly disabled?: boolean
}) {
  const { styles } = useStyles()
  const name = employee?.name ?? 'Bot'
  const suggestions = kind === 'channel' ? WELCOME.team : suggestionsFor(employee)
  const description = kind === 'channel'
    ? WELCOME.channelDescription(name)
    : WELCOME.dmDescription(employee?.title ?? '')

  return (
    <section className={css.welcome} data-workforce-welcome data-preview-kind={kind} aria-label={WELCOME.aria(title)}>
      <WorkforceAvatar name={name} isUser={false} color={employee?.avatarColor} role={employee?.role} size={88} state="idle" live={true} />
      <Tag>Preview</Tag>
      <div className={css.intro}>
        <Typography.Title level={2} style={{ margin: 0 }}>
          {kind === 'channel' ? WELCOME.channelTitle : WELCOME.dmTitle(name)}
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {description}
        </Typography.Paragraph>
      </div>
      <div className={css.recommendations}>
        <Typography.Text type="secondary">{WELCOME.suggestionsTitle}</Typography.Text>
        <div className={css.suggestions}>
          {suggestions.map(suggestion => (
            <button key={suggestion.label} type="button" className={styles.suggestion} disabled={disabled} onClick={() => onSuggestion(suggestion.prompt)}>
              {suggestion.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
