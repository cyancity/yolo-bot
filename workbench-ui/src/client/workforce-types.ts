/**
 * 数字员工（workforce）客户端数据模型 — 与 workbench-host/src/workforce/
 * types.ts 对齐（不跨包 import，手工同步）。会话真源是 thread：频道是共享房间，
 * task 是一次派工，dm 是与单个员工的 1:1。
 */
import type { QuestionCardApproval, QuestionCardQuestion } from './workforce-question-card.tsx'

export type EmployeeRole = 'leader' | 'analyst' | 'writer' | 'custom'

/** 一名数字员工。 */
export interface Employee {
  readonly id: string
  readonly name: string
  /** 职务头衔，如「负责人」「分析员」。 */
  readonly title: string
  readonly role?: EmployeeRole
  /** 人设/职责说明（作为系统提示段落）。 */
  readonly persona: string
  /** 偏好 skill 清单（非隔离保证）。 */
  readonly skills: readonly string[]
  /** 可选模型覆盖。 */
  readonly model?: string
  /** 启用的 MCP 服务器 id；缺省 = 全部已启用服务器，[] = 不启用。 */
  readonly mcpServers?: readonly string[]
  readonly isLeader: boolean
  readonly avatarColor?: string | undefined
  readonly createdAt?: string
  readonly updatedAt?: string
}

export type EmployeeInput = {
  readonly name: string
  readonly title: string
  readonly persona: string
  readonly skills?: readonly string[]
  readonly model?: string
  /** 服务器 id 列表限定可用集合；null 恢复「全部已启用服务器」。 */
  readonly mcpServers?: readonly string[] | null
  readonly isLeader?: boolean
  readonly avatarColor?: string | undefined
}

/** GET /workforce/skills 返回的可调用 skill 摘要（对齐 dsh SkillSummary）。 */
export interface SkillSummary {
  readonly name: string
  readonly description: string
  readonly provider?: string
  readonly source?: string
  readonly invocation?: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
}

/** 沉淀技能草稿（与宿主 WorkforceSkillDraft 同构）。 */
export interface WorkforceSkillDraft {
  readonly id: string
  readonly taskId: string
  readonly slug: string
  readonly title: string
  readonly description: string
  readonly body: string
  readonly status: 'requested' | 'drafted' | 'returned' | 'installed'
  readonly note?: string
  readonly findings: readonly WorkforceSkillFinding[]
  readonly editedBy?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly installedAt?: string
}

export interface WorkforceSkillFinding {
  readonly level: 'block' | 'warn'
  readonly message: string
  readonly excerpt?: string
}

/** 用户 skill 根下的技能；origin=workflow 为本功能安装。 */
export interface WorkforceUserSkill {
  readonly name: string
  readonly description: string
  readonly origin: 'workflow' | 'user'
}

/** MCP env/header 值：明文字符串或凭据引用；绝不存密钥本体。 */
export type McpServerValue =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'credential'; readonly ref: string }

/** 一台用户配置的 MCP 服务器。 */
export interface McpServer {
  readonly id: string
  readonly serverName: string
  readonly label: string
  readonly transport: 'stdio' | 'streamable-http'
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly url?: string
  readonly env?: Readonly<Record<string, McpServerValue>>
  readonly headers?: Readonly<Record<string, McpServerValue>>
  readonly enabled: boolean
  readonly status?: {
    readonly credentials: readonly { readonly key: string; readonly ref: string; readonly configured: boolean }[]
    readonly errors: readonly string[]
    readonly available: boolean
  }
}

export type McpServerInput = Omit<McpServer, 'id' | 'status' | 'enabled' | 'createdAt' | 'updatedAt'> & { readonly enabled?: boolean }

/** 行业模板：随包的 skill 组 + 员工种子。 */
export interface WorkforceTemplate {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly skills: readonly string[]
  readonly employees: readonly {
    readonly name: string
    readonly title: string
    readonly persona: string
    readonly skills: readonly string[]
    readonly model?: string
    readonly isLeader?: boolean
    readonly avatarColor?: string
  }[]
  readonly mcpServers?: readonly McpServerInput[]
  readonly notes?: string
  readonly enabled: boolean
}

export interface Channel {
  readonly id: string
  readonly name: string
  readonly createdAt?: string
}

/** 宿主线程投影的真实用量：未缓存输入与输出 token，不含全部计费项；取不到时缺省，不补零。 */
export interface WorkforceUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number | undefined
  readonly cacheWriteTokens?: number | undefined
}

export type ThreadKind = 'channel' | 'task' | 'dm'
export type ThreadStatus = 'idle' | 'running' | 'error' | 'cancelled' | 'interrupted'

export interface Thread {
  readonly id: string
  readonly kind: ThreadKind
  /** kind === 'task' 时存在。 */
  readonly taskId?: string
  /** kind === 'dm' 时存在。 */
  readonly employeeId?: string
  /** kind === 'task' | 'channel' 时存在。 */
  readonly channelId?: string
  readonly title: string
  readonly status: ThreadStatus
  readonly createdAt?: string
  readonly updatedAt: string
  /** 线程内最近一条真实正文消息的落点时间；纯状态更新不影响，无正文缺省。 */
  readonly lastMessageAt?: string | undefined
  /** 根、子员工、直达与归档会话的真实用量合计；宿主取不到时缺省。 */
  readonly usage?: WorkforceUsage | undefined
}

/** 联网搜索披露的一个真实来源；只放真实解析到的字段，不造假。 */
export interface SearchSource {
  readonly title: string
  readonly url: string
  readonly snippet?: string | undefined
}

/** 消息里的一次工具/skill 执行（可折叠展示）。 */
export interface MessageTool {
  readonly name: string
  readonly status: 'running' | 'done' | 'error'
  /** web_search 专属：查询词，来自 tool/call 参数。 */
  readonly searchQuery?: string | undefined
  /** web_search 专属：真实来源列表，来自 tool/result 解析；缺省不渲染来源。 */
  readonly searchSources?: readonly SearchSource[] | undefined
}

export type MessageRole = 'user' | 'agent' | 'system'

export interface WorkforceMessage {
  /** Registered extension preview emitted by a trusted host/tool integration. */
  readonly extensionPreview?: { readonly id: string; readonly data: unknown } | undefined
  readonly id: string
  readonly threadId: string
  readonly ts: string
  readonly role: MessageRole
  readonly senderId: string
  readonly senderName: string
  readonly text: string
  readonly running?: boolean
  /** 原生回复的 session/turn/step 标识，流式草稿与落盘正文共用。 */
  readonly streamKey?: string
  readonly error?: string
  /** 模型/凭据类失败带上游 code（MISSING_CREDENTIAL、INVALID_CREDENTIAL、QUOTA、RATE_LIMIT、UNKNOWN_MODEL、ACCOUNT_*、UNKNOWN_PROVIDER），UI 据此渲染「添加 key / 登录」入口。 */
  readonly errorCode?: string
  readonly tool?: MessageTool
  readonly taskId?: string
  /** 所属原生 turn；同一 turn 的工具步骤折叠成一行。 */
  readonly turnId?: string
  /** 同 turn 内后面还有工具调用的过程性文字，默认隐藏，展示步骤时才出现。 */
  readonly intermediate?: boolean
  /** 非聊天内容的提示行（如「已中断 · 回复可继续」）：UI 居中纯文本渲染，不挂状态不占消息流。 */
  readonly tip?: boolean
  /** 本行真实带出的文件（原生 present / 成果投影），只含真实存在的文件，不凭模型文字造。 */
  readonly attachments?: readonly WorkforceFile[] | undefined
  /** 人类消息后的第一条员工回复：指向被回复的人类消息 id，UI 渲染「@你」+ 引用。 */
  readonly replyTo?: string
  /** 人类消息上的表情回应（由原生事件推导）：👀 已看到并开始处理，✅ 已处理完。 */
  readonly reactions?: readonly MessageReaction[]
  /** 员工向用户提问（原生 ask-user），渲染为可作答卡片。 */
  readonly question?: QuestionCardQuestion
  /** 员工的工具调用等待用户审批，渲染为「允许一次 / 拒绝」卡片。 */
  readonly approval?: QuestionCardApproval
  /** 浏览器本地投递元数据，不属于宿主消息契约。clientId 保持确认前后的 React key。 */
  readonly clientId?: string | undefined
  readonly delivery?: 'sending' | 'waiting' | 'failed' | undefined
  readonly deliveryError?: string | undefined
  /** 指派员工列表：多 @ 一次发送可含多名员工，各自挂等待状态与 👀/✅。 */
  readonly recipientIds?: readonly string[] | undefined
  /** 模型上报的本轮 token 用量与缓存指标。 */
  readonly usage?: WorkforceUsage | undefined
}

/** 线程产生的一个真实文件（与宿主 WorkforceFile 同构）。行只来真实来源：presented=原生 present 事件；tool=原生文件工具真实写盘且文件存在；deliverable=工作台成果版本。url=可安全服务的字节路由；locationUrl=reveal 路由；两者缺省均表示不提供，不造假链。 */
export interface WorkforceFile {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly url?: string | undefined
  readonly locationUrl?: string | undefined
  readonly mime: string
  readonly sizeBytes?: number | undefined
  readonly createdAt: string
  readonly employeeId: string
  readonly sessionId?: string | undefined
  readonly eventSeq?: number | undefined
  readonly version?: number | undefined
  readonly source: 'presented' | 'tool' | 'deliverable'
}

export interface MessageReaction {
  readonly emoji: '👀' | '✅'
  readonly employeeId: string
}

/** 线程内某员工的实时状态，驱动「正在输入…」与头像眼睛动作。 */
export interface WorkforceActivity {
  readonly employeeId: string
  readonly state: 'thinking' | 'tool' | 'typing'
  readonly tool?: string
}

/** 当前线程使用的原生会话；子员工按其负责人地址订阅。 */
export interface WorkforceSession {
  readonly sessionId: string
  readonly employeeId: string
  readonly parentSessionId?: string
}

/** 一次消息页增量：list 是已合并去重的全量（首拉+since 累积）。 */
export interface ThreadMessages {
  readonly list: readonly WorkforceMessage[]
  readonly cursor: string | undefined
  readonly status: ThreadStatus
  readonly error?: string
  readonly hasMore?: boolean | undefined
  readonly loadingEarlier?: boolean | undefined
  readonly earlierError?: string | undefined
  /** 当前正在工作的员工；空数组表示无人在忙。 */
  readonly activity?: readonly WorkforceActivity[]
  /** 最近一次消息页带回的线程用量；加载更早、重试不应清掉已知值。 */
  readonly usage?: WorkforceUsage | undefined
  /** 本 thread 全部会话的真实文件历史（原生 present 事件 + 本任务成果）；只含真实来源，缺失字段不补造。 */
  readonly files?: readonly WorkforceFile[] | undefined
}

/** 成果的一个不可变版本（与宿主 WorkforceDeliverableVersion 同构）。 */
export interface TaskDeliverableVersion {
  /** 从 1 递增。 */
  readonly version: number
  /** 员工 id；旧数据为 'unknown'。 */
  readonly authorId: string
  readonly sessionId?: string
  readonly createdAt: string
  /** 不含空白的字数。 */
  readonly charCount: number
  readonly sha256: string
}

export interface TaskDeliverable {
  readonly name: string
  /** 指向最终版；未定最终版时指向最新版本。`?v=N` 取指定版本。 */
  readonly url: string
  readonly versions: readonly TaskDeliverableVersion[]
  /** 未定最终版时为空。 */
  readonly publishedVersion?: number
  /** 员工 id 或 'user'。 */
  readonly publishedBy?: string
  readonly publishedAt?: string
}

export interface Task {
  readonly id: string
  /** 来源频道。 */
  readonly channelId: string
  /** 任务自己的会话 thread。 */
  readonly threadId: string
  /** 执行员工。 */
  readonly assigneeId: string
  /** 在频道接下/转派任务的员工（自派时也是负责人）。 */
  readonly delegatorId: string | null
  readonly title: string
  readonly prompt: string
  readonly status: 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
  readonly error?: string
  readonly deliverables: readonly TaskDeliverable[]
  readonly createdAt?: string
  readonly updatedAt?: string
}

/** 发送响应（频道 thread 的发送即建任务：可能返回 task）。 */
export interface SendResult {
  readonly message: WorkforceMessage
  readonly taskId?: string
  readonly thread: Thread
}

/** 一个工作区快照：员工、频道、threads、按 thread 的消息、任务。 */
export interface WorkforceSnapshot {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly employees: readonly Employee[]
  readonly channels: readonly Channel[]
  readonly threads: readonly Thread[]
  readonly messages: Readonly<Record<string, ThreadMessages>>
  readonly tasks: readonly Task[]
  readonly error: string | undefined
}
