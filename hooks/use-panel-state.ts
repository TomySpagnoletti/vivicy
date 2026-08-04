"use client"

import { useCallback, useEffect, useSyncExternalStore } from "react"

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
  } catch {}
}

const listeners = new Set<() => void>()
// Cache the snapshot: useSyncExternalStore loops unless it is referentially stable between calls.
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
  mountedRails = 0
  railSnapshot = false
}

// The rail is mounted by ONE surface (the workspace's ready state) while the toaster lives in the root layout above every surface: presence, not the persisted panel state, is what may push the stack off centre — a launcher or a govern gate has no rail to clear.
let mountedRails = 0
let railSnapshot = false
const railListeners = new Set<() => void>()

function publishRail(): void {
  const next = mountedRails > 0
  if (next === railSnapshot) return
  railSnapshot = next
  for (const listener of railListeners) listener()
}

function subscribeRail(listener: () => void): () => void {
  railListeners.add(listener)
  return () => {
    railListeners.delete(listener)
  }
}

// Declared by the rail itself, so a surface that renders no rail can never claim one.
export function useDeclareRail(): void {
  useEffect(() => {
    mountedRails += 1
    publishRail()
    return () => {
      mountedRails -= 1
      publishRail()
    }
  }, [])
}

export function useRailPresent(): boolean {
  return useSyncExternalStore(
    subscribeRail,
    () => railSnapshot,
    () => false
  )
}

export function usePanelState() {
  const state = useSyncExternalStore(subscribe, getPanelStateSnapshot, getPanelStateServerSnapshot)

  const cycle = useCallback(() => setPanelState(CYCLE[getPanelStateSnapshot()]), [])
  const setOpen = useCallback((nextOpen: boolean) => setPanelState(nextOpen ? "peek" : "closed"), [])

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
