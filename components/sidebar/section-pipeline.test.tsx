import { act, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { SectionPipeline } from "@/components/sidebar/section-pipeline"

class FakeEventSource {
  static last: FakeEventSource | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.last = this
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
  close() {
    this.closed = true
  }
}

const IDLE_STATUS = {
  run_active: false,
  verdict: "OK",
  issues_total: 0,
  issues_done: 0,
  gates: { pass: 0, fail: 0 },
}

function stubFetch(extractionStatus: unknown = null) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.includes("/api/control/extract")) {
      return new Response(JSON.stringify({ ok: true, status: extractionStatus }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource)
  FakeEventSource.last = null
  vi.stubGlobal("fetch", stubFetch())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("SectionPipeline — full process view", () => {
  test("renders all 13 stages with a pending badge when nothing has run", async () => {
    render(<SectionPipeline />)
    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))

    for (const id of ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12"]) {
      await waitFor(() => expect(document.querySelector(`[data-stage="${id}"]`)).toBeTruthy())
    }
    const s2 = document.querySelector('[data-stage="S2"]') as HTMLElement
    expect(s2.textContent).toMatch(/pending/)
  })

  test("shows the extraction phase and summary as evidence text for S6 when present", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({ phase: "green", summary: "extraction green: 8 issues", updated_at: "2026-07-02T10:00:00Z" })
    )
    render(<SectionPipeline />)
    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))

    const s6 = await waitFor(() => document.querySelector('[data-stage="S6"]') as HTMLElement)
    await waitFor(() => expect(s6.textContent).toMatch(/extraction green: 8 issues/))
    expect(s6.textContent).toMatch(/2026-07-02T10:00:00Z/)
  })

  test("never fabricates evidence text for a stage with no data (S0 stays evidence-free)", async () => {
    render(<SectionPipeline />)
    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))

    const s0 = await waitFor(() => document.querySelector('[data-stage="S0"]') as HTMLElement)
    expect(s0.querySelector("dl")).toBeNull()
  })

  test("S9 shows the issue-progress line once issues exist", async () => {
    vi.stubGlobal("fetch", stubFetch({ phase: "green" }))
    render(<SectionPipeline />)
    await act(() =>
      FakeEventSource.last?.emit({ ...IDLE_STATUS, issues_total: 8, issues_done: 3, gates: { pass: 3, fail: 1 } })
    )

    const s9 = await waitFor(() => document.querySelector('[data-stage="S9"]') as HTMLElement)
    await waitFor(() => expect(s9.textContent).toMatch(/3\/8 issues verified/))
    expect(s9.textContent).toMatch(/1 gate\(s\) failing/)
  })
})
