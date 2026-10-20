import { useEffect, useDeferredValue, useMemo, useRef, useState } from 'react'
import { SearchBar } from '@lobehub/ui'
import { IconButton } from './ui/index.tsx'
import { Icon } from './ui/icons.tsx'
import { WorkforceAvatar } from './workforce-avatar.tsx'
import { WF } from './workforce-strings.ts'
import type { WorkbenchView } from './nav.ts'
import type { Employee, Thread, WorkforceMessage } from './workforce-types.ts'
import searchCss from './workforce-sidebar-search.module.css'
/** Keyword search matching result */
interface SearchResultItem {
  readonly messageId: string
  readonly threadId: string
  readonly text: string
  readonly ts: string
  readonly role: 'user' | 'agent' | 'system'
  readonly senderName: string
  readonly navView: WorkbenchView
  readonly targetTitle: string
  readonly avatarEmployee?: Employee | undefined
}

function formatSearchTime(ts: string): string {
  try {
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return ''
    const now = new Date()
    const isSameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
    if (isSameDay) {
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }
    return `${date.getMonth() + 1}/${date.getDate()}`
  } catch {
    return ''
  }
}

/** Highlight snippet around keyword */
function HighlightedSnippet({ text, query }: { readonly text: string; readonly query: string }) {
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const index = lowerText.indexOf(lowerQuery)
  if (index === -1) {
    return <span>{text.slice(0, 80)}</span>
  }
  const start = Math.max(0, index - 20)
  const end = Math.min(text.length, index + query.length + 40)
  const prefix = (start > 0 ? '…' : '') + text.slice(start, index)
  const matched = text.slice(index, index + query.length)
  const suffix = text.slice(index + query.length, end) + (end < text.length ? '…' : '')

  return (
    <span>
      {prefix}
      <span className={searchCss.highlight}>{matched}</span>
      {suffix}
    </span>
  )
}

/** Top sidebar search box for chat history */
export function SidebarHistorySearch({
  messages,
  threads,
  channels,
  employees,
  onNavigate,
  onAddChat,
}: {
  readonly messages?: Readonly<Record<string, { readonly list: readonly WorkforceMessage[] }>> | undefined
  readonly threads: readonly Thread[]
  readonly channels: readonly { readonly id: string; readonly name: string; readonly groupChatName?: string | null }[]
  readonly employees: readonly Employee[]
  readonly onNavigate: (view: WorkbenchView) => void
  readonly onAddChat?: (() => void) | undefined
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const deferredQuery = useDeferredValue(query)
  const containerRef = useRef<HTMLDivElement>(null)

  const employeeMap = useMemo(() => new Map(employees.map(e => [e.id, e])), [employees])
  const channelMap = useMemo(() => new Map(channels.map(c => [c.id, c])), [channels])
  const threadMap = useMemo(() => new Map(threads.map(t => [t.id, t])), [threads])

  const results = useMemo<SearchResultItem[]>(() => {
    const q = deferredQuery.trim().toLowerCase()
    if (!q || !messages) return []

    const matches: SearchResultItem[] = []
    for (const [threadId, threadMsgs] of Object.entries(messages)) {
      if (!threadMsgs?.list) continue
      const thread = threadMap.get(threadId)

      let navView: WorkbenchView | undefined
      let targetTitle: string = WF.common.session
      let avatarEmployee: Employee | undefined

      if (thread?.kind === 'dm' && thread.employeeId) {
        navView = { kind: 'dm', id: thread.employeeId }
        const emp = employeeMap.get(thread.employeeId)
        avatarEmployee = emp
        targetTitle = emp ? emp.name : (thread.title || WF.nav.dms)
      } else if (thread?.kind === 'channel' && thread.channelId) {
        navView = { kind: 'channel', id: thread.channelId }
        const ch = channelMap.get(thread.channelId)
        targetTitle = ch?.groupChatName?.trim() || ch?.name || thread.title || WF.nav.channels
      } else if (thread?.taskId) {
        if (thread.channelId) {
          navView = { kind: 'channel', id: thread.channelId }
          const ch = channelMap.get(thread.channelId)
          targetTitle = ch?.groupChatName?.trim() || ch?.name || WF.common.channelTask
        } else if (thread.employeeId) {
          navView = { kind: 'dm', id: thread.employeeId }
          const emp = employeeMap.get(thread.employeeId)
          avatarEmployee = emp
          targetTitle = emp ? emp.name : WF.common.employeeTask
        }
      } else {
        // Fallback for threadId if matching a channel directly
        const ch = channelMap.get(threadId)
        if (ch) {
          navView = { kind: 'channel', id: ch.id }
          targetTitle = ch.groupChatName?.trim() || ch.name
        }
      }

      if (!navView) continue

      for (const msg of threadMsgs.list) {
        if (msg.text && msg.text.toLowerCase().includes(q)) {
          const senderEmp = employeeMap.get(msg.senderId)
          matches.push({
            messageId: msg.id,
            threadId,
            text: msg.text,
            ts: msg.ts,
            role: msg.role,
            senderName: msg.senderName || senderEmp?.name || (msg.role === 'user' ? WF.common.me : WF.common.bot),
            navView,
            targetTitle,
            avatarEmployee: senderEmp ?? avatarEmployee,
          })
          if (matches.length >= 40) break
        }
      }
      if (matches.length >= 40) break
    }

    // Sort by timestamp descending
    matches.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    return matches
  }, [deferredQuery, messages, threadMap, employeeMap, channelMap])

  // Click outside to close dropdown
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setQuery('')
      setOpen(false)
    }
  }

  const handleSelectResult = (item: SearchResultItem) => {
    onNavigate(item.navView)
    setOpen(false)
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('workforce:jump-to-message', {
          detail: { messageId: item.messageId, threadId: item.threadId },
        })
      )
    }, 120)
  }

  const isSearching = query.trim().length > 0

  return (
    <div className={searchCss.searchContainer} ref={containerRef} onKeyDown={handleKeyDown}>
      <div className={searchCss.searchRow}>
        <SearchBar
          aria-label={WF.common.search}
          className={searchCss.searchBar}
          classNames={{ input: searchCss.searchInput ?? '' }}
          placeholder={WF.common.search}
          size="small"
          type="block"
          value={query}
          onInputChange={value => {
            setQuery(value)
            setOpen(Boolean(value.trim()))
          }}
          onFocus={() => {
            if (query.trim()) setOpen(true)
          }}
        />
        {onAddChat && (
          <IconButton
            className={searchCss.addChatBtn}
            label={WF.common.createGroupChat}
            size="sm"
            onClick={onAddChat}
            icon={<Icon name="plusCircle" width={16} height={16} />}
          />
        )}
      </div>

      {open && isSearching && (
        <div className={searchCss.dropdownPopover} role="listbox">
          {results.length === 0 ? (
            <div className={searchCss.noResults}>{WF.common.noMatchingMessages}</div>
          ) : (
            results.map(item => (
              <button
                key={`${item.threadId}-${item.messageId}`}
                type="button"
                className={searchCss.resultItem}
                onClick={() => handleSelectResult(item)}
              >
                {item.avatarEmployee ? (
                  <span className={searchCss.resultAvatar}>
                    <WorkforceAvatar
                      name={item.avatarEmployee.name}
                      color={item.avatarEmployee.avatarColor}
                      role={item.avatarEmployee.role}
                      size={20}
                    />
                  </span>
                ) : (
                  <span className={searchCss.resultAvatar}>
                    <WorkforceAvatar
                      name={item.senderName}
                      tone="#8a8a80"
                      size={20}
                    />
                  </span>
                )}
                <div className={searchCss.resultContent}>
                  <div className={searchCss.resultMetaRow}>
                    <span className={searchCss.resultTargetName}>{item.targetTitle}</span>
                    <span className={searchCss.resultTime}>{formatSearchTime(item.ts)}</span>
                  </div>
                  <div className={searchCss.resultAuthorRow}>
                    <span>{item.senderName}</span>
                  </div>
                  <div className={searchCss.resultSnippet}>
                    <HighlightedSnippet text={item.text} query={deferredQuery.trim()} />
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
