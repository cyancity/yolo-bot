import { createHash } from 'node:crypto'
import { link, mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { safeName, WorkforceStore } from '../src/workforce/store.ts'
import { MAX_MATERIAL_BYTES } from '../src/workforce/material-files.ts'

let root: string, store: WorkforceStore
beforeEach(async () => {
  root = await mkdtemp(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, 'tmp') : process.env.TEMP!, 'wf-store-'))
  store = new WorkforceStore(root)
  await store.read()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('文档行动技能只给负责人与分析员：旧安装追加一次，保留自定义技能和用户后续移除', async () => {
  const skill = 'document-to-action-items'
  expect((await store.employee('leader')).skills).toContain(skill)
  expect((await store.employee('analyst')).skills).toContain(skill)
  expect((await store.employee('writer')).skills).not.toContain(skill)
  await store.change(state => {
    state.builtinSkillMigrations = state.builtinSkillMigrations.filter(item => item !== skill)
    state.employees.find(item => item.id === 'leader')!.skills = ['user-leader']
    state.employees.find(item => item.id === 'analyst')!.skills = ['user-analysis']
    state.employees.find(item => item.id === 'writer')!.skills = ['user-custom-workflow']
  })
  const upgraded = new WorkforceStore(root)
  expect((await upgraded.employee('leader')).skills).toEqual(['user-leader', skill])
  expect((await upgraded.employee('analyst')).skills).toEqual(['user-analysis', skill])
  expect((await upgraded.employee('writer')).skills).toEqual(['user-custom-workflow'])
  expect((await upgraded.read()).builtinSkillMigrations.filter(item => item === skill)).toEqual([skill])
  await upgraded.saveEmployee({ skills: ['user-leader'] }, 'leader')
  const restarted = new WorkforceStore(root)
  expect((await restarted.employee('leader')).skills).toEqual(['user-leader'])
  expect((await restarted.employee('analyst')).skills).toEqual(['user-analysis', skill])
})

it('同名材料只可按 id 读取，不猜测最新版；重启保留原文', async () => {
  const first = await store.upload('材料.txt', '第一份'), second = await store.upload('材料.txt', '第二份')
  await expect(store.material('材料.txt')).rejects.toMatchObject({ code: 'bad_request' })
  expect((await store.material(first.id)).content).toBe('第一份')
  expect((await new WorkforceStore(root).material(second.id)).content).toBe('第二份')
})

it('拒绝路径穿越与 Windows 特殊文件名', () => {
  for (const name of ['../文案.txt', '..\\文案.txt', '.', '..', 'C:\\x.txt', 'NUL.txt', 'con', 'COM1.md', '文件.', 'file:stream', 'x\u0000.txt']) expect(() => safeName(name)).toThrow('文件名无效')
  expect(safeName('青禾文案.txt')).toBe('青禾文案.txt')
})

it('同名成果每次保存生成递增版本且旧版不可变，跨任务同名文件隔离并可重新载入', async () => {
  await store.change(state => {
    for (const id of ['a', 'b']) state.tasks.push({ id, threadId: 'thread-' + id, channelId: 'general', assigneeId: 'leader', delegatorId: 'leader', title: id, prompt: id, status: 'running', deliverables: [], createdAt: '2026-10-09', updatedAt: '2026-10-09' })
  })
  const a = await store.deliverable('thread-a', '文案.txt', '甲 初稿')
  const b = await store.deliverable('thread-b', '文案.txt', '乙稿')
  const revised = await store.deliverable('thread-a', '文案.txt', '甲 修订', { employeeId: 'writer', sessionId: 's-1' })
  // 版本号递增；返回给工具的链接固定到本版本，state.url 保持不带版本的默认地址
  expect([a.version, revised.version]).toEqual([1, 2])
  expect(b.version).toBe(1)
  expect(revised.url).toContain('?v=2')
  expect(a.url).toContain('?v=1')
  const fileA = await store.deliverableFile('a', '文案.txt', String(a.version))
  const fileB = await store.deliverableFile('b', '文案.txt', String(b.version))
  const fileRevised = await store.deliverableFile('a', '文案.txt', String(revised.version))
  expect(fileRevised.path).not.toBe(fileA.path)
  expect(fileA.path).not.toBe(fileB.path)
  expect(a).not.toHaveProperty('filePath')
  expect(revised).not.toHaveProperty('filePath')
  // 已写入的版本文件不被后续保存改写
  expect(await readFile(fileA.path, 'utf8')).toBe('甲 初稿')
  expect(await readFile(fileRevised.path, 'utf8')).toBe('甲 修订')
  expect(await readFile(fileB.path, 'utf8')).toBe('乙稿')
  expect(revised.charCount).toBe(3)
  expect(/^[0-9a-f]{64}$/.test(revised.sha256)).toBe(true)
  const reloaded = (await new WorkforceStore(root).read()).tasks
  const itemA = reloaded.find(task => task.id === 'a')!.deliverables[0]!
  expect(itemA.versions.map(entry => entry.version)).toEqual([1, 2])
  expect(itemA.versions[0]).toMatchObject({ authorId: 'unknown', charCount: 3 })
  expect(itemA.versions[1]).toMatchObject({ authorId: 'writer', sessionId: 's-1' })
  expect(itemA.url).not.toContain('?v=')
  expect(reloaded.map(task => task.deliverables.length)).toEqual([1, 1])
})

async function fileTask() {
  await store.change(state => {
    state.tasks.push({ id: 'file-task', threadId: 'file-thread', channelId: 'general', assigneeId: 'leader', delegatorId: 'leader', title: '文件成果', prompt: '保存全文', status: 'running', deliverables: [], createdAt: '2026-10-09', updatedAt: '2026-10-09' })
  })
  const cwd = join(root, 'session')
  await mkdir(join(cwd, 'output'), { recursive: true })
  return cwd
}

it('文件成果保存超过正文参数上限的完整UTF-8正文，同名修订保留旧版与来源', async () => {
  const cwd = await fileTask()
  const text = '\uFEFF# 逐字稿\r\n' + '中😀 \n'.repeat(150000)
  await writeFile(join(cwd, 'output', 'restored.md'), text)
  const first = await store.deliverable('file-thread', '成果.md', undefined, { employeeId: 'writer', sessionId: 'child' }, { cwd, path: 'output\\restored.md' })
  await writeFile(join(cwd, 'output', 'restored.md'), '完整修订正文')
  const next = await store.deliverable('file-thread', '成果.md', undefined, undefined, { cwd, path: './output/restored.md' })
  expect(first.version).toBe(1)
  expect(next.version).toBe(2)
  expect(first.charCount).toBe(300004)
  expect(await readFile((await store.deliverableFile('file-task', '成果.md', '1')).path, 'utf8')).toBe(text)
  expect(await readFile((await store.deliverableFile('file-task', '成果.md', '2')).path, 'utf8')).toBe('完整修订正文')
  expect((await new WorkforceStore(root).read()).tasks[0]!.deliverables[0]!.versions[0]).toMatchObject({ authorId: 'writer', sessionId: 'child', sha256: first.sha256 })
})

it('文件成果只接受content/path二选一，并拒绝越界、绝对路径、目录及不存在文件', async () => {
  const cwd = await fileTask()
  await writeFile(join(root, 'outside.md'), '不得保存')
  await expect(store.deliverable('file-thread', '成果.md', undefined)).rejects.toThrow('二选一')
  await expect(store.deliverable('file-thread', '成果.md', '正文', undefined, { cwd, path: 'output/restored.md' })).rejects.toThrow('二选一')
  for (const path of ['../outside.md', '..\\outside.md', join(root, 'outside.md'), '/absolute.md', 'C:relative.md', 'output/file:stream', '', 'output', 'missing.md']) {
    await expect(store.deliverable('file-thread', '成果.md', undefined, undefined, { cwd, path })).rejects.toMatchObject({ code: 'bad_request' })
  }
  expect((await store.read()).tasks[0]!.deliverables).toEqual([])
})

it('文件成果拒绝目录链接与硬链接，包括指向cwd内的链接', async () => {
  const cwd = await fileTask()
  await writeFile(join(cwd, 'output', 'real.md'), '正文')
  await symlink(join(cwd, 'output'), join(cwd, 'linked-output'), process.platform === 'win32' ? 'junction' : 'dir')
  await link(join(cwd, 'output', 'real.md'), join(cwd, 'hard.md'))
  for (const path of ['linked-output/real.md', 'hard.md', 'output/real.md']) {
    await expect(store.deliverable('file-thread', '成果.md', undefined, undefined, { cwd, path })).rejects.toMatchObject({ code: 'bad_request' })
  }
  await expect(store.deliverable('file-thread', '成果.md', undefined, undefined, { cwd: join(cwd, 'linked-output'), path: 'real.md' })).rejects.toThrow('链接')
  expect((await store.read()).tasks[0]!.deliverables).toEqual([])
})

it('文件成果支持二进制原字节（非法UTF-8/控制字符按原字节保存，sha256/sizeBytes 原值、charCount 0），超上限仍拒', async () => {
  const cwd = await fileTask()
  const cases = [Buffer.from([0xc3, 0x28]), Buffer.from('正文\x00尾部'), Buffer.from([0x01, 0x02])]
  for (const [index, bytes] of cases.entries()) {
    await writeFile(join(cwd, `bin${index}.md`), bytes)
    const saved = await store.deliverable('file-thread', `成果${index}.md`, undefined, undefined, { cwd, path: `bin${index}.md` })
    expect(saved.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(saved.sizeBytes).toBe(bytes.length)
    expect(saved.charCount).toBe(0)
    expect(await readFile((await store.deliverableFile('file-task', `成果${index}.md`, '1')).path)).toEqual(bytes)
  }
  await writeFile(join(cwd, 'large.md'), '')
  await truncate(join(cwd, 'large.md'), MAX_MATERIAL_BYTES + 1)
  await expect(store.deliverable('file-thread', '成果.md', undefined, undefined, { cwd, path: 'large.md' })).rejects.toThrow('32MiB')
  expect((await store.read()).tasks[0]!.deliverables.map(item => item.name)).toEqual(['成果0.md', '成果1.md', '成果2.md'])
})

it('文件成果允许恰好材料上限的文本，不按字符数误判UTF-8大小', async () => {
  const cwd = await fileTask()
  const bytes = Buffer.alloc(MAX_MATERIAL_BYTES, 'a')
  bytes.write('中', MAX_MATERIAL_BYTES - 3)
  await writeFile(join(cwd, 'limit.md'), bytes)
  const saved = await store.deliverable('file-thread', '成果.md', undefined, undefined, { cwd, path: 'limit.md' })
  expect(saved.charCount).toBe(MAX_MATERIAL_BYTES - 2)
  expect((await readFile((await store.deliverableFile('file-task', '成果.md', '1')).path)).equals(bytes)).toBe(true)
}, 15000)

it('同名成果并发保存不重号，各版本文件内容完整', async () => {
  await store.change(state => {
    state.tasks.push({ id: 'task', threadId: 'thread', channelId: 'general', assigneeId: 'leader', delegatorId: 'leader', title: 't', prompt: 't', status: 'running', deliverables: [], createdAt: '2026-10-09', updatedAt: '2026-10-09' })
  })
  const saved = await Promise.all([1, 2, 3, 4].map(n => store.deliverable('thread', '稿.txt', `第${n}稿`)))
  expect(saved.map(item => item.version).sort()).toEqual([1, 2, 3, 4])
  const item = (await store.read()).tasks[0]!.deliverables[0]!
  expect(item.versions.map(entry => entry.version)).toEqual([1, 2, 3, 4])
  const contents = new Set<string>()
  for (const entry of item.versions) {
    const file = await store.deliverableFile('task', '稿.txt', String(entry.version))
    contents.add(await readFile(file.path, 'utf8'))
  }
  expect([...contents].sort()).toEqual(['第1稿', '第2稿', '第3稿', '第4稿'])
})

it('旧平铺成果视作已发布 v1，再保存时迁入版本目录且旧链接解析不变', async () => {
  await store.change(state => {
    state.tasks.push({
      id: 'task3', threadId: 'thread3', channelId: 'general', assigneeId: 'leader', delegatorId: 'leader', title: 't', prompt: 't', status: 'done',
      deliverables: [{ name: '旧稿.txt', url: `/wb/api/workforce/tasks/task3/deliverables/${encodeURIComponent('旧稿.txt')}` } as any],
      createdAt: '2026-10-08', updatedAt: '2026-10-08',
    })
  })
  const directory = join(store.directory, 'deliverables', 'task3')
  const flat = join(directory, '旧稿.txt')
  await mkdir(directory, { recursive: true })
  await writeFile(flat, '旧版内容')
  // 迁移前：默认与 ?v=1 解析到平铺文件，其余版本不存在
  expect((await store.deliverableFile('task3', '旧稿.txt', null)).path).toBe(flat)
  expect((await store.deliverableFile('task3', '旧稿.txt', '1')).path).toBe(flat)
  await expect(store.deliverableFile('task3', '旧稿.txt', '2')).rejects.toMatchObject({ code: 'not_found' })
  const saved = await store.deliverable('thread3', '旧稿.txt', '新版内容', { employeeId: 'writer', sessionId: 's-1' })
  expect(saved.version).toBe(2)
  const item = (await store.read()).tasks.find(task => task.id === 'task3')!.deliverables[0]!
  expect(item.versions.map(entry => entry.version)).toEqual([1, 2])
  expect(item.versions[0]).toMatchObject({ version: 1, authorId: 'unknown', charCount: 4 })
  expect(item.publishedVersion).toBe(1)
  // 平铺文件搬走，v1 落在版本目录；已发布的 v1 仍是默认下载目标
  await expect(readFile(flat, 'utf8')).rejects.toThrow()
  expect(await readFile(join(directory, '旧稿.txt', 'v1.txt'), 'utf8')).toBe('旧版内容')
  expect(saved).not.toHaveProperty('filePath')
  expect(await readFile((await store.deliverableFile('task3', '旧稿.txt', String(saved.version))).path, 'utf8')).toBe('新版内容')
  expect(await readFile((await store.deliverableFile('task3', '旧稿.txt', null)).path, 'utf8')).toBe('旧版内容')
  expect(await readFile((await store.deliverableFile('task3', '旧稿.txt', '2')).path, 'utf8')).toBe('新版内容')
})

it('迁移完成但 state 落库失败回滚：默认下载解析到已迁走的 v1，再保存补记 v1 且孤儿版本顺延', async () => {
  await store.change(state => {
    state.tasks.push({
      id: 'task3', threadId: 'thread3', channelId: 'general', assigneeId: 'leader', delegatorId: 'leader', title: 't', prompt: 't', status: 'done',
      deliverables: [{ name: '旧稿.txt', url: `/wb/api/workforce/tasks/task3/deliverables/${encodeURIComponent('旧稿.txt')}` } as any],
      createdAt: '2026-10-08', updatedAt: '2026-10-08',
    })
  })
  const directory = join(store.directory, 'deliverables', 'task3')
  const flat = join(directory, '旧稿.txt')
  await mkdir(directory, { recursive: true })
  await writeFile(flat, '旧版内容')
  vi.spyOn(store as any, 'persist').mockRejectedValueOnce(new Error('写盘失败'))
  await expect(store.deliverable('thread3', '旧稿.txt', '失败的新版')).rejects.toThrow('写盘失败')
  // state 回滚到无 versions 的旧条目；磁盘上 v1 已迁走、v2 写完未登记成为孤儿
  const rolledBack = (await store.read()).tasks.find(task => task.id === 'task3')!.deliverables[0]!
  expect(rolledBack.versions).toBeUndefined()
  expect(await readFile(join(directory, '旧稿.txt', 'v1.txt'), 'utf8')).toBe('旧版内容')
  expect(await readFile(join(directory, '旧稿.txt', 'v2.txt'), 'utf8')).toBe('失败的新版')
  // 平铺路径已是目录：默认与 ?v=1 都解析到目录内 v1，下载可用而不是 500
  const resolved = await store.deliverableFile('task3', '旧稿.txt', null)
  expect(resolved.path).toBe(join(directory, '旧稿.txt', 'v1.txt'))
  expect(await readFile(resolved.path, 'utf8')).toBe('旧版内容')
  expect((await store.deliverableFile('task3', '旧稿.txt', '1')).path).toBe(join(directory, '旧稿.txt', 'v1.txt'))
  // 再保存：补记 v1 真实元数据（作者 unknown、已发布），孤儿 v2 撞车顺延到新版本 v3
  const saved = await store.deliverable('thread3', '旧稿.txt', '恢复的新版', { employeeId: 'writer' })
  expect(saved.version).toBe(3)
  const item = (await store.read()).tasks.find(task => task.id === 'task3')!.deliverables[0]!
  expect(item.versions.map(entry => entry.version)).toEqual([1, 3])
  expect(item.versions[0]).toMatchObject({ version: 1, authorId: 'unknown', charCount: 4 })
  expect(item.versions[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(item.publishedVersion).toBe(1)
  // 孤儿 v2 不登记、不可按版本下载；默认下载仍指向已发布的 v1
  await expect(store.deliverableFile('task3', '旧稿.txt', '2')).rejects.toMatchObject({ code: 'not_found' })
  expect(await readFile((await store.deliverableFile('task3', '旧稿.txt', null)).path, 'utf8')).toBe('旧版内容')
  expect(await readFile((await store.deliverableFile('task3', '旧稿.txt', '3')).path, 'utf8')).toBe('恢复的新版')
})

it('publishDeliverable 校验任务/成果/版本并记录 publishedBy，旧条目发布会先迁移', async () => {
  await store.change(state => {
    state.tasks.push({ id: 'task', threadId: 'thread', channelId: 'general', assigneeId: 'leader', delegatorId: 'leader', title: 't', prompt: 't', status: 'running', deliverables: [], createdAt: '2026-10-09', updatedAt: '2026-10-09' })
    state.tasks.push({
      id: 'task3', threadId: 'thread3', channelId: 'general', assigneeId: 'leader', delegatorId: 'leader', title: 't', prompt: 't', status: 'done',
      deliverables: [{ name: '旧稿.txt', url: `/wb/api/workforce/tasks/task3/deliverables/${encodeURIComponent('旧稿.txt')}` } as any],
      createdAt: '2026-10-08', updatedAt: '2026-10-08',
    })
  })
  const flat = join(store.directory, 'deliverables', 'task3', '旧稿.txt')
  await mkdir(join(store.directory, 'deliverables', 'task3'), { recursive: true })
  await writeFile(flat, '旧版内容')
  await store.deliverable('thread', '稿.txt', '第一版')
  await store.deliverable('thread', '稿.txt', '第二版')
  const task = await store.publishDeliverable('task', '稿.txt', 1, 'user')
  const item = task.deliverables[0]!
  expect(item.publishedVersion).toBe(1)
  expect(item.publishedBy).toBe('user')
  expect(item.publishedAt).toBeTruthy()
  await expect(store.publishDeliverable('task', '稿.txt', 3, 'user')).rejects.toMatchObject({ code: 'not_found' })
  await expect(store.publishDeliverable('task', '稿.txt', 'x', 'user')).rejects.toMatchObject({ code: 'bad_request' })
  await expect(store.publishDeliverable('task', '无此稿.txt', 1, 'user')).rejects.toMatchObject({ code: 'not_found' })
  await expect(store.publishDeliverable('ghost', '稿.txt', 1, 'user')).rejects.toMatchObject({ code: 'not_found' })
  // 默认下载目标随发布切换；固定版本链接不受影响
  expect(await readFile((await store.deliverableFile('task', '稿.txt', null)).path, 'utf8')).toBe('第一版')
  expect(await readFile((await store.deliverableFile('task', '稿.txt', '2')).path, 'utf8')).toBe('第二版')
  // 旧平铺条目发布：迁移登记 v1 后标记已发布，文件搬进版本目录
  const legacy = await store.publishDeliverable('task3', '旧稿.txt', 1, 'user')
  const legacyItem = legacy.deliverables[0]!
  expect(legacyItem.versions).toHaveLength(1)
  expect(legacyItem.versions[0]).toMatchObject({ version: 1, authorId: 'unknown' })
  expect(legacyItem.publishedVersion).toBe(1)
  await expect(readFile(flat, 'utf8')).rejects.toThrow()
  expect(await readFile(join(store.directory, 'deliverables', 'task3', '旧稿.txt', 'v1.txt'), 'utf8')).toBe('旧版内容')
})

const seedReadTask = (state: any, id: string, channelId: string, deliverables: unknown[] = []) => {
  state.tasks.push({ id, threadId: `thread-${id}`, channelId, assigneeId: 'leader', delegatorId: 'leader', title: id, prompt: id, status: 'done', deliverables, createdAt: '2026-10-08', updatedAt: '2026-10-08' })
  state.threads.push({ id: `thread-${id}`, kind: 'task', taskId: id, channelId, title: id, status: 'idle', createdAt: '2026-10-08', updatedAt: '2026-10-08' })
}

it('readDeliverable 按频道内任务更新时间倒序找同名成果，taskId 限定本频道且不泄露外频道', async () => {
  await store.change(state => {
    seedReadTask(state, 't-old', 'general')
    seedReadTask(state, 't-new', 'general')
    seedReadTask(state, 't-foreign', 'other')
  })
  await store.deliverable('thread-t-old', '稿.txt', '旧稿')
  await store.deliverable('thread-t-new', '稿.txt', '新稿')
  await store.deliverable('thread-t-foreign', '稿.txt', '外频道稿')
  // 保存会刷新 updatedAt：还原受控顺序，t-foreign 更新最晚但属外频道
  await store.change(state => {
    for (const [id, updatedAt] of [['t-old', '2026-10-10T00:00:00.000Z'], ['t-new', '2026-10-09T00:00:00.000Z'], ['t-foreign', '2026-10-11T00:00:00.000Z']])
      state.tasks.find(item => item.id === id)!.updatedAt = updatedAt
  })
  // general 内 t-old 最新 → 默认读旧稿
  const latest = await store.readDeliverable('thread-t-new', '稿.txt')
  expect(latest).toMatchObject({ found: true, readable: true, taskId: 't-old', channelId: 'general', version: 1, authorId: 'unknown', publishedVersion: null, content: '旧稿', url: expect.stringContaining('?v=1') })
  // taskId 限定到本频道该任务
  expect(await store.readDeliverable('thread-t-new', '稿.txt', 't-new')).toMatchObject({ found: true, taskId: 't-new', content: '新稿' })
  // 外频道 taskId 查不到；候选清单只列本频道任务
  const foreign = await store.readDeliverable('thread-t-new', '稿.txt', 't-foreign')
  expect(foreign.found).toBe(false)
  if (!('recentTasks' in foreign)) throw new Error('查不到时应返回本频道成果名清单')
  expect(foreign.recentTasks.map(item => item.taskId)).toEqual(['t-old', 't-new'])
})

it('readDeliverable 默认取已发布、未发布取最新；查不到返回本频道清单；非 UTF-8 与私信按契约', async () => {
  await store.change(state => {
    seedReadTask(state, 't-pub', 'general')
    seedReadTask(state, 't-draft', 'general')
    seedReadTask(state, 't-bin', 'general', [{ name: '二进制.dat', url: `/wb/api/workforce/tasks/t-bin/deliverables/${encodeURIComponent('二进制.dat')}` } as any])
    state.threads.push({ id: 'dm-writer', kind: 'dm', employeeId: 'writer', title: '私信', status: 'idle', createdAt: '2026-10-08', updatedAt: '2026-10-08' })
  })
  const binDir = join(store.directory, 'deliverables', 't-bin')
  await mkdir(binDir, { recursive: true })
  await writeFile(join(binDir, '二进制.dat'), Buffer.from([0xff, 0xfe, 0x00, 0x01]))
  // t-pub：已发布 v1 + 草稿 v2 → 默认读 v1
  await store.deliverable('thread-t-pub', '稿.txt', '第一版')
  await store.publishDeliverable('t-pub', '稿.txt', 1, 'user')
  await store.deliverable('thread-t-pub', '稿.txt', '第二版草稿')
  // t-draft：v1+v2 均未发布 → 默认取最新；显式 version 精确选择
  await store.deliverable('thread-t-draft', '草稿.txt', '草稿一')
  await store.deliverable('thread-t-draft', '草稿.txt', '草稿二')
  const published = await store.readDeliverable('thread-t-pub', '稿.txt')
  expect(published).toMatchObject({ found: true, readable: true, taskId: 't-pub', version: 1, publishedVersion: 1, content: '第一版', url: expect.stringContaining('?v=1') })
  const draft = await store.readDeliverable('thread-t-draft', '草稿.txt')
  expect(draft).toMatchObject({ found: true, readable: true, version: 2, publishedVersion: null, content: '草稿二', url: expect.stringContaining('?v=2') })
  expect(await store.readDeliverable('thread-t-draft', '草稿.txt', undefined, 1)).toMatchObject({ found: true, version: 1, content: '草稿一' })
  // 版本越界与成果缺失都返回 found:false 与本频道最近任务名清单
  const missing = await store.readDeliverable('thread-t-draft', '草稿.txt', undefined, 9)
  expect(missing.found).toBe(false)
  const unknown = await store.readDeliverable('thread-t-pub', '无此稿.txt')
  expect(unknown).toMatchObject({ found: false, channelId: 'general' })
  expect(unknown).toMatchObject({ recentTasks: expect.arrayContaining([{ taskId: 't-pub', title: 't-pub', names: ['稿.txt'] }]) })
  // 非 UTF-8 旧平铺成果：readable:false 不伪造正文；只读不迁移、state 不被改写
  const binary = await store.readDeliverable('thread-t-bin', '二进制.dat')
  expect(binary).toMatchObject({ found: true, readable: false, version: 1, authorId: 'unknown', publishedVersion: 1 })
  expect(binary).not.toHaveProperty('content')
  expect((await store.read()).tasks.find(task => task.id === 't-bin')!.deliverables[0]!.versions).toBeUndefined()
  // 私信无频道归属拒绝；未知线程 not_found；版本与文件名校验
  await expect(store.readDeliverable('dm-writer', '稿.txt')).rejects.toMatchObject({ code: 'bad_request' })
  await expect(store.readDeliverable('ghost-thread', '稿.txt')).rejects.toMatchObject({ code: 'not_found' })
  await expect(store.readDeliverable('thread-t-pub', '稿.txt', undefined, 0)).rejects.toMatchObject({ code: 'bad_request' })
  await expect(store.readDeliverable('thread-t-pub', '稿.txt', undefined, 1.5)).rejects.toMatchObject({ code: 'bad_request' })
  await expect(store.readDeliverable('thread-t-pub', '稿.txt', undefined, 'x')).rejects.toMatchObject({ code: 'bad_request' })
  await expect(store.readDeliverable('thread-t-pub', '../state.json')).rejects.toThrow('文件名无效')
})

it('recentTaskIndex 只列本频道最近 5 个任务（不含当前任务），成果名只收已发布版本', async () => {
  await store.change(state => {
    for (const n of [1, 2, 3, 4, 5, 6]) seedReadTask(state, `t${n}`, 'general')
    seedReadTask(state, 'current', 'general')
    seedReadTask(state, 'foreign', 'other')
  })
  // t1：已发布 v1 + 未发布 v2 → 索引只列 v1；t2：只有草稿 → 不列成果名；t3：旧平铺条目 → 视作已发布 v1
  await store.deliverable('thread-t1', '稿.txt', '第一版')
  await store.publishDeliverable('t1', '稿.txt', 1, 'user')
  await store.deliverable('thread-t1', '稿.txt', '第二版草稿')
  await store.deliverable('thread-t2', '草稿.txt', '未发布稿')
  await store.change(state => {
    state.tasks.find(item => item.id === 't3')!.deliverables.push({ name: '旧稿.txt', url: 'x' } as any)
    for (const [id, updatedAt] of [['t3', '2026-10-06'], ['t2', '2026-10-05'], ['t1', '2026-10-04'], ['t4', '2026-10-03'], ['t5', '2026-10-02'], ['t6', '2026-10-01'], ['current', '2026-10-10'], ['foreign', '2026-10-11']])
      state.tasks.find(item => item.id === id)!.updatedAt = updatedAt
  })
  const index = await store.recentTaskIndex('general', 'current')
  expect(index).toContain('本频道最近 5 个任务')
  const rows = index.trim().split('\n').slice(2)
  expect(rows).toHaveLength(5)
  expect(index).toContain('t3 | "t3"')
  expect(index).not.toContain('t6 |')
  expect(index).not.toContain('current')
  expect(index).not.toContain('foreign')
  // 已发布成果带版本号；未发布草稿不出现在清单；无成果任务标「无」
  expect(rows.find(row => row.startsWith('t1'))).toMatch(/"稿\.txt" v1$/)
  expect(rows.find(row => row.startsWith('t1'))).not.toContain('v2')
  expect(rows.find(row => row.startsWith('t3'))).toMatch(/"旧稿\.txt" v1$/)
  expect(rows.find(row => row.startsWith('t2'))).toMatch(/无$/)
  expect(index).not.toContain('草稿.txt')
  expect(await store.recentTaskIndex('empty-channel', 'x')).toContain('暂无历史任务')
})

it('二进制材料保留原始字节，wb_read_material 返回元数据与转换说明', async () => {
  // PNG magic + 非 UTF-8 字节：上传读取一字节不差
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x01])
  const meta = await store.uploadBytes('报表图.png', bytes, 'image/png')
  expect(meta.mime).toBe('image/png')
  expect(meta.sizeBytes).toBe(bytes.length)
  expect(meta.url).toContain(meta.id)
  const file = await store.materialFile(meta.id, '报表图.png')
  expect(file.textReadable).toBe(false)
  expect(await readFile(file.path)).toEqual(bytes)
  // wb_read_material 的语义：二进制只给元数据、下载链接与转换说明，不吐正文
  const read = await store.material(meta.id)
  expect(read.readable).toBe(false)
  expect(read.content).toBeUndefined()
  expect(read.message).toContain('需转换')
  expect(read.material.url).toBe(meta.url)
  expect(read.material.mime).toBe('image/png')
})

it('文本材料直接可读；坏 UTF-8 与超限字节被拒', async () => {
  const text = await store.upload('笔记.md', '# 标题\n正文')
  expect((await store.material(text.id)).content).toContain('正文')
  // 扩展名像文本但字节不是合法 UTF-8：按不可读处理，不给乱码
  const bad = await store.uploadBytes('伪文本.txt', Buffer.from([0xff, 0xfe, 0x80, 0x00]))
  expect((await store.material(bad.id)).readable).toBe(false)
  await expect(store.uploadBytes('大文件.bin', Buffer.alloc(32 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'bad_request', message: '单个附件不能超过 32MiB' })
})

it('失败的状态修改回滚，模型可清空且不能删最后负责人', async () => {
  await expect(store.change(state => { state.employees.length = 0; throw new Error('故障') })).rejects.toThrow('故障')
  expect((await store.read()).employees).toHaveLength(3)
  await store.saveEmployee({ model: 'provider/model' }, 'writer')
  expect((await store.saveEmployee({ model: '' }, 'writer')).model).toBeUndefined()
  await expect(store.deleteEmployee('leader')).rejects.toMatchObject({ code: 'bad_request' })
})

it('频道分组指派与解绑、副本、已读打点；运行中频道拒绝删除且任务线程保留为历史', async () => {
  const group = await store.saveChannelGroup({ name: '项目' })
  const created = await store.saveChannel({ name: '项目资料', groupId: group.id })
  expect(created.groupId).toBe(group.id)
  expect(created.sort).toBe(0)
  // 频道创建即配频道线程，改名同步线程标题
  expect((await store.read()).threads.some(thread => thread.id === `channel-${created.id}` && thread.kind === 'channel')).toBe(true)
  await store.saveChannel({ name: '资料归档' }, created.id)
  expect((await store.thread(`channel-${created.id}`)).title).toBe('资料归档')
  // 同组内 sort 递增；挂到不存在分组/非法 sort 拒绝
  const second = await store.saveChannel({ name: '交付讨论', groupId: group.id })
  expect(second.sort).toBe(1)
  await expect(store.saveChannel({ name: '坏频道', groupId: 'ghost' })).rejects.toMatchObject({ code: 'bad_request' })
  await expect(store.saveChannel({ sort: Number.NaN }, created.id)).rejects.toMatchObject({ code: 'bad_request' })
  // 副本带独立频道线程、sort 排到组尾
  const copy = await store.duplicateChannel(created.id)
  expect(copy.name).toBe('资料归档 副本')
  expect(copy.groupId).toBe(group.id)
  expect(copy.sort).toBe(2)
  // 已读打点
  expect((await store.markChannelRead(created.id)).readAt).toBeTruthy()
  // 频道内有运行中线程拒绝删除
  await store.change(state => {
    state.threads.push({ id: 'task-live', kind: 'task', channelId: created.id, title: '执行中', status: 'running', createdAt: '2026-10-09', updatedAt: '2026-10-09' })
  })
  await expect(store.deleteChannel(created.id)).rejects.toMatchObject({ code: 'conflict' })
  await store.change(state => { state.threads.find(thread => thread.id === 'task-live')!.status = 'idle' })
  await store.deleteChannel(created.id)
  const state = await store.read()
  expect(state.channels.some(channel => channel.id === created.id)).toBe(false)
  expect(state.threads.some(thread => thread.id === `channel-${created.id}`)).toBe(false)
  // 任务线程不在删除范围，保留为只读历史
  expect(state.threads.some(thread => thread.id === 'task-live')).toBe(true)
  // 删除分组不删频道：成员频道退回未分组
  await store.deleteChannelGroup(group.id)
  const ungrouped = (await store.read()).channels.filter(channel => channel.groupId === group.id)
  expect(ungrouped).toHaveLength(0)
  await expect(store.deleteChannelGroup(group.id)).rejects.toMatchObject({ code: 'not_found' })
})

it('私信置顶与已读标记仅对 dm 线程开放', async () => {
  await store.change(state => {
    state.threads.push({ id: 'dm-1', kind: 'dm', employeeId: 'writer', title: '执行员', status: 'idle', createdAt: '2026-10-09', updatedAt: '2026-10-09' })
  })
  const pinned = await store.patchDmThread('dm-1', { pinned: true })
  expect(pinned.pinned).toBe(true)
  const read = await store.patchDmThread('dm-1', { markRead: true })
  expect(read.readAt).toBeTruthy()
  expect((await store.patchDmThread('dm-1', { pinned: false })).pinned).toBeUndefined()
  await expect(store.patchDmThread('channel-general', { pinned: true })).rejects.toMatchObject({ code: 'bad_request' })
  await expect(store.patchDmThread('ghost', {})).rejects.toMatchObject({ code: 'not_found' })
})

it('用户资料：名字裁剪必填，头像只接受材料地址且可清空', async () => {
  expect((await store.profile()).name).toBe('用户')
  expect((await store.saveProfile({ name: '  林夕  ' })).name).toBe('林夕')
  await expect(store.saveProfile({ name: '   ' })).rejects.toMatchObject({ code: 'bad_request' })
  const withAvatar = await store.saveProfile({ avatarUrl: '/wb/api/workforce/materials/mat-1/头像.png' })
  expect(withAvatar.avatarUrl).toContain('/wb/api/workforce/materials/')
  await expect(store.saveProfile({ avatarUrl: 'https://example.com/x.png' })).rejects.toMatchObject({ code: 'bad_request' })
  expect((await store.saveProfile({ avatarUrl: null })).avatarUrl).toBeUndefined()
  expect((await store.profile()).name).toBe('林夕')
})

it('MCP 服务器字段校验，删除时清掉员工的引用', async () => {
  const server = await store.saveMcpServer({
    serverName: 'fs-tools', label: '文件工具', transport: 'stdio', command: 'node server.js',
    args: ['--root', '.'], env: { MODE: { kind: 'literal', value: 'ro' }, TOKEN: { kind: 'credential', ref: 'FS_TOKEN' } },
  })
  expect(server.enabled).toBe(true)
  for (const input of [
    { serverName: 'bad name!', transport: 'stdio', command: 'x' },
    { serverName: 'fs-tools', transport: 'stdio', command: 'x' },
    { serverName: 'ok2', transport: 'sse', command: 'x' },
    { serverName: 'ok3', transport: 'stdio' },
    { serverName: 'ok4', transport: 'streamable-http' },
    { serverName: 'ok5', transport: 'stdio', command: 'x', env: { '1BAD': { kind: 'literal', value: 'v' } } },
    { serverName: 'ok6', transport: 'stdio', command: 'x', env: { KEY: { kind: 'credential', ref: 'bad-ref' } } },
    { serverName: 'ok7', transport: 'stdio', command: 'x', env: { KEY: { kind: 'weird', value: 'v' } } },
  ]) await expect(store.saveMcpServer(input)).rejects.toMatchObject({ code: 'bad_request' })
  // 引用不存在的服务器被拒绝；删除后引用被清理
  await expect(store.saveEmployee({ mcpServers: ['ghost'] }, 'writer')).rejects.toMatchObject({ code: 'bad_request' })
  await store.saveEmployee({ mcpServers: [server.id] }, 'writer')
  await store.deleteMcpServer(server.id)
  expect((await store.employee('writer')).mcpServers).toEqual([])
  await expect(store.deleteMcpServer(server.id)).rejects.toMatchObject({ code: 'not_found' })
})

it('模板开关幂等；模板员工按名跳过不覆盖，保留 isLeader/model/avatarColor', async () => {
  expect(await store.setTemplateEnabled('generic-team', true)).toEqual(['generic-team'])
  expect(await store.setTemplateEnabled('generic-team', true)).toEqual(['generic-team'])
  expect(await store.setTemplateEnabled('generic-team', false)).toEqual([])
  const seeds = [
    { name: '负责人', title: '同名', persona: '不覆盖', skills: ['x'], isLeader: false },
    { name: '执行助理', title: '执行', persona: '完成任务', skills: ['a', 'b'], isLeader: false, model: 'native/model', avatarColor: '#123456' },
    { name: '小组长', title: '协调', persona: '带队', skills: [], isLeader: true },
  ]
  const applied = await store.applyTemplateEmployees(seeds)
  expect(applied).toEqual({ created: ['执行助理', '小组长'], skipped: ['负责人'] })
  const state = await store.read()
  expect(state.employees).toHaveLength(5)
  const intern = state.employees.find(item => item.name === '执行助理')!
  expect(intern).toMatchObject({ role: 'custom', isLeader: false, model: 'native/model', avatarColor: '#123456', skills: ['workforce-tools', 'workforce-communication', 'a', 'b'] })
  expect(state.employees.find(item => item.name === '小组长')).toMatchObject({ isLeader: true, role: 'leader', skills: ['workforce-workflow-design', 'workforce-tools', 'workforce-communication', 'document-to-action-items'] })
  // 二次应用全部跳过，不产生重复
  expect((await store.applyTemplateEmployees(seeds)).created).toHaveLength(0)
})

it('删除员工把运行中任务的直达会话也算在保护范围', async () => {
  await store.change(state => {
    state.tasks.push({ id: 'task-1', threadId: 'thread-1', channelId: 'general', assigneeId: 'leader', delegatorId: 'leader', title: '执行中', prompt: 'x', status: 'running', deliverables: [], createdAt: '2026-10-09', updatedAt: '2026-10-09' })
    state.threads.push({ id: 'thread-1', kind: 'task', taskId: 'task-1', channelId: 'general', title: '执行中', status: 'running', createdAt: '2026-10-09', updatedAt: '2026-10-09' })
    state.bindings['thread-1'] = { rootId: 'root', ownerId: 'leader', children: {}, directChildren: { analyst: 'direct-session' } }
  })
  await expect(store.deleteEmployee('analyst')).rejects.toMatchObject({ code: 'conflict' })
})

it('记忆 CRUD 与容量：旧数据无 memories 键载入为空；scope/scopeId 校验；PATCH 不改作用域与来源；容量按不含空白计数且 scopeId 独立计额', async () => {
  // 旧数据没有 memories 字段：载入默认为空数组
  const legacyRoot = await mkdtemp(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, 'tmp') : process.env.TEMP!, 'wf-legacy-'))
  try {
    await mkdir(join(legacyRoot, 'workforce'), { recursive: true })
    await writeFile(join(legacyRoot, 'workforce', 'state.json'), JSON.stringify({ employees: [], channels: [], threads: [], tasks: [], materials: [], bindings: {}, profile: { name: 'u' }, mcpServers: [], enabledTemplates: [], channelGroups: [] }))
    const legacy = await new WorkforceStore(legacyRoot).read()
    expect(legacy.memories).toEqual([])
    // 旧数据没有 sendReceipts 字段：载入默认为空映射（G1 幂等回执旧库兼容）
    expect(legacy.sendReceipts).toEqual({})
    // 旧数据没有 skillDrafts/installedSkills 字段：载入默认为空数组（草稿与安装记录旧库兼容）
    expect(legacy.skillDrafts).toEqual([])
    expect(legacy.installedSkills).toEqual([])
  } finally { await rm(legacyRoot, { recursive: true, force: true }) }

  // 三个作用域创建；source 记录写入者与会话出处
  const global = await store.saveMemory({ scope: 'global', text: '全局偏好' })
  expect(global).toMatchObject({ scope: 'global', text: '全局偏好', source: { by: 'user' } })
  expect(global.scopeId).toBeUndefined()
  const channel = await store.saveMemory({ scope: 'channel', scopeId: 'general', text: '频道规则' }, undefined, { by: 'leader', threadId: 'thread-x' })
  expect(channel).toMatchObject({ scope: 'channel', scopeId: 'general', source: { by: 'leader', threadId: 'thread-x' } })
  const own = await store.saveMemory({ scope: 'employee', scopeId: 'writer', text: '署名用小花' })
  expect(own).toMatchObject({ scope: 'employee', scopeId: 'writer' })
  // scope/scopeId 校验
  await expect(store.saveMemory({ scope: 'bad', text: 'x' })).rejects.toMatchObject({ code: 'bad_request' })
  await expect(store.saveMemory({ scope: 'global', scopeId: 'x', text: 'x' })).rejects.toMatchObject({ code: 'bad_request' })
  await expect(store.saveMemory({ scope: 'channel', text: 'x' })).rejects.toMatchObject({ code: 'bad_request' })
  await expect(store.saveMemory({ scope: 'channel', scopeId: 'ghost', text: 'x' })).rejects.toMatchObject({ code: 'not_found' })
  await expect(store.saveMemory({ scope: 'employee', scopeId: 'ghost', text: 'x' })).rejects.toMatchObject({ code: 'not_found' })
  await expect(store.saveMemory({ scope: 'global', text: '  ' })).rejects.toMatchObject({ code: 'bad_request' })
  // PATCH：只改正文；id/scope/scopeId/source/createdAt 全部沿用旧值，输入里的 scope 字段被忽略
  const patched = await store.saveMemory({ scope: 'employee', scopeId: 'analyst', text: '新正文' }, channel.id)
  expect(patched).toMatchObject({ id: channel.id, scope: 'channel', scopeId: 'general', text: '新正文', createdAt: channel.createdAt, source: { by: 'leader', threadId: 'thread-x' } })
  await expect(store.saveMemory({ text: 'x' }, 'ghost')).rejects.toMatchObject({ code: 'not_found' })

  // 容量按不含空白字符计数：global 1000 / channel 2000 / employee 500，同 scope 不同 scopeId 独立计额
  await store.deleteMemory(global.id)
  await store.saveMemory({ scope: 'global', text: '字'.repeat(999) })
  await expect(store.saveMemory({ scope: 'global', text: '一二' })).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('记忆已满') })
  await store.saveMemory({ scope: 'global', text: ' 一 ' }) // 999+1=1000 恰好，空白不计
  await expect(store.saveMemory({ scope: 'global', text: '溢' })).rejects.toMatchObject({ code: 'bad_request' })
  await store.saveMemory({ scope: 'channel', scopeId: 'general', text: '字'.repeat(1997) }) // 已有 3 → 2000
  await expect(store.saveMemory({ scope: 'channel', scopeId: 'general', text: '一' })).rejects.toMatchObject({ code: 'bad_request' })
  await store.saveMemory({ scope: 'employee', scopeId: 'writer', text: '字'.repeat(495) }) // 已有 5 → 500
  await expect(store.saveMemory({ scope: 'employee', scopeId: 'writer', text: '一' })).rejects.toMatchObject({ code: 'bad_request' })
  await store.saveMemory({ scope: 'employee', scopeId: 'analyst', text: '字'.repeat(500) }) // 独立 scopeId 计额
  await expect(store.saveMemory({ scope: 'employee', scopeId: 'analyst', text: '一' })).rejects.toMatchObject({ code: 'bad_request' })

  // listMemories：limits 固定三档；usage 按 scope:scopeId 汇总且不计空白；过滤生效
  const listed = await store.listMemories()
  expect(listed.limits).toEqual({ global: 1000, channel: 2000, employee: 500 })
  expect(listed.usage['global:']).toBe(1000)
  expect(listed.usage['channel:general']).toBe(2000)
  expect(listed.usage['employee:writer']).toBe(500)
  expect(listed.usage['employee:analyst']).toBe(500)
  expect((await store.listMemories('channel', 'general')).memories).toHaveLength(2)
  expect((await store.listMemories('channel')).memories.every(item => item.scope === 'channel')).toBe(true)
  await expect(store.listMemories('global', 'x')).rejects.toMatchObject({ code: 'bad_request' })
  await expect(store.listMemories(undefined, 'x')).rejects.toMatchObject({ code: 'bad_request' })
  await expect(store.listMemories('bad')).rejects.toMatchObject({ code: 'bad_request' })
  // delete：幂等不存在 → not_found
  await store.deleteMemory(own.id)
  await expect(store.deleteMemory(own.id)).rejects.toMatchObject({ code: 'not_found' })
  await expect(store.deleteMemory('ghost')).rejects.toMatchObject({ code: 'not_found' })
})

it('memorySnapshot/frozenMemory：按频道与员工过滤、负责人快照附员工交代；同会话冻结、新会话生效、冷恢复沿用持久化快照', async () => {
  const seedThread = async (id: string, channelId: string, rootId: string) => store.change(state => {
    state.threads.push({ id, kind: 'task', taskId: `task-${id}`, channelId, title: id, status: 'idle', createdAt: '2026-10-08', updatedAt: '2026-10-08' })
    state.bindings[id] = { rootId, ownerId: 'leader', children: {}, humanMessageIds: [] }
  })
  await store.change(state => { state.channels.push({ id: 'other', name: '外频道', sort: 1, createdAt: '2026-10-08' }) })
  await seedThread('thread-m', 'general', 'sess-root')
  // 首次冻结把快照持久化进 binding.memorySnapshots
  const empty = await store.frozenMemory('thread-m', 'leader', 'sess-root')
  expect((await store.read()).bindings['thread-m']!.memorySnapshots!['sess-root']).toBe(empty)
  await store.saveMemory({ scope: 'global', text: '全局条款甲' })
  await store.saveMemory({ scope: 'channel', scopeId: 'general', text: '频道条款乙' })
  await store.saveMemory({ scope: 'channel', scopeId: 'other', text: '外频道条款' })
  await store.saveMemory({ scope: 'employee', scopeId: 'leader', text: '负责人条款丙' })
  await store.saveMemory({ scope: 'employee', scopeId: 'writer', text: '执行员条款丁' })
  // 同会话冻结：任务内新增记忆不进入已冻结快照；冷恢复沿用持久化快照而非重算
  expect(await store.frozenMemory('thread-m', 'leader', 'sess-root')).toBe(empty)
  expect(await new WorkforceStore(root).frozenMemory('thread-m', 'leader', 'sess-root')).toBe(empty)
  // memorySnapshot 现算：负责人（root 会话）可见全部适用条款，员工交代小节列各员工记忆
  const live = await store.memorySnapshot('thread-m', 'leader')
  for (const entry of ['全局条款甲', '频道条款乙', '负责人条款丙', '执行员条款丁']) expect(live).toContain(entry)
  expect(live).not.toContain('外频道条款')
  // 新会话：冻结快照含写入后的全部适用条款
  await seedThread('thread-m2', 'general', 'sess-root2')
  const fresh = await store.frozenMemory('thread-m2', 'leader', 'sess-root2')
  for (const entry of ['全局条款甲', '频道条款乙', '负责人条款丙', '执行员条款丁']) expect(fresh).toContain(entry)
  expect(fresh).not.toContain('外频道条款')
  // 非负责人员工快照：只含自己 scopeId 的员工条款与本频道条款
  const writer = await store.frozenMemory('thread-m2', 'writer', 'sess-w')
  expect(writer).toContain('执行员条款丁')
  expect(writer).toContain('频道条款乙')
  expect(writer).not.toContain('负责人条款丙')
  // 外频道线程不含本频道条款
  await seedThread('thread-o', 'other', 'sess-o')
  const other = await store.frozenMemory('thread-o', 'leader', 'sess-o')
  expect(other).toContain('外频道条款')
  expect(other).not.toContain('频道条款乙')
  // 未知线程明确 not_found
  await expect(store.frozenMemory('ghost', 'leader', 's')).rejects.toMatchObject({ code: 'not_found' })
  await expect(store.memorySnapshot('ghost', 'leader')).rejects.toMatchObject({ code: 'not_found' })
})
