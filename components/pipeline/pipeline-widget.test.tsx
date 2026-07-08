import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { PipelineWidget } from "@/components/pipeline/pipeline-widget"
import { TooltipProvider } from "@/components/ui/tooltip"
import pipeline from "@/messages/en/pipeline.json"

// Minimal EventSource fake so the widget can subscribe to the SSE status stream
// in jsdom, mirroring components/sidebar/process-control-bar.test.tsx.
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

function stubFetch(extractionStatus: unknown = null, skillsReport: unknown = null) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.includes("/api/control/extract") && !url.includes("retry-stage")) {
      return new Response(JSON.stringify({ ok: true, status: extractionStatus }), { status: 200 })
    }
    if (url.includes("/api/control/skills")) {
      return new Response(JSON.stringify({ ok: true, report: skillsReport }), { status: 200 })
    }
    if (url.includes("/api/control/retry-stage")) {
      return new Response(JSON.stringify({ ok: true, summary: "green" }), { status: 200 })
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

function renderWidget() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ pipeline }}>
      <TooltipProvider>
        <PipelineWidget />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

describe("PipelineWidget — renders the full §3 stage strip", () => {
  test("renders all 14 stages (incl. SK), expanded while active", async () => {
    renderWidget()
    await act(() => FakeEventSource.last?.emit({ ...IDLE_STATUS, run_active: true, issues_total: 8, issues_done: 2 }))

    for (const id of ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "SK", "S8", "S9", "S10", "S11", "S12"]) {
      await waitFor(() => expect(document.querySelector(`[data-stage="${id}"]`)).toBeTruthy())
    }
  })

  test("renders the non-loop/dev-loop boundary between S1 and S2", async () => {
    renderWidget()
    await act(() => FakeEventSource.last?.emit({ ...IDLE_STATUS, run_active: true }))
    await waitFor(() => expect(document.querySelector("[data-boundary]")).toBeTruthy())

    const container = document.querySelector("[data-pipeline-widget]") as HTMLElement
    const children = Array.from(container.querySelectorAll("[data-stage], [data-boundary]"))
    const order = children.map((el) => el.getAttribute("data-stage") ?? "BOUNDARY")
    const boundaryIndex = order.indexOf("BOUNDARY")
    expect(order[boundaryIndex - 1]).toBe("S1")
    expect(order[boundaryIndex + 1]).toBe("S2")
  })

  test("collapsed by default when idle (no active run, no extraction status)", async () => {
    renderWidget()
    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))
    await waitFor(() => expect(document.querySelector('[data-stage="S9"]')).toBeNull())
  })

  test("expanded by default when a run is active", async () => {
    renderWidget()
    await act(() => FakeEventSource.last?.emit({ ...IDLE_STATUS, run_active: true }))
    await waitFor(() => expect(document.querySelector('[data-stage="S9"]')).toBeTruthy())
  })
})

describe("PipelineWidget — state classes reflect the derived truth", () => {
  test("a running stage carries data-stage-state=running", async () => {
    vi.stubGlobal("fetch", stubFetch({ phase: "authoring" }))
    renderWidget()
    await act(() => FakeEventSource.last?.emit({ ...IDLE_STATUS, run_active: true }))

    await waitFor(() =>
      expect(document.querySelector('[data-stage="S6"]')).toHaveAttribute("data-stage-state", "running")
    )
  })

  test("a blocked extraction carries data-stage-state=red on S6", async () => {
    vi.stubGlobal("fetch", stubFetch({ phase: "extraction_blocked" }))
    renderWidget()
    await act(() => FakeEventSource.last?.emit({ ...IDLE_STATUS, run_active: true }))

    await waitFor(() =>
      expect(document.querySelector('[data-stage="S6"]')).toHaveAttribute("data-stage-state", "red")
    )
  })

  test("SK reflects the skills report: running while auditing, red on failed", async () => {
    vi.stubGlobal("fetch", stubFetch({ phase: "green" }, { phase: "auditing" }))
    renderWidget()
    await act(() => FakeEventSource.last?.emit({ ...IDLE_STATUS, run_active: true }))
    await waitFor(() =>
      expect(document.querySelector('[data-stage="SK"]')).toHaveAttribute("data-stage-state", "running")
    )

    vi.stubGlobal("fetch", stubFetch({ phase: "green" }, { phase: "failed" }))
    await act(() => FakeEventSource.last?.emit({ ...IDLE_STATUS, run_active: true }))
    await waitFor(() =>
      expect(document.querySelector('[data-stage="SK"]')).toHaveAttribute("data-stage-state", "red")
    )
  })

  test("a failing gate mid-run carries data-stage-state=red on S9", async () => {
    vi.stubGlobal("fetch", stubFetch({ phase: "green" }))
    renderWidget()
    await act(() =>
      FakeEventSource.last?.emit({
        ...IDLE_STATUS,
        run_active: false,
        issues_total: 8,
        issues_done: 3,
        gates: { pass: 3, fail: 1 },
      })
    )

    await waitFor(() =>
      expect(document.querySelector('[data-stage="S9"]')).toHaveAttribute("data-stage-state", "red")
    )
  })
})

describe("PipelineWidget — retry confirm flow", () => {
  test("clicking Retry on S6 opens a confirm dialog, and confirming POSTs retry-stage", async () => {
    const user = userEvent.setup()
    const fetchMock = stubFetch({ phase: "extraction_blocked" })
    vi.stubGlobal("fetch", fetchMock)
    renderWidget()
    await act(() => FakeEventSource.last?.emit({ ...IDLE_STATUS, run_active: true }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry S6" })).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: "Retry S6" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(/Retry Extract issues\?/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole("button", { name: "Retry" }))

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(calls.some((url) => url.includes("/api/control/retry-stage"))).toBe(true)
    })
    const retryCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/control/retry-stage"))
    expect(retryCall?.[1]).toMatchObject({ method: "POST" })
    expect(JSON.parse((retryCall?.[1] as RequestInit).body as string)).toEqual({ stage: "extract" })
  })

  test("confirming Retry on SK POSTs retry-stage with stage=skills", async () => {
    const user = userEvent.setup()
    const fetchMock = stubFetch(null, { phase: "failed", summary: "1 audit failed" })
    vi.stubGlobal("fetch", fetchMock)
    renderWidget()
    await act(() => FakeEventSource.last?.emit({ ...IDLE_STATUS, run_active: true }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry SK" })).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: "Retry SK" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(/Retry Skills\?/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Retry" }))

    await waitFor(() => {
      const retryCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/control/retry-stage"))
      expect(retryCall).toBeTruthy()
      expect(JSON.parse((retryCall?.[1] as RequestInit).body as string)).toEqual({ stage: "skills" })
    })
  })

  test("cancelling the confirm dialog fires no fetch to retry-stage", async () => {
    const user = userEvent.setup()
    const fetchMock = stubFetch({ phase: "extraction_blocked" })
    vi.stubGlobal("fetch", fetchMock)
    renderWidget()
    await act(() => FakeEventSource.last?.emit({ ...IDLE_STATUS, run_active: true }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry S6" })).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: "Retry S6" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))

    const calls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(calls.some((url) => url.includes("/api/control/retry-stage"))).toBe(false)
  })

  test("a non-retryable stage (e.g. S4) has no Retry button, only a tooltip", async () => {
    renderWidget()
    await act(() => FakeEventSource.last?.emit({ ...IDLE_STATUS, run_active: true }))
    await waitFor(() => expect(document.querySelector('[data-stage="S4"]')).toBeTruthy())
    expect(screen.queryByRole("button", { name: "Retry S4" })).toBeNull()
  })
})
