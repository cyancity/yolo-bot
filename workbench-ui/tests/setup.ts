// jsdom 缺 ResizeObserver（Radix/Floating UI 的测量依赖）；stub 成无操作实现。
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub
}

// jsdom 缺 matchMedia（antd-style / Lobe ThemeProvider 的断点与媒体查询）；stub 成永不匹配。
if (typeof window !== 'undefined' && typeof window.matchMedia === 'undefined') {
  const matchMediaStub = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })
  ;(window as unknown as Record<string, unknown>).matchMedia = matchMediaStub
}

// jsdom 缺 <dialog> 的 show/showModal/close（成果预览弹窗）；stub 成只切换 open 属性。
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.show) {
  HTMLDialogElement.prototype.show = function show() { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open') }
}

// Radix Select focuses the active item; jsdom has no layout scrolling implementation.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

