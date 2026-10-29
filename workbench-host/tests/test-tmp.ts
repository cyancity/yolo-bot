import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 测试临时根：CLAUDE_JOB_DIR（CI）优先，再 TEMP/TMPDIR/os.tmpdir()；
// realpath 消除 macOS /tmp、/var 的符号链接祖先（prepareWorkspace 拒绝链接祖先）。
export async function testTmpRoot(prefix: string): Promise<string> {
  const base = process.env.CLAUDE_JOB_DIR
    ? join(process.env.CLAUDE_JOB_DIR, 'tmp')
    : process.env.TEMP || process.env.TMPDIR || tmpdir()
  return mkdtemp(join(await realpath(base), prefix))
}
