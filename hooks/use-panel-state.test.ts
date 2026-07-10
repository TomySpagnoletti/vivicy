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
  __resetPanelStateStoreForTests()
})
afterEach(() => {
  window.localStorage.clear()
  __resetPanelStateStoreForTests()
})

describe("usePanelState — widths", () => {
  test("exposes the grown open widths: peek 24rem (old wide), wide 36rem (1.5x)", () => {
    expect(PANEL_WIDTHS.peek).toBe("24rem")
    expect(PANEL_WIDTHS.wide).toBe("36rem")
    expect(parseFloat(PANEL_WIDTHS.wide)).toBeCloseTo(
      parseFloat(PANEL_WIDTHS.peek) * 1.5
    )
  })
})

describe("usePanelState — hydration safety (default-first)", () => {
  test("the server snapshot is the DEFAULT even when a non-default value is persisted", () => {
    window.localStorage.setItem("vivicy:panel-state", "wide")
    __resetPanelStateStoreForTests()

    expect(getPanelStateServerSnapshot()).toBe("peek")
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

    expect(result.current.state).toBe("peek")
    expect(result.current.open).toBe(true)
    expect(result.current.width).toBe(PANEL_WIDTHS.peek)
    expect(result.current.next).toBe("wide")

    act(() => result.current.cycle())
    expect(result.current.state).toBe("wide")
    expect(result.current.open).toBe(true)
    expect(result.current.width).toBe(PANEL_WIDTHS.wide)
    expect(result.current.next).toBe("closed")

    act(() => result.current.cycle())
    expect(result.current.state).toBe("closed")
    expect(result.current.open).toBe(false)
    expect(result.current.width).toBe(PANEL_WIDTHS.peek)
    expect(result.current.next).toBe("peek")

    act(() => result.current.cycle())
    expect(result.current.state).toBe("peek")
    expect(result.current.open).toBe(true)
  })

  test("setOpen(false) closes; setOpen(true) reopens to peek", () => {
    const { result } = renderHook(() => usePanelState())
    act(() => result.current.cycle())
    act(() => result.current.setOpen(false))
    expect(result.current.state).toBe("closed")
    act(() => result.current.setOpen(true))
    expect(result.current.state).toBe("peek")
  })

  test("persists the chosen state to localStorage and restores it on mount", () => {
    const first = renderHook(() => usePanelState())
    act(() => first.result.current.cycle())
    expect(window.localStorage.getItem("vivicy:panel-state")).toBe("wide")

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
