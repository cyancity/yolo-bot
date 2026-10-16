/** Core workbench shell copy. Feature extensions own their own dictionaries. */
export const S = {
  brand: 'YOLO-Bot',
  nav: {
    today: '首页',
    chat: '回到对话',
    expand: '展开导航',
    collapse: '收起导航',
    zoom: '界面缩放',
    zoomAuto: (zoom: number) => `自动（${Math.round(zoom * 1000) / 10}%）`,
    brandGlyph: '工',
  },
  settings: {
    tab: 'YOLO-Bot',
    interface: '界面',
    appearance: '外观',
    styleLabel: '界面风格',
    styleDiscord: 'Discord',
    styleWechat: 'WeChat',
    schemeLabel: '配色',
    schemeSystem: '跟随系统',
    schemeLight: '浅色',
    schemeDark: '深色',
    sidebarTakeover: '接管侧栏导航（频道/私信/员工）；关闭后回到经典导航',
    showSteps: '显示执行步骤（工具与过程详情）',
  },
} as const
