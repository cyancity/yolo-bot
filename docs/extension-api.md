# 核心扩展 API

核心安装下述运行时服务、HTTP 处理器与 UI 插座。公开子入口只导出类型；扩展通过宿主依赖注入消费服务，不导入核心内部实现。

## 公开入口与依赖边界

| 消费位置 | 类型入口 | 包内声明文件 |
|---|---|---|
| host 插件 | `@cyancity/yolo-bot/extension` | `lib/extension.d.mts` |
| client 插件 | `@cyancity/yolo-bot-ui/extension` | `lib/extension.d.ts` |

两个子入口都只有 `exports.types`，没有运行时导出。必须 `import type`；声明会合并 Cordis `Context` 和客户端 `SlotMap`。构建分别从 `workbench-host/src/extension.ts`、`workbench-ui/src/extension.ts` 生成，不依赖源码深导入。host 声明只引用 Node HTTP 和 Cordis；UI 声明只引用 React 类型、Cordis 和官方 slots，不导入核心 host、React 实例或内部业务对象。

```ts
import type { WorkbenchHost, TemplateProvider } from '@cyancity/yolo-bot/extension'
import type { WorkbenchUi, WorkbenchPageProps } from '@cyancity/yolo-bot-ui/extension'
```

运行时按 Cordis 依赖注入取得服务：host 为 `workbenchHost`、`workbenchTemplates`、`workbenchSkills`、`workbenchInfo`；client 为 `workbenchUi`。扩展必须声明所需服务并等待其挂载。client 继续使用 `dsh.client` / ModuleLoader；类型子入口不加入浏览器 runtime inject 列表。

所有注册 id 全局唯一，由扩展命名空间限定，例如 `vendor.package.page`。重复 id 必须拒绝，不替换别的扩展。同步注册失败不留部分效果。`ExtensionDisposer = () => void` 幂等，只撤销自己的注册，不删除用户数据；用 `ctx.effect` 归属到扩展 fiber。异步排空由维护门负责，不把异步清理塞进同步 disposer。

## UI 插座、页面与导航

| 插座 | kind / scope | owner props | 位置与用途 |
|---|---|---|---|
| `workbench.pages` | keyed / root | `WorkbenchPageProps` | 当前扩展页正文 |
| `workbench.previews` | keyed / root | `WorkbenchPreviewProps` | 对话或工具结果里的扩展预览 |
| `workbench.navigation` | list / root | `WorkbenchChromeProps` | 核心统一导航容器，沿用 label/order 和选中态 |
| `workbench.notice` | list / root | `WorkbenchChromeProps` | 根提示条，不接管正文滚动 |
| `workbench.overlay` | list / root | `WorkbenchChromeProps` | 扩展对话框或 gate；核心不解释 gate 策略 |
| `workbench.settings` | list / root | `WorkbenchChromeProps` | 工作台设置内部 section |
| `workbench.context` | single / root | `WorkbenchChromeProps` | 导航顶部的可选上下文选择器；裸核心没有占用者 |

`context` 是可选的导航上下文插座。顶级设置 tab 继续使用 `settings.section`；扩展页自有的嵌套插座由扩展自己声明，不添加到核心枚举。

```ts
interface ExtensionLocation {
  readonly route: string
  readonly params?: Readonly<Record<string, string>>
}
interface WorkbenchChromeProps {
  readonly activePageId: string | null
  navigate(id: string, location?: ExtensionLocation): void
  openWorkbench(): void
}
interface WorkbenchPageProps extends WorkbenchChromeProps {
  readonly location: ExtensionLocation
}
interface WorkbenchPageRegistration {
  readonly id: string
  readonly label: string | (() => string)
  readonly order?: number
  readonly icon?: ComponentType
  readonly sidebar?: 'default' | 'hidden'
  readonly component: ComponentType<WorkbenchPageProps>
}
interface WorkbenchPreview {
  readonly id: string
  readonly data: unknown
}
interface WorkbenchPreviewProps extends WorkbenchChromeProps {
  readonly data: unknown
}
interface WorkbenchPreviewRegistration {
  readonly id: string
  readonly component: ComponentType<WorkbenchPreviewProps>
}
interface WorkbenchPreviewOutletProps {
  readonly preview: WorkbenchPreview
  readonly fallback?: ReactNode
}
interface WorkbenchUi {
  registerPage(page: WorkbenchPageRegistration): ExtensionDisposer
  registerPreview(preview: WorkbenchPreviewRegistration): ExtensionDisposer
  navigate(id: string, location?: ExtensionLocation): void
  openWorkbench(): void
  readonly preferences: WorkbenchPreferences
  readonly components: {
    readonly PageShell: ComponentType<WorkbenchPageShellProps>
    readonly Dialog: ComponentType<WorkbenchDialogProps>
    readonly Preview: ComponentType<WorkbenchPreviewOutletProps>
  }
}
```

页面助手在同一个 lifecycle 内原子注册 keyed 内容和导航。排序为 order 升序，同值按 id；缺省 order 为 0。普通扩展用助手，不单独注册这两项。notice/overlay/settings/context 直接使用 `ctx.slots.inject` 与 `ctx.slots.register`，采用官方注册生命周期。组件注入的数据由扩展持有，不透传核心 Store、Runtime、Face 或会话数据源。

核心导航状态用 `{ kind: 'extension', id, location }`。省略 location 时使用 `{ route: '' }`，扩展自己解释 route/params；核心不增加业务 view。卸载当前页、导航未知 id 均回核心首页，`activePageId` 为 null；卸载非当前页不改选择。导航不自动打开面板，跨表面跳转先调用 `openWorkbench()`。关闭扩展 UI 不卸载 host、不停止员工。

页面的 `sidebar` 缺省为 `default`。`hidden` 在当前工作台面板激活时只保留窄导航 Rail，核心不挂载频道、私信与员工列表列。退出页面或卸载后恢复宿主原来的宽度和展开状态，不修改侧栏偏好；窄屏也保留 Rail。点击频道导航会返回之前打开的频道或私信。扩展通过注册表达页面布局，不自行定位或隐藏核心侧栏 DOM。当前钉版宿主没有临时侧栏布局 API，核心适配器只在当前页生效，保留宿主后两列与其更新，并在退出时释放布局覆盖。

### 对话与工具结果中的扩展预览

扩展通过 `registerPreview` 注册命名空间限定的 id，重复 id 同步失败。其 `component` 只接收扩展持有的 `data` 和通用导航能力，不接收核心会话或 Store。注册者负责校验未知数据、加载最新资源、操作权限和错误状态。撤销注册不会改动消息或扩展资源；既有消息回退到原文字或工具输出。直接注册 `workbench.previews` 时遵循同样的唯一 id 约定；普通扩展优先使用助手。

消息或工具 JSON 结果可以携带下面的公开信封。`data` 必须可序列化，由扩展定义。核心不解释其中的资源类型、状态或操作。

```ts
{
  extensionPreview: {
    id: 'vendor.package.resource-preview',
    data: { resourceId: 'resource-123' },
  },
}
```

工作台消息与工具渲染器从信封取得预览。找不到渲染器或扩展已经卸载时保留原输出，不留空卡。扩展自己的主页面子树也可使用 `workbenchUi.components.Preview`，参数为 `{ preview: WorkbenchPreview, fallback?: ReactNode }`；该组件复用工作台页面授权的插槽渲染上下文，React portal 中仍可用。工作台之外没有此上下文时使用 fallback。

```tsx
ctx.workbenchUi.registerPage({
  id: 'vendor.package.resources', label: '资源', sidebar: 'hidden', component: ResourcePage,
})
ctx.workbenchUi.registerPreview({
  id: 'vendor.package.resource-preview',
  component: ({ data, openWorkbench, navigate }) => {
    const resource = parseResource(data)
    return <ResourcePreview resource={resource} onOpen={() => {
      openWorkbench()
      navigate('vendor.package.resources', { route: 'resource', params: { id: resource.id } })
    }} />
  },
})
```

预览可以提供简短操作和打开完整页的入口。操作由扩展自己的 HTTP 与生命周期负责；核心只提供渲染、注册撤销和导航，不安装业务处理器。

`components` 复用核心组件和设计 token，不另带 React 或跨包导入 CSS。公开属性沿用既有形状：PageShell 的 `maxWidth?`、`header?`、`subnav?`、`banner?`、`children?`；Dialog 的 `title`、`closeLabel`、`onClose`、`children`、`busy?`、`fullScreen?`。组件只在其提供者存活期间使用，扩展卸载时释放组件持有的订阅和资源。

## HTTP 前门与数据根

```ts
interface WorkbenchHost {
  readonly root: string
  readonly http: WorkbenchHttp
  registerRoute(route: WorkbenchRoute): ExtensionDisposer
  registerEmployeeScopeContribution(value: EmployeeScopeContribution): ExtensionDisposer
}
interface WorkbenchRoute {
  readonly id: string
  readonly prefix: string
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>
}
interface WorkbenchHttp {
  readonly admit: AdmitFn
  readJson(request: IncomingMessage): Promise<unknown>
  sendJson(response: ServerResponse, status: number, body: unknown): void
  sendError(response: ServerResponse, status: number, error: HttpError): void
  serveFile(request: IncomingMessage, response: ServerResponse,
    path: string, name: string, contentType: string): Promise<void>
}
```

`root` 是核心一次解析的 `Config.root`，默认 `<DSH_HOME>/workbench`。只读指根的选择权，不表示扩展不能在自己的既有子目录写入；不是公开核心 Store，也不是新的数据根。扩展只管理自己的子树，不迁移存量数据路径。

`prefix` 相对 `/wb/api`，以 `/` 开头，不允许 `/`、尾斜线、空段、`.`、`..`、编码分隔符、query/hash。匹配完整路径段，按最长前缀分派；`/tools` 不匹配 `/toolset`。重复 prefix（包括核心已注册的 prefix）拒绝，但可注册更长子前缀。核心 bot 路由和扩展路由使用同一 dispatcher。没有匹配返回 404，不生成空结果冒充扩展能力。

核心在分派前做一次 connection/local admission。扩展的业务 admission 自己包装 handler，不再次消费 body；请求保留原 URL 和流。`AdmitFn = (request: IncomingMessage) => Admission`，`Admission` 有 `peer?: unknown`、`rejection?: 401 | 403`。独立前缀使用相同 `http.admit`，显式在自己的 handler 开头处理 rejection。

`readJson` 只用于 JSON 端点，沿用 256 KiB 上限；streaming upload/download 不提前读取。`sendJson` 原样发送传入的 body，成功 envelope 保持 `{ ok: true, data }`；`sendError` 发送 `{ ok: false, error: { code, message } }`。handler 在 headersSent 前失败由 dispatcher 返回通用 internal/500；业务错误由扩展映射原状态和 code；headersSent 后失败 destroy，不再写 JSON。

`serveFile` 支持 HEAD、单 Range/206、非法 Range/416、缺文件/404，不负责路径授权。contentType 显式传入，不能反向 import 扩展。扩展在调用前验证 canonical 路径和允许根。

撤销 route 后新请求不再进入；已经分派的请求保留原 handler，直到完成。卸载 handler 依赖前先获得统一维护门，排空在途请求和写入；核心不强行中止上传或删除落盘数据。

## 员工 scope 贡献

```ts
interface EmployeeScopeView {
  readonly kind: 'leader' | 'child' | 'direct' | 'dm'
  readonly employeeId: string
}
interface EmployeeScopeContribution {
  readonly id: string
  readonly deniedTools?: readonly string[]
  systemPrompt?(view: EmployeeScopeView): string
}
```

通过 `workbenchHost.registerEmployeeScopeContribution` 注册。只作用于核心管理的员工 composition，覆盖负责人、派工子员工、直达员工和 DM；不改用户原生会话或全局工具 registry。deny 集合取并集，不能恢复核心已禁止的工具；prompt 按 id 排序追加，空字符串不追加。callback 是同步纯函数，不修改 employee 数据。
核心在 root/direct/DM 的原生 setup 中安装，在 host 的 awaited `agent/created` 公告中识别已持久化的 child 映射并安装；原生 child 是 sibling scope，不能依赖父 scope 的事件监听来补配置。工具 schema 与执行 guard 都按当前员工的同一 turn 快照约束。

注册/撤销后空闲 scope 重组，在途 turn 保留原快照并先排空，下一 turn 使用新贡献。卸载前排空依赖扩展的 turn，不能留下指向已卸载工具的 prompt。该接口不安装工具、不授予权限，不替代独立的执行路径策略。

## 模板 provider

```ts
interface TemplateProvider {
  readonly id: string
  list(): Promise<readonly TemplateListing[]>
  setEnabled(id: string, enabled: boolean): Promise<void>
}
interface TemplateListing extends TemplateContribution { readonly enabled: boolean }
interface WorkbenchTemplates {
  registerProvider(provider: TemplateProvider): ExtensionDisposer
  list(): Promise<readonly TemplateListing[]>
  setEnabled(id: string, enabled: boolean): Promise<void>
  apply(id: string): Promise<readonly string[]>
}
```

`TemplateContribution` 包含 `id/label/description/skills/employees` 与可选 `mcpServers/notes`；不含绝对可写路径。`EmployeeSeed` 沿用 `name/title/persona/skills`、可选 `model/isLeader/avatarColor`。`McpSeed` 沿用 `serverName/label/transport` 和连接配置；env/headers 只能是 literal 或 credential reference，不存实际密钥。MCP 建议不自动安装。

provider 是 enabled 状态的唯一持久化 owner，list 必须报告真实状态。setEnabled 完成持久化并使官方 skill provider invalidate 后才 resolve；失败向调用方传播，不报告成功。`registerProvider` 同步拒绝重复 provider id。模板 id 由异步 provider.list 发现，因此不在同步注册时检查；核心在 list/setEnabled/apply 构建完整目录时拒绝跨 provider 的重复模板 id，且在任何修改前失败，不选择胜者、不自动删除注册。异步 list 返回后会过滤已卸载 provider 的条目，不让元数据复活。未知模板 id 或 provider 卸载后返回 not_found。

实际技能加载继续走官方 `skills.registerProvider`，同名合并和 bundled rank 600 都由官方处理；项目/用户技能可以覆盖同名 bundled 技能。不要另造 skill registry。provider 用自己的 package anchor 定位资源，承担打包/profile/asar 解析。

`apply` 使用核心既有同名跳过事务，仅返回新建员工 id，不重复 seed，不覆盖老员工。停用/卸载模板同步撤销对应 skill provider，不删除员工或用户同名技能；员工 binding 名保留，来源重新挂载后可恢复。扩展把模板和官方技能 provider 放同一 fiber 中；提供者下线前先排空正在读资源的 turn。

既有 HTTP 的 `/wb/api/workforce/templates` GET、`/:id` PATCH、`/:id/apply` POST 继续由核心框架承担。POST apply 保持原 envelope，返回 `created` / `skipped` 员工名称数组；host 服务的 `apply` 只返回新建员工 id，不缩窄既有 HTTP 响应。持久化 enabled 集合的迁移由内容提供者完成，不由类型入口自动迁移。

## 用户技能 CRUD 与刷新

```ts
interface WorkbenchSkills {
  userRoot(): string
  list(): Promise<readonly UserSkill[]>
  read(name: string): Promise<UserSkillContent>
  create(name: string, input: UserSkillInput): Promise<UserSkillContent>
  update(name: string, input: UserSkillInput): Promise<UserSkillContent>
  remove(name: string): Promise<void>
  changed(names: readonly string[]): Promise<void>
}
```

`UserSkill` 为 `name/description/origin: string`；`UserSkillContent` 增加完整 `content`；`UserSkillInput` 为完整 SKILL.md `content` 和可选 origin。origin 是开放来源标识，不授予目录权限；update 省略时保留来源，create 省略时为 `user`。name 与 frontmatter name 必须相同；update 不承担重命名。

HTTP 与 host 服务共用实现，核心新增协议为：

| `/wb/api/workforce/user-skills` 下的操作 | 输入 | 成功 data |
|---|---|---|
| GET 根路径 | 无 | `{ skills: UserSkill[] }` |
| GET `/:name/content` | 无 | `UserSkillContent` |
| POST 根路径 | `{ name, content, origin? }` | `UserSkillContent` |
| PUT `/:name` | `{ content, origin? }` | `UserSkillContent` |
| DELETE `/:name` | 无 | `{ deleted: true }` |

name 是单个目录名，拒绝遍历和分隔符；操作限定 user root，canonical 检查拒绝越界 symlink/junction。create 撞名报 conflict，read/update/delete 不存在报 not_found；密钥、私有路径、空内容等阻断扫描复用核心规则。用户与 bundled/project 同名时只改 user 来源。

`remove` 将技能目录归档到 `<root>/workforce/skills-removed`，再原子解绑员工并刷新目录/hash；技能从活动用户目录与目录列表移除，归档内容保留，不是永久数据删除。失败恢复原活动路径和绑定；跨设备移动（EXDEV）等归档失败不修改员工状态。下载器写自己选定的用户技能目录，承担相同安全检查，完整安装后 await changed；changed 只刷新，不写文件、不绑定员工、不把不安全安装变成合法安装。新下载器优先调用 create/update，含 references/assets 的安装才直接写目录。

服务卸载不删除技能或安装记录。扩展持有的路径不是绕过维护门的能力，所有安装、CRUD 和下载写入都计入自身 participant。

## 运行版本、busy 与维护门

```ts
type MaintenanceResult =
  | { readonly ok: false; readonly reason: 'busy' }
  | { readonly ok: true; release(): void }
interface MaintenanceParticipant {
  readonly id: string
  idle(): Promise<boolean>
  enterMaintenance(): Promise<MaintenanceResult>
}
interface WorkbenchInfo {
  readonly apiVersion: 1
  readonly version: string
  idle(): Promise<boolean>
  enterMaintenance(): Promise<MaintenanceResult>
  registerParticipant(participant: MaintenanceParticipant): ExtensionDisposer
}
```

`version` 与 `/wb/api/health` 的 `data.version` 来自正在运行的 host 包；不是壳版本或安装完成但尚未激活的版本。health 保留原 `data.name` / `data.version`，新增 `data.apiVersion: 1`。

`idle()` 只观察核心与全部 participant 的 conjunction，不获得门。负责人派工、线程追问、DM、@、定时入口、审批、工具、在途 HTTP 写入、启动恢复都计入 busy；恢复尚未完成不能报 idle。participant 真实观察自己的作业，不由核心猜测外部私有状态。

`enterMaintenance()` 原子关闭核心新入口，再按 participant id 顺序获得各门；只成功于所有入口已关闭且在途已归静。任一 busy 返回 `{ ok: false, reason: 'busy' }`，逆序释放已取得的门，恢复核心入口；callback 异常同样回滚后 reject。已持门时二次获取返回 busy，不能复入。成功时所有注册/卸载和新任务入口冻结；release 幂等，逆序释放 participant 后恢复核心入口。调用方必须用 finally 释放，不能用 idle 结果替代持门安装。

participant 的 busy 消失不代表安全下线。disposer 只能在统一维护门持有期间调用，否则抛出冲突并保留注册；取得门的 participant 引用保留到 release。扩展先在门内撤销路由、scope 和 provider，再停止依赖，最后释放门；运行时意外丢失 participant 按 busy 处理，不能静默视为空闲。核心备份函数内部消费同一维护门，HTTP 路由不重复获取，因此扩展写入不会漏过备份屏障。

更新 feed、通道、签名、desktop IPC、发布组合和恢复策略归扩展/发行层。核心不定义 UpdateStatus，不绑定 pluginManager；消费者使用官方安装能力并处理其 applied/restart-required 状态。

## 通用偏好

```ts
type PreferenceValue = null | boolean | number | string
  | readonly PreferenceValue[]
  | { readonly [key: string]: PreferenceValue }
type PreferenceFields = Readonly<Record<string, PreferenceValue>>
interface WorkbenchPreferences {
  getSnapshot(): PreferenceFields
  subscribe(listener: () => void): ExtensionDisposer
  patch(fields: PreferenceFields): Promise<void>
}
```

通过 `workbenchUi.preferences` 访问，继续持久化在 `workbench.prefs.v1`。核心解释自己的通用字段，扩展解释自己的字段；新字段用命名空间，既有字段保持原名。只接受 JSON 值和有限数值，拒绝特殊原型键；null 为显式值，无删除 API。

patch 串行浅合并，保留未识别字段；嵌套对象按整个字段替换。Promise 在持久化完成后 resolve；写失败 reject，旧快照不变。快照不可变，变更后订阅通知；取消订阅幂等。扩展卸载不清偏好，不允许独立 whole-object writer 覆盖其他插件字段。独立 draft 的原 key 由其 owner 管理，不纳入此容器。

## 验证与兼容边界

类型编译、声明打包与运行时行为必须分别验证。验证覆盖：注册/卸载无死页、完整段最长前缀分派、scope 重组不越权、模板停用不删用户技能、CRUD 拒绝越界、维护门阻止新增工作并回滚失败获取、偏好并发浅合并不丢字段。

保留运行时 `workbench` / `ui-workbench`、`Config.root`、`<DSH_HOME>/workbench`、`/wb/api`、`/wb/api/workforce` 和原偏好 key。扩展启停不重写存量 id、数据 schema 或会话关系；核心没有未安装扩展的替代处理器或兼容转发入口。
