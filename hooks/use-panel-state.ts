"use client"

import { useCallback, useSyncExternalStore } from "react"

/**
 * The right panel has THREE states, cycled by the edge toggle on each click:
 *   peek   — narrow, just enough to scan (1)
 *   wide   — more room + readability (2)
 *   closed — fully offcanvas; the map reclaims the space (3)
 * The cycle is peek -> wide -> closed -> peek.
 */
export type PanelState = "peek" | "wide" | "closed"

/**
 * The two OPEN widths, driven into the shadcn Sidebar's `--sidebar-width`.
 * `peek` is today's comfortable default (what used to be `wide`); `wide` is
 * 1.5x that for the roomy reading state. The 3-state cycle itself is unchanged.
 */
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

/** Read the persisted state, or the default. Safe on the server (returns default). */
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

/**
 * A tiny external store for the panel state, backed by localStorage. The state
 * lives outside React so {@link useSyncExternalStore} can read it without a
 * lazy initializer (which would diverge from SSR) and without a setState-in-
 * effect (which the cascading-render lint rule forbids).
 *
 * `getServerSnapshot` deliberately returns the server-safe DEFAULT, so the
 * server HTML and the first client (hydration) render agree. React then swaps
 * in the real `getSnapshot` value right after hydration — a one-frame flip, not
 * a hydration mismatch.
 */
const listeners = new Set<() => void>()
// Cached so `getSnapshot` returns a stable reference between writes (React
// requires snapshot stability to avoid an infinite render loop).
let snapshot: PanelState | null = null

/**
 * The CLIENT snapshot: the live persisted value, cached for reference stability.
 * Exported for unit tests that assert hydration safety against the server one.
 */
export function getPanelStateSnapshot(): PanelState {
  if (snapshot === null) snapshot = readStoredState()
  return snapshot
}

/**
 * The SERVER snapshot: ALWAYS the default, never localStorage — this is what
 * keeps the first client (hydration) render in lock-step with the server HTML.
 * Exported so tests can prove it ignores a persisted non-default value.
 */
export function getPanelStateServerSnapshot(): PanelState {
  return DEFAULT_STATE
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Cross-tab/window sync: another tab changing the value updates this one.
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

/**
 * Drop the cached snapshot so a fresh read re-consults localStorage. Test-only —
 * lets a test clear storage and observe the default again without a stale cache.
 * Never used by app code.
 */
export function __resetPanelStateStoreForTests(): void {
  snapshot = null
}

/**
 * Owns the 3-state panel: the current state, the next state in the cycle (so the
 * toggle icon can reflect what the next click does), a cycle action, and the
 * derived width / open flag the shadcn Sidebar consumes.
 *
 * Hydration-safe by construction (see the store above): the first render uses
 * the server-safe {@link DEFAULT_STATE}; the persisted choice is applied right
 * after hydration via `useSyncExternalStore`, never during the first paint.
 */
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
  // When closed, fall back to the peek width so re-opening lands on peek (1).
  const width = PANEL_WIDTHS[state === "closed" ? "peek" : state]

  return {
    state,
    next: CYCLE[state],
    cycle,
    open,
    width,
    /** Drive the shadcn Sidebar's `open` prop from the panel state. */
    setOpen,
  }
}
