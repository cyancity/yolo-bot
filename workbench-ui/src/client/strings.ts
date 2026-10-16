/** Core workbench shell copy. Feature extensions own their own dictionaries. */
import { createI18nProxy } from './i18n.ts'

const S_zh = {
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
    languageLabel: '语言',
    languageAuto: '跟随宿主',
    languageZh: '中文',
    languageEn: 'English',
  },
} as const

const S_en = {
  brand: 'YOLO-Bot',
  nav: {
    today: 'Home',
    chat: 'Back to Chat',
    expand: 'Expand Navigation',
    collapse: 'Collapse Navigation',
    zoom: 'Interface Zoom',
    zoomAuto: (zoom: number) => `Auto (${Math.round(zoom * 1000) / 10}%)`,
    brandGlyph: 'YB',
  },
  settings: {
    tab: 'YOLO-Bot',
    interface: 'Interface',
    appearance: 'Appearance',
    styleLabel: 'Layout Style',
    styleDiscord: 'Discord',
    styleWechat: 'WeChat',
    schemeLabel: 'Theme',
    schemeSystem: 'System',
    schemeLight: 'Light',
    schemeDark: 'Dark',
    sidebarTakeover: 'Take over sidebar navigation (channels/DMs/employees); disable to return to classic navigation',
    showSteps: 'Show execution steps (tool and reasoning details)',
    languageLabel: 'Language',
    languageAuto: 'Follow Host',
    languageZh: '中文',
    languageEn: 'English',
  },
}

export const S = createI18nProxy(S_zh, S_en)
