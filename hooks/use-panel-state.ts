"use client"

import { useCallback, useSyncExternalStore } from "react"

export type PanelState = "peek" | "wide" | "closed"

export const PANEL_WIDTHS: Record<"peek" | "wide", string> = {
  peek: "24rem",
  wide: "36rem",
} as const

const CYCLE: Record<PanelState, PanelState> = {
  peek: "wide",
  wide: "closed",
  closed: "peek",
}

const STORAGE_KEY = "vivicy:panel-state"
const DEFAULT_STATE: PanelState = "peek"

function isPanelState(value: unknown): value is PanelState {
  return value === "peek" || value === "wide" || value === "closed"
}

function readStoredState(): PanelState {
  if (typeof window === "undefined") return DEFAULT_STATE
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isPanelState(stored) ? stored : DEFAULT_STATE
  } catch {
    return DEFAULT_STATE
  }
}

function writeStoredState(state: PanelState): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, state)
  } catch {
    // Private mode / disabled storage: persistence is best-effort.
  }
}

// Lives outside React (not useState+useEffect) so useSyncExternalStore avoids a hydration mismatch: server and first-client render both read the DEFAULT snapshot, and the real value swaps in only after hydration.
const listeners = new Set<() => void>()
// Cached: useSyncExternalStore requires a referentially stable snapshot between calls or it loops.
let snapshot: PanelState | null = null

export function getPanelStateSnapshot(): PanelState {
  if (snapshot === null) snapshot = readStoredState()
  return snapshot
}

export function getPanelStateServerSnapshot(): PanelState {
  return DEFAULT_STATE
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return
    snapshot = readStoredState()
    listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

function setPanelState(next: PanelState): void {
  if (snapshot === next) return
  snapshot = next
  writeStoredState(next)
  for (const listener of listeners) listener()
}

export function __resetPanelStateStoreForTests(): void {
  snapshot = null
}

export function usePanelState() {
  const state = useSyncExternalStore(
    subscribe,
    getPanelStateSnapshot,
    getPanelStateServerSnapshot
  )

  const cycle = useCallback(
    () => setPanelState(CYCLE[getPanelStateSnapshot()]),
    []
  )
  const setOpen = useCallback(
    (nextOpen: boolean) => setPanelState(nextOpen ? "peek" : "closed"),
    []
  )

  const open = state !== "closed"
  const width = PANEL_WIDTHS[state === "closed" ? "peek" : state]

  return {
    state,
    next: CYCLE[state],
    cycle,
    open,
    width,
    setOpen,
  }
}
