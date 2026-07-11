import "@testing-library/jest-dom/vitest"

// jsdom lacks ResizeObserver; Radix primitives (Tooltip, Select) construct one on mount.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverPolyfill {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverPolyfill as unknown as typeof ResizeObserver
}

// jsdom lacks pointer-capture/scroll methods; Radix Select and the message-scroller call them on mount/scroll and throw without these no-ops.
if (typeof Element !== "undefined") {
  const proto = Element.prototype as unknown as Record<string, unknown>
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {}
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {}
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {}
  if (!proto.scrollTo) proto.scrollTo = () => {}
}

// jsdom's default about:blank origin is opaque, so window.localStorage throws SecurityError without this in-memory shim.
if (typeof window !== "undefined" && !("localStorage" in window && window.localStorage)) {
  const createStorage = (): Storage => {
    const store = new Map<string, string>()
    return {
      get length() {
        return store.size
      },
      clear: () => store.clear(),
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      removeItem: (key: string) => void store.delete(key),
      setItem: (key: string, value: string) => void store.set(key, String(value)),
    }
  }
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createStorage(),
  })
}
