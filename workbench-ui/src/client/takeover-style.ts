/**
 * 侧栏完全接管样式注入与销毁。
 * 当工作台激活且侧栏接管开启时，完全隐藏 DSH 原生侧栏的所有原生外壳区域
 * （logoRow 品牌行、topStrip、newSession 新建会话按钮、panelList 全局面板列表、footArea 底部用户卡），
 * 并消除外层 root/regionArea 的默认外边距与内边距，使工作台自身的侧栏导航与频道列表占满整窗。
 * 当撤销接管或切回原生会话时，移除该样式标签，原生侧栏瞬间恢复。
 */

const TAKEOVER_STYLE_TAG = 'wb-takeover-sidebar'

const TAKEOVER_CSS = `
:root {
  --dsh-windows-content-radius: 0px !important;
}

:root, body {
  --dsw-specific-sidebar-fill: var(--wb-rail, var(--wb-bg, #1e1f22));
  --dsw-alias-label-primary: var(--wb-fg, #f2f3f5);
}
/* 隐藏 DSH 原生 Windows 标题栏的应用与编辑菜单 */
[data-windows-menu],
div[data-windows-menu] {
  display: none !important;
}

[data-windows-titlebar] [class*="_centerCol"],
[class*="_centerCol"] {
  border-radius: 0 !important;
}

[class*="_logoRow"],
[class*="_topStrip"],
[class*="_newSession"],
nav[class*="_panelList"],
[class*="_footArea"] {
  display: none !important;
}

/* DSH 工作区原生会话列表中的未分组显示为 YOLO BotChat */
[data-row-key="workspace:"] [class*="_title"],
[data-row-key="workspace:"] [class*="_projectText"] span {
  font-size: 0 !important;
}
[data-row-key="workspace:"] [class*="_title"]::after,
[data-row-key="workspace:"] [class*="_projectText"] span::after {
  content: "YOLO BotChat" !important;
  font-size: 13px !important;
  font-weight: 500 !important;
  color: var(--wb-fg, inherit) !important;
}

[class*="_root"]:has([data-workforce-sidebar]) {
  padding: 0 !important;
}

[class*="_regionArea"]:has([data-workforce-sidebar]) {
  margin: 0 !important;
  padding: 0 !important;
  height: 100% !important;
  flex: 1 1 100% !important;
}
`

export function installTakeoverStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  let style = document.querySelector(`style[data-wb-style-tag="${TAKEOVER_STYLE_TAG}"]`) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.dataset.wbStyleTag = TAKEOVER_STYLE_TAG
    style.textContent = TAKEOVER_CSS
    document.head.appendChild(style)
  }
  return () => {
    style?.remove()
  }
}
