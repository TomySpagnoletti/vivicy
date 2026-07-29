import { act, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { SectionWorkflow } from "@/components/sidebar/section-workflow"
import { WORKFLOW_STAGES } from "@/components/workflow/workflow-stages"
import { renderWithIntl } from "@/test/render"

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

function stubFetch(extractionStatus: unknown = null, skillsReport: unknown = null, docPrepReport: unknown = null) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.includes("/api/control/prepare")) {
      return new Response(JSON.stringify({ ok: true, report: docPrepReport }), { status: 200 })
    }
    if (url.includes("/api/control/extract")) {
      return new Response(JSON.stringify({ ok: true, status: extractionStatus }), { status: 200 })
    }
    if (url.includes("/api/control/skills")) {
      return new Response(JSON.stringify({ ok: true, report: skillsReport }), { status: 200 })
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

describe("SectionWorkflow — full process view", () => {
  test("renders exactly the WORKFLOW_STAGES table, in order, every stage pending when nothing has run", async () => {
    renderWithIntl(<SectionWorkflow />)
    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))

    const rendered = () => [...document.querySelectorAll("[data-stage]")].map((el) => el.getAttribute("data-stage"))
    await waitFor(() => expect(rendered()).toEqual(WORKFLOW_STAGES.map((stage) => stage.id)))

    for (const el of document.querySelectorAll("[data-stage]")) {
      expect(el.textContent, `stage ${el.getAttribute("data-stage")}`).toMatch(/pending/)
    }
  })

  test("SP shows the doc-prep report summary and timestamp as evidence when present", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch(null, null, { phase: "green", summary: "doc-prep green: 3 placed, 1 rejected", updated_at: "2026-07-05T09:00:00Z" })
    )
    renderWithIntl(<SectionWorkflow />)
    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))

    const sp = await waitFor(() => document.querySelector('[data-stage="SP"]') as HTMLElement)
    await waitFor(() => expect(sp.textContent).toMatch(/doc-prep green: 3 placed, 1 rejected/))
    expect(sp.textContent).toMatch(/2026-07-05T09:00:00Z/)
    expect(sp.textContent).toMatch(/done/)
  })

  test("SK shows the skills report summary and timestamp as evidence when present", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch(null, { phase: "green", summary: "2 skills installed, 1 rejected", updated_at: "2026-07-04T09:00:00Z" })
    )
    renderWithIntl(<SectionWorkflow />)
    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))

    const sk = await waitFor(() => document.querySelector('[data-stage="SK"]') as HTMLElement)
    await waitFor(() => expect(sk.textContent).toMatch(/2 skills installed, 1 rejected/))
    expect(sk.textContent).toMatch(/2026-07-04T09:00:00Z/)
    expect(sk.textContent).toMatch(/done/)
  })

  test("shows the extraction phase and summary as evidence text for S6 when present", async () => {
    vi.stubGlobal("fetch", stubFetch({ phase: "green", summary: "extraction green: 8 issues", updated_at: "2026-07-02T10:00:00Z" }))
    renderWithIntl(<SectionWorkflow />)
    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))

    const s6 = await waitFor(() => document.querySelector('[data-stage="S6"]') as HTMLElement)
    await waitFor(() => expect(s6.textContent).toMatch(/extraction green: 8 issues/))
    expect(s6.textContent).toMatch(/2026-07-02T10:00:00Z/)
  })

  test("never fabricates evidence text for a stage with no data (S0 stays evidence-free)", async () => {
    renderWithIntl(<SectionWorkflow />)
    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))

    const s0 = await waitFor(() => document.querySelector('[data-stage="S0"]') as HTMLElement)
    expect(s0.querySelector("dl")).toBeNull()
  })

  test("S9 shows the issue-progress line once issues exist", async () => {
    vi.stubGlobal("fetch", stubFetch({ phase: "green" }))
    renderWithIntl(<SectionWorkflow />)
    await act(() => FakeEventSource.last?.emit({ ...IDLE_STATUS, issues_total: 8, issues_done: 3, gates: { pass: 3, fail: 1 } }))

    const s9 = await waitFor(() => document.querySelector('[data-stage="S9"]') as HTMLElement)
    await waitFor(() => expect(s9.textContent).toMatch(/3\/8 issues verified/))
    expect(s9.textContent).toMatch(/1 gate failing/)

    await act(() => FakeEventSource.last?.emit({ ...IDLE_STATUS, issues_total: 8, issues_done: 3, gates: { pass: 3, fail: 4 } }))
    await waitFor(() => expect(s9.textContent).toMatch(/4 gates failing/))
  })
})
