import '@testing-library/jest-dom/vitest'

class TestResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  disconnect(): void {
    // The shell tests do not need to observe browser layout changes.
  }

  observe(): void {
    // The shell tests assert semantic constraints rather than computed pixels.
  }

  unobserve(): void {
    // The shell tests do not retain observed elements.
  }
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: TestResizeObserver
})

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })
})
