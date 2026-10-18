# 设计 token 刻度

workbench-ui 的颜色、字号、圆角、阴影、间距只从 `--wb-*` token 取值。token 唯一定义在 `workbench-ui/src/client/ui/tokens.module.css`，组件样式里不写字面量，也不写 `var(--wb-x, 兜底值)` 形式的兜底：基础刻度同时挂在 `html[data-wb-style]`、`.root`、`.scope` 上，portal 到 `document.body` 的弹窗也能取到。

`pnpm lint`（stylelint + `stylelint-declaration-strict-value`，配置在 `workbench-ui/stylelint.config.mjs`）会拦下新写进来的字面量。

## 共享组件

对话使用 assistant-ui 官方 runtime 和 primitives；基础控件采用配套的 shadcn/Radix 组合，样式继续消费同一份 `--wb-*` token。整体外观采用 [assistant-ui 官方 Thread 默认风格](https://www.assistant-ui.com/elements/thread)，通过同一套语义 token 映射到全部页面和扩展：中性配色、细边框、近黑主按钮、16px 正文，避免局部重新设计控件。

页面和扩展从 `workbench-ui/src/client/ui/` 复用 Button、TextInput、Textarea、Select、Switch、Checkbox、RadioGroup、Dialog、Tabs、Menu、Tooltip 等；已有 label 模式的 Input 保持兼容。基础原生控件只在 kit 中实现，业务处保留文件选择等需要专门浏览器语义的输入。标准组件已有的键盘、焦点和浮层行为交给官方 primitive。

## 间距

| token | 值 | 常见用途 |
|---|---|---|
| `--wb-space-2` | 2px | 图标与文字的微调、徽标内边距 |
| `--wb-space-3` | 4px | 紧凑元素间隙 |
| `--wb-space-4` | 8px | 默认元素间隙、行内边距 |
| `--wb-space-5` | 12px | 卡片、面板内边距 |
| `--wb-space-6` | 16px | 区块间距 |
| `--wb-space-7` | 24px | 页面左右边距 |
| `--wb-space-8` | 32px | 大区块分隔 |
| `--wb-space-9` | 48px | 空态留白 |

token 名里的数字是档位，不是像素。padding、margin、gap 只用这些档；负外边距写成 `calc(-1 * var(--wb-space-4))`，和其他尺寸叠加写成 `calc(var(--wb-space-5) + var(--wb-avatar-message-size))`，calc 里不出现长度字面量。

按钮、输入框、菜单项这类控件的高度不靠内边距凑：内边距取刻度值，总高度用 `min-height` 对齐 `--wb-control-height-sm/md/lg`（32/36/44px）。徽标类小元素需要 1px 级微调时改 `line-height`，内边距仍取刻度。

消息与输入框共用 `--wb-thread-max: 44rem` 的居中内容列。`--wb-message-pad-x`、`--wb-bubble-pad-y`、`--wb-message-gap` 统一定义在 token 根，不随导航结构改变。

## 圆角

三档加两个形状：

| token | 值 |
|---|---|
| `--wb-radius-sm` | 4px |
| `--wb-radius-md` | 6px |
| `--wb-radius-lg` | 8px |
| `--wb-radius-pill` | 999px，胶囊 |
| `--wb-radius-dot` | 50%，圆形 |

语义圆角统一使用组件角色，不随导航结构切换：

| token | 值 |
|---|---|
| `--wb-radius-panel` | 12px |
| `--wb-radius-control` | 6px |
| `--wb-radius-bubble` / `--wb-radius-composer` | 16px |
| `--wb-radius-overlay` | 8px |
| `--wb-radius-avatar` | 50% |
| `--wb-radius-badge` | 4px |

## 字号

正文五档，标题三档，都是 rem（根字号 16px 时的像素值列在括号里）：

| token | 值 | 用途 |
|---|---|---|
| `--wb-type-micro-size` | .6875rem（11px） | 徽标、计数、极小标签 |
| `--wb-type-caption-size` | .75rem（12px） | 时间、说明、次要信息 |
| `--wb-type-compact-size` | .875rem（14px） | 列表、按钮、紧凑正文 |
| `--wb-type-label-size` | .875rem（14px） | 表单标签、卡片标题 |
| `--wb-type-body-size` | 1rem（16px） | 消息正文、聊天输入框 |
| `--wb-type-section-size` | 1rem（16px） | 区块标题、Markdown h3 |
| `--wb-type-heading-size` | 1.125rem（18px） | 弹窗标题、Markdown h2 |
| `--wb-type-title-size` | 1.25rem（20px） | 页面标题、Markdown h1 |

`--wb-type-strong-size`、`--wb-type-code-size` 是同字号的语义别名。每档都配有 `-weight`、`-leading`。相对父级的 `em` 只用于行内代码这类跟随正文的场景。

## 颜色

浅色与深色各有一张 assistant-ui 中性色表。历史 `style` 偏好值 `discord` / `wechat` 仅控制分组频道或会话列表的导航结构，不再切换配色、气泡和控件外观。

- 中性色阶：`--wb-bg`、`--wb-rail`、`--wb-nav`、`--wb-surface`、`--wb-surface-sub`、`--wb-surface-raised`；前景 `--wb-fg`、`--wb-fg-muted`、`--wb-fg-placeholder`；线 `--wb-line-soft`、`--wb-line`、`--wb-line-control`；交互 `--wb-hover`、`--wb-pressed`、`--wb-selected-bg`、`--wb-selected-fg`。
- 中性主色（浅色近黑，深色浅白）：`--wb-accent` 及 `-hover`、`-pressed`、`-soft`、`-fg`，强调色上的文字用 `--wb-on-accent`。
- 语义色：`--wb-success`、`--wb-warning`、`--wb-danger`、`--wb-info`，各带 `-bg`；实底危险按钮 `--wb-danger-solid` + `--wb-on-danger`；未读 `--wb-unread-bg` + `--wb-on-unread`。
- 其他：`--wb-link`、`--wb-focus`、`--wb-disabled-*`、`--wb-quote-*`、`--wb-bubble-*`、`--wb-skeleton-*`、`--wb-tooltip-*`、`--wb-overlay`。
- 小字前景：`--wb-accent-fg-sm`、`--wb-sub-fg-sm`、`--wb-fg-placeholder-aa` 引用统一前景与次要前景；焦点颜色为 `--wb-focus`，半透明焦点环为 `--wb-focus-ring`。
- 与深浅无关：`--wb-on-color`（站点色、生成色等彩色填充上的白字）、`--wb-media-bg`（视频底色）。

派生色用 `color-mix()` 混 token，例如 `color-mix(in srgb, var(--wb-accent) 12%, transparent)`；需要提亮或压暗时混 `var(--wb-fg)`，不混 `#fff` / `#000`。

## 阴影

| token | 用途 |
|---|---|
| `--wb-shadow-sm` | 卡片、色块、小提示 |
| `--wb-shadow-popover` | 菜单、下拉、浮层卡片 |
| `--wb-shadow-dialog` | 弹窗 |

## lint 规则与例外

检查的属性：所有 `*color`、`background`、`fill`、`stroke`、`box-shadow`、`font-size`、`*radius`，`border`、`border-*`、`outline` 简写，以及 `padding`、`margin`（含分方向和 `-inline` / `-block`）、`gap`、`row-gap`、`column-gap`。值按空格拆段逐段检查：颜色段必须引用变量且不含颜色字面量，字号必须是 token / 基于 token 的 calc / em，圆角每段是 token 或 0，间距每段是 token、`0`、`auto` 或引用 token 且不含长度字面量的 calc / clamp / min / max，阴影和描边的长度段照常写。`var(--x, 兜底值)` 不算合规取值。

允许的例外：

- `ui/tokens.module.css` 整个文件不检查。
- 自定义属性声明（`--xxx: #...`）不在检查范围。员工头像插画的局部色板（`workforce-avatar.module.css` 里的 `--bot-*`）按这条放行，色值只在该块定义。
- 确实不是界面取值的个别声明，用行内注释说明原因，例如头像 SVG 里按 viewBox 单位写的字号：`/* stylelint-disable-next-line scale-unlimited/declaration-strict-value -- 原因 */`。

TS/TSX 里的颜色（头像插画 SVG、站点色板、用户自选头像色）属于内容数据，不在本规则范围。
