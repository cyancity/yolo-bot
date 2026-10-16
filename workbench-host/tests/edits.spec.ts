import { describe, expect, it } from 'vitest'
import { parseRange } from '../src/http-files.ts'

describe('HTTP 文件 Range 响应', () => {
  it('parseRange：前缀/后缀/全量/非法', () => {
    expect(parseRange(undefined, 100)).toBe('none')
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 })
    expect(parseRange('bytes=-20', 100)).toEqual({ start: 80, end: 99 })
    expect(parseRange('bytes=95-200', 100)).toEqual({ start: 95, end: 99 })
    expect(parseRange('bytes=200-300', 100)).toBeNull()
    expect(parseRange('bytes=abc', 100)).toBeNull()
    expect(parseRange('bytes=50-10', 100)).toBeNull()
    expect(parseRange('bytes=-0', 100)).toBeNull()
  })

})
