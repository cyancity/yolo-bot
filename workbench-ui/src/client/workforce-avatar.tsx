/**
 * WorkforceAvatar：数字员工与用户的统一头像组件。
 * - 用户：字母圆（首字缩写）。
 * - 员工：复古终端屏 / 经典圆形 3D SVG 分层头像，由 workforce-avatar-motion 引擎驱动
 *   视线跟随、状态动作（thinking/tool/typing）与终端输出字符流。
 */
import { useEffect, useId, useRef } from 'react'
import type { CSSProperties } from 'react'
import { useWorkforcePrefs } from './workforce-prefs.ts'
import {
  attachAvatarMotion,
  DEFAULT_GAZE_X,
  DEFAULT_GAZE_Y,
  type AvatarMotionHandle,
  type AvatarMotionState,
  type AvatarSpeedTier,
  type TypingEffect,
} from './workforce-avatar-motion.ts'
import css from './workforce-avatar.module.css'
import { DEFAULT_USER_AVATAR_DATA_URL } from './workforce-user-avatar.ts'
import { getUserProfile } from './workforce-profile.tsx'

export type AvatarActivityState =
  | 'idle'
  | 'sleeping'
  | 'waking'
  | 'listening'
  | 'thinking'
  | 'searching'
  | 'working'
  | 'tool'
  | 'typing'
export type AvatarStyle = 'circle' | 'terminal'

/** 5 套官方机身调色盘 ID（照搬 avatar-prototype.html 的 .palette-*） */
export type AvatarPalette =
  | 'retro-cream'
  | 'titanium-obsidian'
  | 'cyber-cyan'
  | 'geek-violet'
  | 'mint-sage'

export interface AvatarPaletteDefinition {
  readonly id: AvatarPalette
  readonly label: string
  readonly caseColor: string
  readonly eyeColor: string
  readonly description: string
}

export const AVATAR_PALETTES: readonly AvatarPaletteDefinition[] = [
  {
    id: 'retro-cream',
    label: '复古米白',
    caseColor: '#F4EEE0',
    eyeColor: '#FF5459',
    description: '文案员默认 · 温暖复古',
  },
  {
    id: 'titanium-obsidian',
    label: '钛金黑曜',
    caseColor: '#383C46',
    eyeColor: '#FFB800',
    description: '负责人默认 · 沉稳冷峻',
  },
  {
    id: 'cyber-cyan',
    label: '赛博青',
    caseColor: '#E2F1F5',
    eyeColor: '#00E5FF',
    description: '分析员默认 · 科技清爽',
  },
  {
    id: 'geek-violet',
    label: '极客紫',
    caseColor: '#EFEBF8',
    eyeColor: '#B066FE',
    description: '智性极客 · 神秘优雅',
  },
  {
    id: 'mint-sage',
    label: '薄荷鼠尾草',
    caseColor: '#E2EFE8',
    eyeColor: '#10B981',
    description: '清新敏锐 · 专注自然',
  },
] as const

const IS_PALETTE: Record<string, boolean> = {
  'retro-cream': true,
  'titanium-obsidian': true,
  'cyber-cyan': true,
  'geek-violet': true,
  'mint-sage': true,
}

/**
 * 默认按角色分配机身配色：
 * - 负责人：titanium-obsidian
 * - 分析员：cyber-cyan
 * - 文案员：retro-cream
 * - 新员工：按名字哈希在 5 套配色中轮流取
 */
export function defaultPaletteForRole(name: string, role?: string): AvatarPalette {
  const normName = (name || '').trim().toLowerCase()
  const normRole = (role || '').trim().toLowerCase()

  if (normRole === 'leader' || normName === '负责人' || normName.includes('负责人') || normName === 'leader') {
    return 'titanium-obsidian'
  }
  if (normRole === 'analyst' || normName === '分析员' || normName.includes('分析员') || normName === 'analyst') {
    return 'cyber-cyan'
  }
  if (normRole === 'writer' || normName === '文案员' || normName.includes('文案员') || normName === 'writer') {
    return 'retro-cream'
  }

  let hash = 0
  for (const char of name) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  }
  return AVATAR_PALETTES[hash % AVATAR_PALETTES.length]!.id
}

export interface ResolvedAvatarPalette {
  readonly palette: AvatarPalette
  readonly customCaseColor?: string | undefined
}

/**
 * 解析员工头像最终使用的配色方案与自定义机身色。
 * 员工 avatarColor 支持 'palette:<名字>'、调色盘名称或十六进制自定义色（自定义色以 retro-cream 为底仅改机身）。
 */
export function resolveAvatarPalette(
  name: string,
  role?: string | undefined,
  color?: string | undefined,
  paletteProp?: AvatarPalette | undefined,
): ResolvedAvatarPalette {
  if (paletteProp && IS_PALETTE[paletteProp]) {
    return { palette: paletteProp }
  }

  const raw = (color ?? '').trim()
  if (raw.startsWith('palette:')) {
    const palName = raw.slice(8).trim()
    if (IS_PALETTE[palName]) {
      return { palette: palName as AvatarPalette }
    }
  }

  if (IS_PALETTE[raw]) {
    return { palette: raw as AvatarPalette }
  }

  if (raw) {
    // 自定义色（如 #hex），其余属性用 retro-cream
    return {
      palette: 'retro-cream',
      customCaseColor: raw,
    }
  }

  return {
    palette: defaultPaletteForRole(name, role),
  }
}

/** 员工头像配色的唯一入口：avatarColor 优先（palette:/#hex），空则按 role/name 走角色调色盘——
 *  与 resolveAvatarPalette 的缺省路径一致，侧栏、消息区、员工页统一从这里取。 */
export function employeeAvatarColor(employee: { readonly id: string; readonly name?: string | undefined; readonly role?: string | undefined; readonly avatarColor?: string | undefined }): string {
  const color = employee.avatarColor?.trim()
  if (color) return color
  return resolveAvatarPalette(employee.name ?? employee.id, employee.role).palette
}

export interface WorkforceAvatarProps {
  readonly name: string
  readonly isUser?: boolean
  readonly role?: string | undefined
  readonly tone?: string
  /** 自定义头像/机身颜色（支持 'palette:<name>' 或十六进制自定义色） */
  readonly color?: string | undefined
  /** 显式指定 5 套机身调色盘之一 */
  readonly palette?: AvatarPalette | undefined
  /** 头像风格：circle 圆形，terminal 复古终端屏（默认 terminal） */
  readonly style?: AvatarStyle | undefined
  /** 终端输出动效类型：hash、binary、cli */
  readonly typingEffect?: TypingEffect | undefined
  readonly state?: 'idle' | 'working' | AvatarMotionState | undefined
  /** 执行中活动变体，映射 activity.state（thinking、tool、typing） */
  readonly activityState?: AvatarActivityState | undefined
  /** 是否为消息流最新一条消息头像：动画常驻，鼠标靠近即跟随。非 live 只在 hover 时动 */
  readonly live?: boolean | undefined
  /** 注视速度档：flow 消息流内快跟，sidebar 侧栏/员工页放慢。未传时按 DOM 上下文自动判断 */
  readonly speedTier?: AvatarSpeedTier | undefined
  /** 兼容旧代码属性，live 未传时回退到 isLatest */
  readonly isLatest?: boolean | undefined
  readonly size?: number
  readonly className?: string
  readonly title?: string
}

export function WorkforceAvatar({
  name,
  isUser = false,
  role,
  tone,
  color,
  palette,
  style: styleProp,
  typingEffect: typingEffectProp,
  state = 'idle',
  activityState,
  live,
  speedTier,
  isLatest = false,
  size = 36,
  className,
  title,
}: WorkforceAvatarProps) {
  const [prefs] = useWorkforcePrefs()
  const style = styleProp ?? prefs.avatarStyle
  const typingEffect = typingEffectProp ?? prefs.typingEffect
  const isLive = live ?? isLatest
  const motionState: AvatarMotionState =
    activityState ?? (state === 'working' ? 'working' : (state ?? 'idle'))

  const rootRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef<AvatarMotionHandle | null>(null)

  // 速度档未显式传入时按挂载上下文判断：消息元素（data-msg-role）内为 flow，其余按 sidebar 慢档。
  const resolveTier = (): AvatarSpeedTier =>
    speedTier ?? (rootRef.current?.closest('[data-msg-role]') ? 'flow' : 'sidebar')

  useEffect(() => {
    if (isUser || !rootRef.current) return
    const handle = attachAvatarMotion(rootRef.current, {
      state: motionState,
      typingEffect,
      live: isLive,
      style,
      speedTier: resolveTier(),
    })
    motionRef.current = handle
    return () => {
      handle.dispose()
      motionRef.current = null
    }
  }, [isUser, style])

  useEffect(() => {
    motionRef.current?.update({
      state: motionState,
      typingEffect,
      live: isLive,
      style,
      speedTier: resolveTier(),
    })
  }, [motionState, typingEffect, isLive, style, speedTier])

  const { palette: activePalette, customCaseColor } = resolveAvatarPalette(
    name,
    role,
    color,
    palette,
  )
  // Expose the same resolved body color in every surface, including palette defaults and dark overrides.
  const effectiveTone = customCaseColor ?? tone ?? 'var(--bot-case)'
  const customStyle: CSSProperties = {
    ['--sz' as string]: `${size}px`,
    ...(effectiveTone ? { ['--tone' as string]: effectiveTone } : {}),
    ...(customCaseColor ? { ['--bot-case-custom' as string]: customCaseColor } : {}),
  }

  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const glassGradId = `glass-${rawId}`
  const scanPatId = `scan-${rawId}`
  const hashGradId = `hgrad-${rawId}`
  const clipId = `clip-${rawId}`

  if (isUser) {
    const userAvatarUrl = color || getUserProfile().avatarUrl || DEFAULT_USER_AVATAR_DATA_URL
    return (
      <span
        className={`${css.avatar} ${css.avatarUser} ${className ?? ''}`}
        style={{ ...customStyle, borderRadius: '50%', overflow: 'hidden' }}
        aria-hidden="true"
        title={title ?? name}
      >
        <img
          src={userAvatarUrl}
          alt={name}
          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%', display: 'block' }}
          onError={e => {
            e.currentTarget.src = DEFAULT_USER_AVATAR_DATA_URL
          }}
        />
      </span>
    )
  }

  const isTerminal = style === 'terminal'
  const isSleeping = motionState === 'sleeping'
  const initGx = isSleeping ? DEFAULT_GAZE_X * 0.3 : DEFAULT_GAZE_X
  const initGy = isSleeping ? 0.35 : DEFAULT_GAZE_Y
  const initEyeAmpX = isTerminal ? 9.5 : 24.5
  const initEyeAmpY = isTerminal ? 7.5 : 20.0
  const initEyeTx = (initGx * initEyeAmpX).toFixed(2)
  const initEyeTy = (initGy * initEyeAmpY).toFixed(2)
  const initCompL = '1'
  const initCompR = !isTerminal && initGx > 0 ? (1.0 - initGx * 0.22).toFixed(3) : '1'
  const initEyeScaleY = isSleeping ? '0.08' : '0.92'
  return (
    <div
      ref={rootRef}
      className={`${css.avatar} ${css.avatarEmployee} ${className ?? ''}`}
      style={customStyle}
      data-state={state}
      data-avatar-style={style}
      data-palette={activePalette}
      data-custom-color={customCaseColor ? 'true' : undefined}
      aria-hidden="true"
      title={title ?? name}
    >
      <div data-layer="inner" className={css.avatarInner}>
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" className={css.avatarSvg}>
          <defs>
            <linearGradient id={glassGradId} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.10" />
              <stop offset="65%" stopColor="#000000" stopOpacity="0" />
              <stop offset="100%" stopColor="#000000" stopOpacity="0.35" />
            </linearGradient>
            <pattern id={scanPatId} width="100" height="4" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="100" y2="0" stroke="rgba(0,0,0,0.22)" strokeWidth="1.2" />
            </pattern>
            <linearGradient id={hashGradId} gradientUnits="userSpaceOnUse" x1="22" y1="0" x2="78" y2="0">
              <stop offset="0%" stopColor="#FF79C6" />
              <stop offset="100%" stopColor="#BD93F9" />
            </linearGradient>
            <clipPath id={clipId}>
              {isTerminal ? (
                <rect x="20" y="20" width="60" height="60" rx="11" />
              ) : (
                <circle cx="50" cy="50" r="49" />
              )}
            </clipPath>
          </defs>

          {/* 第 1 层：机身外壳（终端屏含显示器底座：先于机身画的托板被机身底边压住，读作坐在底座上） */}
          <g data-layer="case">
            {isTerminal ? (
              <>
                <rect x="24" y="86" width="52" height="12" rx="6" fill="var(--bot-case)" stroke="var(--bot-border)" strokeWidth="1.6" />
                <path d="M34 93.5 Q50 96 66 93.5" stroke="var(--bot-case-shadow)" strokeWidth="2.4" strokeLinecap="round" fill="none" opacity="0.4" />
                <rect x="9" y="9" width="82" height="82" rx="20" fill="var(--bot-case)" stroke="var(--bot-border)" strokeWidth="1.6" />
                <path d="M22 12 Q50 10.5 78 12" stroke="rgba(255,255,255,0.45)" strokeWidth="1.3" strokeLinecap="round" fill="none" />
              </>
            ) : (
              <circle cx="50" cy="50" r="49" fill="var(--bot-case)" stroke="var(--bot-border)" strokeWidth="1.8" />
            )}
          </g>

          {/* 第 2 层：深色内嵌屏幕框 */}
          {isTerminal && (
            <g data-layer="bezel">
              <rect x="17" y="17" width="66" height="66" rx="14" fill="var(--bot-bezel)" />
            </g>
          )}

          {/* 第 3 层：黑曜石屏幕玻璃 */}
          {/* 圆形头像只有机身与眼睛：没有屏幕、扫描线和终端输出 */}
          <g data-layer="screen">
            {isTerminal ? (
              <>
                <rect x="20" y="20" width="60" height="60" rx="11" fill="var(--bot-screen)" />
                <rect x="20" y="20" width="60" height="60" rx="11" fill={`url(#${scanPatId})`} opacity="0.45" />
                <path d="M24 24 Q50 21 74 24" stroke="rgba(255,255,255,0.16)" strokeWidth="1.5" strokeLinecap="round" fill="none" />
                <rect x="20" y="20" width="60" height="60" rx="11" fill={`url(#${glassGradId})`} />
                <rect data-layer="scan" x="20" y="20" width="60" height="4" fill="var(--bot-scanline)" opacity="0" style={{ display: 'none' }} />
              </>
            ) : null}
          </g>

          {/* 第 3.5 层：Typing 终端输出字符流（由引擎生成子行） */}
          {isTerminal && (
            <g data-layer="typing" clipPath={`url(#${clipId})`} style={{ display: 'none' }} className={css.layerTypingStream}>
              <g data-layer="typing-rows" data-variant={typingEffect} className={css.typingRows} style={{ ['--hash-grad-url' as string]: `url(#${hashGradId})` }} />
            </g>
          )}

          {/* 第 4 层：眼睛（预置初始右上贴边或睡眠闭眼 transform，保证无 JS / 静态渲染 / 初始帧绝不居中） */}
          <g
            data-layer="eyes"
            clipPath={`url(#${clipId})`}
            style={{
              transform: `translate(${initEyeTx}px, ${initEyeTy}px)`,
              opacity: isSleeping ? 0.65 : 1,
            }}
          >
            {/* 胶囊眼统一规格：宽 ≈ 眼心距 25%，高 ≈ 2.2 倍宽，rx=宽/2 全圆头（竖向圆头短条） */}
            {isTerminal ? (
              <>
                {/* 屏内等比缩 grok 眼（屏宽 60 / 机身内径 98 ≈ 0.61）：w6 h11.3 rx3，眼心距 11.6，y 居中 44.35 */}
                <g data-layer="eye-left" style={{ transform: `scale(1, ${initEyeScaleY})` }}>
                  <rect className={css.botEyeShape} x="41.2" y="44.35" width="6" height="11.3" rx="3" />
                </g>
                <g data-layer="eye-right" style={{ transform: `scale(1, ${initEyeScaleY})` }}>
                  <rect className={css.botEyeShape} x="52.8" y="44.35" width="6" height="11.3" rx="3" />
                </g>
              </>
            ) : (
              <>
                {/* grok 规格：宽胶囊竖条 w10 h18.5 rx5，眼心距 19（左心 40.5 右心 59.5），y 居中 40.75 */}
                <g data-layer="eye-left" style={{ transform: `scale(${initCompL}, ${initEyeScaleY})` }}>
                  <rect className={css.botEyeShape} x="30.5" y="40.75" width="10" height="18.5" rx="5" />
                </g>
                <g data-layer="eye-right" style={{ transform: `scale(${initCompR}, ${initEyeScaleY})` }}>
                  <rect className={css.botEyeShape} x="59.5" y="40.75" width="10" height="18.5" rx="5" />
                </g>
              </>
            )}
          </g>
        </svg>
      </div>
    </div>
  )
}
