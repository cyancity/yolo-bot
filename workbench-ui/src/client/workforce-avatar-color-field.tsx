import { WF } from './workforce-strings.ts'
import { WorkforceAvatar, AVATAR_PALETTES, resolveAvatarPalette } from './workforce-avatar.tsx'
import css from './workforce.module.css'

/** Avatar colour: by name, one of the palettes (named on hover), or a custom hex. */
export function AvatarColorField({ name, value, onChange }: {
  readonly name: string
  readonly value: string
  readonly onChange: (value: string) => void
}) {
  const display = name.trim() || WF.common.employee
  return (
    <div className={css.empField}>
      <label id="wf-emp-avatar-color">{WF.employeesPage.avatarColor}</label>
      <div className={css.avatarColorPicker}>
        <WorkforceAvatar name={display} isUser={false} color={value || undefined} live={false} size={42} />
        <div className={css.colorSwatches} role="group" aria-labelledby="wf-emp-avatar-color">
          <button
            type="button"
            className={`${css.colorDefaultBtn} ${value === '' ? css.colorDefaultBtnActive : ''}`}
            aria-pressed={value === ''}
            onClick={() => onChange('')}
            title={WF.workspace.defaultColorTooltip}
          >
            {WF.employeesPage.avatarColorDefault}
          </button>
          {AVATAR_PALETTES.map(palette => {
            const selected = !!value && !value.startsWith('#') && resolveAvatarPalette(name, undefined, value).palette === palette.id
            return (
              <button
                key={palette.id}
                type="button"
                className={`${css.paletteSwatchBtn} ${selected ? css.paletteSwatchActive : ''}`}
                title={palette.label}
                aria-label={`${palette.label}：${palette.description}`}
                aria-pressed={selected}
                onClick={() => onChange(`palette:${palette.id}`)}
              >
                <WorkforceAvatar name={display} isUser={false} palette={palette.id} live={false} size={26} />
              </button>
            )
          })}
          <label className={`${css.colorCustomWrap} ${value.startsWith('#') ? css.colorCustomActive : ''}`} title={WF.employeesPage.avatarColorCustom}>
            <input
              type="color"
              className={css.colorCustomInput}
              value={value && /^#[0-9a-f]{6}$/i.test(value) ? value : '#3b5bdb'}
              onChange={event => onChange(event.target.value)}
              aria-label={WF.employeesPage.avatarColorCustom}
            />
            <span className={css.colorCustomLabel}>{value.startsWith('#') ? value.toUpperCase() : WF.workspace.customColor}</span>
          </label>
        </div>
      </div>
    </div>
  )
}
