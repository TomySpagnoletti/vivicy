import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { PANEL_WIDTHS, usePanelState } from "@/hooks/use-panel-state"

beforeEach(() => window.localStorage.clear())
afterEach(() => window.localStorage.clear())

describe("usePanelState — 3-state cycle", () => {
  test("cycles peek -> wide -> closed -> peek on each toggle", () => {
    const { result } = renderHook(() => usePanelState())

    // Default first state is peek (narrow), open, peek width.
    expect(result.current.state).toBe("peek")
    expect(result.current.open).toBe(true)
    expect(result.current.width).toBe(PANEL_WIDTHS.peek)
    expect(result.current.next).toBe("wide")

    // peek -> wide: still open, wider width.
    act(() => result.current.cycle())
    expect(result.current.state).toBe("wide")
    expect(result.current.open).toBe(true)
    expect(result.current.width).toBe(PANEL_WIDTHS.wide)
    expect(result.current.next).toBe("closed")

    // wide -> closed: panel offcanvas; width falls back to peek so reopening
    // lands on the narrow state.
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

    // A fresh mount restores the persisted state.
    const second = renderHook(() => usePanelState())
    expect(second.result.current.state).toBe("wide")
    expect(second.result.current.width).toBe(PANEL_WIDTHS.wide)
  })

  test("ignores a corrupt persisted value and falls back to the default", () => {
    window.localStorage.setItem("vivicy:panel-state", "bogus")
    const { result } = renderHook(() => usePanelState())
    expect(result.current.state).toBe("peek")
  })
})
