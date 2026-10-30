import { Select } from 'antd'
import { WF } from './workforce-strings.ts'
import css from './workforce.module.css'

export function EmployeeAccess({ value, onChange }: {
  readonly value: 'office' | 'development'
  readonly onChange: (value: 'office' | 'development') => void
}) {
  return (
    <div className={css.empField}>
      <label htmlFor="wf-employee-access">{WF.employeesPage.toolAccess}</label>
      <Select
        id="wf-employee-access"
        className={css.empInput ?? ''}
        value={value}
        onChange={onChange}
        options={[
          { value: 'office', label: WF.employeesPage.officeAccess },
          { value: 'development', label: WF.employeesPage.developmentAccess },
        ]}
      />
      <span className={css.empModelHint}>{value === 'development' ? WF.employeesPage.developmentAccessHint : WF.employeesPage.officeAccessHint}</span>
    </div>
  )
}
