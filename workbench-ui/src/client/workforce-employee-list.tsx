import type { ReactNode } from 'react'
import { Tag as LobeTag } from '@lobehub/ui'
import { Button as LobeButton } from 'antd'
import { Plus } from 'lucide-react'
import { WF } from './workforce-strings.ts'
import type { Employee } from './workforce-types.ts'
import { WorkforceAvatar } from './workforce-avatar.tsx'
import css from './workforce.module.css'

function EmployeeRow({ name, title, color, role, lead, selected, onSelect }: {
  readonly name: string
  readonly title: string
  readonly color?: string | undefined
  readonly role?: Employee['role'] | undefined
  readonly lead: boolean
  readonly selected: boolean
  readonly onSelect?: (() => void) | undefined
}) {
  return (
    <button type="button" className={css.empCompactCard} aria-current={selected ? 'true' : undefined} data-selected={selected ? 'true' : undefined} onClick={onSelect}>
      <WorkforceAvatar name={name} isUser={false} color={color} role={role} live={false} size={28} />
      <span className={css.empCompactCardBody}>
        <span className={css.empCompactCardName}>
          <span className={css.empCompactCardNameText}>{name}</span>
          {lead && name.trim() !== WF.employee.lead && <LobeTag color="blue" size="small">{WF.employee.lead}</LobeTag>}
        </span>
        <span className={css.empCompactCardTitle}>{title}</span>
      </span>
    </button>
  )
}

/** Roster column: the unsaved draft sits on top while creating; shared settings follow the employees. */
export function EmployeeList({ employees, selectedId, draft, onSelect, onAdd, children }: {
  readonly employees: readonly Employee[]
  readonly selectedId: string
  readonly draft: { readonly name: string; readonly color: string; readonly lead: boolean } | undefined
  readonly onSelect: (employee: Employee) => void
  readonly onAdd: () => void
  readonly children?: ReactNode
}) {
  return (
    <nav className={css.empSidebarList} aria-label={WF.workspace.employeeListTitle(employees.length)}>
      <div className={css.empSidebarHead}>
        <span className={css.empSidebarTitle}>{WF.workspace.employeeListTitle(employees.length)}</span>
        <LobeButton type="primary" size="small" icon={<Plus size={14} aria-hidden="true" />} onClick={onAdd}>
          {WF.employeesPage.add}
        </LobeButton>
      </div>
      {draft !== undefined && (
        <EmployeeRow name={draft.name.trim() || WF.workspace.newEmployee} title={WF.workspace.unsaved} color={draft.color || undefined} lead={draft.lead} selected />
      )}
      {employees.map(employee => (
        <EmployeeRow
          key={employee.id}
          name={employee.name}
          title={employee.title || employee.persona || WF.workspace.noRoleDescription}
          color={employee.avatarColor}
          role={employee.role}
          lead={employee.isLeader}
          selected={selectedId === employee.id}
          onSelect={() => onSelect(employee)}
        />
      ))}
      {children}
    </nav>
  )
}
