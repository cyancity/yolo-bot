/**
 * wb_check_arithmetic 的确定性算术核算：有限操作枚举 + 有限数值 operands，
 * 返回实际算式与结果。只核算式本身——来源真实性、口径一致、去重与因果/归因
 * 不由本工具认证；非法输入（未知操作、非有限值、零分母、个数不符）一律拒绝。
 * 不做字符串表达式解析，不用 eval/shell，无外部依赖。
 */
import { WorkforceError } from './types.ts'

export type ArithmeticOperation = 'sum' | 'product' | 'difference' | 'ratio' | 'percentage' | 'change'

export const ARITHMETIC_OPERATIONS: readonly ArithmeticOperation[] = ['sum', 'product', 'difference', 'ratio', 'percentage', 'change']

/** 回执固定说明：核算范围只到算式，口径与因果仍要员工在稿中标注。 */
export const ARITHMETIC_NOTE = '只核算式，不核来源、去重、口径与因果'

export interface ArithmeticOperand {
  readonly value: number
  /** 口径标签，如「付费用户」「上月GMV」；展示在算式里帮助员工核对分母。 */
  readonly label?: string
}

export interface ArithmeticReceipt {
  readonly operation: ArithmeticOperation
  readonly formula: string
  readonly result: number
  /** percentage/change 的结果单位是 %；其余为空。 */
  readonly unit?: '%'
  readonly operands: readonly ArithmeticOperand[]
  readonly note: string
}

const MAX_OPERANDS = 50
const TWO_OPERAND: readonly ArithmeticOperation[] = ['difference', 'ratio', 'percentage', 'change']

/** 浮点噪声截到 12 位有效数字（0.1+0.2 回执 0.3，不回填尾数）。 */
function round(value: number): number {
  return Number(value.toPrecision(12))
}

function fmt(value: number): string {
  return String(round(value))
}

function show(operand: ArithmeticOperand): string {
  return operand.label === undefined ? fmt(operand.value) : `${operand.label} ${fmt(operand.value)}`
}

function readOperands(raw: unknown): ArithmeticOperand[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new WorkforceError('bad_request', 'operands 需要至少一个数值')
  if (raw.length > MAX_OPERANDS) throw new WorkforceError('bad_request', `operands 最多 ${MAX_OPERANDS} 项`)
  return raw.map((item, index) => {
    const record = typeof item === 'object' && item !== null && !Array.isArray(item) ? item as Record<string, unknown> : undefined
    const value = record === undefined ? item : record['value']
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new WorkforceError('bad_request', `operands[${index}] 不是有限数值`)
    const label = record?.['label']
    if (label !== undefined && (typeof label !== 'string' || label.trim() === '' || label.length > 120)) throw new WorkforceError('bad_request', `operands[${index}] 口径标签无效`)
    return label === undefined ? { value } : { value, label: label.trim() }
  })
}

function isArithmeticOperation(value: unknown): value is ArithmeticOperation {
  return typeof value === 'string' && (ARITHMETIC_OPERATIONS as readonly string[]).includes(value)
}

export function checkArithmetic(args: { readonly operation?: unknown; readonly operands?: unknown }): ArithmeticReceipt {
  const operation = args.operation
  if (!isArithmeticOperation(operation)) {
    throw new WorkforceError('bad_request', `未知算术操作（可用：${ARITHMETIC_OPERATIONS.join('/')}）`)
  }
  const operands = readOperands(args.operands)
  if (TWO_OPERAND.includes(operation) && operands.length !== 2) {
    throw new WorkforceError('bad_request', `${operation} 需要恰好两个操作数（首项为起点或分子）`)
  }
  const [a, b] = operands as [ArithmeticOperand, ArithmeticOperand?]
  const base: Pick<ArithmeticReceipt, 'operation' | 'operands' | 'note'> = { operation, operands, note: ARITHMETIC_NOTE }
  switch (operation) {
    case 'sum': {
      const result = round(operands.reduce((acc, item) => acc + item.value, 0))
      return { ...base, formula: `${operands.map(show).join(' + ')} = ${fmt(result)}`, result }
    }
    case 'product': {
      const result = round(operands.reduce((acc, item) => acc * item.value, 1))
      return { ...base, formula: `${operands.map(show).join(' × ')} = ${fmt(result)}`, result }
    }
    case 'difference': {
      const result = round(a.value - b!.value)
      return { ...base, formula: `${show(a)} - ${show(b!)} = ${fmt(result)}`, result }
    }
    case 'ratio': {
      if (b!.value === 0) throw new WorkforceError('bad_request', '分母为零，无法计算比值')
      const result = round(a.value / b!.value)
      return { ...base, formula: `${show(a)} / ${show(b!)} = ${fmt(result)}`, result }
    }
    case 'percentage': {
      if (b!.value === 0) throw new WorkforceError('bad_request', '分母为零，无法计算百分比')
      const result = round((a.value / b!.value) * 100)
      return { ...base, formula: `${show(a)} / ${show(b!)} × 100% = ${fmt(result)}%`, result, unit: '%' }
    }
    case 'change': {
      if (a.value === 0) throw new WorkforceError('bad_request', '起点为零，无法计算增减率')
      const result = round(((b!.value - a.value) / a.value) * 100)
      return { ...base, formula: `(${show(b!)} - ${show(a)}) / ${show(a)} × 100% = ${fmt(result)}%`, result, unit: '%' }
    }
  }
  throw new WorkforceError('bad_request', '未知算术操作')
}
