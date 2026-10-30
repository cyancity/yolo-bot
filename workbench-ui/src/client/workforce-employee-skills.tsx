import { useState } from 'react'
import { Input as LobeInput } from '@lobehub/ui'
import { Button as LobeButton } from 'antd'
import { Check, Plus, Search, X } from 'lucide-react'
import { WF } from './workforce-strings.ts'
import type { SkillSummary, WorkforceUserSkill } from './workforce-types.ts'
import css from './workforce.module.css'

const WORKBENCH_PROVIDER = 'cyancity-workbench'
const USER_PROVIDER = 'user-host'

type LibrarySkill = { readonly name: string; readonly description: string; readonly group: 'workbench' | 'workflow' | 'mine' | 'other' }

function groupLabel(group: LibrarySkill['group']): string {
  return group === 'workbench' ? WF.workspace.skillGroupWorkbench
    : group === 'workflow' ? WF.workspace.skillGroupWorkflow
      : group === 'mine' ? WF.workspace.skillGroupMine : WF.workspace.skillGroupOther
}

/** Workbench skills first, then distilled workflows, the user's own skills, and the rest. */
function librarySkills(catalog: readonly SkillSummary[] | undefined, user: readonly WorkforceUserSkill[] | undefined): LibrarySkill[] {
  const seen = new Set<string>()
  const out: LibrarySkill[] = []
  for (const skill of catalog ?? []) {
    seen.add(skill.name)
    out.push({ name: skill.name, description: skill.description, group: skill.provider === WORKBENCH_PROVIDER ? 'workbench' : skill.provider === USER_PROVIDER ? 'mine' : 'other' })
  }
  for (const skill of user ?? []) {
    if (seen.has(skill.name)) continue
    out.push({ name: skill.name, description: skill.description, group: skill.origin === 'workflow' ? 'workflow' : 'mine' })
  }
  const order = ['workbench', 'workflow', 'mine', 'other']
  return out.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))
}

/** Selected skills stay visible; the full library opens on demand instead of filling the form. */
export function EmployeeSkillsField({ skills, onChange, catalog, user }: {
  readonly skills: readonly string[]
  readonly onChange: (skills: string[]) => void
  readonly catalog: readonly SkillSummary[] | undefined
  readonly user: readonly WorkforceUserSkill[] | undefined
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const library = librarySkills(catalog, user)
  const needle = query.trim().toLowerCase()
  const matched = needle ? library.filter(skill => skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle)) : library
  const toggle = (name: string): void => onChange(skills.includes(name) ? skills.filter(item => item !== name) : [...skills, name])
  const descriptionOf = (name: string): string | undefined => library.find(skill => skill.name === name)?.description

  return (
    <div className={css.empField}>
      <label id="wf-emp-skills">{WF.workspace.skillsConfigLabel(skills.length)}</label>
      <div className={css.skillChipsContainer} aria-labelledby="wf-emp-skills">
        {skills.length === 0 && <span className={css.skillEmptyHint}>{WF.workspace.noSkillsConfiguredHint}</span>}
        {skills.map(name => (
          <span key={name} className={css.skillChipSelected} title={descriptionOf(name)}>
            <span className={css.skillChipText}>{name}</span>
            <button type="button" className={css.skillChipRemove} aria-label={WF.workspace.removeSkill(name)} onClick={() => toggle(name)}>
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        {!open && library.length > 0 && (
          <LobeButton type="text" size="small" className={css.skillAddBtn ?? ''} icon={<Plus size={14} aria-hidden="true" />} onClick={() => setOpen(true)}>
            {WF.workspace.addSkill}
          </LobeButton>
        )}
      </div>
      {open && (
        <div className={css.skillPicker}>
          <div className={css.skillPickerHead}>
            <LobeInput
              type="block"
              className="wb-input"
              autoFocus
              prefix={<Search size={14} aria-hidden="true" />}
              placeholder={WF.workspace.skillSearchPlaceholder}
              aria-label={WF.workspace.skillSearchPlaceholder}
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return }
                if (event.key !== 'Enter') return
                event.preventDefault()
                if (matched.length === 1) toggle(matched[0]!.name)
              }}
            />
            <LobeButton onClick={() => { setOpen(false); setQuery('') }}>{WF.workspace.doneAddingSkills}</LobeButton>
          </div>
          <div className={css.skillPickerList} aria-label={WF.employeesPage.skillPickerLabel}>
            {matched.length === 0 && <span className={css.skillEmptyHint}>{WF.workspace.noSkillMatch}</span>}
            {matched.map((skill, index) => {
              const added = skills.includes(skill.name)
              const startsGroup = index === 0 || matched[index - 1]!.group !== skill.group
              return (
                <div key={`${skill.group}:${skill.name}`} className={css.skillPickerItem}>
                  {startsGroup && <div className={css.skillGroupTitle}>{groupLabel(skill.group)}</div>}
                  <button type="button" className={css.skillRow} aria-pressed={added} title={skill.description} onClick={() => toggle(skill.name)}>
                    <span className={css.skillRowCheck} aria-hidden="true">{added && <Check size={14} />}</span>
                    <span className={css.skillRowName}>{skill.name}</span>
                    <span className={css.skillRowDesc}>{skill.description}</span>
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
