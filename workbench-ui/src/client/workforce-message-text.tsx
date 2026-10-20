import { isValidElement, memo, useCallback, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Employee, Task, TaskDeliverable } from './workforce-types.ts'
import { WorkforceAttachment, WorkforceFileLink, WorkforceImageGallery, isAttachmentUrl, safeAttachmentUrl, gateAttachment, attachmentName } from './workforce-attachments.tsx'
import type { DeliverableInfo } from './workforce-attachments.tsx'
import css from './workforce-message-text.module.css'
import workforceCss from './workforce.module.css'
import { WF } from './workforce-strings.ts'
import { Button } from './ui/button.tsx'

interface MarkdownNode {
  type: string
  value?: string
  children?: MarkdownNode[]
  url?: string
}

/** Mention expansion happens only in prose, never inside code, links, or raw HTML. */
function mentionsPlugin(employees: readonly Employee[]) {
  const named = [...employees].sort((a, b) => b.name.length - a.name.length)
  return () => (tree: unknown) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || ['link', 'linkReference'].includes(node.type)) return
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text' || !child.value) { visit(child); return [child] }
        const value = child.value
        const result: MarkdownNode[] = []
        let start = 0
        for (let index = 0; index < value.length; index++) {
          if (value[index] !== '@') continue
          const boundary = /[\s,，。;；:：!！?？()（）]/
          const isEveryoneZh = value.startsWith('@所有人', index)
            && (index + 4 === value.length || boundary.test(value[index + 4]!))
          const isEveryoneEn = value.slice(index, index + 9).toLowerCase() === '@everyone'
            && (index + 9 === value.length || boundary.test(value[index + 9]!))
          if (isEveryoneZh || isEveryoneEn) {
            const tokenLen = isEveryoneZh ? 4 : 9
            if (index > start) result.push({ type: 'text', value: value.slice(start, index) })
            result.push({ type: 'link', url: '#workforce-all', children: [{ type: 'text', value: value.slice(index, index + tokenLen) }] })
            index += tokenLen - 1
            start = index + 1
            continue
          }
          const employee = named.find(item => value.startsWith(item.name, index + 1)
            && (index + item.name.length + 1 === value.length || boundary.test(value[index + item.name.length + 1]!)))
          if (!employee) continue
          if (index > start) result.push({ type: 'text', value: value.slice(start, index) })
          result.push({ type: 'link', url: `#workforce-employee/${encodeURIComponent(employee.id)}`, children: [{ type: 'text', value: `@${employee.name}` }] })
          index += employee.name.length
          start = index + 1
        }
        if (start < value.length) result.push({ type: 'text', value: value.slice(start) })
        return result
      })
    }
    visit(tree as MarkdownNode)
  }
}

/**
 * 从当前任务快照解析成果链接的核对信息：`/tasks/<taskId>/deliverables/<名>?v=N`
 * 命中任务与文件名后取该版本（未给 v 则取已发布或最新版）；解析不到返回 undefined，
 * 附件卡片据此不显示信息图标。
 */
function resolveDeliverableInfo(url: string, tasks: readonly Task[], authorName: (id: string) => string): DeliverableInfo | undefined {
  const parsed = new URL(url, 'http://localhost')
  const segments = parsed.pathname.split('/').filter(Boolean)
  const name = segments.pop() ?? ''
  if (segments.pop() !== 'deliverables') return undefined
  const taskId = segments.pop()
  if (taskId === undefined) return undefined
  const task = tasks.find(item => item.id === taskId)
  if (task === undefined) return undefined
  const deliverable: TaskDeliverable | undefined = task.deliverables.find(item => item.name === decodeURIComponent(name))
  if (deliverable === undefined) return undefined
  const versions = deliverable.versions ?? []
  if (versions.length === 0) return undefined
  const requested = parsed.searchParams.get('v')
  const wanted = requested === null ? undefined : Number(requested)
  const entry = wanted === undefined
    ? versions.find(item => item.version === deliverable.publishedVersion) ?? versions[versions.length - 1]
    : versions.find(item => item.version === wanted)
  if (entry === undefined) return undefined
  return {
    version: entry.version,
    authorName: authorName(entry.authorId),
    published: deliverable.publishedVersion !== undefined && deliverable.publishedVersion === entry.version,
    charCount: entry.charCount,
    createdAt: entry.createdAt,
  }
}

interface ParsedAttachmentMeta {
  readonly name?: string | undefined
  readonly locationUrl?: string | undefined
  readonly sizeBytes?: number | undefined
  readonly mime?: string | undefined
}

function attachmentMetadata(title?: string): ParsedAttachmentMeta {
  if (!title) return {}
  try {
    const value = JSON.parse(title) as {
      name?: unknown
      locationUrl?: unknown
      sizeBytes?: unknown
      mime?: unknown
    }
    if (typeof value !== 'object' || value === null) return {}
    return {
      ...(typeof value.name === 'string' && value.name.trim() !== '' ? { name: value.name.trim() } : {}),
      ...(typeof value.locationUrl === 'string' && value.locationUrl.trim() !== '' ? { locationUrl: value.locationUrl.trim() } : {}),
      ...(typeof value.sizeBytes === 'number' && Number.isFinite(value.sizeBytes) && value.sizeBytes >= 0 ? { sizeBytes: value.sizeBytes } : {}),
      ...(typeof value.mime === 'string' && value.mime.trim() !== '' ? { mime: value.mime.trim() } : {}),
    }
  } catch { return {} }
}
function cleanMessageText(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(/(?:^|\n\n?)附件：(?=\n\s*-\s*\[)/g, '\n\n')
    .replace(/(-\s*\[[^\]]+\]\([^\)]+\))\s*·\s*名称：[^\n]*?·\s*类型：[^\n]*?·\s*material\s*id：[^\n]*/gi, '$1')
    .trim()
}

/**
 * 校验 HAST 列表项节点是否为纯文件引用条目：
 * 节点内容必须仅包含空白文本 + 唯一个 <a> 标签（允许单 <p> 包裹），
 * 且该链接指向经过安全门控可见的合法文件路由。
 */
function isPureFileHastNode(node: unknown): boolean {
  if (!node || typeof node !== 'object' || !('children' in node)) return false
  const rawChildren = node.children
  if (!Array.isArray(rawChildren)) return false

  const significantChildren = rawChildren.filter((item: unknown): boolean => {
    if (!item || typeof item !== 'object') return false
    if ('type' in item && item.type === 'text' && 'value' in item && typeof item.value === 'string') {
      return item.value.trim() !== ''
    }
    return true
  })

  if (significantChildren.length !== 1) return false
  let targetNode: unknown = significantChildren[0]

  if (targetNode && typeof targetNode === 'object' && 'type' in targetNode && targetNode.type === 'element' && 'tagName' in targetNode && targetNode.tagName === 'p' && 'children' in targetNode && Array.isArray(targetNode.children)) {
    const pChildren = targetNode.children.filter((item: unknown): boolean => {
      if (!item || typeof item !== 'object') return false
      if ('type' in item && item.type === 'text' && 'value' in item && typeof item.value === 'string') {
        return item.value.trim() !== ''
      }
      return true
    })
    if (pChildren.length !== 1) return false
    targetNode = pChildren[0]
  }

  if (!targetNode || typeof targetNode !== 'object' || !('type' in targetNode) || targetNode.type !== 'element' || !('tagName' in targetNode) || targetNode.tagName !== 'a') {
    return false
  }

  if (!('properties' in targetNode) || typeof targetNode.properties !== 'object' || targetNode.properties === null) {
    return false
  }

  const props = targetNode.properties
  const href = 'href' in props && typeof props.href === 'string' ? props.href : undefined
  if (!href) return false

  const url = safeAttachmentUrl(href)
  if (!url || !isAttachmentUrl(url)) return false

  const title = 'title' in props && typeof props.title === 'string' ? props.title : undefined
  const meta = attachmentMetadata(title)
  const fileName = meta.name ?? attachmentName(url)
  const gate = gateAttachment(fileName, meta.mime)
  return gate.visible
}


function MessageCodeBlock({ children }: { readonly children?: ReactNode }) {
  const child = isValidElement<{ children?: ReactNode; className?: string }>(children) ? children : undefined
  const code = String(child?.props.children ?? children ?? '').replace(/\n$/, '')
  const language = /language-([^\s]+)/.exec(child?.props.className ?? '')?.[1]
  const lineCount = code.split('\n').length
  const [expanded, setExpanded] = useState(false)
  return <section className={css.codeFence} data-collapsed={lineCount > 20 && !expanded}>
    <CodeBlock code={code} lang={language ?? 'text'} copyLabel={WF.ui.copyCode} copiedLabel={WF.ui.copiedCode} />
    {lineCount > 20 && <Button variant="plain" type="button" className={css.expandCode} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? WF.ui.collapseCode : WF.ui.expandCode(lineCount)}
    </Button>}
  </section>
}

/** GFM for both roles; model-authored HTML remains inert literal text.
 *  memo 后未变化正文零重渲染；内部对 <Markdown> 元素再按 text 记忆化，
 *  即使外层因 tasks/employees 引用变化重渲染，也不重解析 markdown。 */
export const WorkforceMessageText = memo(function WorkforceMessageText({ text, employees, onDm, tasks = [], hasAttachments = false, hasDeliverables = false }: {
  readonly text: string
  readonly employees: readonly Employee[]
  readonly onDm: (id: string) => void
  readonly tasks?: readonly Task[] | undefined
  readonly hasAttachments?: boolean | undefined
  readonly hasDeliverables?: boolean | undefined
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  // tasks、employees、onDm 每次轮询都可能是新引用；经 ref 读取，保持 components 稳定，避免附件卡片重挂（tooltip 被关掉）。
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const employeesRef = useRef(employees)
  employeesRef.current = employees
  const onDmRef = useRef(onDm)
  onDmRef.current = onDm
  const [gallery, setGallery] = useState<{ images: { src: string; alt: string }[]; index: number }>()
  const closeGallery = useCallback(() => setGallery(undefined), [])
  const openImage = useCallback((src: string) => {
    const images = Array.from(rootRef.current?.querySelectorAll<HTMLImageElement>('img[data-message-image]') ?? [], image => ({ src: image.getAttribute('src')!, alt: image.alt }))
    const index = images.findIndex(image => image.src === src)
    if (index >= 0) setGallery({ images, index })
  }, [])
  const mentionPlugin = useMemo(() => mentionsPlugin(employees), [employees])
  const authorNameOf = useCallback((authorId: string) =>
    authorId === 'user'
      ? WF.common.you
      : authorId === 'unknown' || authorId === ''
        ? WF.common.unknown
        : employeesRef.current.find(item => item.id === authorId)?.name ?? WF.common.unknown, [])
  const components: Components = useMemo(() => ({
    table: ({ children }: { children?: ReactNode }) => <div className={css.tableScroll}><table>{children}</table></div>,
    pre: MessageCodeBlock,
    a: ({ href, title, children }: { href?: string | undefined; title?: string | undefined; children?: ReactNode }) => {
      if (href === '#workforce-all') return <span className={`${workforceCss.mention} ${workforceCss.mentionAll}`}>{children}</span>
      if (href?.startsWith('#workforce-employee/')) {
        const id = decodeURIComponent(href.slice('#workforce-employee/'.length))
        return <Button variant="plain" type="button" className={workforceCss.mention} onClick={() => onDmRef.current(id)}>{children}</Button>
      }
      const url = href && safeAttachmentUrl(href)
      if (!url) return <>{children}</>
      const meta = attachmentMetadata(title)
      const fileName = meta.name ?? attachmentName(url)
      const gate = gateAttachment(fileName, meta.mime)
      if (!gate.visible) return null
      if (isAttachmentUrl(url)) {
        const isDeliverable = url.includes('/deliverables/')
        if (hasAttachments || (isDeliverable && hasDeliverables)) {
          return (
            <WorkforceFileLink
              url={url}
              name={meta.name}
              locationUrl={meta.locationUrl}
              sizeBytes={meta.sizeBytes}
              mime={meta.mime}
            >
              {children}
            </WorkforceFileLink>
          )
        }
        return (
          <WorkforceAttachment
            url={url}
            name={meta.name}
            locationUrl={meta.locationUrl}
            sizeBytes={meta.sizeBytes}
            mime={meta.mime}
            onImageOpen={openImage}
            deliverableInfo={resolveDeliverableInfo(url, tasksRef.current, authorNameOf)}
          />
        )
      }
      return <a href={url} title={title} target="_blank" rel="noopener noreferrer">{children}</a>
    },
    img: ({ src, alt, title }: { src?: string | undefined; alt?: string | undefined; title?: string | undefined }) => {
      const url = src && safeAttachmentUrl(src)
      if (!url) return <>{alt}</>
      const meta = attachmentMetadata(title)
      const mime = meta.mime?.startsWith('image/') ? meta.mime : 'image/*'
      const fileName = meta.name || alt || undefined
      return (
        <WorkforceAttachment
          url={url}
          name={fileName}
          locationUrl={meta.locationUrl}
          sizeBytes={meta.sizeBytes}
          mime={mime}
          onImageOpen={openImage}
        />
      )
    },
    li: ({ children, node, ...props }) => {
      const isPureFile = isPureFileHastNode(node)
      return (
        <li data-file-item={isPureFile ? 'true' : undefined} {...props}>
          {children}
        </li>
      )
    },
  }), [openImage, authorNameOf, hasAttachments, hasDeliverables])
  const cleanedText = useMemo(() => cleanMessageText(text), [text])
  const rendered = useMemo(() => (
    <Markdown remarkPlugins={[remarkGfm, mentionPlugin]} components={components} urlTransform={value => value === '#workforce-all' || value.startsWith('#workforce-employee/') ? value : safeAttachmentUrl(value) ?? ''}>{cleanedText}</Markdown>
  ), [cleanedText, mentionPlugin, components])
  return <div ref={rootRef} className={css.messageText}>
    {rendered}
    {gallery && <WorkforceImageGallery images={gallery.images} initialIndex={gallery.index} onClose={closeGallery} />}
  </div>
})
