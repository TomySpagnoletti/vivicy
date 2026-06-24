"use client"

import { useCallback, useEffect, useState } from "react"

/**
 * The right panel has THREE states, cycled by the edge toggle on each click:
 *   peek   — narrow, just enough to scan (1)
 *   wide   — more room + readability (2)
 *   closed — fully offcanvas; the map reclaims the space (3)
 * The cycle is peek -> wide -> closed -> peek.
 */
export type PanelState = "peek" | "wide" | "closed"

/** The two OPEN widths, driven into the shadcn Sidebar's `--sidebar-width`. */
export const PANEL_WIDTHS: Record<"peek" | "wide", string> = {
  peek: "15rem",
  wide: "24rem",
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
 * Owns the 3-state panel: the current state, the next state in the cycle (so the
 * toggle icon can reflect what the next click does), a cycle action, and the
 * derived width / open flag the shadcn Sidebar consumes. The chosen state is
 * persisted to localStorage and restored via a lazy initializer (no
 * setState-in-effect), then written on every change.
 */
export function usePanelState() {
  const [state, setState] = useState<PanelState>(readStoredState)

  // Persist on every change (cheap; the value is a tiny enum string).
  useEffect(() => {
    writeStoredState(state)
  }, [state])

  const cycle = useCallback(() => setState((prev) => CYCLE[prev]), [])

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
    setOpen: (nextOpen: boolean) => setState(nextOpen ? "peek" : "closed"),
  }
}
