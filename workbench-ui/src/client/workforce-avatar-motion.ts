/**
 * 员工头像动效引擎：视线跟随 + 执行状态动画 + 终端输出。
 * 动画参数与原型规范保持一致。
 *
 * 组件只负责画 SVG，并用 data-layer 标出分层；本模块用一个共享 rAF 循环写所有 transform，
 * 头、屏幕、眼睛只由这一处计算，所以永远同步。层上不要再挂 transform 过渡或 keyframes。
 *
 * data-layer：inner（3D 容器）、case、bezel、screen、eyes、scan（tool 扫描光束）、
 * typing（终端输出外层，带 clip-path，不移动）、typing-rows（内层，引擎在里面生成行并平移）。
 */

export type AvatarMotionState =
  | 'idle'
  | 'sleeping'
  | 'waking'
  | 'listening'
  | 'thinking'
  | 'searching'
  | 'working'
  | 'tool'
  | 'typing'
export type TypingEffect = 'hash' | 'binary' | 'cli'
/** 注视速度档：flow 消息流内快跟；sidebar 左列/员工页等非流上下文整体放慢。 */
export type AvatarSpeedTier = 'flow' | 'sidebar'

export interface AvatarMotionOptions {
  readonly state: AvatarMotionState
  readonly typingEffect: TypingEffect
  /** 最新一条消息的头像：状态动画常驻、鼠标靠近即跟随。非 live 只在 hover 时动。 */
  readonly live: boolean
  /** 头像风格：圆形款眼睛位移幅度更大（视线可达圆边），终端屏不变。 */
  readonly style?: 'circle' | 'terminal' | undefined
  /** 注视速度档，默认 flow。 */
  readonly speedTier?: AvatarSpeedTier | undefined
}

export interface AvatarMotionHandle {
  update(options: AvatarMotionOptions): void
  dispose(): void
}

// 验收参数（2026-10-10）：跟随 300ms 到 98%，触发圈内放慢 1.8 倍，回正 600ms；触发范围 3r（用户 2026-10-11 要求扩大一倍）。
const FOLLOW_MS = 300
const RING_SLOWDOWN = 1.8
const RETURN_MS = 600
const TRIGGER_MULT = 3
const BLEND_MS = 280
export const DEFAULT_GAZE_X = 0.62
export const DEFAULT_GAZE_Y = -0.50
// 眼睛静息开合度：胶囊眼轻下切（2026-10-11 用户反馈，对齐 Grok 参考图微眯姿态）。
const REST_SCALE_Y = 0.92

/** 两档注视速度：flow 沿用验收参数；sidebar 用户 2026-10-11 要求侧栏明显更慢。 */
const SPEED_TIERS: Record<AvatarSpeedTier, { followMs: number; ringSlowdown: number; returnMs: number }> = {
  flow: { followMs: FOLLOW_MS, ringSlowdown: RING_SLOWDOWN, returnMs: RETURN_MS },
  sidebar: { followMs: 900, ringSlowdown: 2.6, returnMs: 1400 },
}

// 终端缓冲：屏幕 20..80，行距 6.75，可见 8 行，每行 11 字，左右各留 3。
const TERM = { rows: 8, cols: 11, lineH: 6.75, top: 29, x: 23, width: 54, cps: 260, cliLineMs: 220 }
const HASH_CHARS = '0123456789abcdefABCDEF=^+)(£€$#%&*'
const CLI_SNIPPET = ['$ wb run', '> fetch ok', '> parse 1524', '> rank 0.87', '> draft.md', '> lint ok', '> save 2.1k', '✓ done']
const SVG_NS = 'http://www.w3.org/2000/svg'

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** 临界阻尼弹簧解析解：与帧率无关，从当前速度接续，无过冲。 */
function spring(pos: number, vel: number, target: number, omega: number, dt: number): [number, number] {
  const d = pos - target
  const c = vel + omega * d
  const e = Math.exp(-omega * dt)
  return [target + (d + c * dt) * e, (vel - omega * c * dt) * e]
}

function randChar(effect: TypingEffect): string {
  return effect === 'binary' ? (Math.random() < 0.5 ? '0' : '1') : HASH_CHARS[(Math.random() * HASH_CHARS.length) | 0]!
}

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

interface Pose {
  gx: number
  gy: number
  scaleY: number
  nodY: number
  eyeOpacity: number
  scanY: number
  typing: boolean
  rot?: number
}

function statePose(state: AvatarMotionState, t: number): Pose {
  const normState = state === 'tool' ? 'searching' : state === 'typing' ? 'working' : state
  const pose: Pose = {
    gx: DEFAULT_GAZE_X,
    gy: DEFAULT_GAZE_Y,
    scaleY: REST_SCALE_Y,
    nodY: 0,
    eyeOpacity: 1,
    scanY: -1,
    typing: false,
    rot: 0,
  }

  if (normState === 'idle') {
    // 待机闲置：右上贴边静息、微幅呼吸浮沉、偶发眨眼（live 专属；t 已含头像随机相位）
    const blink = t % 4.6
    if (blink > 4.35 && blink < 4.52) {
      pose.scaleY = Math.abs(Math.cos(((blink - 4.35) / 0.17) * Math.PI)) * 0.88 + 0.12
    }
    pose.gx = DEFAULT_GAZE_X + Math.sin(t * 0.55) * 0.025
    pose.gy = DEFAULT_GAZE_Y + Math.sin(t * 0.9) * 0.02
    pose.nodY = Math.sin(t * 1.1) * 0.45
  } else if (normState === 'sleeping') {
    // 睡眠休眠：闭眼压成细缝、极缓呼吸下沉、无眨眼
    pose.scaleY = 0.08
    pose.gx = DEFAULT_GAZE_X * 0.3
    pose.gy = 0.35 + Math.sin(t * 0.6) * 0.03
    pose.eyeOpacity = 0.65
    pose.nodY = 2.5 + Math.sin(t * 0.6) * 0.8
    pose.rot = 2.0
  } else if (normState === 'waking') {
    // 唤醒：低头揉眼后向上回弹睁眼，随后眨眼归正
    const phase = (t % 3.0) / 3.0
    if (phase < 0.25) {
      pose.scaleY = 0.1
      pose.gy = 0.25
      pose.gx = 0.1
      pose.nodY = 1.5
    } else if (phase < 0.55) {
      const u = (phase - 0.25) / 0.30
      pose.scaleY = 1.0 + Math.sin(u * Math.PI) * 0.2
      pose.gx = DEFAULT_GAZE_X * u
      pose.gy = 0.25 + (DEFAULT_GAZE_Y - 0.25) * u
      pose.nodY = -1.2 * Math.sin(u * Math.PI)
    } else {
      const blinkPhase = (phase - 0.55) / 0.45
      if (blinkPhase > 0.2 && blinkPhase < 0.5) {
        pose.scaleY = Math.abs(Math.cos(((blinkPhase - 0.2) / 0.3) * Math.PI)) * 0.88 + 0.12
      }
      pose.gx = DEFAULT_GAZE_X
      pose.gy = DEFAULT_GAZE_Y
    }
  } else if (normState === 'listening') {
    // 倾听关注：头部侧倾、微扬注视、周期性点头交互（~2.2s 周期），双眼睁开保持专注不眨
    const nodCycle = (t % 2.2) / 2.2
    const nod = nodCycle < 0.22 ? Math.sin((nodCycle / 0.22) * Math.PI) * 2.8 : 0
    pose.gx = DEFAULT_GAZE_X * 0.85
    pose.gy = DEFAULT_GAZE_Y * 0.8 + nod * 0.04
    pose.rot = 5.5 + (nod > 0 ? 1.5 : 0)
    pose.nodY = nod
    pose.scaleY = 1.0
  } else if (normState === 'thinking') {
    // 思考中：视线上浮偏转、游移沉思、呼吸微动、眯眼（胶囊压扁 ~0.45）+ 透明度浮动
    pose.gx = Math.sin(t * 0.9) * 0.22
    pose.gy = -0.68 + Math.cos(t * 1.2) * 0.10
    pose.eyeOpacity = 0.72 + Math.sin(t * 2.2) * 0.26
    pose.scaleY = 0.45 + Math.sin(t * 1.8) * 0.05
    pose.rot = -4.5 + Math.sin(t * 0.9) * 1.5
  } else if (normState === 'searching') {
    // 搜索/检索（tool）：高速横向扫视 + 摆头 + 扫描线，双眼睁大——与 working 的低垂慢点头拉开频率与幅度
    pose.gx = Math.sin(t * 5.6) * 0.85
    pose.gy = -0.08
    pose.rot = Math.sin(t * 5.6) * 3.4
    pose.scaleY = 1.0
    pose.scanY = 20 + ((t * 60) % 56)
  } else {
    // working（typing）：专注工作/终端输出、视线下垂看输出流、低频规律点头
    pose.typing = true
    pose.gx = 0.02
    pose.gy = 0.38
    pose.eyeOpacity = 0
    pose.nodY = Math.sin(t * 7.0) * 0.95
  }
  return pose
}

const layer = (root: Element, name: string) => root.querySelector<SVGElement | HTMLElement>(`[data-layer="${name}"]`)

interface AvatarLayers {
  readonly inner: HTMLElement | SVGElement | null
  readonly case: HTMLElement | SVGElement | null
  readonly bezel: HTMLElement | SVGElement | null
  readonly screen: HTMLElement | SVGElement | null
  readonly eyes: HTMLElement | SVGElement | null
  readonly eyeLeft: HTMLElement | SVGElement | null
  readonly eyeRight: HTMLElement | SVGElement | null
  readonly scan: HTMLElement | SVGElement | null
  readonly typing: HTMLElement | SVGElement | null
  readonly typingRows: HTMLElement | SVGElement | null
}


class AvatarMotion implements AvatarMotionHandle {
  private options: AvatarMotionOptions
  private hovered = false
  private gx = DEFAULT_GAZE_X
  private gy = DEFAULT_GAZE_Y
  private vx = 0
  private vy = 0
  private weight = 0
  // 每个头像挂载时的随机相位：眨眼与各状态周期动作错开，避免全场同步
  private readonly tPhase = Math.random() * 40
  private term = { lines: [''], carry: 0, cliIndex: 0, cliElapsed: 0, effect: 'hash' as TypingEffect }
  private rows: SVGTextElement[] = []
  private readonly layers: AvatarLayers
  private readonly onEnter = () => { this.hovered = true }
  private readonly onLeave = () => { this.hovered = false }

  constructor(private readonly root: HTMLElement, options: AvatarMotionOptions) {
    this.options = options
    this.layers = {
      inner: layer(root, 'inner'),
      case: layer(root, 'case'),
      bezel: layer(root, 'bezel'),
      screen: layer(root, 'screen'),
      eyes: layer(root, 'eyes'),
      eyeLeft: layer(root, 'eye-left'),
      eyeRight: layer(root, 'eye-right'),
      scan: layer(root, 'scan'),
      typing: layer(root, 'typing'),
      typingRows: layer(root, 'typing-rows'),
    }
    const group = this.layers.typingRows
    if (group) {
      group.replaceChildren()
      for (let i = 0; i <= TERM.rows; i++) {
        const row = document.createElementNS(SVG_NS, 'text')
        row.setAttribute('x', String(TERM.x))
        row.setAttribute('y', (TERM.top + i * TERM.lineH).toFixed(2))
        group.appendChild(row)
        this.rows.push(row)
      }
    }
    root.addEventListener('mouseenter', this.onEnter)
    root.addEventListener('mouseleave', this.onLeave)
    // 挂载时立即执行一次姿态应用，确保非 live、初始渲染和无 pointer 移动时立刻就位
    this.apply(statePose(this.options.state, this.tPhase))
  }

  update(options: AvatarMotionOptions): void {
    const prevState = this.options.state
    this.options = options
    if (prevState !== options.state) {
      this.apply(statePose(options.state, this.tPhase))
    }
  }

  dispose(): void {
    this.root.removeEventListener('mouseenter', this.onEnter)
    this.root.removeEventListener('mouseleave', this.onLeave)
  }

  /** 旧消息、不在悬停、已回正且无状态动画时可跳过整帧。 */
  private settled(): boolean {
    return !this.options.live && !this.hovered && this.weight === 0
      && Math.abs(this.gx - DEFAULT_GAZE_X) < 1e-3 && Math.abs(this.gy - DEFAULT_GAZE_Y) < 1e-3
      && Math.abs(this.vx) < 1e-3 && Math.abs(this.vy) < 1e-3
  }

  tick(t: number, dt: number, mouseX: number, mouseY: number, reduced: boolean): void {
    if (reduced) {
      // 减弱动态：注视跟随与状态动作关闭，但保留 live idle 的周期眨眼（用户 2026-10-11 明确要求）。
      const scaleY = this.options.live && this.options.state === 'idle'
        ? statePose('idle', t + this.tPhase).scaleY
        : REST_SCALE_Y
      this.apply({
        gx: DEFAULT_GAZE_X,
        gy: DEFAULT_GAZE_Y,
        scaleY,
        nodY: 0,
        eyeOpacity: 1,
        scanY: -1,
        typing: false,
        rot: 0,
      })
      return
    }
    if (this.settled()) return

    const rect = this.root.getBoundingClientRect()
    const r = Math.max(rect.width, rect.height) / 2
    const dx = mouseX - (rect.left + rect.width / 2)
    const dy = mouseY - (rect.top + rect.height / 2)
    const dist = Math.hypot(dx, dy)

    const tier = SPEED_TIERS[this.options.speedTier ?? 'flow']

    // 触发区：头像内实时跟；头像外到 3r 慢一些跟（live 与非 live 一视同仁——侧栏等非 live
    // 头像也要在鼠标靠近时注视）；圈外回正。非 live 头像只有 hover 才进 inner。
    let zone: 'inner' | 'ring' | 'out' = 'out'
    if (this.hovered || (this.options.live && dist <= r)) zone = 'inner'
    else if (dist <= r * TRIGGER_MULT) zone = 'ring'

    let tx = DEFAULT_GAZE_X, ty = DEFAULT_GAZE_Y, settleMs = tier.returnMs
    if (zone !== 'out') {
      const k = 1 / Math.max(r, dist)
      tx = dx * k; ty = dy * k
      settleMs = zone === 'inner' ? tier.followMs : tier.followMs * tier.ringSlowdown
    }
    const omega = 5.8 / (settleMs / 1000)
    ;[this.gx, this.vx] = spring(this.gx, this.vx, tx, omega, dt)
    ;[this.gy, this.vy] = spring(this.gy, this.vy, ty, omega, dt)
    const vmax = 2 / ((tier.followMs / 1000) * 0.6)
    const speed = Math.hypot(this.vx, this.vy)
    if (speed > vmax) { this.vx *= vmax / speed; this.vy *= vmax / speed }

    const step = dt / (BLEND_MS / 1000)
    const target = zone === 'out' ? 0 : 1
    this.weight += Math.max(-step, Math.min(step, target - this.weight))
    const w = easeInOutCubic(this.weight)

    // 非 live 头像没有状态动画，只有 idle 静止姿态（不眨眼）。
    const base = this.options.live
      ? statePose(this.options.state, t + this.tPhase)
      : { ...statePose('idle', 0), scaleY: REST_SCALE_Y, gx: DEFAULT_GAZE_X, gy: DEFAULT_GAZE_Y, rot: 0, nodY: 0 }
    // 没有终端输出层（圆形头像）时，输出中不隐藏眼睛，只低头点头、双眼变暗。
    if (base.typing && !this.layers.typing) { base.typing = false; base.eyeOpacity = 0.42 }
    this.apply({
      gx: base.gx * (1 - w) + this.gx * w,
      gy: base.gy * (1 - w) + this.gy * w,
      scaleY: base.scaleY * (1 - w) + w,
      nodY: base.nodY * (1 - w),
      eyeOpacity: base.eyeOpacity * (1 - w) + w,
      scanY: base.scanY,
      typing: base.typing && w < 0.85,
      rot: (base.rot ?? 0) * (1 - w),
    }, base.typing ? dt : 0)
  }

  private apply(p: Pose, typingDt = 0): void {
    const L = this.layers
    const circle = this.options.style === 'circle'
    // 胶囊眼横移视觉比圆点更明显：终端档幅度略降，圆形保持可达圆边
    const eyeAmpX = circle ? 24.5 : 9.5
    const eyeAmpY = circle ? 20.0 : 7.5

    // 身体与机身微倾（思考倾斜、倾听侧耳、搜索摆头）
    const rot = p.rot ?? 0
    if (L.case) L.case.style.transform = rot ? `rotate(${rot.toFixed(2)}deg)` : ''
    if (L.bezel) L.bezel.style.transform = rot ? `rotate(${(rot * 0.8).toFixed(2)}deg)` : ''
    if (L.screen) L.screen.style.transform = rot ? `rotate(${(rot * 0.9).toFixed(2)}deg)` : ''

    // 单眼球面透视压缩：视线向圆边缘移动时，靠近圆弧的一侧眼睛受圆弧曲率透视压缩 (Foreshortening)
    const clampedGx = Math.max(-1, Math.min(1, p.gx))
    const compL = circle ? 1.0 - (clampedGx < 0 ? Math.abs(clampedGx) * 0.22 : 0) : 1
    const compR = circle ? 1.0 - (clampedGx > 0 ? Math.abs(clampedGx) * 0.22 : 0) : 1

    if (L.eyes) {
      const tx = (p.gx * eyeAmpX).toFixed(2)
      const ty = (p.gy * eyeAmpY + p.nodY).toFixed(2)
      const eyeRot = (rot * 0.6).toFixed(2)
      L.eyes.style.transform = `translate(${tx}px, ${ty}px) rotate(${eyeRot}deg)`
      L.eyes.style.opacity = p.eyeOpacity.toFixed(2)
    }

    // 单眼独立缩放（眨眼原地压扁、透视压缩）：分别以单眼中心为原点，避免整体缩放导致眨眼跳动
    if (L.eyeLeft) {
      L.eyeLeft.style.transform = `scale(${compL.toFixed(3)}, ${p.scaleY.toFixed(3)})`
    }
    if (L.eyeRight) {
      L.eyeRight.style.transform = `scale(${compR.toFixed(3)}, ${p.scaleY.toFixed(3)})`
    }
    if (!L.eyeLeft && !L.eyeRight && L.eyes) {
      L.eyes.style.transform += ` scaleY(${p.scaleY.toFixed(3)})`
    }

    if (L.scan) {
      L.scan.style.display = p.scanY > 0 ? 'block' : 'none'
      if (p.scanY > 0) L.scan.setAttribute('y', p.scanY.toFixed(1))
    }
    if (L.typing) {
      L.typing.style.display = p.typing ? 'block' : 'none'
      if (p.typing && L.typingRows) L.typingRows.setAttribute('transform', `translate(0 ${this.tickTyping(typingDt).toFixed(2)})`)
    }
  }

  /** hash/0101：逐字写满一行换行，满屏整屏上推；cli：循环片段逐行平滑上滚。返回内层平移量。 */
  private tickTyping(dt: number): number {
    if (!this.rows.length) return 0
    const T = this.term, effect = this.options.typingEffect
    if (T.effect !== effect) { T.effect = effect; T.lines = ['']; T.carry = 0; T.cliIndex = 0; T.cliElapsed = 0 }
    let shift = 0
    if (effect === 'cli') {
      T.cliElapsed += dt * 1000
      while (T.cliElapsed >= TERM.cliLineMs) {
        T.cliElapsed -= TERM.cliLineMs
        T.lines.push(CLI_SNIPPET[T.cliIndex++ % CLI_SNIPPET.length]!)
        if (T.lines.length > TERM.rows + 1) T.lines.shift()
      }
      const u = T.cliElapsed / TERM.cliLineMs
      shift = T.lines.length > TERM.rows ? -TERM.lineH * (u < 0.35 ? easeInOutCubic(u / 0.35) : 1) : 0
    } else {
      T.carry += dt * TERM.cps
      let n = Math.floor(T.carry)
      T.carry -= n
      while (n-- > 0) {
        let current = T.lines[T.lines.length - 1]!
        if (current.length >= TERM.cols) { T.lines.push(''); if (T.lines.length > TERM.rows) T.lines.shift(); current = '' }
        T.lines[T.lines.length - 1] = current + randChar(effect)
      }
    }
    const start = effect === 'cli' && T.lines.length > TERM.rows ? 0 : Math.max(0, T.lines.length - TERM.rows)
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i]!, text = T.lines[start + i] ?? ''
      if (row.textContent !== text) row.textContent = text
      // hash/0101 按满行宽度均匀铺开，左右留白一致；未写满的行按比例占宽。
      if (effect !== 'cli' && text) { row.setAttribute('textLength', ((TERM.width * text.length) / TERM.cols).toFixed(2)); row.setAttribute('lengthAdjust', 'spacing') }
      else row.removeAttribute('textLength')
    }
    return shift
  }
}

// 共享循环：一个 rAF、一个 pointermove 监听，服务所有已挂载头像；无头像时停转。
const avatars = new Set<AvatarMotion>()
let frame = 0
let last = 0
let mouseX = -1e4
let mouseY = -1e4
const onPointer = (event: PointerEvent) => { mouseX = event.clientX; mouseY = event.clientY }

function loop(now: number): void {
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000))
  last = now
  const reduced = prefersReducedMotion()
  for (const avatar of avatars) avatar.tick(now / 1000, dt, mouseX, mouseY, reduced)
  frame = avatars.size ? requestAnimationFrame(loop) : 0
}

export function attachAvatarMotion(root: HTMLElement, options: AvatarMotionOptions): AvatarMotionHandle {
  const avatar = new AvatarMotion(root, options)
  avatars.add(avatar)
  if (avatars.size === 1) window.addEventListener('pointermove', onPointer, { passive: true })
  if (!frame) { last = performance.now(); frame = requestAnimationFrame(loop) }
  return {
    update: next => avatar.update(next),
    dispose: () => {
      avatar.dispose()
      avatars.delete(avatar)
      if (!avatars.size) { window.removeEventListener('pointermove', onPointer); cancelAnimationFrame(frame); frame = 0 }
    },
  }
}
