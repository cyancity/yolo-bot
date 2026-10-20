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
  color: inherit !important;
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

/* 宿主窄屏 toggle 仍把展开宽度写进 grid；让侧栏占零宽轨道，抽屉浮在完整主区之上。 */
@media (max-width: 1023.98px) {
  [class*="_frame"]:has([data-workforce-sidebar][data-wb-expanded="true"]) {
    grid-template-columns: 0px minmax(0px, 1fr) 0px !important;
  }

  [class*="_frame"]:has([data-workforce-sidebar][data-wb-expanded="true"]) > [class*="_sidebarCol"] {
    position: relative;
    z-index: 21;
    overflow: visible !important;
    background: transparent;
    border: 0;
  }

  [class*="_frame"]:has([data-workforce-sidebar][data-wb-expanded="true"]) > [class*="_sidebarCol"] > [class*="_root"],
  [class*="_frame"]:has([data-workforce-sidebar][data-wb-expanded="true"]) > [class*="_sidebarCol"] > [data-workforce-sidebar] {
    position: absolute;
    inset: 0 auto 0 0;
    box-sizing: border-box;
    width: min(320px, calc(100vw - 48px));
    height: 100%;
    box-shadow: 12px 0 36px rgba(0, 0, 0, .18);
  }

  [class*="_frame"]:has([data-workforce-sidebar][data-wb-expanded="true"]) > [class*="_handle"] {
    display: none;
  }
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
