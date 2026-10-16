import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { renameMock, rmMock } = vi.hoisted(() => ({ renameMock: vi.fn(), rmMock: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: renameMock, rm: rmMock }
})
import { writeJsonAtomic } from '../src/atomic-file.ts'

let root: string
let destination: string
let actualRename: typeof import('node:fs/promises').rename
let actualRm: typeof import('node:fs/promises').rm
const errno = (code: string) => Object.assign(new Error(code), { code })

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  actualRename = actual.rename
  actualRm = actual.rm
  rmMock.mockReset()
  rmMock.mockImplementation(actualRm)
  renameMock.mockReset()
  renameMock.mockImplementation(actualRename)
  // Exercise the Windows branch on every test platform without changing the OS.
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
  root = await mkdtemp(join(tmpdir(), 'wb-atomic-'))
  destination = join(root, 'project.json')
  await writeFile(destination, '{"rev":1}\n')
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await actualRm(root, { recursive: true, force: true })
})

describe('原子文件替换的 Windows 暂时占用', () => {
  it.each(['EPERM', 'EBUSY'])('遇到 %s 保留旧目标和同一临时文件后重试', async (code) => {
    renameMock.mockImplementationOnce(async (source: string, target: string) => {
      expect(await readFile(target, 'utf8')).toBe('{"rev":1}\n')
      expect(JSON.parse(await readFile(source, 'utf8'))).toEqual({ rev: 2 })
      throw errno(code)
    })
    await writeJsonAtomic(destination, { rev: 2 })
    expect(renameMock).toHaveBeenCalledTimes(2)
    expect(renameMock.mock.calls[0]).toEqual(renameMock.mock.calls[1])
    expect(JSON.parse(await readFile(destination, 'utf8'))).toEqual({ rev: 2 })
    expect(await readdir(root)).toEqual(['project.json'])
  })

  it('占用超出重试上限时保留旧目标，清临时文件并报原错误', async () => {
    const failure = errno('EPERM')
    renameMock.mockRejectedValue(failure)
    await expect(writeJsonAtomic(destination, { rev: 2 })).rejects.toBe(failure)
    expect(renameMock).toHaveBeenCalledTimes(5)
    expect(new Set(renameMock.mock.calls.map(([source]) => source)).size).toBe(1)
    expect(await readFile(destination, 'utf8')).toBe('{"rev":1}\n')
    expect(await readdir(root)).toEqual(['project.json'])
  })

  it('非占用错误立即停止，不能删除或覆盖旧目标', async () => {
    const failure = errno('ENOSPC')
    renameMock.mockRejectedValue(failure)
    await expect(writeJsonAtomic(destination, { rev: 2 })).rejects.toBe(failure)
    expect(renameMock).toHaveBeenCalledTimes(1)
    expect(await readFile(destination, 'utf8')).toBe('{"rev":1}\n')
    expect(await readdir(root)).toEqual(['project.json'])
  })

  it('临时文件清理也被占用时仍报原替换错误，旧目标保持可读', async () => {
    const replacementFailure = errno('EPERM')
    renameMock.mockRejectedValue(replacementFailure)
    rmMock.mockRejectedValueOnce(errno('EBUSY'))
    await expect(writeJsonAtomic(destination, { rev: 2 })).rejects.toBe(replacementFailure)
    expect(renameMock).toHaveBeenCalledTimes(5)
    expect(rmMock).toHaveBeenCalledExactlyOnceWith(renameMock.mock.calls[0][0], { force: true })
    expect(await readFile(destination, 'utf8')).toBe('{"rev":1}\n')
    const files = await readdir(root)
    expect(files).toHaveLength(2)
    expect(files.some(name => name.endsWith('.tmp'))).toBe(true)
  })

  it('非 Windows 的权限错误立即停止', async () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }))
    const failure = errno('EPERM')
    renameMock.mockRejectedValue(failure)
    await expect(writeJsonAtomic(destination, { rev: 2 })).rejects.toBe(failure)
    expect(renameMock).toHaveBeenCalledTimes(1)
    expect(await readFile(destination, 'utf8')).toBe('{"rev":1}\n')
  })
})
