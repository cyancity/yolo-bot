/** Project optional host fields into the native tool runtime's lossless JSON boundary. */
export function toolValue(value: unknown): any {
  const visiting = new Set<object>()
  const project = (current: unknown): any => {
    if (current == null) return null
    if (typeof current === 'string' || typeof current === 'boolean') return current
    if (typeof current === 'number' && Number.isFinite(current)) return current
    if (typeof current !== 'object' || visiting.has(current)) throw new Error('工作台工具输出包含不可序列化的数据')
    visiting.add(current)
    try {
      if (Array.isArray(current)) return Array.from(current, project)
      const prototype = Object.getPrototypeOf(current)
      if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(current).length) throw new Error('工作台工具输出包含不可序列化的数据')
      return Object.fromEntries(Object.entries(current).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, project(entry)]))
    } finally { visiting.delete(current) }
  }
  return project(value)
}

export const renderToolJson = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(toolValue(value)) }]
