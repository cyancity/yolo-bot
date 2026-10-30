import type { WorkforceMessage } from './workforce-types.ts'
import { WF } from './workforce-strings.ts'

/** Approval cards name the workbench agent tool the way users know it. */
export function approvalToolLabel(toolName: string): string {
  return toolName === 'wb_run_agent' ? WF.roles.externalAgent : toolName
}

/** Shows an external agent run as a status line instead of raw tool output. */
export function agentRunMessage(message: WorkforceMessage): WorkforceMessage {
  const { tool, ...rest } = message
  let failed = tool?.status === 'error'
  try { failed ||= (JSON.parse(message.text) as { processExited?: boolean }).processExited === false } catch { /* Running progress is plain text. */ }
  const prefix = tool?.status === 'running' ? WF.settings.agentRunning : failed ? WF.settings.agentFailed : WF.settings.agentDone
  if (tool?.status !== 'running') return { ...rest, text: prefix }
  const action = message.text.trim().split('\n').at(-1)?.toLowerCase() ?? ''
  const detail = /read|glob|grep|search/.test(action) ? WF.settings.agentReading
    : /edit|write|replace/.test(action) ? WF.settings.agentEditing
      : /bash|shell|terminal/.test(action) ? WF.settings.agentExecuting : WF.settings.agentWorking
  return { ...rest, text: `${prefix}\n\n${detail}` }
}
