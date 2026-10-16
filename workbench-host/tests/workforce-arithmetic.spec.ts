import { describe, expect, it } from 'vitest'
import { checkArithmetic, ARITHMETIC_NOTE } from '../src/workforce/arithmetic.ts'

describe('wb_check_arithmetic 算式核算', () => {
  it('合计/乘积/差额/比值/百分比/增减率返回算式、结果与固定说明', () => {
    expect(checkArithmetic({ operation: 'sum', operands: [1200, 300, 500] })).toMatchObject({ result: 2000, note: ARITHMETIC_NOTE })
    expect(checkArithmetic({ operation: 'product', operands: [0.2, 0.1] })).toMatchObject({ result: 0.02 })
    expect(checkArithmetic({ operation: 'difference', operands: [1600, 300] })).toMatchObject({ result: 1300 })
    const ratio = checkArithmetic({ operation: 'ratio', operands: [20, 1000] })
    expect(ratio.result).toBe(0.02)
    expect(ratio.formula).toContain('20 / 1000 = 0.02')
    const pct = checkArithmetic({ operation: 'percentage', operands: [20, 1000] })
    expect(pct.result).toBe(2)
    expect(pct.unit).toBe('%')
    expect(pct.formula).toContain('× 100% = 2%')
    const change = checkArithmetic({ operation: 'change', operands: [100, 80] })
    expect(change.result).toBe(-20)
    expect(change.unit).toBe('%')
  })

  it('口径标签进算式与回执，帮助核对分子分母', () => {
    const receipt = checkArithmetic({ operation: 'percentage', operands: [{ value: 200, label: '成交' }, { value: 5000, label: '曝光' }] })
    expect(receipt.formula).toBe('成交 200 / 曝光 5000 × 100% = 4%')
    expect(receipt.operands).toEqual([{ value: 200, label: '成交' }, { value: 5000, label: '曝光' }])
    expect(receipt.note).toBe('只核算式，不核来源、去重、口径与因果')
  })

  it('零分母/零起点拒绝：比值、百分比、增减率', () => {
    expect(() => checkArithmetic({ operation: 'ratio', operands: [20, 0] })).toThrow('分母为零')
    expect(() => checkArithmetic({ operation: 'percentage', operands: [20, 0] })).toThrow('分母为零')
    expect(() => checkArithmetic({ operation: 'change', operands: [0, 80] })).toThrow('起点为零')
  })

  it('非有限数值拒绝：NaN、Infinity、字符串、缺 value', () => {
    expect(() => checkArithmetic({ operation: 'sum', operands: [Number.NaN, 1] })).toThrow('不是有限数值')
    expect(() => checkArithmetic({ operation: 'sum', operands: [Number.POSITIVE_INFINITY] })).toThrow('不是有限数值')
    expect(() => checkArithmetic({ operation: 'sum', operands: ['20'] })).toThrow('不是有限数值')
    expect(() => checkArithmetic({ operation: 'sum', operands: [{ label: '缺值' }] })).toThrow('不是有限数值')
  })

  it('未知操作、空 operands、个数不符都拒绝，不做表达式解析', () => {
    expect(() => checkArithmetic({ operation: 'sqrt', operands: [4] })).toThrow('未知算术操作')
    expect(() => checkArithmetic({ operation: 'sum', operands: [] })).toThrow('至少一个数值')
    expect(() => checkArithmetic({ operation: 'ratio', operands: [1] })).toThrow('恰好两个')
    expect(() => checkArithmetic({ operation: 'ratio', operands: [1, 2, 3] })).toThrow('恰好两个')
    expect(() => checkArithmetic({ operation: '20/1000' as never, operands: [20, 1000] })).toThrow('未知算术操作')
    expect(() => checkArithmetic({ operation: 'sum', operands: '20+30' as never })).toThrow('至少一个数值')
  })
})
