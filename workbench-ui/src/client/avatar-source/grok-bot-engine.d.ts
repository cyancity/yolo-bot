export class GrokBotEngine {
  constructor(svg: SVGSVGElement, getConfig: () => Record<string, unknown>)
  frameId: number
  pointer: { clientX: number; clientY: number }
  frame(time: number): void
  stepFrame(seconds?: number): void
  setState(state: string, immediate?: boolean): void
  setPlaybackRate(rate: number): number
  setPaused(paused: boolean): boolean
  destroy(): void
}
