import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, useExternalMessageConverter, type AttachmentAdapter, type ThreadMessage, type ThreadMessageLike, type ToolCallMessagePartProps } from '@assistant-ui/react'
import type { WorkforceMessage, WorkforceSnapshot } from './workforce-types.ts'
import type { WorkforceSource } from './workforce-source.ts'
import { attachmentMessage, MAX_ATTACHMENT_BYTES, type UploadedAttachment } from './workforce-upload.ts'
import { WorkbenchExtensionPreview, readExtensionPreview } from './extension-preview.tsx'
import { WF } from './workforce-strings.ts'
import css from './assistant-runtime.module.css'

/** The host remains the message store; assistant-ui supplies rendering and interaction state. */
export function workforceMessageToAssistant(message: WorkforceMessage): ThreadMessageLike {
  const common = {
    id: message.id,
    createdAt: new Date(message.ts),
    metadata: { custom: { workforce: message } },
  }
  if (message.role === 'user') return {
    ...common, role: 'user', content: message.text,
    attachments: (message.attachments ?? []).map(file => ({
      id: file.id, type: file.mime.startsWith('image/') ? 'image' : 'file', name: file.name,
      contentType: file.mime, status: { type: 'complete' as const }, content: [],
    })),
  }
  if (message.role === 'system') return { ...common, role: 'system', content: message.text }
  return {
    ...common, role: 'assistant',
    status: message.running || message.tool?.status === 'running' ? { type: 'running' }
      : message.error || message.tool?.status === 'error' ? { type: 'incomplete', reason: 'error', error: message.error ?? message.text }
        : { type: 'complete', reason: 'stop' },
    content: message.tool ? [{
      type: 'tool-call', toolCallId: message.id, toolName: message.tool.name,
      args: message.tool.searchQuery ? { query: message.tool.searchQuery } : {},
      argsText: message.tool.searchQuery ? JSON.stringify({ query: message.tool.searchQuery }) : '{}',
      ...(message.tool.status !== 'running' ? { result: message.text, isError: message.tool.status === 'error' } : {}),
    }] : [{ type: 'text', text: message.text }],
  }
}

/** File bytes continue through the authenticated DSH material endpoint. */
export function dshAttachmentAdapter(upload: (file: File) => Promise<UploadedAttachment>): AttachmentAdapter {
  const uploaded = new Map<string, UploadedAttachment>()
  return {
    accept: '*/*',
    async add({ file }) {
      if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(WF.taskStatus.attachmentSizeLimit)
      const id = crypto.randomUUID()
      const result = await upload(file)
      uploaded.set(id, result)
      return { id, name: file.name, type: file.type.startsWith('image/') ? 'image' : 'file', contentType: file.type, file, status: { type: 'requires-action', reason: 'composer-send' } }
    },
    async send(attachment) {
      const result = uploaded.get(attachment.id)
      if (!result) throw new Error(WF.taskStatus.uploadFailedPrefix)
      return { ...attachment, status: { type: 'complete' }, content: [{ type: 'text', text: attachmentMessage('', [result]) }] }
    },
    async remove(attachment) { uploaded.delete(attachment.id) },
  }
}

export function WorkforceAssistantRuntime({ source, snapshot, messages, threadIds, targetThreadId, children }: {
  readonly source: WorkforceSource; readonly snapshot: WorkforceSnapshot; readonly messages: readonly WorkforceMessage[]
  readonly threadIds: readonly string[]; readonly targetThreadId?: string | undefined; readonly children: ReactNode
}) {
  const attachments = useMemo(() => dshAttachmentAdapter(file => source.uploadFile(file)), [source])
  const runningTasks = snapshot.tasks.filter(task => task.status === 'running' && threadIds.includes(task.threadId))
  const isRunning = runningTasks.length > 0 || messages.some(message => message.running === true)
  const externalMessages = useMemo(() => [...messages], [messages])
  const convertedMessages = useExternalMessageConverter({ messages: externalMessages, callback: workforceMessageToAssistant, isRunning, joinStrategy: 'none' })
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: convertedMessages,
    isRunning,
    isLoading: snapshot.phase === 'loading' && messages.length === 0,
    hasEarlier: threadIds.some(id => snapshot.messages[id]?.hasMore === true),
    onLoadEarlier: async () => { await Promise.all(threadIds.map(id => source.loadEarlierMessages(id))) },
    onNew: async message => {
      if (!targetThreadId) throw new Error(WF.common.failed)
      const text = [...message.content, ...(message.attachments ?? []).flatMap(attachment => attachment.content)]
        .filter(part => part.type === 'text').map(part => part.text).join('\n\n')
      await source.send(targetThreadId, text, [])
    },
    ...(runningTasks.length ? { onCancel: async () => { await Promise.all(runningTasks.map(task => source.cancelTask(task.id))) } } : {}),
    onReload: async parentId => {
      const start = parentId === null ? 0 : messages.findIndex(message => message.id === parentId) + 1
      const message = messages.slice(start).find(message => message.role === 'agent' && !message.tool)
      if (message) await source.regenerateMessage(message.threadId, message.id, message.senderId)
    },
    adapters: { attachments },
  })
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}

const MessageChildren = createContext<ReactNode>(null)
function RenderMessageChildren() { return <>{useContext(MessageChildren)}</> }
const MESSAGE_COMPONENTS = { Message: RenderMessageChildren }

/** Id-based context keeps host pagination, channel aggregation and reply groups intact. */
export function AssistantMessageScope({ message, children }: { readonly message: WorkforceMessage; readonly children: ReactNode }) {
  return <MessageChildren.Provider value={children}>
    <ThreadPrimitive.Unstable_MessageById messageId={message.id} components={MESSAGE_COMPONENTS} />
  </MessageChildren.Provider>
}

const TextRenderer = createContext<((text: string) => ReactNode) | undefined>(undefined)
function RichTextPart({ text }: { readonly text: string }) { return <>{useContext(TextRenderer)?.(text) ?? text}</> }

function ToolFallback({ toolName, result, argsText, status, isError }: ToolCallMessagePartProps) {
  let parsed: unknown = result
  if (typeof result === 'string') { try { parsed = JSON.parse(result) } catch {} }
  const preview = readExtensionPreview(parsed)
  const output = typeof result === 'string' ? result : result === undefined ? argsText : JSON.stringify(result, null, 2)
  const fallback = <details className={css.tool} open={isError} data-state={status.type}>
    <summary><span>{toolName}</span><span className={css.toolState}>{status.type === 'running' ? WF.ui.uploadingState : isError ? WF.common.failed : WF.steps.summary(1)}</span></summary>
    {output && <pre className={css.output}>{output}</pre>}
  </details>
  return preview ? <WorkbenchExtensionPreview preview={preview} fallback={fallback} /> : fallback
}
const PART_COMPONENTS = { Text: RichTextPart, tools: { Fallback: ToolFallback } }

export function AssistantMessageParts({ renderText }: { readonly renderText?: ((text: string) => ReactNode) | undefined }) {
  return <TextRenderer.Provider value={renderText}><MessagePrimitive.Parts components={PART_COMPONENTS} /></TextRenderer.Provider>
}

export function AssistantToolParts({ message }: { readonly message: WorkforceMessage }) {
  return <AssistantMessageScope message={message}><AssistantMessageParts /></AssistantMessageScope>
}
