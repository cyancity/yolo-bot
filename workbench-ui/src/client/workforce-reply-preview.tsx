/**
 * ReplyPreviewDialog：组卡成员的全文预览，右侧抽屉（复用 Dialog 与 files/memory 的
 * :has(> .drawer) 贴边定位，不新造浮层体系）。不接管发送，不产生第二条回复路径。
 */
import { Button } from './ui/primitives.ts'
import { useEffect, useRef, type ReactNode } from 'react'
import css from './workforce-reply-group.module.css'
import { Dialog } from './ui/index.tsx'
import { Icon } from './ui/icons.tsx'
import { WF } from './workforce-strings.ts'

export interface ReplyPreviewDialogProps {
  readonly title: string
  readonly subtitle?: string | undefined
  /** 完整 markdown 正文（调用方注入同一套渲染器）。 */
  readonly children: ReactNode
  readonly footer?: ReactNode | undefined
  readonly onPrevious?: (() => void) | undefined
  readonly onNext?: (() => void) | undefined
  readonly onClose: () => void
}

export function ReplyPreviewDialog({ title, subtitle, children, footer, onPrevious, onNext, onClose }: ReplyPreviewDialogProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { bodyRef.current?.scrollTo?.({ top: 0 }) }, [title])
  return (
    <Dialog title={title} closeLabel={WF.replyGroup.closePreview} onClose={onClose}>
      <div className={css.previewDrawer}>
        {subtitle !== undefined && <p className={css.previewSubtitle}>{subtitle}</p>}
        <div className={css.previewBody} ref={bodyRef}>{children}</div>
        {(onPrevious !== undefined || onNext !== undefined || footer !== undefined) && (
          <div className={css.previewFoot}>
            {onPrevious !== undefined && (
              <Button variant="plain" type="button" className={css.previewNav} onClick={onPrevious}>
                <Icon name="chevronRight" width={14} height={14} className={css.previewNavPrev} />
                {WF.replyGroup.previous}
              </Button>
            )}
            {onNext !== undefined && (
              <Button variant="plain" type="button" className={css.previewNav} onClick={onNext}>
                {WF.replyGroup.next}
                <Icon name="chevronRight" width={14} height={14} />
              </Button>
            )}
            {footer !== undefined && <span className={css.previewFootExtra}>{footer}</span>}
          </div>
        )}
      </div>
    </Dialog>
  )
}
