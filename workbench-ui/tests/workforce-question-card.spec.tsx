// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkforceQuestionCard, type QuestionCardApproval } from '../src/client/workforce-question-card.tsx'

const approval = (extra: Partial<QuestionCardApproval> = {}): QuestionCardApproval => ({ requestId: 'req-1', toolName: 'shell.run', ...extra })
afterEach(() => cleanup())

describe('批准卡操作详情', () => {
  it('展示原生 displayReason 与可展开操作详情，已回答卡片仍保留', () => {
    render(<WorkforceQuestionCard approval={approval({ reason: '需要清理产物', displayReason: 'shell.run 需要在工作区外执行', detail: { text: '{"command":"rm -rf build"}', truncated: false } })} onAnswer={vi.fn()} />)
    expect(screen.getByText('「shell.run」需要你的批准才能继续')).toBeTruthy()
    expect(screen.getByText('shell.run 需要在工作区外执行')).toBeTruthy()
    // 有 displayReason 时不再重复显示原生英文前缀的 reason
    expect(screen.queryByText('需要清理产物')).toBeNull()
    expect(screen.getByText('操作详情')).toBeTruthy()
    expect(screen.getByText('{"command":"rm -rf build"}')).toBeTruthy()
    // 回答后只读，displayReason/detail 仍留在卡片上
    const onAnswer = vi.fn(async () => {})
    cleanup()
    render(<WorkforceQuestionCard approval={approval({ displayReason: 'shell.run 需要在工作区外执行', detail: { text: 'ls', truncated: false }, answered: 'allowed-once' })} onAnswer={onAnswer} />)
    expect(screen.getByText('已允许一次')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '允许一次' })).toBeNull()
    expect(screen.getByText('ls')).toBeTruthy()
  })

  it('detail 截断标记；无 detail 显示「操作详情不可用」；无 displayReason 只显示 reason', () => {
    render(<WorkforceQuestionCard approval={approval({ detail: { text: 'xxx', truncated: true } })} onAnswer={vi.fn()} />)
    expect(screen.getByText('操作详情（已截断）')).toBeTruthy()
    cleanup()
    render(<WorkforceQuestionCard approval={approval({ reason: '模型自述理由' })} onAnswer={vi.fn()} />)
    expect(screen.getByText('模型自述理由')).toBeTruthy()
    expect(screen.getByText('操作详情不可用')).toBeTruthy()
  })

  it('允许一次/拒绝透传 outcome 与 requestId', async () => {
    const onAnswer = vi.fn(async () => {})
    render(<WorkforceQuestionCard approval={approval()} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }))
    expect(onAnswer).toHaveBeenCalledWith('req-1', { outcome: 'allowed-once' })
    await waitFor(() => expect(screen.getByText('已允许一次')).toBeTruthy())
  })
})
