import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { toolValue, renderToolJson } from '../tool-output.ts'
import { requiredText } from './store.ts'
import type { WorkforceRuntime } from './runtime.ts'
import { WorkforceError } from './types.ts'
import { verifyProjectDirectory } from './project-directory.ts'
import { createKimiHome, privateTemp, removeKimiHome } from './kimi-home.ts'
import { currentKimiProgress, KimiStillRunning, runKimiAcp } from './kimi-acp.ts'

export function kimiProgress(_jobs: unknown, _events: readonly any[], callId: string, owner: string): string { return currentKimiProgress(owner, callId) }

export function registerKimiTool(runtime: WorkforceRuntime, ctx: { tools: { register(tool: unknown): unknown } }): void {
  ctx.tools.register(defineTool({
    name: 'wb_run_kimi',
    description: '在当前任务绑定的项目目录中运行 Kimi CLI 完成开发任务。等待真实退出和结果后返回；只供负责人使用。任务须包含用户需求、约束和验收要求。',
    parameters: { task: { type: 'string', required: true, description: '完整开发任务，不含密钥' } },
    output: { schema: { type: 'object' as const, additionalProperties: true }, render: renderToolJson },
    async execute(args, exec: ToolRunContext) {
      const agent = exec.agent
      if (!agent) throw new WorkforceError('bad_request', '当前工具调用没有负责人会话')
      const owner = agent.session.id
      const { threadId } = await runtime.address(owner)
      const binding = (await runtime.store.read()).bindings[threadId]
      if (!binding || binding.rootId !== owner) throw new WorkforceError('bad_request', '仅任务负责人可以运行 Kimi')
      const cwd = binding.projectDirectory
      if (!cwd) throw new WorkforceError('bad_request', '请先在频道设置中选择项目目录，再开始新任务')
      await verifyProjectDirectory(cwd)
      const task = requiredText(args.task, 16000)
      const home = await createKimiHome(await privateTemp(agent, exec, cwd))
      let safeToRemove = true
      try {
        const output = await runKimiAcp(agent, exec.callId, cwd, home, task, exec.signal)
        return toolValue({ processExited: true, projectDirectory: cwd, output: output || 'Kimi 未返回文本结果；不要假设任务成功' })
      } catch (error) {
        if (error instanceof KimiStillRunning) safeToRemove = false
        if (exec.signal.aborted) throw error
        return toolValue({ processExited: false, projectDirectory: cwd, output: error instanceof Error ? error.message : String(error) })
      } finally { if (safeToRemove) await removeKimiHome(home) }
    },
  }))
}
