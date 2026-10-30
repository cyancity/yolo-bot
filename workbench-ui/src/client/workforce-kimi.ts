import type { WorkforceMessage } from './workforce-types.ts'
import { WF } from './workforce-strings.ts'

export function kimiMessage(message: WorkforceMessage): WorkforceMessage {
  const { tool, ...rest } = message
  let failed = tool?.status === 'error'
  try { failed ||= (JSON.parse(message.text) as { processExited?: boolean }).processExited === false } catch { /* Running progress is plain text. */ }
  const prefix = tool?.status === 'running' ? WF.settings.kimiRunning : failed ? WF.settings.kimiFailed : WF.settings.kimiDone
  if (tool?.status !== 'running') return { ...rest, text: prefix }
  const action = message.text.trim().split('\n').at(-1)?.toLowerCase() ?? ''
  const detail = /read|glob|grep|search/.test(action) ? WF.settings.kimiReading
    : /edit|write|replace/.test(action) ? WF.settings.kimiEditing
      : /bash|shell|terminal/.test(action) ? WF.settings.kimiExecuting : WF.settings.kimiWorking
  return { ...rest, text: `${prefix}\n\n${detail}` }
}
