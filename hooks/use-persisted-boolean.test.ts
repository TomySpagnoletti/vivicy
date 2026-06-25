import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import {
  __resetPersistedBooleanStoresForTests,
  usePersistedBoolean,
} from "@/hooks/use-persisted-boolean"

const KEY = "vivicy:legend-open"

beforeEach(() => {
  window.localStorage.clear()
  __resetPersistedBooleanStoresForTests()
})
afterEach(() => {
  window.localStorage.clear()
  __resetPersistedBooleanStoresForTests()
})

describe("usePersistedBoolean — legend collapsed-state persistence", () => {
  test("defaults to false (collapsed) when nothing is persisted", () => {
    const { result } = renderHook(() => usePersistedBoolean(KEY, false))
    expect(result.current[0]).toBe(false)
  })

  test("setting true persists 'true' and exposes the new value", () => {
    const { result } = renderHook(() => usePersistedBoolean(KEY, false))
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    expect(window.localStorage.getItem(KEY)).toBe("true")
  })

  test("a fresh mount restores the persisted open state", () => {
    window.localStorage.setItem(KEY, "true")
    __resetPersistedBooleanStoresForTests()
    const { result } = renderHook(() => usePersistedBoolean(KEY, false))
    expect(result.current[0]).toBe(true)
  })

  test("setting false persists 'false' (an explicit collapse is remembered)", () => {
    window.localStorage.setItem(KEY, "true")
    __resetPersistedBooleanStoresForTests()
    const { result } = renderHook(() => usePersistedBoolean(KEY, false))
    expect(result.current[0]).toBe(true)
    act(() => result.current[1](false))
    expect(result.current[0]).toBe(false)
    expect(window.localStorage.getItem(KEY)).toBe("false")
  })
})
