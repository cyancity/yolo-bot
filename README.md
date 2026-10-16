# yolo-bot

DSH 的数字员工工作台插件：频道负责人接任务，派员工执行工具与 skill，汇总交付；支持线程追问、@ 员工、私信、材料与成果、记忆和原生模型接入。

## 包与结构

| 包 | 目录 | 形态 |
|---|---|---|
| `@cyancity/yolo-bot` | `workbench-host` | Cordis host 插件 |
| `@cyancity/yolo-bot-ui` | `workbench-ui` | `dsh.client` web 插件 |

## 安装

插件 peer 要求 DSH `0.2.0-rc.2`。

1. 从 GitHub Release 下载两个插件包的 `.tgz` 文件：
   - `@cyancity/yolo-bot` (`workbench-host`)
   - `@cyancity/yolo-bot-ui` (`workbench-ui`)
2. 执行安装命令（使用目标 profile）：

```sh
dsh plugin --profile <profile> add <host-package.tgz 绝对路径>
dsh plugin --profile <profile> add <ui-package.tgz 绝对路径>
```

桌面版的 `desktop` profile 只能由桌面版自己的插件管理器修改，请用安装目录下 `resources/runtime/cli/bin/dsh` 执行上面的命令。

两包各带 `dsh.bundle` 与 `cordis.patch.yml`。UI 由宿主模块加载器动态加载，不需要重建宿主 webapp。

## 开发

本项目采用 pnpm workspace 管理。

```sh
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

装包前必须构建，发布文件以各包 `files` 白名单为准。上游依赖钉在 `@deepseek-ai/*@0.2.0-rc.2`；`build-support/` 与 `tests/vendor/` 随钉版同步。

## 扩展

公开的类型、运行时服务与 UI 插座见 [扩展 API](docs/extension-api.md)。核心不附带行业目录或制作流程。运行时 Cordis id `workbench` / `ui-workbench`、配置键、`/wb/api`、`$DSH_HOME/workbench` 与偏好 key 保持稳定。

## 许可证

MIT，见 [LICENSE](LICENSE)。第三方代码的来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
