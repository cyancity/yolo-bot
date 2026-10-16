import css from './skeleton.module.css'

export interface SkeletonProps {
  readonly kind?: 'text' | 'avatar' | 'message' | 'row' | 'card'
  readonly lines?: number
  readonly width?: number | string
  /** 整块占位同一含义时在外层统一 aria-busy/status，骨架自身 aria-hidden。 */
  readonly label?: string
}

export function Skeleton({ kind = 'text', lines = 1, width, label }: SkeletonProps) {
  const style = width !== undefined ? { width: typeof width === 'number' ? `${width}px` : width } : undefined
  if (kind === 'avatar') {
    return <span className={`${css.base} ${css.avatar}`} style={style} aria-hidden="true" />
  }
  if (kind === 'row') {
    return (
      <span className={css.row} style={style} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
        <span className={`${css.base} ${css.avatar}`} />
        <span className={css.rowBody}>
          <span className={`${css.base} ${css.line}`} style={{ width: '40%' }} />
          <span className={`${css.base} ${css.line}`} style={{ width: '85%' }} />
        </span>
      </span>
    )
  }
  if (kind === 'message') {
    return (
      <span className={css.message} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
        <span className={`${css.base} ${css.avatar}`} />
        <span className={css.msgBody}>
          <span className={`${css.base} ${css.line}`} style={{ width: '30%', height: 'var(--wb-type-compact-size)' }} />
          {Array.from({ length: Math.max(1, lines) }, (_, i) => (
            <span key={i} className={`${css.base} ${css.line}`} style={{ width: i === lines - 1 ? '60%' : '92%' }} />
          ))}
        </span>
      </span>
    )
  }
  if (kind === 'card') {
    return (
      <span className={css.card} style={style} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
        {Array.from({ length: Math.max(1, lines) }, (_, i) => (
          <span key={i} className={`${css.base} ${css.line}`} style={{ width: i === 0 ? '45%' : '88%' }} />
        ))}
      </span>
    )
  }
  return (
    <span className={css.linesWrap} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {Array.from({ length: Math.max(1, lines) }, (_, i) => (
        <span key={i} className={`${css.base} ${css.line}`} style={i === 0 ? style : undefined} />
      ))}
    </span>
  )
}
