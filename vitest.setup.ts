import "@testing-library/jest-dom/vitest"

// jsdom only exposes window.localStorage when the document has a concrete
// (non-opaque) origin; vitest's jsdom environment defaults to an opaque
// about:blank origin, so accessing window.localStorage throws a SecurityError.
// The panel-state hook and quota footer persist UI state there, so provide a
// minimal in-memory localStorage when the environment hasn't supplied one.
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
