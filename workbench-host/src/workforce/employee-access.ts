import { WorkforceError } from './types.ts'

export type EmployeeAccess = 'office' | 'development'

export function employeeAccess(input: unknown, previous?: EmployeeAccess): EmployeeAccess {
  const value = input === undefined ? previous ?? 'office' : input
  if (value !== 'office' && value !== 'development') throw new WorkforceError('bad_request', '员工工具权限无效')
  return value
}
