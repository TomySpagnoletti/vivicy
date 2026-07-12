import { act, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { SectionCycles } from "@/components/sidebar/section-cycles"
import type { CyclesView } from "@/lib/cycles"
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

function stubFetch(cycles: CyclesView | null) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.includes("/api/control/cycles")) {
      return new Response(JSON.stringify({ ok: true, cycles }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource)
  FakeEventSource.last = null
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("SectionCycles — active cycle + history", () => {
  test("no cycle at all (target unresolved): only the empty-state guidance renders", async () => {
    vi.stubGlobal("fetch", stubFetch(null))
    renderWithIntl(<SectionCycles />)
    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))

    await waitFor(() => expect(document.body.textContent).toMatch(/No active cycle yet/))
    expect(document.querySelector('[data-cycle="active"]')).toBeNull()
  })

  test("active pre-freeze cycle shows kind, editable phase, and the pending-batch count", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({ active: { id: null, kind: "project", editable: true, pending_batches: 3 }, history: [] })
    )
    renderWithIntl(<SectionCycles />)
    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))

    const active = await waitFor(() => document.querySelector('[data-cycle="active"]') as HTMLElement)
    expect(active.textContent).toMatch(/Project/)
    expect(active.textContent).toMatch(/Pre-freeze · editable/)
    expect(active.textContent).toMatch(/3 batches pending/)
    expect(document.body.textContent).toMatch(/No past cycles yet/)
  })

  test("frozen cycle with an active run shows Building and the status-stream issue signal", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        active: { id: "cycle-ab12cd", kind: "feature", editable: false, pending_batches: 0 },
        history: [],
      })
    )
    renderWithIntl(<SectionCycles />)
    await act(() =>
      FakeEventSource.last?.emit({
        run_active: true,
        verdict: "OK",
        issues_total: 8,
        issues_done: 5,
        gates: { pass: 5, fail: 1 },
      })
    )

    const active = await waitFor(() => document.querySelector('[data-cycle="active"]') as HTMLElement)
    await waitFor(() => expect(active.textContent).toMatch(/Building/))
    expect(active.textContent).toMatch(/Feature/)
    expect(active.textContent).toMatch(/cycle-ab12cd/)
    expect(active.textContent).toMatch(/5\/8 issues verified/)
    expect(active.textContent).toMatch(/1 gate\(s\) failing/)
  })

  test("frozen cycle with every issue verified and no active run shows Done", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        active: { id: "cycle-done", kind: "feature", editable: false, pending_batches: 0 },
        history: [],
      })
    )
    renderWithIntl(<SectionCycles />)
    await act(() =>
      FakeEventSource.last?.emit({
        run_active: false,
        verdict: "OK",
        issues_total: 4,
        issues_done: 4,
        gates: { pass: 4, fail: 0 },
      })
    )

    const active = await waitFor(() => document.querySelector('[data-cycle="active"]') as HTMLElement)
    await waitFor(() => expect(active.textContent).toMatch(/Done/))
    expect(active.textContent).toMatch(/4\/4 issues verified/)
  })

  test("frozen cycle with no status frame yet shows Frozen and no issue signal", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        active: { id: "cycle-frozen", kind: "feature", editable: false, pending_batches: 0 },
        history: [],
      })
    )
    renderWithIntl(<SectionCycles />)

    await waitFor(() => expect(document.querySelector('[data-cycle="active"]')?.textContent).toMatch(/Frozen/))
    const active = document.querySelector('[data-cycle="active"]') as HTMLElement
    expect(active.textContent).not.toMatch(/issues verified/)
  })

  test("history lists past cycles with kind, version, outcome, and the closed date", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        active: { id: null, kind: "feature", editable: true, pending_batches: 0 },
        history: [
          {
            baseline_id: "baseline-v1.1.0",
            version: "1.1.0",
            kind: "feature",
            approval_ref: "cycle-later",
            closed_at: "2026-07-10T09:00:00Z",
            superseded: false,
          },
          {
            baseline_id: "baseline-v1.0.0",
            version: "1.0.0",
            kind: "project",
            approval_ref: "project",
            closed_at: "2026-07-01T09:00:00Z",
            superseded: true,
          },
        ],
      })
    )
    renderWithIntl(<SectionCycles />)
    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))

    const rows = await waitFor(() => {
      const found = document.querySelectorAll('[data-cycle="history"]')
      expect(found.length).toBe(2)
      return found
    })
    expect(rows[0].textContent).toMatch(/v1\.1\.0/)
    expect(rows[0].textContent).toMatch(/Feature/)
    expect(rows[0].textContent).toMatch(/frozen/)
    expect(rows[0].textContent).toMatch(/closed 2026-07-10/)
    expect(rows[1].textContent).toMatch(/v1\.0\.0/)
    expect(rows[1].textContent).toMatch(/Project/)
    expect(rows[1].textContent).toMatch(/superseded/)
  })
})
