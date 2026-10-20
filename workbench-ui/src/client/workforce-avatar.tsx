/** 员工统一使用 Morph Bot；材质与动画来自 avatar-source，用户头像仍使用个人图片。 */
import { useEffect, useId, useMemo, useRef, type CSSProperties } from 'react'
import { attachAvatarMotion, avatarSvgTemplate, type AvatarMotionHandle, type AvatarMotionState, type AvatarSpeedTier, type BotMaterial } from './workforce-avatar-motion.ts'
import { DEFAULT_USER_AVATAR_DATA_URL } from './workforce-user-avatar.ts'
import { getUserProfile } from './workforce-profile.tsx'
import css from './workforce-avatar.module.css'
import { getLocale } from './i18n.ts'
const localize = (zh: string, en: string) => getLocale() === 'zh' ? zh : en

export type AvatarActivityState = AvatarMotionState
export type AvatarPalette = 'aurora' | 'prism' | 'candy' | 'iridescent-orb' | 'electric-dusk' | 'ocean-signal' | 'mint-violet' | 'peach-sky'

export interface AvatarPaletteDefinition {
  readonly id: AvatarPalette
  readonly label: string
  readonly material: BotMaterial
  readonly color: string
  readonly eyeColor: string
  readonly description: string
}

/** 与 danmaku-live 的 THEMES 同源，具体渐变和玻璃参数由真源 materials.js 提供。 */
export const AVATAR_PALETTES: readonly AvatarPaletteDefinition[] = [
  { id: 'aurora', get label() { return localize('极光', 'Aurora') }, material: 'rainbow-glass', color: '#3fe0d0', eyeColor: '#ffffff', get description() { return localize('负责人默认 · 青蓝玻璃', 'Lead default · cyan glass') } },
  { id: 'prism', get label() { return localize('棱镜', 'Prism') }, material: 'rainbow-glass', color: '#8a7dff', eyeColor: '#ffffff', get description() { return localize('粉紫幻彩玻璃', 'Pink and violet glass') } },
  { id: 'candy', get label() { return localize('糖果', 'Candy') }, material: 'rainbow-glass', color: '#ff6fb5', eyeColor: '#ffffff', get description() { return localize('文案员默认 · 珊瑚暖色', 'Writer default · warm coral') } },
  { id: 'iridescent-orb', get label() { return localize('虹彩', 'Iridescent orb') }, material: 'rainbow-glass', color: '#4d7cff', eyeColor: '#ffffff', get description() { return localize('靛蓝虹彩玻璃', 'Indigo iridescent glass') } },
  { id: 'electric-dusk', get label() { return localize('电光暮色', 'Electric dusk') }, material: 'gradient', color: '#9567f5', eyeColor: '#ffffff', get description() { return localize('紫粉渐变', 'Violet and pink gradient') } },
  { id: 'ocean-signal', get label() { return localize('海洋信号', 'Ocean signal') }, material: 'gradient', color: '#2fb8d8', eyeColor: '#ffffff', get description() { return localize('分析员默认 · 蓝青渐变', 'Analyst default · blue and cyan') } },
  { id: 'mint-violet', get label() { return localize('薄荷紫', 'Mint violet') }, material: 'gradient', color: '#6aa6ff', eyeColor: '#ffffff', get description() { return localize('薄荷蓝紫渐变', 'Mint, blue and violet gradient') } },
  { id: 'peach-sky', get label() { return localize('桃色天空', 'Peach sky') }, material: 'gradient', color: '#ff8f7a', eyeColor: '#ffffff', get description() { return localize('执行员默认 · 暖桃天蓝', 'Executor default · peach and sky blue') } },
]

const PALETTES = new Map(AVATAR_PALETTES.map(palette => [palette.id, palette]))
// Existing employee avatarColor values stay readable without rewriting employee records.
const LEGACY_PALETTES: Readonly<Record<string, AvatarPalette>> = {
  'retro-cream': 'candy',
  'titanium-obsidian': 'aurora',
  'cyber-cyan': 'ocean-signal',
  'geek-violet': 'electric-dusk',
  'mint-sage': 'mint-violet',
}

export function defaultPaletteForRole(name: string, role?: string): AvatarPalette {
  const value = `${role ?? ''} ${name}`.toLowerCase()
  if (/leader|负责人/.test(value)) return 'aurora'
  if (/analyst|分析员/.test(value)) return 'ocean-signal'
  if (/writer|文案员/.test(value)) return 'candy'
  if (/executor|执行员/.test(value)) return 'peach-sky'
  let hash = 0
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return AVATAR_PALETTES[hash % AVATAR_PALETTES.length]!.id
}

export interface ResolvedAvatarPalette {
  readonly palette: AvatarPalette
  readonly customCaseColor?: string | undefined
}

export function resolveAvatarPalette(name: string, role?: string, color?: string, paletteProp?: AvatarPalette): ResolvedAvatarPalette {
  if (paletteProp && PALETTES.has(paletteProp)) return { palette: paletteProp }
  const raw = (color ?? '').trim().replace(/^palette:/, '')
  if (PALETTES.has(raw as AvatarPalette)) return { palette: raw as AvatarPalette }
  const legacy = LEGACY_PALETTES[raw]
  if (legacy) return { palette: legacy }
  if (/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(raw)) return { palette: 'aurora', customCaseColor: raw }
  return { palette: defaultPaletteForRole(name, role) }
}

export function employeeAvatarColor(employee: { readonly id: string; readonly name?: string | undefined; readonly role?: string | undefined; readonly avatarColor?: string | undefined }): string {
  return employee.avatarColor?.trim() || defaultPaletteForRole(employee.name ?? employee.id, employee.role)
}

export interface WorkforceAvatarProps {
  readonly name: string
  readonly isUser?: boolean
  readonly role?: string | undefined
  readonly tone?: string
  readonly color?: string | undefined
  readonly palette?: AvatarPalette | undefined
  readonly state?: AvatarMotionState | undefined
  readonly activityState?: AvatarActivityState | undefined
  readonly live?: boolean | undefined
  readonly speedTier?: AvatarSpeedTier | undefined
  readonly isLatest?: boolean | undefined
  readonly size?: number
  readonly className?: string
  readonly title?: string
}

function customEyeColor(hex: string): string {
  const expanded = hex.length === 4 ? [...hex.slice(1)].map(char => char + char).join('') : hex.slice(1)
  const values = [0, 2, 4].map(index => Number.parseInt(expanded.slice(index, index + 2), 16) / 255)
  return values[0]! * 0.299 + values[1]! * 0.587 + values[2]! * 0.114 > 0.68 ? '#17203c' : '#ffffff'
}

export function WorkforceAvatar({ name, isUser = false, role, tone, color, palette, state = 'idle', activityState, live, speedTier, isLatest = false, size = 36, className, title }: WorkforceAvatarProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef<AvatarMotionHandle | null>(null)
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const svg = useMemo(() => ({ __html: avatarSvgTemplate(`morph-${rawId}`) }), [rawId])
  const { palette: activePalette, customCaseColor } = resolveAvatarPalette(name, role, color, palette)
  const definition = PALETTES.get(activePalette)!
  const bodyColor = customCaseColor ?? definition.color
  const eyeColor = customCaseColor ? customEyeColor(customCaseColor) : definition.eyeColor
  const material = customCaseColor ? 'solid' : definition.material
  const motionState = activityState ?? state
  const isLive = live ?? isLatest
  const resolveTier = () => speedTier ?? (rootRef.current?.closest('[data-msg-role]') ? 'flow' : 'sidebar')

  useEffect(() => {
    if (isUser || !rootRef.current) return
    const motion = attachAvatarMotion(rootRef.current, { state: motionState, live: isLive, speedTier: resolveTier(), material, color: bodyColor, eyeColor, preset: activePalette, size })
    motionRef.current = motion
    return () => { motion.dispose(); motionRef.current = null }
  }, [isUser])

  useEffect(() => {
    motionRef.current?.update({ state: motionState, live: isLive, speedTier: resolveTier(), material, color: bodyColor, eyeColor, preset: activePalette, size })
  }, [motionState, isLive, speedTier, material, bodyColor, eyeColor, activePalette, size])

  const customStyle: CSSProperties = { ['--sz' as string]: `${size}px`, ['--tone' as string]: tone ?? bodyColor }
  if (isUser) {
    const userAvatarUrl = color || getUserProfile().avatarUrl || DEFAULT_USER_AVATAR_DATA_URL
    return <span className={`${css.avatar} ${css.avatarUser} ${className ?? ''}`} style={customStyle} aria-hidden="true" title={title ?? name}>
      <img src={userAvatarUrl} alt={name} onError={event => { event.currentTarget.src = DEFAULT_USER_AVATAR_DATA_URL }} />
    </span>
  }

  return <div ref={rootRef} className={`${css.avatar} ${css.avatarEmployee} ${className ?? ''}`} style={customStyle} data-state={motionState} data-avatar-style="bot" data-palette={activePalette} data-custom-color={customCaseColor ? 'true' : undefined} aria-hidden="true" title={title ?? name} dangerouslySetInnerHTML={svg} />
}
