/** Morph Bot 的 React 生命周期适配；SVG、形体、表情和材质均由真源引擎驱动。 */
import { GrokBotEngine } from './avatar-source/grok-bot-engine.js'
import { ORIGINAL_STATE_DATA } from './avatar-source/original-data.js'

export type AvatarMotionState =
  | 'idle' | 'sleeping' | 'waking' | 'listening' | 'thinking'
  | 'searching' | 'working' | 'tool' | 'typing'
export type AvatarSpeedTier = 'flow' | 'sidebar'
export type BotMaterial = 'solid' | 'gradient' | 'rainbow-glass'

export interface AvatarMotionOptions {
  readonly state: AvatarMotionState
  readonly live: boolean
  readonly speedTier?: AvatarSpeedTier | undefined
  readonly material: BotMaterial
  readonly color: string
  readonly eyeColor: string
  readonly preset: string
  readonly size: number
}

export interface AvatarMotionHandle {
  update(options: AvatarMotionOptions): void
  dispose(): void
}

export function avatarSvgTemplate(id: string): string {
  return `<svg id="${id}" class="grok-bot-mark" viewBox="-15 -15 259 259" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><clipPath id="${id}-head-clip"><path id="${id}-head-clip-path"></path></clipPath></defs>
    <g id="${id}-particles-back" aria-hidden="true"></g>
    <path class="grok-bot-mark__head morph-head" hidden></path>
    <path class="grok-bot-mark__head morph-head" hidden></path>
    ${Array.from({ length: 5 }, () => '<circle class="morph-ring" cx="114.2705" cy="114.2705" r="0" hidden></circle>').join('')}
    ${Array.from({ length: 5 }, () => '<circle class="grok-bot-mark__head morph-part" cx="114.2705" cy="114.2705" r="0" hidden></circle>').join('')}
    ${Array.from({ length: 3 }, () => '<path class="morph-glyph" hidden></path>').join('')}
    <g id="${id}-bot-transform">
      <path id="${id}-head-path" class="grok-bot-mark__head"></path>
      <g clip-path="url(#${id}-head-clip)">
        <path class="grok-bot-mark__eye eye-path"></path>
        <path class="grok-bot-mark__eye eye-path"></path>
      </g>
      <circle id="${id}-notify-badge" cx="114.2705" cy="114.2705" r="0" hidden></circle>
    </g>
    <g id="${id}-particles-front" aria-hidden="true"></g>
  </svg>`
}

const normalizeState = (state: AvatarMotionState) => state === 'tool' ? 'searching' : state === 'typing' ? 'working' : state

export function attachAvatarMotion(root: HTMLElement, initial: AvatarMotionOptions): AvatarMotionHandle {
  const svg = root.querySelector<SVGSVGElement>('svg')!
  let options = initial
  let hovered = false
  let visible = true
  let destroyed = false
  let running = false
  let staticPoseDirty = true
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let engine: GrokBotEngine | undefined

  const config = () => {
    const state = normalizeState(options.state)
    const bounds = svg.getBoundingClientRect()
    const pointer = engine?.pointer
    const distance = pointer ? Math.hypot(pointer.clientX - bounds.left - bounds.width / 2, pointer.clientY - bounds.top - bounds.height / 2) : Infinity
    return {
      color: options.color,
      material: options.material,
      gradientPreset: options.preset,
      glassPreset: options.preset,
      eyeColor: options.eyeColor,
      shape: 'blob',
      size: options.size,
      flipX: false,
      pointer: !reducedMotion.matches && (hovered || (options.live && distance < bounds.width * 3)),
      badgeColor: '#1d9bf0', badgeScale: 1,
      particlesEnabled: options.size >= 64,
      expressionPool: ORIGINAL_STATE_DATA.EXPRESSION_POOLS[state] ?? [0],
      expressionWeights: {},
      expressionCadence: ORIGINAL_STATE_DATA.EXPRESSION_CADENCE[state] ?? [9000, 16000],
      blinkCadence: ORIGINAL_STATE_DATA.BLINK_CADENCE[state] ?? null,
      morph: state === 'thinking' ? 'dots' : 'none',
      headX: 0, headY: 0, headRotation: 0,
      scaleX: 1, scaleY: 1, eyeOpen: 1, eyeScale: 1,
      gazeScale: 1, motionScale: 1, tempo: 1,
    }
  }
  engine = new GrokBotEngine(svg, config)
  engine.setState(normalizeState(options.state), true)

  const sync = () => {
    if (destroyed || !engine) return
    const nextRunning = visible && !reducedMotion.matches && (options.live || hovered)
    engine.setPlaybackRate(options.speedTier === 'sidebar' ? 0.65 : 1)
    engine.setPaused(!nextRunning)
    cancelAnimationFrame(engine.frameId)
    if (!nextRunning && (running || staticPoseDirty)) {
      // Advance the source state machine and springs to a settled snapshot. A paused
      // frame has zero simulation delta, so sleeping would otherwise retain idle eyes.
      for (const seconds of [1.5, 0.25, 0.25]) {
        engine.stepFrame(seconds)
        engine.frame(performance.now())
        cancelAnimationFrame(engine.frameId)
      }
    } else {
      engine.frame(performance.now())
      if (!nextRunning) cancelAnimationFrame(engine.frameId)
    }
    staticPoseDirty = false
    running = nextRunning
  }
  const onEnter = () => { hovered = true; sync() }
  const onLeave = () => { hovered = false; sync() }
  const onMotionChange = () => { staticPoseDirty = true; sync() }
  root.addEventListener('pointerenter', onEnter)
  root.addEventListener('pointerleave', onLeave)
  reducedMotion.addEventListener('change', onMotionChange)
  const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true
    sync()
  })
  observer?.observe(root)
  sync()

  return {
    update(next) {
      const previousState = normalizeState(options.state)
      options = next
      const nextState = normalizeState(next.state)
      if (previousState !== nextState) {
        staticPoseDirty = true
        engine?.setState(nextState)
      }
      sync()
    },
    dispose() {
      destroyed = true
      observer?.disconnect()
      reducedMotion.removeEventListener('change', onMotionChange)
      root.removeEventListener('pointerenter', onEnter)
      root.removeEventListener('pointerleave', onLeave)
      if (running) engine?.setPaused(true)
      engine?.destroy()
      engine = undefined
    },
  }
}
