import { Segmented } from 'antd'
import { WF } from './workforce-strings.ts'
import css from './workforce.module.css'

/** Two options, so a segmented switch instead of a dropdown; the hint states what the choice allows. */
export function EmployeeAccess({ value, onChange }: {
  readonly value: 'office' | 'development'
  readonly onChange: (value: 'office' | 'development') => void
}) {
  return (
    <div className={css.empField}>
      <label id="wf-employee-access">{WF.employeesPage.toolAccess}</label>
      <Segmented<'office' | 'development'>
        aria-labelledby="wf-employee-access"
        className={css.empSegmented ?? ''}
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
