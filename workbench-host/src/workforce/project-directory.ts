import { isAbsolute, join } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { WorkforceError } from './types.ts'

export async function resolveProjectDirectory(value: unknown): Promise<string | null | undefined> {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !isAbsolute(value)) throw new WorkforceError('bad_request', '项目目录必须是绝对路径')
  try {
    const directory = await realpath(value)
    if (!(await stat(directory)).isDirectory()) throw new Error('not a directory')
    return directory
  } catch {
    throw new WorkforceError('bad_request', '项目目录不存在或无法访问')
  }
}

export function projectWorkspace(directory: string | undefined, threadId: string, sessionId: string) {
  if (!directory) return {}
  return { workspaceSessions: { [sessionId]: { nativeCwd: directory, logicalRoot: join('workspaces', threadId, 'scratch', sessionId), layout: 'scoped-v2' as const } } }
}

export async function verifyProjectDirectory(directory: string): Promise<void> {
  if (await resolveProjectDirectory(directory) !== directory) throw new WorkforceError('unavailable', '项目目录已改变，请重新选择')
}
