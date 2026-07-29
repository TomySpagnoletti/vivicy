import { describe, expect, it } from "vitest"

import { countForm, countOf } from "@/lib/count-form"

describe("countForm", () => {
  it("switches on exactly one, so zero and every count above one take the many form", () => {
    expect(countForm(1, "It is", "They are")).toBe("It is")
    expect(countForm(0, "It is", "They are")).toBe("They are")
    expect(countForm(2, "It is", "They are")).toBe("They are")
    expect(countForm(97, "It is", "They are")).toBe("They are")
  })

  it("returns each branch verbatim, so a caller's complete phrase never gets a suffix bolted on", () => {
    expect(countForm(1, "the single issue is delivered", "all 4 issues are delivered")).toBe("the single issue is delivered")
    expect(countForm(4, "the single issue is delivered", "all 4 issues are delivered")).toBe("all 4 issues are delivered")
  })
})

describe("countOf", () => {
  it("prefixes the count to the form the count selects", () => {
    expect(countOf(1, "gate", "gates")).toBe("1 gate")
    expect(countOf(0, "gate", "gates")).toBe("0 gates")
    expect(countOf(12, "gate", "gates")).toBe("12 gates")
  })

  it("carries irregular English morphology because both forms are spelled by the caller, never derived", () => {
    expect(countOf(1, "batch", "batches")).toBe("1 batch")
    expect(countOf(3, "batch", "batches")).toBe("3 batches")
    expect(countOf(1, "recurring class", "recurring classes")).toBe("1 recurring class")
    expect(countOf(2, "recurring class", "recurring classes")).toBe("2 recurring classes")
    expect(countOf(1, "entry", "entries")).toBe("1 entry")
    expect(countOf(5, "entry", "entries")).toBe("5 entries")
    expect(countOf(1, "match", "matches")).toBe("1 match")
    expect(countOf(7, "match", "matches")).toBe("7 matches")
  })
})
