/** Digital workforce data model: employees, channels, threads, tasks, materials. */

export type EmployeeRole = 'leader' | 'analyst' | 'writer' | 'custom'

/** A workforce member. `persona` is appended as a system-prompt section; `skills` is a preference list (not an isolation guarantee). */
export interface WorkforceEmployee {
  id: string
  name: string
  title: string
  role: EmployeeRole
  /** Persona text shadowing `deployment:persona-prefix` in the member's own scope. */
  persona: string
  /** Preferred skill names, loaded first; informational, not a permission boundary. */
  skills: string[]
  /** Optional model override resolved per request through the host llm config. */
  model?: string
  toolAccess?: import('./employee-access.ts').EmployeeAccess
  /** Grants wb_generate_image through the shared image provider. */
  imageGeneration?: boolean
  /** Grants native web_search and web_fetch to office employees. */
  webSearch?: boolean
  /** Enabled MCP server ids; undefined means every enabled server, [] means none. */
  mcpServers?: string[]
  isLeader: boolean
  avatarColor?: string
  createdAt: string
  updatedAt: string
}

/** One MCP env/header value: a plain literal or a credential reference, never a stored secret. */
export type WorkforceMcpValue =
  | { kind: 'literal'; value: string }
  | { kind: 'credential'; ref: string }

/** Shared image provider. The API key lives in the host credentials service under keyRef. */
export type WorkforceImageProvider =
  | { kind: 'codex'; model: string }
  | { kind: 'openai'; baseUrl: string; model: string; keyRef: string }
  | { kind: 'command'; command: string; args: string[]; env?: Record<string, string> }

/** A user-configured MCP server definition; only references to credentials are persisted, never secret values. */
export interface WorkforceMcpServer {
  id: string
  /** MCP tool namespace (`mcp__<serverName>__*`), matches dsh's [A-Za-z0-9_-]{1,32} grammar. */
  serverName: string
  label: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  env?: Record<string, WorkforceMcpValue>
  headers?: Record<string, WorkforceMcpValue>
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface WorkforceChannelGroup {
  id: string
  /** 分组显示名；空串合法，UI 回退显示「未命名分组」。 */
  name: string
  /** Ordering among groups; lower sorts first. */
  sort: number
  createdAt: string
}

export interface WorkforceChannel {
  id: string
  name: string
  projectDirectory?: string
  /** 分组（Discord 式）侧栏的显示名覆盖；缺省回落到 name。 */
  groupName?: string
  /** 群聊（微信式）会话列表的标题；缺省回落到成员名串再到 name。 */
  groupChatName?: string
  /** 群聊成员员工 id：群头像拼格与空群名回退用；缺省=全员。 */
  memberIds?: string[]
  /** Owning group; absent means ungrouped (the UI's default section). */
  groupId?: string
  /** Ordering inside the group; lower sorts first. */
  sort: number
  pinned?: boolean
  /** Last time the user marked the channel read; threads updated after it make it unread. */
  readAt?: string
  createdAt: string
}

/** The signed-in user's display profile; the avatar image is stored as a material and referenced by its URL. */
export interface WorkforceProfile {
  name: string
  avatarUrl?: string
}

/** Thread kinds: a channel is the shared room, a task is one delegated job, a dm is 1:1 with one employee. */
export type WorkforceThreadKind = 'channel' | 'task' | 'dm'

/** `interrupted`：宕机/重载修复封口或达到任务时长上限后的可恢复中断，不算失败；回复即继续。 */
export type WorkforceThreadStatus = 'idle' | 'running' | 'error' | 'cancelled' | 'interrupted'

export interface WorkforceThread {
  id: string
  kind: WorkforceThreadKind
  /** Present when kind === 'task'. */
  taskId?: string
  /** Present when kind === 'dm'. */
  employeeId?: string
  /** Present when kind === 'task' or 'channel'. */
  channelId?: string
  title: string
  status: WorkforceThreadStatus
  /** dm threads only: pin/read-mark surfaced on the sidebar private-message item. */
  pinned?: boolean
  readAt?: string
  createdAt: string
  updatedAt: string
  /** 线程内最近一条真实正文消息（用户或员工）的落点时间；无正文缺省。状态/取消/刷新只动 updatedAt 不动它。 */
  lastMessageAt?: string
  /** lastMessageAt 迁移扫过标记：旧 DM 线程只补一次，扫出空正文也置位，避免每轮列表重读会话文件。 */
  lastMessageScanned?: boolean
  /** 仅消息接口投影：汇总原生 assistant/message 中实际报告的用量，不估算。inputTokens 沿用原生未缓存输入口径。 */
  usage?: { inputTokens: number; outputTokens: number }
}

/** `interrupted` 同线程语义：中断可续，与 `failed` 区分展示（「已中断 · 可继续」）。 */
export type WorkforceTaskStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

/** 成果的一个版本：文件写入 `deliverables/<taskId>/<name>/v<N><ext>`；同一轮人类消息内的重复保存会修订覆盖本轮未发布版本，跨轮与已发布版本不改写。 */
export interface WorkforceDeliverableVersion {
  /** 从 1 递增。 */
  version: number
  /** 员工 id；旧数据迁移为 'unknown'。 */
  authorId: string
  sessionId?: string
  createdAt: string
  /** 本版正文最后一次被同轮修订的时间；首轮新建后缺省。 */
  updatedAt?: string
  /** 本版归属的用户消息批次 id；旧数据缺省视为已封版，不可修订。 */
  turnKey?: string
  /** 不含空白的字数。 */
  charCount: number
  sha256: string
}

export interface WorkforceDeliverable {
  name: string
  /** 指向已发布版本；未发布时指向最新版本。 */
  url: string
  versions: WorkforceDeliverableVersion[]
  /** 未发布时为空。 */
  publishedVersion?: number
  /** 员工 id 或 'user'。 */
  publishedBy?: string
  publishedAt?: string
}

export interface WorkforceTask {
  id: string
  /** Channel thread the task came from. */
  channelId: string
  /** The task's own conversation thread. */
  threadId: string
  /** Employee that owns the work (the delegator is a leader; the doer may be any member). */
  assigneeId: string
  /** Employee that accepted/relays the task on the channel (also a leader when it self-assigns). */
  delegatorId: string | null
  title: string
  prompt: string
  status: WorkforceTaskStatus
  error?: string
  /** fail() 按 turnError 同口径识别出的模型错误码（MODEL_ERROR_COPY 键）；非模型类失败不落。投递阶段失败没有会话事件，消息流靠它给合成错误行补修复入口。 */
  errorCode?: string
  deliverables: WorkforceDeliverable[]
  createdAt: string
  updatedAt: string
}

/** A material uploaded for analysis. Content is stored as a real file; employees read it by id via wb_read_material. */
export interface WorkforceMaterial {
  id: string
  name: string
  sizeBytes: number
  createdAt: string
}

/**
 * 线程产生的一个真实文件。行只来自真实来源（不凭模型文字造行、不造历史）：
 * `presented` = 原生 present 工具的 `deliverables/presented` 事件（会话日志可回读，含旧会话）；
 * `tool` = 原生文件工具（write/edit/str_replace_editor）真实调用且文件当前存在（cwd 内验证）；
 * `deliverable` = 工作台成果版本（wb_save_deliverable）。同一文件多次事件各成一行，保留真实时间线。
 * `url` 仅在字节可安全服务时给出（安装包类不给字节路由）；`locationUrl` 在文件当前真实存在且通过安全验证时给出（reveal 用），两者缺省都只表示不提供，不造假链。
 */
export interface WorkforceFile {
  /** 稳定身份：presented 为 `p|<sessionId>|<seq>|<index>`；tool 为 `t|<sessionId>|<callId>`；deliverable 为 `d|<taskId>|<name>|<version>`。 */
  id: string
  /** 展示名（路径 basename 或成果名）。 */
  name: string
  /** 真实来源路径：presented/tool 为事件里记录的原始 path（可相对 cwd）；deliverable 为成果名。 */
  path: string
  /** 字节路由；安装包类或不可安全服务时缺省。 */
  url?: string
  /** reveal（在资源管理器中显示）路由；文件当前真实存在且验证通过时给出。 */
  locationUrl?: string
  /** 按真实文件名判定的 MIME；未知为 application/octet-stream，不用模型描述代替。 */
  mime: string
  /** 真实文件大小（字节）；读不到时缺省。 */
  sizeBytes?: number
  /** 来源时间：presented 为事件时间；tool 为调用时间；deliverable 为版本 createdAt。 */
  createdAt: string
  /** 产生它的员工 id。 */
  employeeId: string
  /** 原生会话 id（presented/tool）。 */
  sessionId?: string
  /** 来源事件在会话日志中的 seq（presented），用于真实时间线排序。 */
  eventSeq?: number
  /** 成果真实版本号（deliverable）。 */
  version?: number
  /** 真实来源类别。 */
  source: 'presented' | 'tool' | 'deliverable'
}

/** 联网搜索披露的一个真实来源；只放解析到的字段。 */
export interface SearchSource {
  title: string
  url: string
  snippet?: string
}

/** 消息里的一次工具执行。searchQuery / searchSources 仅 web_search 投影填写。 */
export interface WorkforceTool {
  name: string
  status: 'running' | 'done' | 'error'
  /** 查询词，来自 tool/call 参数。 */
  searchQuery?: string
  /** 真实来源列表，来自 tool/result 的 meta.sources；缺省不渲染来源。 */
  searchSources?: SearchSource[]
}

/** One simplified timeline row rendered by the UI; derived from native session events, which stay the source of truth. */
export interface WorkforceMessage {
  id: string
  threadId: string
  ts: string
  role: 'user' | 'agent' | 'system'
  senderId: string
  senderName: string
  text: string
  running?: boolean
  /** 原生回复的 session/turn/step 标识，流式草稿与落盘正文共用。 */
  streamKey?: string
  error?: string
  /** Model/credential failures carry the upstream code (MISSING_CREDENTIAL, INVALID_CREDENTIAL, QUOTA, RATE_LIMIT, UNKNOWN_MODEL, ACCOUNT_*, UNKNOWN_PROVIDER); UI renders the add-key / sign-in action from it. */
  errorCode?: string
  /** web_search 专属字段只在该工具上出现；缺省表示没有搜索披露。 */
  tool?: WorkforceTool
  taskId?: string
  /** Native turn this row belongs to (`<sessionId>:<turn/start seq>`); groups tool steps into one collapsible line. */
  turnId?: string
  /** 本行真实带出的文件（同线程/同任务文件历史的消息侧投影）：只含可安全服务的真实文件，见 WorkforceFile。 */
  attachments?: WorkforceFile[]
  /** Agent text followed by tool calls in the same turn (narration, not the final reply). Hidden unless steps are shown. */
  intermediate?: boolean
  /** Non-chat hint row (e.g. interrupted-resumable): UI renders it as centered plain text without state. */
  tip?: boolean
  /** On the first agent reply after a human message: the human message id it answers (UI renders "@你" + quote). */
  replyTo?: string
  /** On human messages, derived from native events (never written to logs): 👀 when the receiver's turn starts, ✅ when it settles. */
  reactions?: { emoji: '👀' | '✅'; employeeId: string }[]
  /** Employee asked the user a question through the native ask-user tool; the row carries an answerable card. */
  question?: WorkforceQuestion
  /** Employee's tool call awaits the user's approval; the row carries an allow/reject card. */
  approval?: WorkforceApproval
}

/** One selectable option of a question, mirroring the native ask-user option. */
export interface WorkforceQuestionOption {
  label: string
  description?: string
}

/** One question inside an ask card, mirroring the native ask-user item. */
export interface WorkforceQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: WorkforceQuestionOption[]
  multiSelect?: boolean
}

/** One submitted answer item, mirroring the native ask-user answer item. */
export interface WorkforceQuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/**
 * Answerable question card on a WorkforceMessage. `answered` present means
 * read-only. `requestId` is the answer-route key: the in-memory request while
 * the native waterfall is held, or `cont-<callId>` for a timed question that
 * outlived its foreground wait and is answered through `userQuestions.answer`.
 */
export interface WorkforceQuestion {
  requestId: string
  callId?: string
  /** Timed question whose foreground wait ended; still answerable via late reply. */
  continued?: boolean
  items: WorkforceQuestionItem[]
  answered?: WorkforceQuestionAnswerItem[]
  /**
   * 请求生命周期（UI 仅 status==='inactive' 冻结交互，不能按 thread.running 判断卡是否可答）：
   * active=前台等待；continued=超时转续答仍有效；answered=已答只读；inactive=已被显式停止（用户 stop/run-limit 取消）不再接受提交。
   */
  status?: 'active' | 'continued' | 'answered' | 'inactive'
}

/** Answerable approval card; `answered` present means read-only. */
export interface WorkforceApproval {
  requestId: string
  toolName: string
  callId?: string
  reason?: string
  /** 原生权限说明（displayReason），缺省时只显示 reason。 */
  displayReason?: string
  /** 同 session 同 callId 的真实调用参数摘要，已脱敏、限长；取不到时缺省，不用模型理由代替。 */
  detail?: { text: string; truncated: boolean }
  answered?: 'allowed-once' | 'rejected'
  /** 同 WorkforceQuestion.status 的四态生命周期。 */
  status?: 'active' | 'continued' | 'answered' | 'inactive'
}

/** Live per-employee state of one thread; drives the typing indicator and avatar eye motion. */
export interface WorkforceActivity {
  employeeId: string
  state: 'thinking' | 'tool' | 'typing'
  /** Tool name when state === 'tool'. */
  tool?: string
}

/**
 * 长期记忆的作用域：global 用户偏好；channel 频道品牌、项目事实与规则（scopeId=channelId）；
 * employee 对某个员工的交代（scopeId=employeeId）。任务内上下文仍由会话本身承担。
 */
export type WorkforceMemoryScope = 'global' | 'channel' | 'employee'

/**
 * 一条长期记忆。会话创建时按「全局 + 本频道 + 本员工」渲染进 system 段并冻结，
 * 改动从下一个会话生效。容量上限（按字数，不含空白）：global 1000、每频道 2000、每员工 500。
 */
export interface WorkforceMemory {
  id: string
  scope: WorkforceMemoryScope
  /** channel → channelId；employee → employeeId；global 不填。 */
  scopeId?: string
  text: string
  source: {
    /** 'user' 为用户在界面里手写；否则为写入它的员工 id。 */
    by: string
    threadId?: string
    messageId?: string
  }
  createdAt: string
  updatedAt: string
}

/** 沉淀技能草稿（MVP）。草稿存工作台私有 state，不在任何活跃 skill 根；安装后才写入 $DSH_HOME/skills/<slug>/SKILL.md。 */
export interface WorkforceSkillDraft {
  id: string
  /** 来源任务；用户在该任务上点「沉淀为技能」即视为验收。 */
  taskId: string
  /** 安装目录名与 skill name，固定前缀 user-workflow-，后接 [a-z0-9-]。 */
  slug: string
  title: string
  /** SKILL.md frontmatter description：何时使用。 */
  description: string
  /** SKILL.md 正文（不含 frontmatter）。 */
  body: string
  /** requested 已请求负责人整理；drafted 负责人已提交待用户审核；returned 用户退回待负责人修改；installed 已安装。 */
  status: 'requested' | 'drafted' | 'returned' | 'installed'
  /** 用户退回意见或请求时的补充说明。 */
  note?: string
  /** 每次保存（负责人或用户）后由宿主重新扫描。 */
  findings: WorkforceSkillFinding[]
  /** 最后一次保存者：负责人员工 id 或 'user'。 */
  editedBy?: string
  createdAt: string
  updatedAt: string
  installedAt?: string
}

/** 静态扫描结果：block 时不能安装（密钥、私有绝对路径、空正文或超长）；warn 需用户看过（疑似注入指令、外部发布/付费/登录字样）。 */
export interface WorkforceSkillFinding {
  level: 'block' | 'warn'
  message: string
  excerpt?: string
}

/** state 记录的工作流技能安装信息：slug、来源草稿、安装时间与落盘 SKILL.md 的 sha256。 */
export interface WorkforceInstalledSkill {
  slug: string
  draftId: string
  installedAt: string
  sha256: string
}

/** 用户 skill 根（$DSH_HOME/skills）下的技能，供员工技能选择器与管理列表使用。 */
export interface WorkforceUserSkill {
  name: string
  description: string
  /** workflow：本功能安装（state 有记录）；user：用户自己放进目录的。 */
  origin: 'workflow' | 'user'
}

export class WorkforceError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkforceError'
    this.code = code
  }
}
