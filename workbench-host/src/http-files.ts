/**
 * Static-file responder with HEAD and single-range support.
 * Path authorization remains the caller's responsibility.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WorkforceError } from './workforce/types.ts'

export interface ByteRange {
  start: number
  end: number
}

/** Parse one `bytes=` range against size; null = malformed → 416. */
export function parseRange(header: string | undefined, size: number): ByteRange | 'none' | null {
  if (header === undefined || header === '') return 'none'
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null || (match[1] === '' && match[2] === '')) return null
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  if (start > end || start >= size) return null
  return { start, end }
}

/** Stream `path` honoring Range; 404 on missing file/directory, 416 on bad range. */
export async function serveFile(req: IncomingMessage, res: ServerResponse, path: string, _name: string, contentType: string): Promise<void> {
  let size: number
  try {
    const stats = await stat(path)
    if (!stats.isFile()) throw new WorkforceError('not_found', '文件不存在')
    size = stats.size
  } catch (error) {
    if (error instanceof WorkforceError) throw error
    throw new WorkforceError('not_found', '文件不存在')
  }
  const type = contentType
  const range = parseRange(req.headers.range, size)
  if (range === null) {
    res.writeHead(416, { 'content-range': `bytes */${size}` })
    res.end()
    return
  }
  if (range === 'none') {
    res.writeHead(200, {
      'content-type': type,
      'x-content-type-options': 'nosniff',
      'content-length': size,
      'accept-ranges': 'bytes',
    })
    if (req.method === 'HEAD') { res.end(); return }
    pipeFile(res, path)
    return
  }
  const length = range.end - range.start + 1
  res.writeHead(206, {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'content-length': length,
    'content-range': `bytes ${range.start}-${range.end}/${size}`,
    'accept-ranges': 'bytes',
  })
  if (req.method === 'HEAD') { res.end(); return }
  pipeFile(res, path, { start: range.start, end: range.end })
}

/** Pipe one file into res; a mid-flight read failure destroys the response instead of going unhandled. */
function pipeFile(res: ServerResponse, path: string, options?: { start: number; end: number }): void {
  const stream = createReadStream(path, options)
  stream.once('error', () => { res.destroy() })
  stream.pipe(res)
}
