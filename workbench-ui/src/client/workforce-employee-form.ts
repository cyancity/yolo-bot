import { useEffect, useRef } from 'react'
import { setLeaveGuard, type WorkbenchView } from './nav.ts'
import type { Employee, EmployeeAgent } from './workforce-types.ts'

/** Every field the employee form edits; compared as a whole to detect unsaved changes. */
export type EmployeeForm = {
  readonly name: string
  readonly title: string
  readonly persona: string
  readonly model: string
  readonly toolAccess: 'office' | 'development'
  readonly skills: readonly string[]
  readonly imageGeneration: boolean
  readonly webSearch: boolean
  readonly agent: EmployeeAgent | null
  readonly lead: boolean
  readonly avatarColor: string
  readonly mcpLimited: boolean
  readonly mcpIds: readonly string[]
}

export const formOf = (employee: Employee | 'new' | undefined): EmployeeForm => employee !== undefined && employee !== 'new'
  ? {
      name: employee.name, title: employee.title, persona: employee.persona, model: employee.model ?? '', toolAccess: employee.toolAccess ?? 'office',
      skills: employee.skills ? [...employee.skills] : [], imageGeneration: employee.imageGeneration === true, webSearch: employee.webSearch === true,
      agent: employee.agent ?? null, lead: employee.isLeader, avatarColor: employee.avatarColor ?? '',
      mcpLimited: employee.mcpServers !== undefined, mcpIds: employee.mcpServers ?? [],
    }
  : { name: '', title: '', persona: '', model: '', toolAccess: 'office', skills: [], imageGeneration: false, webSearch: false, agent: null, lead: false, avatarColor: '', mcpLimited: false, mcpIds: [] }

/** Compared against the loaded employee to tell whether the form has unsaved edits. */
export const formKey = (form: EmployeeForm): string => JSON.stringify([
  form.name, form.title, form.persona, form.model, form.toolAccess, form.skills, form.imageGeneration, form.webSearch,
  form.agent, form.lead, form.avatarColor, form.mcpLimited, form.mcpIds,
])

/**
 * While the form is dirty, leaving the employees page is held back and handed to `onBlocked`
 * so the page can ask first. Call the returned `leave` once the user agrees to discard.
 */
export function useLeaveGuard(dirty: boolean, onBlocked: (next: WorkbenchView) => void, navigate: (next: WorkbenchView) => void): (next: WorkbenchView) => void {
  const state = useRef({ dirty, onBlocked, leaving: false })
  state.current.dirty = dirty
  state.current.onBlocked = onBlocked
  useEffect(() => {
    setLeaveGuard(next => {
      if (!state.current.dirty || state.current.leaving || next.kind === 'employees') return false
      state.current.onBlocked(next)
      return true
    })
    return () => setLeaveGuard(undefined)
  }, [])
  return next => { state.current.leaving = true; navigate(next) }
}
