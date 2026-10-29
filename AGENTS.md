# AGENTS.md

本仓库是开源 YOLO Bot 核心的唯一开发主线。历史私有核心库停止维护，剩余成果迁入本仓库后归档并清理本地副本。私有工作台通过公开扩展接口提供业务页面，按需更新；独立白标壳目前冻结。核心不包含私有工作台业务。

yolo-bot 是 DeepSeek Harness 的 bot 协作插件。核心包含频道、私信、线程、员工、负责人派工、材料与成果、记忆、工具与技能框架、原生模型接入和通用 UI。

## 包与运行时契约

- `workbench-host` → `@cyancity/yolo-bot`：Cordis host 插件，id `workbench`；数据在 `$DSH_HOME/workbench`，HTTP 前缀 `/wb/api`。
- `workbench-ui` → `@cyancity/yolo-bot-ui`：`dsh.client` web 插件，id `ui-workbench`，由宿主 client module runtime 加载。
- 公开扩展类型入口分别为 `@cyancity/yolo-bot/extension` 和 `@cyancity/yolo-bot-ui/extension`，生命周期与使用方式见 `docs/extension-api.md`。扩展消费公开类型、Cordis 服务与 HTTP，不深导入核心 Store、Runtime 或 React 业务源码。
- Cordis id、配置键、数据目录和 API 前缀不可随包名变化。`Config.root` 和 `sessionEventCache` 保持原含义；现有员工、频道、线程、任务、binding 和偏好 key 不重编。
- 两包各带 `dsh.bundle` / `cordis.patch.yml`，可通过官方 `dsh plugin add` 安装；浏览器包不需要重建宿主 webapp。

## 依赖与构建

- `@deepseek-ai/*` 钉 `0.2.1-rc.5`（npm 发布版；上游 git 无 rc.5 标签，build-support 与 vendored 副本来源仍为 `dsh-v0.2.1-rc.4`，pin `504a01a957`）；Cordis `~4.0.5`、schemastery `~3.18.5`。
- `build-support/` 是 vendored clientBundle preset；升级钉版时同步文件头标明的来源。`entries.ts` / `system.ts` 是 type-only 构建输入。
- UI 的 `@deepseek-ai/dsh-llm-retry` 与 `workforce-live.ts` 顶部 type-only import 合并 retry 事件到 SessionEvent union，不删除。
- `workbench-ui/tests/vendor/session-events.ts` 是上游 events.ts 的单文件副本；上游 npm 不发布源码，升级钉版时同步。
- `pnpm install` 后执行 `pnpm -r typecheck`、`pnpm -r test`、`pnpm -r build`。host 测试限制两文件 worker，避免文件持久化测试抢占 CPU/磁盘；不增加全局测试超时，不放宽断言。
- 发版：两包同版本；`pnpm market` 把当前版本和 `engines.dsh` 写入 `market/index.json`（DSH 插件市场索引，main 上的 raw 地址即对外索引 URL），并用官方校验器检查；同一 tgz 上传 GitHub Release 并 `npm publish --access public`。索引只列 npm 上已存在的版本，先发 npm 再合并索引改动。
- 发布包只使用预构建 `lib/` 与 package.json 的 files 白名单。host 输出 `lib/index.mjs`，UI 输出 `lib/index.js`、`lib/client.js`；公开声明分别为 `lib/extension.d.mts` / `lib/extension.d.ts`。用 `pnpm -r exec npm pack --dry-run --json` 核对实际文件清单。
- UI 统一使用兼容 React 18 的 `@lobehub/ui@1.171.0` 和 Ant Design 5。颜色、字体、圆角和控件外观直接继承原生 Lobe ThemeProvider；`--wb-*` 外观变量只作原生 token 的兼容别名，不维护第二套配色。布局取值留在共享布局样式，图标使用 lucide。
- 页面和私有扩展复用 `src/client/ui/` 的公共组件接口；官方组件已有的行为直接复用。宿主仍持有会话和持久化真源，UI 库迁移不删除多人回复分组、成果锚点、中英切换或公开扩展能力。
- Morph Bot 头像的本次公开分发已由项目维护者确认获得授权；来源与第三方许可说明必须保留，不将上游参考素材擅自声明为本项目 MIT 原创代码。
- 不新增单测或接口测试；既有核心断言不删、不放宽、不新增 skip。移除功能时删除其专属测试；混合文件保留通用断言，依赖路径变化只调整导入与 fixture。

## 贡献规范

- 提交信息使用 conventional 前缀，例如 `feat:`、`fix:`、`chore:`。
- 提交前请执行 `pnpm -r typecheck`、`pnpm -r test`、`pnpm -r build` 保证检查通过；改了样式再跑 `pnpm lint`。

## 安装与边界

- 浏览器开发使用 `pnpm dev`，默认 `http://127.0.0.1:3099`，可用 `--port` 改端口，`--data` 改数据目录，`--extension <目录>` 挂载本地扩展（见 `docs/extension-api.md`）。启动器用精确钉版的官方 DSH CLI，把两包链接到当前工作树，监听构建并交给原生 HMR 更新。只修改启动命令所属工作树的代码才会更新该实例。
- 开发 profile、模型设置、员工、频道与会话持久保存在当前工作树 `tmp/dev-web/`，与 Release 分开；`instance.json` 标明源码位置与本次进程，`access.json` 是受限的本机登录入口，不打印或提交；浏览器打开一次后 cookie 十年有效，重启后直接访问端口即可（`127.0.0.1` 与 `localhost` 各需一次）。宿主用户技能只读发现，技能 CRUD 仍在开发 home。不要清空开发数据来处理普通 UI 问题，也不要因此重启或覆盖 Release。
- 官方安装支持包来源、tgz 绝对路径和 git tag；peer 为精确 `0.2.1-rc.5`。跨版本宿主会进行兼容检查。
- 模型由官方已注册 provider 提供，默认选择与凭据由宿主管理；核心不建立第二套账户、模型目录或凭据库。
- 技能来源继续使用官方 skills registry；用户技能 CRUD 限 user root，并进行 canonical 路径检查；扩展 provider 独立管理其资源和启停。
- 维护门纳入核心和扩展 participant。扩展写入、安装、任务恢复都必须参与 busy 观察，备份与卸载不能绕过门。
- 仓库不保存密钥、客户资料或个人环境配置；第三方内容保留必要的许可证和公开来源信息。
