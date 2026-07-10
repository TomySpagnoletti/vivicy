"use client"

import {
  useCallback,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react"

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
  } catch {}
}

export function __resetPersistedBooleanStoresForTests(): void {
  stores.clear()
}

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

function writeStore(
  key: string,
  defaultValue: boolean,
  action: SetStateAction<boolean>
): void {
  const store = storeFor(key, defaultValue)
  const current = store.value ?? readPersisted(key, defaultValue)
  const next = typeof action === "function" ? action(current) : action
  store.value = next
  if (current === next) return
  writePersisted(key, next)
  for (const listener of store.listeners) listener()
}

export function usePersistedBoolean(
  key: string,
  defaultValue: boolean
): [boolean, Dispatch<SetStateAction<boolean>>] {
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

  const setValue = useCallback<Dispatch<SetStateAction<boolean>>>(
    (action) => writeStore(key, defaultValue, action),
    [defaultValue, key]
  )

  return [value, setValue]
}
