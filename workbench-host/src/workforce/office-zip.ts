import * as zlib from 'node:zlib'

export const MAX_OFFICE_BYTES = 64 * 1024 * 1024
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(data: Buffer): number {
  const native = (zlib as unknown as { crc32?: (data: Buffer) => number }).crc32
  if (native) return native(data) >>> 0
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Reads central-directory sizes, including Office archives with data descriptors. Never extracts paths. */
export function unzipOffice(data: Buffer): Map<string, Buffer> {
  if (data.length > MAX_OFFICE_BYTES) throw new Error('Office 文件不能超过 64 MiB')
  let end = data.length - 22
  while (end >= Math.max(0, data.length - 65557)) {
    if (data.readUInt32LE(end) === 0x06054b50 && end + 22 + data.readUInt16LE(end + 20) === data.length) break
    end--
  }
  if (end < Math.max(0, data.length - 65557)) throw new Error('不是有效的 Office ZIP 文件')
  const count = data.readUInt16LE(end + 10)
  const directoryEnd = data.readUInt32LE(end + 16) + data.readUInt32LE(end + 12)
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || count !== data.readUInt16LE(end + 8)
    || count === 0xffff || directoryEnd !== end) throw new Error('不支持分卷或 ZIP64 Office 文件')
  let cursor = data.readUInt32LE(end + 16), total = 0
  const entries = new Map<string, Buffer>()
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Office ZIP 目录损坏')
    const flags = data.readUInt16LE(cursor + 8), method = data.readUInt16LE(cursor + 10)
    const checksum = data.readUInt32LE(cursor + 16), packed = data.readUInt32LE(cursor + 20), size = data.readUInt32LE(cursor + 24)
    const nameSize = data.readUInt16LE(cursor + 28), extraSize = data.readUInt16LE(cursor + 30), commentSize = data.readUInt16LE(cursor + 32)
    const offset = data.readUInt32LE(cursor + 42)
    total += size
    if (flags & 0x41 || ![0, 8].includes(method) || size > MAX_OFFICE_BYTES || total > MAX_EXPANDED_BYTES
      || cursor + 46 + nameSize + extraSize + commentSize > end || offset + 30 > data.length) throw new Error('Office ZIP 加密、压缩方法或大小不受支持')
    const name = data.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8')
    if (entries.has(name) || data.readUInt32LE(offset) !== 0x04034b50) throw new Error('Office ZIP 条目损坏或重复')
    const localNameSize = data.readUInt16LE(offset + 26)
    const start = offset + 30 + localNameSize + data.readUInt16LE(offset + 28)
    if (start + packed > data.readUInt32LE(end + 16) || data.readUInt16LE(offset + 8) !== method
      || data.readUInt16LE(offset + 6) !== flags || data.subarray(offset + 30, offset + 30 + localNameSize).toString('utf8') !== name) throw new Error('Office ZIP 条目越界或不一致')
    const compressed = data.subarray(start, start + packed)
    const value = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) })
    if (value.length !== size || crc32(value) !== checksum) throw new Error('Office ZIP 校验失败')
    entries.set(name, value)
    cursor += 46 + nameSize + extraSize + commentSize
  }
  if (cursor !== directoryEnd) throw new Error('Office ZIP 目录长度不一致')
  return entries
}

export function zipOffice(entries: Record<string, string | Buffer>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const [path, content] of Object.entries(entries)) {
    const name = Buffer.from(path), value = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const packed = zlib.deflateRawSync(value), checksum = crc32(value)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6)
    header.writeUInt16LE(8, 8); header.writeUInt16LE(0x21, 12)
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(value.length, 22)
    header.writeUInt16LE(name.length, 26)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); header.copy(record, 6, 4, 28)
    record.writeUInt32LE(offset, 42)
    local.push(header, name, packed); central.push(record, name)
    offset += header.length + name.length + packed.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
