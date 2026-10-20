# Lobe 主题与兼容变量

界面使用 `@lobehub/ui@1.171.0` 与 Ant Design 5，运行在 React 18 宿主中。主题、字体、控件外观以当前安装版本的 Lobe ThemeProvider 为准，不套用新版 Lobe v6 的 API。

## 主题来源

- `workbench-ui/src/client/ui/root.tsx` 创建独立的原生 Lobe ThemeProvider，不继承宿主的自定义主题。
- `themeAliases()` 将原有 `--wb-*` 外观名称映射到原生 Lobe token，供现有页面与私有扩展兼容使用。别名不是第二套设计系统。
- `ui/tokens.module.css` 只保存业务布局、间距、导航尺寸与层级；不再维护独立的浅色/深色配色表。
- body portal 和浏览器顶层 Dialog 使用同一主题上下文及变量作用域。

颜色、字体、圆角、阴影和控件尺寸都从 Lobe theme 读取。不要给 Ant/Lobe 控件追加项目自己的主色、选中背景、圆角或字号覆盖。新增别名应映射已有原生 token，不写一组“接近 Lobe”的固定值。

## 公共组件与扩展

页面和扩展继续消费 `src/client/ui/` 的公共组件接口。Button、Input、Select、Switch、Checkbox、RadioGroup、Dialog、Tabs、Menu 和 Tooltip 的交互由 Lobe / Ant 组件承接。公开扩展契约与会话持久化不依赖具体 UI 库。

`registerPage`、`registerPreview`、独立页面隐藏协作列、返回原对话，以及共享偏好容器都属于公共能力，视觉迁移不能删除它们。

## 布局与插画

业务布局可使用共享间距变量或组件局部布局值。推荐项的胶囊形态参考 Lobe 官方欢迎区；这类特定结构不能扩散成对全站控件的外观覆盖。

Morph Bot 的形体、材质、渐变和用户自选颜色是插画内容数据，不属于界面主题。保持其来源和授权说明。

## 样式检查

`pnpm lint` 检查 CSS 中写死的界面颜色和阴影。变量定义与头像插画按配置排除；布局间距不再被旧的固定项目刻度锁定。TSX 中通过 `antd-style` 直接消费 Lobe token，仍需在浅色、深色和浮层中检查最终呈现。
