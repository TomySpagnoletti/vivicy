import { describe, expect, it } from "vitest"

import { cn } from "@/lib/utils"

describe("cn", () => {
  it("joins plain class strings", () => {
    expect(cn("a", "b", "c")).toBe("a b c")
  })

  it("drops falsy and conditional values", () => {
    // clsx semantics: false/null/undefined/"" are skipped, truthy survives.
    expect(cn("base", false, null, undefined, "", "kept")).toBe("base kept")
    const active = true
    const disabled = false
    expect(cn("btn", active && "btn-active", disabled && "btn-disabled")).toBe("btn btn-active")
  })

  it("flattens arrays and object syntax (clsx pass-through)", () => {
    expect(cn(["a", "b"], { c: true, d: false })).toBe("a b c")
  })

  it("dedupes conflicting tailwind utilities, last wins (twMerge)", () => {
    // Same property family: the later class overrides the earlier one.
    expect(cn("px-2", "px-4")).toBe("px-4")
    expect(cn("text-sm", "text-lg")).toBe("text-lg")
    expect(cn("p-2", "p-4", "p-6")).toBe("p-6")
  })

  it("keeps non-conflicting utilities from the same string", () => {
    // Different axes (padding-x vs padding-y) do not conflict.
    expect(cn("px-2 py-4")).toBe("px-2 py-4")
    expect(cn("text-red-500 bg-blue-500")).toBe("text-red-500 bg-blue-500")
  })

  it("resolves conflicts across conditional inputs (override a base class)", () => {
    // A common real usage: a base class overridden by a caller-supplied one.
    expect(cn("rounded-md bg-white", "bg-black")).toBe("rounded-md bg-black")
    const override = true
    expect(cn("text-sm", override && "text-base")).toBe("text-base")
  })

  it("returns an empty string for no/empty input", () => {
    expect(cn()).toBe("")
    expect(cn(false, null, undefined, "")).toBe("")
  })
})
