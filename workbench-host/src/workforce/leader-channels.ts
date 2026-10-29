import type { WorkforceStore } from './store.ts'
import { WorkforceError } from './types.ts'

export interface CreateChannelItemResult {
  id: string
  name: string
  memberIds?: string[]
}

export interface CreateChannelItemFailure {
  index: number
  name?: string
  error: string
}

export interface CreateChannelsResult {
  created: CreateChannelItemResult[]
  failed: CreateChannelItemFailure[]
}

/**
 * wb_create_channel 核心逻辑：仅负责人根会话可批量创建频道/群聊。
 * 逐个调用 store.saveChannel 创建；单项校验失败记录并继续，不回滚已成功的频道。
 */
export async function createChannelsAsLeader(
  store: WorkforceStore,
  sessionId: string,
  input: unknown,
): Promise<CreateChannelsResult> {
  const state = await store.read()
  const entry = Object.entries(state.bindings).find(([, binding]) => binding.rootId === sessionId)
  const employee = entry === undefined ? undefined : state.employees.find(item => item.id === state.bindings[entry[0]]!.ownerId)
  if (entry === undefined || employee?.isLeader !== true) {
    throw new WorkforceError('forbidden', '只有负责人的会话可以建群')
  }

  if (!input || typeof input !== 'object' || !('channels' in input) || !Array.isArray(input.channels)) {
    throw new WorkforceError('bad_request', 'channels 参数必须为数组')
  }

  const rawChannels = input.channels
  if (rawChannels.length === 0) {
    throw new WorkforceError('bad_request', 'channels 列表不能为空')
  }
  if (rawChannels.length > 20) {
    throw new WorkforceError('bad_request', '一次最多创建 20 个频道')
  }

  const created: CreateChannelItemResult[] = []
  const failed: CreateChannelItemFailure[] = []

  for (let i = 0; i < rawChannels.length; i++) {
    const item = rawChannels[i]
    const isObject = typeof item === 'object' && item !== null
    const rawName = isObject && 'name' in item ? item.name : undefined
    const name = typeof rawName === 'string' ? rawName.trim() : undefined

    try {
      if (!isObject) {
        throw new WorkforceError('bad_request', '频道配置项无效')
      }
      if (!name) {
        throw new WorkforceError('bad_request', '频道名称必填')
      }
      if (name.length > 60) {
        throw new WorkforceError('bad_request', '频道名称超出长度限制（最多60字）')
      }
      const rawMemberIds = 'memberIds' in item ? item.memberIds : undefined
      if (rawMemberIds !== undefined && !Array.isArray(rawMemberIds)) {
        throw new WorkforceError('bad_request', '成员列表无效')
      }
      if (Array.isArray(rawMemberIds) && rawMemberIds.some(id => typeof id !== 'string')) {
        throw new WorkforceError('bad_request', '成员列表包含无效 ID')
      }

      const memberIds = Array.isArray(rawMemberIds)
        ? rawMemberIds.map(id => (typeof id === 'string' ? id.trim() : '')).filter(Boolean)
        : undefined
      const channel = await store.saveChannel({
        name,
        ...(memberIds !== undefined ? { memberIds } : {}),
      })

      created.push({
        id: channel.id,
        name: channel.name,
        ...(channel.memberIds !== undefined ? { memberIds: channel.memberIds } : {}),
      })
    } catch (error) {
      failed.push({
        index: i,
        name: name ?? (typeof rawName === 'string' ? rawName : undefined),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { created, failed }
}
