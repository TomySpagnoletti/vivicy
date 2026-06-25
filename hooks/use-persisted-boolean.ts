"use client"

import { useCallback, useSyncExternalStore } from "react"

/**
 * A hydration-safe boolean persisted to localStorage, shared by collapsible UI
 * (e.g. the sidebar legend) that must default-first on the server and apply the
 * stored choice only after hydration.
 *
 * Built on {@link useSyncExternalStore}: `getServerSnapshot` returns the
 * `defaultValue`, so SSR and the first client (hydration) render agree; the
 * persisted value is swapped in right after hydration — never during the first
 * paint, and never via a setState-in-effect (which the cascading-render lint
 * rule forbids).
 *
 * Each `key` gets its own module-level store, so multiple components reading the
 * same key stay in sync (and across tabs via the `storage` event).
 */
interface BooleanStore {
  value: boolean | null
  readonly defaultValue: boolean
  readonly listeners: Set<() => void>
}

const stores = new Map<string, BooleanStore>()

function storeFor(key: string, defaultValue: boolean): BooleanStore {
  let store = stores.get(key)
  if (!store) {
    store = { value: null, defaultValue, listeners: new Set() }
    stores.set(key, store)
  }
  return store
}

function readPersisted(key: string, defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? defaultValue : raw === "true"
  } catch {
    return defaultValue
  }
}

function writePersisted(key: string, value: boolean): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // Private mode / disabled storage: persistence is best-effort.
  }
}

/** Reset every store. Test-only — never used by app code. */
export function __resetPersistedBooleanStoresForTests(): void {
  stores.clear()
}

// --- Module-level store operations (mirrors use-panel-state). ----------------
// Keeping mutation in free functions — not in hook-captured objects — avoids the
// `react-hooks/immutability` rule while keeping a single shared store per key.

function subscribeStore(
  key: string,
  defaultValue: boolean,
  listener: () => void
): () => void {
  const store = storeFor(key, defaultValue)
  store.listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== key) return
    store.value = readPersisted(key, defaultValue)
    listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    store.listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

function snapshotStore(key: string, defaultValue: boolean): boolean {
  const store = storeFor(key, defaultValue)
  if (store.value === null) store.value = readPersisted(key, defaultValue)
  return store.value
}

function writeStore(key: string, defaultValue: boolean, next: boolean): void {
  const store = storeFor(key, defaultValue)
  if (store.value === next) return
  store.value = next
  writePersisted(key, next)
  for (const listener of store.listeners) listener()
}

export function usePersistedBoolean(
  key: string,
  defaultValue: boolean
): [boolean, (next: boolean) => void] {
  const subscribe = useCallback(
    (listener: () => void) => subscribeStore(key, defaultValue, listener),
    [defaultValue, key]
  )
  const getSnapshot = useCallback(
    () => snapshotStore(key, defaultValue),
    [defaultValue, key]
  )
  const getServerSnapshot = useCallback(() => defaultValue, [defaultValue])

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const setValue = useCallback(
    (next: boolean) => writeStore(key, defaultValue, next),
    [defaultValue, key]
  )

  return [value, setValue]
}
