import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  const data = JSON.stringify(value, null, 2) + '\n'
  try {
    await writeFile(tmp, data, 'utf8')
      // Windows readers/antivirus can briefly prevent replacement of an open file.
    // Retry the same rename; never unlink the destination or expose partial JSON.
    const retryDelays = [15, 30, 60, 120]
    for (let attempt = 0; ; attempt++) {
      try {
              await rename(tmp, path)
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY') || attempt >= retryDelays.length) throw error
        await delay(retryDelays[attempt])
      }
    }
  } catch (error) {
    // A locked temp may also resist cleanup; retain the replacement failure.
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}
