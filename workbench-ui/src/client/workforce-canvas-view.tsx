import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  ViewportPortal,
  ReactFlowProvider,
  useReactFlow,
  useNodesInitialized,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { NodeTypes, OnNodeDrag } from '@xyflow/react'
import type { WorkforceSnapshot } from './workforce-types.ts'
import type { WorkforceSource } from './workforce-source.ts'
import {
  buildConversationGraph,
  computeAutoLayout,
  savePositions,
  loadSavedPositions,
  clearSavedPositions,
} from './workforce-canvas-data.ts'
import type { CanvasTurnNode } from './workforce-canvas-data.ts'
import { TurnCanvasNode } from './workforce-canvas-node.tsx'
import { ConfirmDialog } from './workforce-context-menu.tsx'
import { ThreadPanel } from './workforce.tsx'
import { Icon } from './ui/icons.tsx'
import { WF } from './workforce-strings.ts'
import css from './workforce-canvas.module.css'

const nodeTypes: NodeTypes = {
  turn: TurnCanvasNode,
}

export function WorkforceCanvasView(props: {
  readonly source: WorkforceSource
  readonly snapshot: WorkforceSnapshot
  readonly onCloseCanvas?: (() => void) | undefined
  readonly onDrawerChange?: ((open: boolean) => void) | undefined
}) {
  return (
    <ReactFlowProvider>
      <WorkforceCanvasViewContent {...props} />
    </ReactFlowProvider>
  )
}

function WorkforceCanvasViewContent({
  source,
  snapshot,
  onCloseCanvas,
  onDrawerChange,
}: {
  readonly source: WorkforceSource
  readonly snapshot: WorkforceSnapshot
  readonly onCloseCanvas?: (() => void) | undefined
  readonly onDrawerChange?: ((open: boolean) => void) | undefined
}) {
  const { setCenter, getZoom, getNodes } = useReactFlow()
  const nodesInitialized = useNodesInitialized()
  const hasAutoLaidOutRef = useRef(false)
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [selectedMessageId, setSelectedMessageId] = useState<string | undefined>()
  const [confirmAutoLayoutOpen, setConfirmAutoLayoutOpen] = useState(false)
  const [helperLines, setHelperLines] = useState<{
    horizontal?: { y: number; x1: number; x2: number }
    vertical?: { x: number; y1: number; y2: number }
  } | null>(null)

  useEffect(() => {
    onDrawerChange?.(Boolean(selectedThreadId))
  }, [selectedThreadId, onDrawerChange])

  // Pre-load all threads so all conversation turns render on first open
  useEffect(() => {
    const unloaded = snapshot.threads.filter(t => snapshot.messages[t.id] === undefined)
    if (unloaded.length > 0) {
      void Promise.all(unloaded.map(t => source.ensureThreadLoaded(t.id)))
    }
  }, [snapshot.threads, snapshot.messages, source])

  // Stable fingerprint: only changes when thread statuses, counts, or latest message IDs actually change
  const graphFingerprint = useMemo(() => {
    let key = ''
    for (const thread of snapshot.threads) {
      const msgs = snapshot.messages[thread.id]?.list
      key += `${thread.id}:${thread.status}:${msgs?.length ?? 0}:${msgs?.at(-1)?.id ?? ''};`
    }
    return key
  }, [snapshot.threads, snapshot.messages])

  // Build graph ONLY when fingerprint changes
  const rawGraph = useMemo(() => buildConversationGraph(snapshot), [graphFingerprint])

  const isDraggingRef = useRef(false)
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasTurnNode>(rawGraph.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(rawGraph.edges)

  // Keep nodes in sync when graph changes, preserving current in-memory positions
  useEffect(() => {
    if (isDraggingRef.current) return
    const saved = loadSavedPositions()
    const hasAnySaved = Object.keys(saved).length > 0

    if (!hasAnySaved && rawGraph.nodes.length > 0) {
      const laidOut = computeAutoLayout(rawGraph.nodes, rawGraph.edges, 'LR')
      setNodes(laidOut)
    } else {
      setNodes(prev => {
        if (prev.length === 0) return rawGraph.nodes
        const prevPosMap = new Map(prev.map(n => [n.id, n.position]))

        // Find incoming edges: targetId -> sourceId
        const incoming = new Map<string, string>()
        for (const e of rawGraph.edges) {
          if (!incoming.has(e.target)) incoming.set(e.target, e.source)
        }

        const newSaved = { ...saved }
        let hasNewPositions = false

        const nextNodes = rawGraph.nodes.map(n => {
          let pos = prevPosMap.get(n.id) ?? saved[n.id]
          if (!pos) {
            // New node! Check if it has a parent
            const parentId = incoming.get(n.id)
            const parentPos = parentId ? (prevPosMap.get(parentId) ?? newSaved[parentId]) : undefined
            if (parentPos) {
              // Position horizontally to the right of parent
              const siblings = rawGraph.edges.filter(e => e.source === parentId)
              const sibIndex = siblings.findIndex(e => e.target === n.id)
              const yOffset = sibIndex > 0 ? sibIndex * 290 : 0
              pos = {
                x: parentPos.x + 420,
                y: parentPos.y + yOffset,
              }
            } else if (n.position && (n.position.x !== 0 || n.position.y !== 0)) {
              pos = n.position
            } else {
              // New root node without parent: place below max Y
              let maxY = 0
              for (const p of prevPosMap.values()) {
                if (p.y > maxY) maxY = p.y
              }
              for (const p of Object.values(newSaved)) {
                if (p.y > maxY) maxY = p.y
              }
              pos = { x: 50, y: (prevPosMap.size > 0 || Object.keys(newSaved).length > 0) ? maxY + 290 : 50 }
            }
            newSaved[n.id] = pos
            hasNewPositions = true
          }
          return {
            ...n,
            position: pos,
          }
        })

        if (hasNewPositions) {
          savePositions(newSaved)
        }

        return nextNodes
      })
    }
    setEdges(rawGraph.edges)
  }, [rawGraph, setNodes, setEdges])

  // Once nodes are initialized and measured by React Flow, recompute layout with exact measured heights
  useEffect(() => {
    if (!nodesInitialized || hasAutoLaidOutRef.current || isDraggingRef.current) return
    hasAutoLaidOutRef.current = true
    const currentNodes = getNodes() as CanvasTurnNode[]
    if (currentNodes.length > 0) {
      const laidOut = computeAutoLayout(currentNodes, edges, 'LR')
      setNodes(laidOut)
    }
  }, [nodesInitialized, edges, getNodes, setNodes])
  // Magnetic horizontal & vertical center snapping while dragging with visual alignment guide lines
  const handleNodeDrag: OnNodeDrag = useCallback((_event, node) => {
    let matchedY: typeof node | undefined
    let matchedX: typeof node | undefined
    for (const other of nodes) {
      if (other.id === node.id) continue
      if (!matchedY && Math.abs(node.position.y - other.position.y) <= 12) {
        node.position.y = other.position.y
        matchedY = other
      }
      if (!matchedX && Math.abs(node.position.x - other.position.x) <= 12) {
        node.position.x = other.position.x
        matchedX = other
      }
      if (matchedY && matchedX) break
    }

    const nextLines: {
      horizontal?: { y: number; x1: number; x2: number }
      vertical?: { x: number; y1: number; y2: number }
    } = {}

    if (matchedY) {
      const minX = Math.min(node.position.x, matchedY.position.x) - 40
      const maxX = Math.max(node.position.x, matchedY.position.x) + 360
      nextLines.horizontal = {
        y: node.position.y + 36, // passes exactly through the card handles / header line
        x1: minX,
        x2: maxX,
      }
    }
    if (matchedX) {
      const minY = Math.min(node.position.y, matchedX.position.y) - 40
      const maxY = Math.max(node.position.y, matchedX.position.y) + 260
      nextLines.vertical = {
        x: node.position.x + 160, // center of the cards (320px / 2)
        y1: minY,
        y2: maxY,
      }
    }

    if (nextLines.horizontal || nextLines.vertical) {
      setHelperLines(nextLines)
    } else {
      setHelperLines(null)
    }
  }, [nodes])

  const handleNodeDragStart: OnNodeDrag = useCallback(() => {
    isDraggingRef.current = true
  }, [])

  // Handle node drag stop -> persist position
  const handleNodeDragStop: OnNodeDrag = useCallback((_event, node) => {
    isDraggingRef.current = false
    setHelperLines(null)
    const saved = loadSavedPositions()
    saved[node.id] = {
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
    }
    savePositions(saved)
  }, [])
  const handleConfirmAutoLayout = useCallback(() => {
    clearSavedPositions()
    const currentNodes = getNodes() as CanvasTurnNode[]
    const laidOut = computeAutoLayout(currentNodes.length > 0 ? currentNodes : nodes, edges, 'LR')
    setNodes(laidOut)
    setConfirmAutoLayoutOpen(false)
  }, [getNodes, nodes, edges, setNodes])

  // Node click: select turn, open thread drawer, and center node in left 1/3 of screen
  const handleNodeClick = useCallback((_event: React.MouseEvent, node: { id: string; data?: unknown; position: { x: number; y: number } }) => {
    const data = node.data as { threadId?: string; userMessage?: { id: string } } | undefined
    if (data?.threadId) {
      setSelectedThreadId(data.threadId)
      setSelectedMessageId(data.userMessage?.id)
      const currentZoom = getZoom()
      const shiftX = typeof window !== 'undefined' ? Math.round(window.innerWidth * 0.2) : 260
      void setCenter(node.position.x + 160 + shiftX, node.position.y + 80, { zoom: Math.max(currentZoom, 0.75), duration: 400 })
    }
  }, [setCenter, getZoom])

  const handlePaneClick = useCallback(() => {
    setSelectedThreadId(null)
    setSelectedMessageId(undefined)
  }, [])

  return (
    <div className={css.canvasContainer} data-canvas-drawer-open={Boolean(selectedThreadId)}>
      {/* Top Floating Toolbar */}
      <div className={css.canvasToolbar}>
        {onCloseCanvas && (
          <button
            type="button"
            className={css.toolbarBtn}
            onClick={onCloseCanvas}
            title={WF.canvas.backToChat}
            aria-label={WF.canvas.backToChat}
          >
            <Icon name="reply" width={14} height={14} />
            <span>{WF.canvas.backToChat}</span>
          </button>
        )}
        <button
          type="button"
          className={css.toolbarBtn}
          onClick={() => setConfirmAutoLayoutOpen(true)}
          title={WF.canvas.autoLayoutTree}
          aria-label={WF.canvas.autoLayout}
        >
          <Icon name="direction" width={14} height={14} />
          <span>{WF.canvas.autoLayout}</span>
        </button>
        <span className={css.toolbarMeta}>
          {WF.canvas.stats(nodes.length, edges.length)}
        </span>
      </div>

      {/* Confirmation Dialog for Auto Layout */}
      {confirmAutoLayoutOpen && (
        <ConfirmDialog
          title={WF.canvas.confirmLayoutTitle}
          message={WF.canvas.confirmLayoutMessage}
          confirmLabel={WF.canvas.confirmLayoutButton}
          onConfirm={handleConfirmAutoLayout}
          onCancel={() => setConfirmAutoLayoutOpen(false)}
        />
      )}

      {/* Infinite Canvas */}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        onInit={instance => {
          window.setTimeout(() => {
            const single = nodes.length <= 1
            instance.fitView({ padding: single ? 0.2 : 0.35, maxZoom: single ? 1.0 : 0.85, duration: 250 })
          }, 80)
        }}
        fitView
        fitViewOptions={{ padding: nodes.length <= 1 ? 0.2 : 0.35, maxZoom: nodes.length <= 1 ? 1.0 : 0.85 }}
        snapToGrid
        snapGrid={[10, 10]}
        minZoom={0.15}
        maxZoom={2.5}
        defaultEdgeOptions={{
          type: 'smoothstep',
          animated: false,
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--wb-line, #e3e3e5)" />
        <Controls showInteractive={false} />
        {nodes.length >= 3 && (
          <MiniMap
            nodeColor="var(--wb-accent, #00c375)"
            maskColor="color-mix(in srgb, var(--wb-bg) 70%, transparent)"
            style={{
              background: 'var(--wb-surface)',
              border: '1px solid var(--wb-line)',
              borderRadius: '8px',
            }}
          />
        )}
        {helperLines && (
          <ViewportPortal>
            <svg
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                overflow: 'visible',
                pointerEvents: 'none',
                zIndex: 1000,
              }}
            >
              {helperLines.horizontal && (
                <g>
                  <line
                    x1={helperLines.horizontal.x1}
                    y1={helperLines.horizontal.y}
                    x2={helperLines.horizontal.x2}
                    y2={helperLines.horizontal.y}
                    stroke="var(--wb-accent, #00c375)"
                    strokeWidth={1.5}
                    strokeDasharray="6 4"
                  />
                  <circle cx={helperLines.horizontal.x1} cy={helperLines.horizontal.y} r={3.5} fill="var(--wb-accent, #00c375)" />
                  <circle cx={helperLines.horizontal.x2} cy={helperLines.horizontal.y} r={3.5} fill="var(--wb-accent, #00c375)" />
                  <g transform={`translate(${(helperLines.horizontal.x1 + helperLines.horizontal.x2) / 2}, ${helperLines.horizontal.y - 12})`}>
                    <rect x={-32} y={-10} width={64} height={18} rx={9} fill="var(--wb-accent, #00c375)" />
                    <text x={0} y={3} textAnchor="middle" fill="#ffffff" fontSize={11} fontWeight={600} fontFamily="inherit">
                      {WF.canvas.alignHorizontal}
                    </text>
                  </g>
                </g>
              )}
              {helperLines.vertical && (
                <g>
                  <line
                    x1={helperLines.vertical.x}
                    y1={helperLines.vertical.y1}
                    x2={helperLines.vertical.x}
                    y2={helperLines.vertical.y2}
                    stroke="var(--wb-accent, #00c375)"
                    strokeWidth={1.5}
                    strokeDasharray="6 4"
                  />
                  <circle cx={helperLines.vertical.x} cy={helperLines.vertical.y1} r={3.5} fill="var(--wb-accent, #00c375)" />
                  <circle cx={helperLines.vertical.x} cy={helperLines.vertical.y2} r={3.5} fill="var(--wb-accent, #00c375)" />
                  <g transform={`translate(${helperLines.vertical.x + 38}, ${(helperLines.vertical.y1 + helperLines.vertical.y2) / 2})`}>
                    <rect x={-32} y={-10} width={64} height={18} rx={9} fill="var(--wb-accent, #00c375)" />
                    <text x={0} y={3} textAnchor="middle" fill="#ffffff" fontSize={11} fontWeight={600} fontFamily="inherit">
                      {WF.canvas.alignCenter}
                    </text>
                  </g>
                </g>
              )}
            </svg>
          </ViewportPortal>
        )}
      </ReactFlow>
      {/* Slide-out Drawer on Right for selected Turn/Thread */}
      {selectedThreadId && (
        <div className={css.canvasDrawer}>
          <ThreadPanel
            threadId={selectedThreadId}
            onClose={() => setSelectedThreadId(null)}
            source={source}
            sourceMessageId={selectedMessageId}
            onDm={() => {}}
          />
        </div>
      )}
    </div>
  )
}
