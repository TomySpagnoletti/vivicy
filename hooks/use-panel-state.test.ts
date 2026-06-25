import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import {
  __resetPanelStateStoreForTests,
  getPanelStateServerSnapshot,
  getPanelStateSnapshot,
  PANEL_WIDTHS,
  usePanelState,
} from "@/hooks/use-panel-state"

beforeEach(() => {
  window.localStorage.clear()
  // Drop the module-level snapshot cache so each test starts from storage.
  __resetPanelStateStoreForTests()
})
afterEach(() => {
  window.localStorage.clear()
  __resetPanelStateStoreForTests()
})

describe("usePanelState — widths", () => {
  test("exposes the grown open widths: peek 24rem (old wide), wide 36rem (1.5x)", () => {
    // The owner widened the panel: today's WIDE became the DEFAULT (peek), and
    // a new WIDE is 1.5x that. These are the values the shadcn Sidebar consumes.
    expect(PANEL_WIDTHS.peek).toBe("24rem")
    expect(PANEL_WIDTHS.wide).toBe("36rem")
    // wide is exactly 1.5x peek.
    expect(parseFloat(PANEL_WIDTHS.wide)).toBeCloseTo(
      parseFloat(PANEL_WIDTHS.peek) * 1.5
    )
  })
})

describe("usePanelState — hydration safety (default-first)", () => {
  test("the server snapshot is the DEFAULT even when a non-default value is persisted", () => {
    // Persist `wide` — the exact case that triggered the reported hydration bug
    // (server rendered 15rem/peek, client read 24rem/wide).
    window.localStorage.setItem("vivicy:panel-state", "wide")
    __resetPanelStateStoreForTests()

    // The SSR snapshot must NOT consult localStorage, so the server HTML and the
    // first client (hydration) render agree on --sidebar-width.
    expect(getPanelStateServerSnapshot()).toBe("peek")
    // The CLIENT snapshot does reflect the persisted value (applied right after
    // hydration), so the panel ends up where the user left it.
    expect(getPanelStateSnapshot()).toBe("wide")
  })

  test("rendered hook reflects the persisted value (post-hydration)", () => {
    window.localStorage.setItem("vivicy:panel-state", "wide")
    __resetPanelStateStoreForTests()
    const { result } = renderHook(() => usePanelState())
    expect(result.current.state).toBe("wide")
    expect(result.current.width).toBe(PANEL_WIDTHS.wide)
  })
})

describe("usePanelState — 3-state cycle", () => {
  test("cycles peek -> wide -> closed -> peek on each toggle", () => {
    const { result } = renderHook(() => usePanelState())

    // Default first state is peek (the comfortable default), open, peek width.
    expect(result.current.state).toBe("peek")
    expect(result.current.open).toBe(true)
    expect(result.current.width).toBe(PANEL_WIDTHS.peek)
    expect(result.current.next).toBe("wide")

    // peek -> wide: still open, the wider 36rem width.
    act(() => result.current.cycle())
    expect(result.current.state).toBe("wide")
    expect(result.current.open).toBe(true)
    expect(result.current.width).toBe(PANEL_WIDTHS.wide)
    expect(result.current.next).toBe("closed")

    // wide -> closed: panel offcanvas; width falls back to peek so reopening
    // lands on the comfortable default.
    act(() => result.current.cycle())
    expect(result.current.state).toBe("closed")
    expect(result.current.open).toBe(false)
    expect(result.current.width).toBe(PANEL_WIDTHS.peek)
    expect(result.current.next).toBe("peek")

    // closed -> peek: back to the start.
    act(() => result.current.cycle())
    expect(result.current.state).toBe("peek")
    expect(result.current.open).toBe(true)
  })

  test("setOpen(false) closes; setOpen(true) reopens to peek", () => {
    const { result } = renderHook(() => usePanelState())
    act(() => result.current.cycle()) // -> wide
    act(() => result.current.setOpen(false))
    expect(result.current.state).toBe("closed")
    act(() => result.current.setOpen(true))
    expect(result.current.state).toBe("peek")
  })

  test("persists the chosen state to localStorage and restores it on mount", () => {
    const first = renderHook(() => usePanelState())
    act(() => first.result.current.cycle()) // peek -> wide
    expect(window.localStorage.getItem("vivicy:panel-state")).toBe("wide")

    // A fresh mount restores the persisted state (the store keeps the value).
    const second = renderHook(() => usePanelState())
    expect(second.result.current.state).toBe("wide")
    expect(second.result.current.width).toBe(PANEL_WIDTHS.wide)
  })

  test("ignores a corrupt persisted value and falls back to the default", () => {
    window.localStorage.setItem("vivicy:panel-state", "bogus")
    __resetPanelStateStoreForTests()
    const { result } = renderHook(() => usePanelState())
    expect(result.current.state).toBe("peek")
  })
})
