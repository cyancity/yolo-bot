import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { toolValue, renderToolJson } from '../tool-output.ts'
import { requiredText } from './store.ts'
import type { WorkforceRuntime } from './runtime.ts'
import { WorkforceError } from './types.ts'
import { verifyProjectDirectory } from './project-directory.ts'
import { currentAgentProgress, runAgentCli } from './agent-cli/index.ts'
import { AGENT_TOOL } from './agent-config.ts'

export function agentProgress(owner: string, callId: string): string { return currentAgentProgress(owner, callId) }

export function registerAgentTool(runtime: WorkforceRuntime, ctx: { tools: { register(tool: unknown): unknown } }): void {
  ctx.tools.register(defineTool({
    name: AGENT_TOOL,
    description: '调用当前员工配置的外部 Agent CLI，在频道绑定的项目目录中执行开发任务。任务须包含完整需求、约束和验收要求，最多 16000 字。每次运行需完整权限审批，等待真实结果后核对；进程退出不等于任务成功。',
    parameters: { task: { type: 'string', required: true, description: '完整开发任务，不含密钥，最多 16000 字' } },
    output: { schema: { type: 'object' as const, additionalProperties: true }, render: renderToolJson },
    async execute(args, exec: ToolRunContext) {
      const agent = exec.agent
      if (!agent) throw new WorkforceError('bad_request', '当前工具调用没有员工会话')
      const { threadId, employeeId } = await runtime.address(agent.session.id)
      const state = await runtime.store.read()
      const config = state.employees.find(item => item.id === employeeId)?.agent
      if (!config) throw new WorkforceError('bad_request', '当前员工未配置外部 Agent')
      const cwd = state.bindings[threadId]?.projectDirectory
      try {
        if (!cwd) throw new WorkforceError('bad_request', '外部 Agent 需要项目目录：请在频道设置里选择项目目录，再在该频道派任务。')
        await verifyProjectDirectory(cwd)
        const task = requiredText(args.task, 16000)
        const output = await runAgentCli(agent, exec.callId, cwd, task, config, exec.signal, request => runtime.requestAgentApproval(request))
        return toolValue({ processExited: true, projectDirectory: cwd, agent: config.cli, output: output || '外部 Agent 未返回文本结果；不要假设任务成功' })
      } catch (error) {
        if (exec.signal.aborted) throw error
        return toolValue({ processExited: false, projectDirectory: cwd ?? null, agent: config.cli, output: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
}
