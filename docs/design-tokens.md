# 设计 token 刻度

workbench-ui 的颜色、字号、圆角、阴影只从 `--wb-*` token 取值。token 唯一定义在 `workbench-ui/src/client/ui/tokens.module.css`，组件样式里不写字面量，也不写 `var(--wb-x, 兜底值)` 形式的兜底：基础刻度同时挂在 `html[data-wb-style]`、`.root`、`.scope` 上，portal 到 `document.body` 的弹窗也能取到。

`pnpm lint`（stylelint + `stylelint-declaration-strict-value`，配置在 `workbench-ui/stylelint.config.mjs`）会拦下新写进来的字面量。

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

token 名里的数字是档位，不是像素。新写的 padding、margin、gap 只用这些档。现有样式里还留着刻度外的值（6px 约 140 处、10px 约 100 处，另有 3/5/7/14/18/20px），这次没有并档，避免整体布局位移；lint 目前不检查间距。

## 圆角

三档加两个形状：

| token | 值 |
|---|---|
| `--wb-radius-sm` | 4px |
| `--wb-radius-md` | 6px |
| `--wb-radius-lg` | 8px |
| `--wb-radius-pill` | 999px，胶囊 |
| `--wb-radius-dot` | 50%，圆形 |

语义圆角按布局风格取三档之一，组件优先用语义 token：

| token | Discord | WeChat |
|---|---|---|
| `--wb-radius-panel` | md | sm |
| `--wb-radius-control` | lg | md |
| `--wb-radius-bubble` | md | sm |
| `--wb-radius-overlay` | md | md |
| `--wb-radius-avatar` | 50% | sm |
| `--wb-radius-badge` | sm | sm |

## 字号

正文五档，标题三档，都是 rem（根字号 16px 时的像素值列在括号里）：

| token | 值 | 用途 |
|---|---|---|
| `--wb-type-micro-size` | .6875rem（11px） | 徽标、计数、极小标签 |
| `--wb-type-caption-size` | .75rem（12px） | 时间、说明、次要信息 |
| `--wb-type-compact-size` | .8125rem（13px） | 列表、按钮、紧凑正文 |
| `--wb-type-label-size` | .875rem（14px） | 表单标签、卡片标题 |
| `--wb-type-body-size` | .9375rem（15px） | 消息正文 |
| `--wb-type-section-size` | 1rem（16px） | 区块标题、Markdown h3 |
| `--wb-type-heading-size` | 1.125rem（18px） | 弹窗标题、Markdown h2 |
| `--wb-type-title-size` | 1.25rem（20px） | 页面标题、Markdown h1 |

`--wb-type-strong-size`、`--wb-type-code-size` 是同字号的语义别名。每档都配有 `-weight`、`-leading`。相对父级的 `em` 只用于行内代码这类跟随正文的场景。

## 颜色

每个布局风格（discord / wechat）× 深浅（light / dark）各有一张色表，结构相同：

- 中性色阶：`--wb-bg`、`--wb-rail`、`--wb-nav`、`--wb-surface`、`--wb-surface-sub`、`--wb-surface-raised`；前景 `--wb-fg`、`--wb-fg-muted`、`--wb-fg-placeholder`；线 `--wb-line-soft`、`--wb-line`、`--wb-line-control`；交互 `--wb-hover`、`--wb-pressed`、`--wb-selected-bg`、`--wb-selected-fg`。
- 一个强调色：`--wb-accent` 及 `-hover`、`-pressed`、`-soft`、`-fg`，强调色上的文字用 `--wb-on-accent`。
- 语义色：`--wb-success`、`--wb-warning`、`--wb-danger`、`--wb-info`，各带 `-bg`；实底危险按钮 `--wb-danger-solid` + `--wb-on-danger`；未读 `--wb-unread-bg` + `--wb-on-unread`。
- 其他：`--wb-link`、`--wb-focus`、`--wb-disabled-*`、`--wb-quote-*`、`--wb-bubble-*`、`--wb-skeleton-*`、`--wb-tooltip-*`、`--wb-overlay`。
- 小字对比度：`--wb-accent-fg-sm`、`--wb-sub-fg-sm` 在浅色下加深到 AA；`--wb-fg-placeholder-aa` 是主消息区用的 placeholder（浅色加深）。
- 与深浅无关：`--wb-on-color`（站点色、生成色等彩色填充上的白字）、`--wb-media-bg`（视频底色）。

派生色用 `color-mix()` 混 token，例如 `color-mix(in srgb, var(--wb-accent) 12%, transparent)`；需要提亮或压暗时混 `var(--wb-fg)`，不混 `#fff` / `#000`。

## 阴影

| token | 用途 |
|---|---|
| `--wb-shadow-sm` | 卡片、色块、小提示 |
| `--wb-shadow-popover` | 菜单、下拉、浮层卡片 |
| `--wb-shadow-dialog` | 弹窗 |

## lint 规则与例外

检查的属性：所有 `*color`、`background`、`fill`、`stroke`、`box-shadow`、`font-size`、`*radius`，以及 `border`、`border-*`、`outline` 简写。值按空格拆段逐段检查：颜色段必须引用变量且不含颜色字面量，字号必须是 token / 基于 token 的 calc / em，圆角每段是 token 或 0，阴影和描边的长度段照常写。

允许的例外：

- `ui/tokens.module.css` 整个文件不检查。
- 自定义属性声明（`--xxx: #...`）不在检查范围。员工头像插画的局部色板（`workforce-avatar.module.css` 里的 `--bot-*`）按这条放行，色值只在该块定义。
- 确实不是界面取值的个别声明，用行内注释说明原因，例如头像 SVG 里按 viewBox 单位写的字号：`/* stylelint-disable-next-line scale-unlimited/declaration-strict-value -- 原因 */`。

TS/TSX 里的颜色（头像插画 SVG、站点色板、用户自选头像色）属于内容数据，不在本规则范围。
