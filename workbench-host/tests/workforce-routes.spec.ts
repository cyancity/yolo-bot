import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { testTmpRoot } from './test-tmp.ts'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { listenForFetch } from './helpers/http-server.ts'
import { WorkforceStore } from '../src/workforce/store.ts'
import { WorkforceRuntime } from '../src/workforce/runtime.ts'
import { createWorkforceHandler } from '../src/workforce/routes.ts'
import { WorkforceError } from '../src/workforce/types.ts'

let root: string, store: WorkforceStore, runtime: WorkforceRuntime, server: Server, base: string
let reject: 401 | 403 | undefined
beforeEach(async () => {
  root = await testTmpRoot('wf-routes-')
  store = new WorkforceStore(root)
  runtime = new WorkforceRuntime(store, () => undefined)
  reject = undefined
  server = createServer(createWorkforceHandler(runtime, () => reject ? { rejection: reject } : { peer: {} }, async (_req, res) => { res.writeHead(404); res.end() }))
  await listenForFetch(server)
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/wb/api/workforce`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await runtime.dispose(); await rm(root, { recursive: true, force: true })
})
const post = (route: string, data: unknown) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })

it('所有读写通过admission，拒绝时不创建员工或材料', async () => {
  reject = 401
  expect((await fetch(base + '/employees')).status).toBe(401)
  expect((await post('/employees', { name: '新员工' })).status).toBe(401)
  reject = 403
  expect((await post('/materials', { name: '材料.txt', content: '材料' })).status).toBe(403)
  expect((await store.read()).employees).toHaveLength(3)
  expect((await store.read()).materials).toHaveLength(0)
})

it('员工/材料 envelope、无模型错误、非法JSON保持明确错误码', async () => {
  const employee = await (await post('/employees', { name: '检查员', title: '检查', persona: '核对', skills: [] })).json()
  expect(employee.ok).toBe(true)
  expect(employee.data.employee.name).toBe('检查员')
  const uploaded = await (await post('/materials', { name: '材料.txt', content: '青禾' })).json()
  expect(uploaded.data.material.url).toContain(uploaded.data.material.id)
  expect((await (await fetch(base + '/materials/' + uploaded.data.material.id)).json()).data.content).toBe('青禾')
  const unavailable = await post('/threads/channel-general/messages', { text: '执行任务' })
  expect(unavailable.status).toBe(503)
  expect((await unavailable.json()).error.code).toBe('model_unavailable')
  const invalid = await fetch(base + '/materials', { method: 'POST', body: '{' })
  expect(invalid.status).toBe(400)
})

it('任务详情返回task，真实成果可下载，未知文件和路径不能读取', async () => {
  await store.change(state => { state.tasks.push({ id: 'task', threadId: 'thread', channelId: 'general', assigneeId: 'leader', delegatorId: 'leader', title: '任务', prompt: '任务', status: 'done', deliverables: [], createdAt: '2026-10-09', updatedAt: '2026-10-09' }) })
  vi.spyOn(runtime, 'refreshTasks').mockResolvedValue()
  const item = await store.deliverable('thread', '青禾.txt', '真实文案')
  expect((await (await fetch(base + '/tasks/task')).json()).data.task.id).toBe('task')
  const output = await fetch(new URL(base).origin + item.url)
  expect(output.status).toBe(200)
  expect(await output.text()).toBe('真实文案')
  expect((await fetch(base + '/tasks/task/deliverables/unknown.txt')).status).toBe(404)
  expect((await fetch(base + '/tasks/task/deliverables/' + encodeURIComponent('../state.json'))).status).toBe(400)
})

it('成果下载按 ?v 取版本、未发布取最新；publish 路由以 user 署名并回传 task', async () => {
  await store.change(state => {
    state.tasks.push({ id: 'task', threadId: 'thread', channelId: 'general', assigneeId: 'leader', delegatorId: 'leader', title: '任务', prompt: '任务', status: 'done', deliverables: [], createdAt: '2026-10-09', updatedAt: '2026-10-09' })
    state.tasks.push({
      id: 'legacy', threadId: 'legacy-thread', channelId: 'general', assigneeId: 'leader', delegatorId: 'leader', title: '旧任务', prompt: '旧任务', status: 'done',
      deliverables: [{ name: '旧稿.txt', url: `/wb/api/workforce/tasks/legacy/deliverables/${encodeURIComponent('旧稿.txt')}` } as any],
      createdAt: '2026-10-08', updatedAt: '2026-10-08',
    })
  })
  await mkdir(join(store.directory, 'deliverables', 'legacy'), { recursive: true })
  await writeFile(join(store.directory, 'deliverables', 'legacy', '旧稿.txt'), '旧版内容')
  await store.deliverable('thread', '稿.txt', '第一版')
  await store.deliverable('thread', '稿.txt', '第二版')
  const name = encodeURIComponent('稿.txt')
  const bare = `${base}/tasks/task/deliverables/${name}`
  // 未发布：默认取最新；?v=N 取指定版本，越界 404、非法 400
  expect(await (await fetch(bare)).text()).toBe('第二版')
  expect(await (await fetch(`${bare}?v=1`)).text()).toBe('第一版')
  expect((await fetch(`${bare}?v=9`)).status).toBe(404)
  expect((await fetch(`${bare}?v=x`)).status).toBe(400)
  expect((await fetch(`${bare}?v=1`, { method: 'HEAD' })).status).toBe(200)
  // 旧平铺成果：默认与 ?v=1 返回原文件内容
  const legacyUrl = `${base}/tasks/legacy/deliverables/${encodeURIComponent('旧稿.txt')}`
  expect(await (await fetch(legacyUrl)).text()).toBe('旧版内容')
  expect(await (await fetch(`${legacyUrl}?v=1`)).text()).toBe('旧版内容')
  expect((await fetch(`${legacyUrl}?v=2`)).status).toBe(404)
  // 用户发布 v1：publishedBy=user，返回更新后的整条 task；默认链接切换到已发布版本
  const published = await post(`/tasks/task/deliverables/${name}/publish`, { version: 1 })
  expect(published.status).toBe(200)
  const body = await published.json()
  expect(body.data.task.id).toBe('task')
  expect(body.data.task.deliverables[0]).toMatchObject({ publishedVersion: 1, publishedBy: 'user' })
  expect(await (await fetch(bare)).text()).toBe('第一版')
  expect(await (await fetch(`${bare}?v=2`)).text()).toBe('第二版')
  // 发布不存在的版本/成果 404 not_found；旧条目发布会先迁移，旧链接仍可用
  const missing = await post(`/tasks/task/deliverables/${name}/publish`, { version: 42 })
  expect(missing.status).toBe(404)
  expect((await missing.json()).error.code).toBe('not_found')
  expect((await post(`/tasks/task/deliverables/${encodeURIComponent('无此稿.txt')}/publish`, { version: 1 })).status).toBe(404)
  const legacyPublished = await post(`/tasks/legacy/deliverables/${encodeURIComponent('旧稿.txt')}/publish`, { version: 1 })
  expect(legacyPublished.status).toBe(200)
  expect((await legacyPublished.json()).data.task.deliverables[0]).toMatchObject({ publishedVersion: 1, publishedBy: 'user' })
  expect(await (await fetch(legacyUrl)).text()).toBe('旧版内容')
})

it('原始字节材料：x-workforce-filename 上传、GET 回同样字节、可执行类型带沙箱 CSP', async () => {
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e])
  const up = await fetch(base + '/materials', {
    method: 'POST',
    headers: { 'x-workforce-filename': encodeURIComponent('报告.pdf'), 'content-type': 'application/pdf' },
    body: bytes,
  })
  expect(up.status).toBe(200)
  const material = (await up.json()).data.material
  expect(material.mime).toBe('application/pdf')
  const got = await fetch(new URL(base).origin + material.url)
  expect(got.status).toBe(200)
  expect(Buffer.from(await got.arrayBuffer())).toEqual(bytes)
  // 可执行内容类型直接给沙箱 CSP，防内嵌脚本
  const html = await fetch(base + '/materials', {
    method: 'POST',
    headers: { 'x-workforce-filename': encodeURIComponent('页面.html'), 'content-type': 'text/html' },
    body: '<html><body>x</body></html>',
  })
  const htmlUrl = (await html.json()).data.material.url
  const page = await fetch(new URL(base).origin + htmlUrl)
  expect(page.headers.get('content-security-policy')).toContain('sandbox')
  expect(page.headers.get('content-disposition')).toContain('attachment')
})

it('提问/审批应答路由透传 runtime.answerAsk，错误码按类型映射', async () => {
  const answer = vi.spyOn(runtime, 'answerAsk').mockResolvedValue({ answered: true })
  const res = await post('/threads/task-thread/asks/req-1', { answers: [{ id: 'q1', selected: ['方案A'] }] })
  expect(res.status).toBe(200)
  expect((await res.json()).data.answered).toBe(true)
  expect(answer).toHaveBeenCalledWith('task-thread', 'req-1', { answers: [{ id: 'q1', selected: ['方案A'] }] })
  answer.mockRejectedValue(new WorkforceError('bad_request', '每道题都需要提交一项答案'))
  expect((await post('/threads/task-thread/asks/req-1', { answers: [] })).status).toBe(400)
  answer.mockRejectedValue(new WorkforceError('conflict', '此请求已回答'))
  expect((await post('/threads/task-thread/asks/req-1', { outcome: 'rejected' })).status).toBe(409)
  answer.mockRejectedValue(new WorkforceError('not_found', '提问请求不存在或已失效'))
  expect((await post('/threads/task-thread/asks/stale-id', { answers: [] })).status).toBe(404)
})

it('频道列表带未读标记与分组，read 打点清零；无正文变动不计未读；副本与运行中删除保护走明确状态码', async () => {
  // 未读只认真实正文（threadContentAt）：无正文的新频道线程不计未读（创建/状态变动不复活已读）
  const channels = (await (await fetch(base + '/channels')).json()).data
  expect(channels.channels.find((item: any) => item.id === 'general').unread).toBe(false)
  expect(channels.groups).toEqual([])
  // task 线程无 lastMessageAt 时按 createdAt（首条用户消息落点）计未读
  await store.change(state => { state.threads.push({ id: 'task-unread', kind: 'task', channelId: 'general', title: '有正文', status: 'idle', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' }) })
  expect((await (await fetch(base + '/channels')).json()).data.channels.find((item: any) => item.id === 'general').unread).toBe(true)
  await post('/channels/general/read', {})
  expect((await (await fetch(base + '/channels')).json()).data.channels[0].unread).toBe(false)
  // 分组 CRUD 与频道挂靠
  const group = (await (await post('/channel-groups', { name: '项目' })).json()).data.group
  const created = (await (await post('/channels', { name: '协作频道', groupId: group.id })).json()).data.channel
  expect(created.groupId).toBe(group.id)
  const patched = await fetch(`${base}/channels/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ groupId: null }) })
  expect((await patched.json()).data.channel.groupId).toBeUndefined()
  // 副本
  const copy = (await (await post(`/channels/${created.id}/duplicate`, {})).json()).data.channel
  expect(copy.name).toBe('协作频道 副本')
  // 运行中频道删除 → 409
  await store.change(state => { state.threads.push({ id: 'task-live', kind: 'task', channelId: created.id, title: '执行中', status: 'running', createdAt: '2026-10-09', updatedAt: '2026-10-09' }) })
  expect((await fetch(`${base}/channels/${created.id}`, { method: 'DELETE' })).status).toBe(409)
})

it('私信线程 PATCH 置顶/已读，未读只认真实正文 lastMessageAt（updatedAt 状态变动不计）；频道线程被拒', async () => {
  await store.change(state => {
    state.threads.push({ id: 'dm-1', kind: 'dm', employeeId: 'writer', title: '文案员', status: 'idle', createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', lastMessageAt: '2026-10-09T00:00:00Z' })
  })
  expect((await (await fetch(base + '/threads')).json()).data.threads.find((item: any) => item.id === 'dm-1').unread).toBe(true)
  const patched = await fetch(`${base}/threads/dm-1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned: true, markRead: true }) })
  const thread = (await patched.json()).data.thread
  expect(thread.pinned).toBe(true)
  expect((await (await fetch(base + '/threads')).json()).data.threads.find((item: any) => item.id === 'dm-1').unread).toBe(false)
  // 已读之后仅 updatedAt 状态变动（置顶/刷新/取消），无新正文不复活未读
  await store.change(state => { const target = state.threads.find(item => item.id === 'dm-1')!; target.updatedAt = '2026-10-12T00:00:00Z' })
  expect((await (await fetch(base + '/threads')).json()).data.threads.find((item: any) => item.id === 'dm-1').unread).toBe(false)
  expect((await fetch(`${base}/threads/channel-general`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned: true }) })).status).toBe(400)
})

it('消息发送校验 employeeIds 形状；mcp-servers 与 templates 路由', async () => {
  for (const body of [{ text: 'x', employeeIds: 'writer' }, { text: 'x', employeeIds: [1] }, { text: 'x', employeeIds: [''] }])
    expect((await post('/threads/whatever/messages', body)).status).toBe(400)
  // @ 不存在的员工在任务线程创建前就被拒，不留孤儿任务
  const ghost = await post('/threads/channel-general/messages', { text: 'x', employeeIds: ['ghost'] })
  expect(ghost.status).toBe(404)
  expect((await store.read()).tasks).toHaveLength(0)
  const server = (await (await post('/mcp-servers', { serverName: 'fs', label: '文件', transport: 'stdio', command: 'npx srv' })).json()).data.server
  expect(server.enabled).toBe(true)
  const listed = (await (await fetch(base + '/mcp-servers')).json()).data.servers
  expect(listed.map((item: any) => item.serverName)).toContain('fs')
  // 宿主注入的 status 标注透出（本 handler 无 mcp 依赖 → 无 status 字段）
  expect(listed[0].status).toBeUndefined()
  expect((await fetch(`${base}/mcp-servers/${server.id}`, { method: 'DELETE' })).status).toBe(200)
  // 模板清单无打包 manifest 时为空列表；未知 id 404
  expect((await (await fetch(base + '/templates')).json()).data.templates).toEqual([])
  expect((await fetch(`${base}/templates/ghost`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })).status).toBe(404)
  expect((await post('/templates/ghost/apply', {})).status).toBe(404)
})

it('记忆路由：GET 过滤与 limits/usage，POST user 署名，PATCH 只改正文，DELETE 与错误码', async () => {
  const patch = (route: string, data: unknown) => fetch(base + route, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
  // POST：source.by=user；scope/scopeId 校验按既有错误码映射
  const global = await (await post('/memories', { scope: 'global', text: '全局偏好' })).json()
  expect(global.data.memory).toMatchObject({ scope: 'global', text: '全局偏好', source: { by: 'user' } })
  const channel = await (await post('/memories', { scope: 'channel', scopeId: 'general', text: '频道规则' })).json()
  expect(channel.data.memory).toMatchObject({ scope: 'channel', scopeId: 'general', source: { by: 'user' } })
  expect((await post('/memories', { scope: 'bad', text: 'x' })).status).toBe(400)
  expect((await post('/memories', { scope: 'global', scopeId: 'x', text: 'x' })).status).toBe(400)
  expect((await post('/memories', { scope: 'channel', text: 'x' })).status).toBe(400)
  expect((await post('/memories', { scope: 'channel', scopeId: 'ghost', text: 'x' })).status).toBe(404)
  expect((await post('/memories', { scope: 'employee', scopeId: 'ghost', text: 'x' })).status).toBe(404)
  // 容量溢出 → 400 记忆已满（global 已有 4 字）
  const overflow = await post('/memories', { scope: 'global', text: 'x'.repeat(2000) })
  expect(overflow.status).toBe(400)
  expect((await overflow.json()).error.code).toBe('bad_request')
  // GET：limits 三档固定；usage 按 scope:scopeId 汇总且不计空白；scope/scopeId 过滤生效
  const listed = (await (await fetch(base + '/memories')).json()).data
  expect(listed.memories).toHaveLength(2)
  expect(listed.limits).toEqual({ global: 1000, channel: 2000, employee: 500 })
  expect(listed.usage['global:']).toBe(4)
  expect(listed.usage['channel:general']).toBe(4)
  const filtered = (await (await fetch(base + '/memories?scope=channel&scopeId=general')).json()).data
  expect(filtered.memories).toHaveLength(1)
  expect(filtered.memories[0].scopeId).toBe('general')
  expect((await (await fetch(base + '/memories?scope=channel')).json()).data.memories).toHaveLength(1)
  expect((await fetch(base + '/memories?scope=global&scopeId=x')).status).toBe(400)
  expect((await fetch(base + '/memories?scopeId=x')).status).toBe(400)
  // PATCH：只改正文，scope/scopeId/source 不变（输入里的 scope 字段被忽略）；未知 id 404
  const patched = await patch(`/memories/${channel.data.memory.id}`, { scope: 'global', text: '新规则' })
  expect(patched.status).toBe(200)
  expect((await patched.json()).data.memory).toMatchObject({ id: channel.data.memory.id, scope: 'channel', scopeId: 'general', text: '新规则', source: { by: 'user' } })
  expect((await patch('/memories/ghost', { text: 'x' })).status).toBe(404)
  // DELETE：{deleted:true}；重复删除 404
  const deleted = await fetch(`${base}/memories/${channel.data.memory.id}`, { method: 'DELETE' })
  expect(deleted.status).toBe(200)
  expect((await deleted.json()).data.deleted).toBe(true)
  expect((await (await fetch(base + '/memories')).json()).data.memories).toHaveLength(1)
  expect((await fetch(`${base}/memories/${channel.data.memory.id}`, { method: 'DELETE' })).status).toBe(404)
})

it('G1/G3 路由参数：requestId 非字符串 400、合法值透传到发送；messages 分页 limit/before 校验', async () => {
  // requestId：非字符串 → 400 bad_request；合法值透传到 runtime（无原生服务 → 503 model_unavailable）
  expect((await post('/threads/channel-general/messages', { text: 'x', requestId: 5 })).status).toBe(400)
  const unavailable = await post('/threads/channel-general/messages', { text: 'x', requestId: 'req-1' })
  expect(unavailable.status).toBe(503)
  expect((await unavailable.json()).error.code).toBe('model_unavailable')
  // messages 分页：非法 limit/游标 → 400；无 binding 的频道线程 → 空页带 hasMore
  expect((await fetch(base + '/threads/channel-general/messages?limit=abc')).status).toBe(400)
  expect((await fetch(base + '/threads/channel-general/messages?limit=0')).status).toBe(400)
  expect((await fetch(base + '/threads/channel-general/messages?limit=1.5')).status).toBe(400)
  expect((await fetch(base + '/threads/channel-general/messages?before=x')).status).toBe(400)
  const paged = await (await fetch(base + '/threads/channel-general/messages?limit=999')).json()
  expect(paged.data.messages).toEqual([])
  expect(paged.data.hasMore).toBe(false)
  expect((await fetch(base + '/threads/ghost-thread/messages')).status).toBe(404)
})

it('B3 诊断导出：默认无对话正文、密钥与家目录遮蔽、taskId 附对话、损坏 state 降级为 errors 不 500', async () => {
  const server = (await (await post('/mcp-servers', { serverName: 'fs', label: '文件', transport: 'stdio', command: 'npx srv' })).json()).data.server
  await store.change(state => {
    state.tasks.push({ id: 't-fail', threadId: 'th-fail', channelId: 'general', assigneeId: 'leader', delegatorId: 'leader', title: 'f', prompt: 'f', status: 'failed', error: `sk-FAKE-999 在 ${homedir()}\\keys\\x.txt 读取失败`, deliverables: [], createdAt: '2026-10-09', updatedAt: '2026-10-09' })
    state.threads.push({ id: 'th-fail', kind: 'task', taskId: 't-fail', channelId: 'general', title: 'f', status: 'error', createdAt: '2026-10-09', updatedAt: '2026-10-09' })
  })
  const report = (await (await fetch(base + '/diagnostics')).json()).data
  expect(report.conversation).toBeUndefined()
  expect(report.counts.tasks.failed).toBe(1)
  expect(report.recentFailures[0]).toMatchObject({ id: 't-fail', threadId: 'th-fail', status: 'failed' })
  expect(report.mcpServers.find((item: any) => item.id === server.id)).toMatchObject({ serverName: 'fs', available: null, credentialsReady: null })
  expect(report.errors.some((item: any) => item.section === `mcp:${server.id}`)).toBe(true)
  expect(report.errors.some((item: any) => item.section === 'models')).toBe(true)
  const failureError = report.recentFailures[0].error
  expect(failureError).not.toContain('FAKE-999')
  expect(failureError).not.toContain(homedir())
  expect(failureError).toContain('已遮蔽')
  expect(JSON.stringify(report)).not.toContain('FAKE-999')
  // taskId 附对话（无 binding → 空消息结构）；未知 taskId → errors.conversation
  const withTask = (await (await fetch(base + '/diagnostics?taskId=t-fail')).json()).data
  expect(withTask.conversation).toMatchObject({ taskId: 't-fail', threadId: 'th-fail', messages: [] })
  // 消息带工具行 → conversation.messages 附 tool {name,status}（无参数正文）
  const pageSpy = vi.spyOn(runtime, 'messagePage').mockResolvedValue({ messages: [{ id: 'm1', threadId: 'th-fail', ts: '2026-10-09', role: 'agent', senderId: 'leader', text: '调用失败', tool: { name: 'shell.run', status: 'error' } }] } as any)
  try {
    const withTool = (await (await fetch(base + '/diagnostics?taskId=t-fail')).json()).data
    expect(withTool.conversation.messages[0].tool).toEqual({ name: 'shell.run', status: 'error' })
    expect(withTool.conversation.messages[0].text).toBe('调用失败')
  } finally { pageSpy.mockRestore() }
  const unknown = (await (await fetch(base + '/diagnostics?taskId=nope')).json()).data
  expect(unknown.conversation).toBeUndefined()
  expect(unknown.errors.some((item: any) => item.section === 'conversation')).toBe(true)
  // state 损坏：仍返回诊断信封（counts:null + errors.state），不是 500
  const spy = vi.spyOn(store, 'read').mockRejectedValue(new SyntaxError('state.json 损坏'))
  try {
    const broken = await fetch(base + '/diagnostics')
    expect(broken.status).toBe(200)
    const degraded = (await broken.json()).data
    expect(degraded.counts).toBeNull()
    expect(degraded.errors.some((item: any) => item.section === 'state' && item.message.includes('SyntaxError'))).toBe(true)
    expect(degraded.environment.workbenchVersion).toBeTruthy()
  } finally { spy.mockRestore() }
})

it('B3 诊断落盘：export 写数据根 diagnostics/ 新文件、与 GET 同参数同源、默认无对话正文', async () => {
  const saved = await post('/diagnostics/export', {})
  expect(saved.status).toBe(200)
  const path = (await saved.json()).data.path
  expect(path.startsWith(join(store.directory, 'diagnostics'))).toBe(true)
  expect(path.endsWith('.json')).toBe(true)
  const written = JSON.parse(await readFile(path, 'utf8'))
  expect(written.privacy).toContain('默认不包含对话')
  expect(written.conversation).toBeUndefined()
  // 与 GET 同参数 → 内容同源（仅 generatedAt 可不同）
  const preview = (await (await fetch(base + '/diagnostics')).json()).data
  expect({ ...written, generatedAt: undefined }).toEqual({ ...preview, generatedAt: undefined })
  // taskId 走 body 透传（未知任务 → 写出的 errors.conversation 与 GET 一致）；wx 不覆盖，两次导出不复用路径
  const saved2 = await post('/diagnostics/export', { taskId: 'nope' })
  expect(saved2.status).toBe(200)
  const path2 = (await saved2.json()).data.path
  expect(path2).not.toBe(path)
  const written2 = JSON.parse(await readFile(path2, 'utf8'))
  expect(written2.errors.some((item: any) => item.section === 'conversation')).toBe(true)
  const preview2 = (await (await fetch(base + '/diagnostics?taskId=nope')).json()).data
  expect({ ...written2, generatedAt: undefined }).toEqual({ ...preview2, generatedAt: undefined })
})

it('安装包不给字节：materials 与任务成果、thread files 的 GET/HEAD/?download=1 一律拒，location/reveal 与普通文件不受影响', async () => {
  // 材料路径：上传成功，但字节路由（含 HEAD 与强制下载）全拒
  const uploaded = await post('/materials', { name: '安装包.exe', content: 'MZ' })
  expect(uploaded.status).toBe(200)
  const material = (await uploaded.json()).data.material
  const matBase = `${base}/materials/${material.id}/${encodeURIComponent('安装包.exe')}`
  expect((await fetch(matBase)).status).toBe(404)
  expect((await fetch(matBase, { method: 'HEAD' })).status).toBe(404)
  expect((await fetch(`${matBase}?download=1`)).status).toBe(404)
  // 大写扩展名同样命中安装包判定
  const msi = await post('/materials', { name: '打包.MSI', content: 'MZ' })
  const msiMaterial = (await msi.json()).data.material
  expect((await fetch(`${base}/materials/${msiMaterial.id}/${encodeURIComponent('打包.MSI')}`)).status).toBe(404)
  // 任务成果路径：GET/HEAD/?download=1 拒，location 仍给真实绝对路径
  await store.change(state => { state.tasks.push({ id: 'task', threadId: 'thread', channelId: 'general', assigneeId: 'leader', delegatorId: 'leader', title: '任务', prompt: '任务', status: 'done', deliverables: [], createdAt: '2026-10-11', updatedAt: '2026-10-11' }) })
  const exe = await store.deliverable('thread', 'setup.exe', 'MZ-installer-bytes')
  const exeUrl = new URL(base).origin + exe.url
  expect((await fetch(exeUrl)).status).toBe(404)
  expect((await fetch(exeUrl, { method: 'HEAD' })).status).toBe(404)
  expect((await fetch(`${exeUrl}&download=1`)).status).toBe(404)
  const exeLocation = await fetch(new URL(base).origin + `/wb/api/workforce/tasks/task/deliverables/${encodeURIComponent('setup.exe')}/location?v=1`)
  expect(exeLocation.status).toBe(200)
  expect(((await exeLocation.json()).data.path as string).replace(/\\/g, '/')).toContain('deliverables/task/setup.exe/')
  // thread files：成果行在列表中不给 url 只给 locationUrl；files/:id 字节路由与 location 双向验证
  // （threadFileRows 需要线程绑定存在；sessionEvents 无服务失败按会话跳过，不影响成果行）
  await store.change(state => { state.bindings['thread'] = { rootId: 'sess-root', ownerId: 'leader', children: {} } as any })
  const listing = await (await fetch(`${base}/threads/thread/files`)).json()
  const row = listing.data.files.find((item: any) => item.name === 'setup.exe')
  expect(row.url).toBeUndefined()
  expect(row.locationUrl).toBeTruthy()
  const encodedId = encodeURIComponent(row.id)
  expect((await fetch(`${base}/threads/thread/files/${encodedId}`)).status).toBe(404)
  expect((await fetch(`${base}/threads/thread/files/${encodedId}`, { method: 'HEAD' })).status).toBe(404)
  expect((await fetch(`${base}/threads/thread/files/${encodedId}?download=1`)).status).toBe(404)
  const fileLocation = await fetch(`${base}/threads/thread/files/${encodedId}/location`)
  expect(fileLocation.status).toBe(200)
  expect(((await fileLocation.json()).data.path as string).replace(/\\/g, '/')).toContain('deliverables/task/setup.exe/')
  // 对照组：同请求形态的普通文本成果照常可下载（防「全拒」回归）
  const txt = await store.deliverable('thread', '稿.txt', '正文')
  expect(await (await fetch(new URL(base).origin + txt.url)).text()).toBe('正文')
})
