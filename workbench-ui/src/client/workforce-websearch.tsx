/**
 * 联网搜索披露。阶段 B 再挂进消息行：只有线程里已有 web_search 才渲染，
 * 并用 React.lazy(() => import('./workforce-websearch.tsx')) 包一层 Suspense。
 * 本文件不进主包，直到那次懒加载。
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { SearchSource } from './workforce-types.ts'
import css from './workforce-websearch.module.css'

/** 线程已加载消息里是否出现过 web_search。为 false 时不要挂载本组件。 */
export function threadHasWebSearch(messages: readonly { readonly tool?: { readonly name: string } | undefined }[]): boolean {
  return messages.some(message => message.tool?.name === 'web_search')
}

export interface WorkforceWebSearchProps {
  readonly status: 'running' | 'done' | 'error'
  readonly query?: string | undefined
  readonly sources?: readonly SearchSource[] | undefined
}

/** 同 turn 多条 web_search 聚合进一行批量披露时的一条记录。 */
export interface SearchEntry {
  readonly id: string
  readonly status: 'running' | 'done' | 'error'
  readonly query?: string | undefined
  readonly sources?: readonly SearchSource[] | undefined
  readonly error?: string | undefined
}

const RING_RADIUS = 9
const RING_LENGTH = 2 * Math.PI * RING_RADIUS
/** 进度环把来源数折进 8 个满格；8 是该工具单次返回的常见上限，只用于视觉比例。 */
const SOURCE_SCALE = 8
const FAVICON_COLORS = ['#2f5d50', '#2c4f7c', '#6e4a2e', '#6a3d52', '#1f6a66', '#534a7a', '#7a4638', '#3c5a34'] as const

/** searching 时按已耗时与来源数填充；完成为满环，出错停在短弧。 */
export function searchRingFill(status: WorkforceWebSearchProps['status'], elapsedMs: number, sourceCount: number): number {
  if (status === 'done') return 1
  const timeFill = 1 - Math.exp(-Math.max(0, elapsedMs) / 8000)
  const sourceFill = sourceCount > 0 ? Math.min(1, sourceCount / SOURCE_SCALE) : 0
  const mixed = Math.max(timeFill, sourceFill)
  if (status === 'error') return Math.min(0.35, Math.max(0.12, mixed))
  return Math.min(0.92, mixed)
}

export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}


export function faviconLetter(host: string): string {
  const char = host.match(/\p{L}|\p{N}/u)?.[0]
  return (char ?? '?').toLocaleUpperCase()
}

export function faviconColor(host: string): string {
  let hash = 0
  for (let index = 0; index < host.length; index += 1) hash = (Math.imul(hash, 33) + host.charCodeAt(index)) >>> 0
  return FAVICON_COLORS[hash % FAVICON_COLORS.length] ?? FAVICON_COLORS[0]
}

/** 真实站点 favicon：Google s2 服务按域名取 64px 图标；空域名给 undefined 走字母球。 */
export function faviconUrl(host: string): string | undefined {
  if (!host || typeof Image === 'undefined') return undefined
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`
}

/** 小图标：先拉真实 favicon，加载失败（含离线/被拦）回退字母球。 */
function Favicon({ host, className }: { readonly host: string | undefined; readonly className: string | undefined }) {
  const safeHost = host ?? ''
  const [failed, setFailed] = useState(false)
  const url = faviconUrl(safeHost)
  if (url === undefined || failed) {
    return (
      <span className={className} style={{ backgroundColor: faviconColor(safeHost) }} aria-hidden="true">
        {faviconLetter(safeHost)}
      </span>
    )
  }
  return (
    <span className={className} style={{ backgroundColor: faviconColor(safeHost) }} aria-hidden="true">
      <img className={css.faviconImg} src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
    </span>
  )
}

function pillLabel(status: WorkforceWebSearchProps['status'], query: string | undefined, sources: readonly SearchSource[] | undefined): string {
  if (status === 'error') return '搜索没有完成'
  if (status === 'running') return query ? `正在搜索 ${query}` : '正在搜索'
  return sources ? `已搜索 ${sources.length} 个站点` : '已搜索'
}

function httpUrl(url: string): string | undefined {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = (): void => setReduced(query.matches)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])
  return reduced
}

function Globe() {
  return (
    <svg className={css.globe} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <ellipse cx="8" cy="8" rx="2.6" ry="6.25" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="M2 8h12M3.2 5.2h9.6M3.2 10.8h9.6" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function SearchSkeleton() {
  return (
    <div data-websearch-skeleton="" aria-hidden="true">
      {[0, 1, 2].map(slot => (
        <div key={slot} className={css.skeleton}>
          <span className={css.bone} />
          <span>
            <span className={css.boneLong} />
            <span className={css.boneShort} />
          </span>
        </div>
      ))}
    </div>
  )
}

const ORB_VISIBLE_MAX = 6

/** 单个来源行：favicon + 标题 + 域名 + snippet，可点开链接。 */
function SourceRow({ source }: { readonly source: SearchSource }) {
  const host = sourceHost(source.url)
  const href = httpUrl(source.url)
  const body = (
    <>
      <Favicon host={host} className={css.rowFavicon} />
      <span className={css.cardText}>
        <span className={css.title}>{source.title}</span>
        {host ? <span className={css.domain}>{host}</span> : null}
        {source.snippet ? <span className={css.snippet}>{source.snippet}</span> : null}
      </span>
    </>
  )
  if (href === undefined) return <div className={css.cardStatic}>{body}</div>
  return (
    <a className={css.card} href={href} target="_blank" rel="noopener noreferrer">
      {body}
    </a>
  )
}

/** 来源区：左缘竖向导轨 + 堆叠 favicon 球组；点球堆展开沿导轨的来源列表。
    超 6 个来源第 6 位折叠为 +N 计数球；running 尾部 thinking 骨架由父层加。 */
function SourceBoard({ sources, running }: { readonly sources: readonly SearchSource[]; readonly running: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const visible = sources.slice(0, ORB_VISIBLE_MAX)
  const extra = sources.length - ORB_VISIBLE_MAX
  return (
    <div className={css.board} data-expanded={expanded ? 'true' : 'false'}>
      <button
        type="button"
        className={css.stackBtn}
        aria-expanded={expanded}
        aria-label={`${sources.length} 个来源，点击${expanded ? '收起' : '展开'}`}
        onClick={() => setExpanded(v => !v)}
      >
        <span className={css.stack} aria-hidden="true">
          {visible.map((source, index) => {
            const host = sourceHost(source.url)
            const isLast = index === visible.length - 1 && extra > 0
            if (isLast) {
              return (
                <span key={`${source.url}${index}`} className={css.stackOrb} style={{ backgroundColor: 'var(--wb-hover, #efefea)', color: 'var(--wb-sub, #6f6f66)', zIndex: 0 }}>
                  {`+${extra + 1}`}
                </span>
              )
            }
            return (
              <span key={`${source.url}${index}`} className={css.stackOrbWrap} style={{ zIndex: visible.length - index }}>
                <Favicon host={host} className={css.stackOrb} />
              </span>
            )
          })}
        </span>
        <span className={css.stackCount}>{sources.length} 个来源</span>
      </button>
      {expanded ? (
        <ul className={css.trackList}>
          {sources.map((source, index) => (
            <li key={`${source.url}${index}`} className={css.trackItem}>
              <SourceRow source={source} />
            </li>
          ))}
          {running ? <li className={css.trackItem}><SearchSkeleton /></li> : null}
        </ul>
      ) : null}
    </div>
  )
}

/** 搜索 pill。点击自身展开或收起来源，没有第二个按钮。 */
export function WorkforceWebSearch({ status, query, sources }: WorkforceWebSearchProps) {
  const [open, setOpen] = useState(false)
  const reduced = useReducedMotion()
  const started = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)
  const panelId = useId()
  useEffect(() => {
    if (status !== 'running') return undefined
    const tick = (): void => setElapsed(Date.now() - started.current)
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [status])
  const label = pillLabel(status, query, sources)
  const fill = searchRingFill(status, status === 'running' ? elapsed : 0, sources?.length ?? 0)
  const listed = sources ?? []
  return (
    <div className={css.root} data-websearch="" data-status={status} data-motion={reduced ? 'reduce' : 'full'}>
      <button type="button" className={css.pill} aria-expanded={open} aria-controls={panelId} title={label} onClick={() => setOpen(value => !value)}>
        <span className={css.mark} aria-hidden="true">
          <svg className={css.ring} viewBox="0 0 20 20">
            <circle className={css.track} cx="10" cy="10" r={RING_RADIUS} />
            <circle
              className={status === 'error' ? css.arcError : css.arc}
              cx="10"
              cy="10"
              r={RING_RADIUS}
              strokeDasharray={RING_LENGTH}
              strokeDashoffset={RING_LENGTH * (1 - fill)}
              data-fill={fill.toFixed(3)}
            />
          </svg>
          <Globe />
        </span>
        <span className={status === 'running' && !reduced ? css.labelRunning : css.label}>{label}</span>
      </button>
      {open ? (
        <div id={panelId} className={reduced ? css.panel : css.panelMotion}>
          {query ? <p className={css.query}>搜索：{query}</p> : null}
          {status === 'running' && listed.length === 0 ? <SearchSkeleton /> : null}
          {status === 'error' && listed.length === 0 ? <p className={css.errorNote}>没有返回来源</p> : null}
          {listed.length > 0 ? <SourceBoard sources={listed} running={status === 'running'} /> : null}
        </div>
      ) : null}
    </div>
  )
}

/** 一次搜索的来源球堆：成功按来源域名去重（最多 6 个），running 显示旋转地球，error 显示 ! 球。 */
function BatchOrbs({ entry }: { readonly entry: SearchEntry }) {
  if (entry.status === 'running') {
    return (
      <span className={css.batchOrb} aria-hidden="true">
        <span className={css.batchOrbLoading}>
          <Globe />
        </span>
      </span>
    )
  }
  if (entry.status === 'error') {
    return (
      <span className={css.batchOrb} aria-hidden="true">
        <span className={css.batchOrbError}>!</span>
      </span>
    )
  }
  const hosts: string[] = []
  for (const source of entry.sources ?? []) {
    const host = sourceHost(source.url)
    if (host && !hosts.includes(host)) hosts.push(host)
    if (hosts.length >= ORB_VISIBLE_MAX) break
  }
  if (hosts.length === 0) {
    return (
      <span className={css.batchOrb} aria-hidden="true">
        <span className={css.batchOrbEmpty}>✓</span>
      </span>
    )
  }
  return (
    <span className={css.batchOrb} aria-hidden="true">
      <span className={css.batchStack}>
        {hosts.map((host, index) => (
          <span key={host} className={css.batchOrbWrap} style={{ zIndex: hosts.length - index }}>
            <Favicon host={host} className={css.stackOrb} />
          </span>
        ))}
      </span>
    </span>
  )
}

function batchCountText(entries: readonly SearchEntry[]): string {
  const running = entries.filter(e => e.status === 'running').length
  const sources = entries.reduce((sum, e) => sum + (e.sources?.length ?? 0), 0)
  const parts: string[] = []
  if (running > 0) parts.push('正在搜索')
  if (sources > 0) parts.push(`${sources} 个来源`)
  if (parts.length === 0) parts.push('搜索完成')
  return parts.join(' · ')
}

/** 失败小 chip：点击展开该次搜索的查询与真实错误文本。 */
function FailChip({ entry, detailId }: { readonly entry: SearchEntry; readonly detailId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <li className={css.trackItem}>
      <button type="button" className={css.failChip} aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(v => !v)}>
        <span className={css.failMark} aria-hidden="true">!</span>
        <span className={css.failLabel}>{entry.query ?? '搜索失败'}</span>
      </button>
      {open ? (
        <div id={detailId} className={css.failDetail}>
          {entry.query ? <p className={css.query}>搜索：{entry.query}</p> : null}
          <p className={css.errorNote}>{entry.error ?? '搜索没有完成'}</p>
        </div>
      ) : null}
    </li>
  )
}

/** 同 turn 多条 web_search 紧凑成一行：球堆总览 + 计数，点击沿导轨展开全部来源；失败项成小 chip 可展开错误详情。 */
export function WebSearchBatch({ entries }: { readonly entries: readonly SearchEntry[] }) {
  const [expanded, setExpanded] = useState(false)
  const reduced = useReducedMotion()
  const running = entries.some(e => e.status === 'running')
  const failures = entries.filter(e => e.status === 'error')
  const successes = entries.filter(e => e.status !== 'error')
  const allSources = successes.flatMap(e => e.sources ?? [])
  const queries = entries.map(e => e.query).filter((q): q is string => typeof q === 'string' && q.length > 0)
  return (
    <div className={css.root} data-websearch-batch="" data-motion={reduced ? 'reduce' : 'full'}>
      <div className={css.board}>
        <button
          type="button"
          className={css.stackBtn}
          aria-expanded={expanded}
          aria-label={`搜索详情，点击${expanded ? '收起' : '展开'}`}
          onClick={() => setExpanded(v => !v)}
        >
          <span className={css.batchOrbs} aria-hidden="true">
            {entries.map(entry => <BatchOrbs key={entry.id} entry={entry} />)}
          </span>
          <span className={css.stackCount}>{batchCountText(entries)}</span>
        </button>
        {expanded ? (
          <div className={css.batchPanel}>
            {queries.map((query, index) => <p key={`${query}${index}`} className={css.query}>搜索：{query}</p>)}
            <ul className={css.trackList}>
              {allSources.map((source, index) => (
                <li key={`${source.url}${index}`} className={css.trackItem}>
                  <SourceRow source={source} />
                </li>
              ))}
              {failures.map(entry => <FailChip key={entry.id} entry={entry} detailId={`search-fail-${entry.id}`} />)}
              {running ? <li className={css.trackItem}><SearchSkeleton /></li> : null}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default WorkforceWebSearch
