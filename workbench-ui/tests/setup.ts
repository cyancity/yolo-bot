// jsdom 缺 ResizeObserver（Radix/Floating UI 的测量依赖）；stub 成无操作实现。
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub
}
