import dagre from 'dagre'
import type { Node, Edge } from '@xyflow/react'
import type { WorkforceSnapshot, WorkforceMessage, Employee, WorkforceUsage } from './workforce-types.ts'
import { WF } from './workforce-strings.ts'
import { stripMarkdown } from './workforce-strip-markdown.ts'

export interface TurnNodeData extends Record<string, unknown> {
  readonly id: string
  readonly threadId: string
  readonly channelId?: string | undefined
  readonly channelTitle: string
  readonly taskId?: string | undefined
  readonly promptText: string
  readonly replySnippet: string
  readonly senderName: string
  readonly agentName?: string | undefined
  readonly agentRole?: string | undefined
  readonly agentAvatarColor?: string | undefined
  readonly timestamp: string
  readonly toolsCount: number
  readonly status: 'idle' | 'running' | 'done' | 'failed'
  readonly usage?: WorkforceUsage | undefined
  readonly replyCount?: number | undefined
}

export type CanvasTurnNode = Node<TurnNodeData, 'turn'>

const POS_STORAGE_KEY = 'wb:canvas-node-positions:v1'

export function loadSavedPositions(): Record<string, { x: number; y: number }> {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(POS_STORAGE_KEY)
    if (raw) return JSON.parse(raw) as Record<string, { x: number; y: number }>
  } catch {}
  return {}
}

export function savePositions(positions: Record<string, { x: number; y: number }>): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(positions))
  } catch {}
}

export function clearSavedPositions(): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(POS_STORAGE_KEY)
  } catch {}
}

export function buildConversationGraph(snapshot: WorkforceSnapshot): {
  nodes: CanvasTurnNode[]
  edges: Edge[]
} {
  const employeesMap = new Map<string, Employee>(snapshot.employees.map(e => [e.id, e]))
  const channelsMap = new Map<string, { id: string; name: string; groupChatName?: string | null }>(
    snapshot.channels.map(c => [c.id, c]),
  )
  const taskMap = new Map<string, { id: string; title: string; status: string; assigneeId?: string }>(
    snapshot.tasks.map(t => [t.threadId, { id: t.id, title: t.title, status: t.status, assigneeId: t.assigneeId }]),
  )

  const nodes: CanvasTurnNode[] = []
  const edges: Edge[] = []
  const messageToTurnMap = new Map<string, string>() // messageId -> turnNodeId

  const savedPositions = loadSavedPositions()

  // Iterate over all threads in snapshot
  for (const thread of snapshot.threads) {
    const msgs = snapshot.messages[thread.id]?.list ?? []
    if (msgs.length === 0) continue

    const task = taskMap.get(thread.id)
    const channel = thread.channelId ? channelsMap.get(thread.channelId) : undefined
    const channelTitle = channel ? (channel.groupChatName?.trim() || channel.name) : (thread.title || '会话')

    // Segment messages in this thread into turns
    // A turn begins with a user message, or leading agent messages
    let currentTurnId = ''
    let currentPrompt = ''
    let currentReplies: WorkforceMessage[] = []
    let currentTools = 0
    let currentTurnTimestamp = ''
    let prevTurnIdInThread = ''
    let turnIndex = 0

    const flushTurn = () => {
      if (!currentTurnId) return
      const latestAgent = currentReplies.find(m => m.role === 'agent' && !m.tool && !m.intermediate)
      const targetEmployeeId = latestAgent?.senderId ?? (thread.kind === 'dm' ? thread.employeeId : task?.assigneeId)
      const emp = targetEmployeeId ? employeesMap.get(targetEmployeeId) : undefined
      const turnStatus: 'idle' | 'running' | 'done' | 'failed' =
        thread.status === 'running' && turnIndex === 0 ? 'running'
        : task?.status === 'done' ? 'done'
        : task?.status === 'failed' ? 'failed'
        : 'idle'

      let nodePos = savedPositions[currentTurnId]
      if (!nodePos && prevTurnIdInThread) {
        const prevNode = nodes.find(n => n.id === prevTurnIdInThread)
        if (prevNode && (prevNode.position.x !== 0 || prevNode.position.y !== 0)) {
          nodePos = {
            x: prevNode.position.x + 420,
            y: prevNode.position.y,
          }
        }
      }

      const node: CanvasTurnNode = {
        id: currentTurnId,
        type: 'turn',
        position: nodePos ?? { x: 0, y: 0 },
        data: {
          id: currentTurnId,
          threadId: thread.id,
          channelId: thread.channelId,
          channelTitle,
          taskId: task?.id,
          promptText: stripMarkdown(currentPrompt) || (latestAgent ? '任务启动' : '消息'),
          replySnippet: latestAgent ? stripMarkdown(latestAgent.text).slice(0, 120) : '',
          senderName: WF.common.you,
          agentName: emp?.name ?? latestAgent?.senderName,
          agentRole: emp?.role,
          agentAvatarColor: emp?.avatarColor,
          timestamp: currentTurnTimestamp || thread.updatedAt,
          toolsCount: currentTools,
          status: turnStatus,
          usage: latestAgent?.usage,
          replyCount: currentReplies.length,
        },
      }
      nodes.push(node)

      // Sequential edge within same thread
      if (prevTurnIdInThread) {
        edges.push({
          id: `seq:${prevTurnIdInThread}->${currentTurnId}`,
          source: prevTurnIdInThread,
          target: currentTurnId,
          type: 'smoothstep',
          style: { stroke: 'var(--wb-line-control, #9f9fa6)', strokeWidth: 1.5 },
        })
      }

      prevTurnIdInThread = currentTurnId
      currentTurnId = ''
      currentPrompt = ''
      currentReplies = []
      currentTools = 0
    }

    for (const msg of msgs) {
      if (msg.role === 'user') {
        flushTurn()
        turnIndex += 1
        currentTurnId = `turn:${msg.id}`
        currentPrompt = msg.text
        currentTurnTimestamp = msg.ts
        messageToTurnMap.set(msg.id, currentTurnId)

        // Check if this user prompt is a branch off another message (replyTo)
        if (msg.replyTo) {
          const parentTurnId = messageToTurnMap.get(msg.replyTo)
          if (parentTurnId && parentTurnId !== prevTurnIdInThread) {
            edges.push({
              id: `branch:${parentTurnId}->${currentTurnId}`,
              source: parentTurnId,
              target: currentTurnId,
              type: 'bezier',
              animated: true,
              style: { stroke: 'var(--wb-accent, #00c375)', strokeWidth: 2 },
            })
          }
        }
      } else if (msg.role === 'agent') {
        if (!currentTurnId) {
          turnIndex += 1
          currentTurnId = `turn:${msg.id}`
          currentTurnTimestamp = msg.ts
          messageToTurnMap.set(msg.id, currentTurnId)
        }
        if (msg.tool) currentTools += 1
        currentReplies.push(msg)
        messageToTurnMap.set(msg.id, currentTurnId)
      }
    }

    flushTurn()
  }

  return { nodes, edges }
}

export function computeAutoLayout(
  nodes: CanvasTurnNode[],
  edges: Edge[],
  rankdir: 'LR' | 'TB' = 'LR',
): CanvasTurnNode[] {
  if (nodes.length === 0) return nodes

  const g = new dagre.graphlib.Graph()
  g.setGraph({
    rankdir,
    nodesep: 60,
    ranksep: 100,
    marginx: 50,
    marginy: 50,
  })
  g.setDefaultEdgeLabel(() => ({}))

  const defaultNodeWidth = 320
  const defaultNodeHeight = 260

  const nodeHeightMap = new Map<string, number>()
  const nodeWidthMap = new Map<string, number>()

  for (const node of nodes) {
    const measured = (node as unknown as { measured?: { width?: number; height?: number } }).measured
    const w = measured?.width && measured.width > 0 ? measured.width : defaultNodeWidth
    const h = measured?.height && measured.height > 0 ? measured.height : defaultNodeHeight
    nodeWidthMap.set(node.id, w)
    nodeHeightMap.set(node.id, h)
    g.setNode(node.id, { width: w, height: h })
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  const updatedPositions: Record<string, { x: number; y: number }> = {}

  const result = nodes.map(node => {
    const pos = g.node(node.id)
    const w = nodeWidthMap.get(node.id) ?? defaultNodeWidth
    const h = nodeHeightMap.get(node.id) ?? defaultNodeHeight
    const position = pos
      ? {
          x: Math.round(pos.x - w / 2),
          y: Math.round(pos.y - h / 2),
        }
      : node.position
    updatedPositions[node.id] = position
    return {
      ...node,
      position,
    }
  })

  // Align single-child sequential chains so horizontal connecting lines are 100% straight
  const outgoingCount: Record<string, number> = {}
  for (const edge of edges) {
    outgoingCount[edge.source] = (outgoingCount[edge.source] ?? 0) + 1
  }
  for (const edge of edges) {
    if (outgoingCount[edge.source] === 1) {
      const parentNode = result.find(n => n.id === edge.source)
      const childNode = result.find(n => n.id === edge.target)
      if (parentNode && childNode) {
        childNode.position.y = parentNode.position.y
        updatedPositions[childNode.id] = childNode.position
      }
    }
  }

  // Ensure minimum vertical separation (>= 24px) between nodes in the same column
  const columns = new Map<number, typeof result>()
  for (const node of result) {
    let placed = false
    for (const [colX, colNodes] of columns.entries()) {
      if (Math.abs(node.position.x - colX) <= 80) {
        colNodes.push(node)
        placed = true
        break
      }
    }
    if (!placed) {
      columns.set(node.position.x, [node])
    }
  }

  for (const colNodes of columns.values()) {
    colNodes.sort((a, b) => a.position.y - b.position.y)
    for (let i = 1; i < colNodes.length; i++) {
      const prev = colNodes[i - 1]
      const curr = colNodes[i]
      if (!prev || !curr) continue
      const prevH = nodeHeightMap.get(prev.id) ?? defaultNodeHeight
      const minDistance = 24
      const expectedMinY = prev.position.y + prevH + minDistance
      if (curr.position.y < expectedMinY) {
        curr.position.y = Math.round(expectedMinY)
        updatedPositions[curr.id] = curr.position
      }
    }
  }

  savePositions(updatedPositions)
  return result
}
