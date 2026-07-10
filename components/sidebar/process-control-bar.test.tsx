import { act, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import {
  extractedGateMessage,
  ProcessControlBar,
} from "@/components/sidebar/process-control-bar"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { DevelopmentBlock, DevelopmentIssue } from "@/lib/types"
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

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource)
  FakeEventSource.last = null
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const IDLE_STATUS = {
  run_active: false,
  verdict: "OK",
  issues_total: 0,
  issues_done: 0,
  gates: { pass: 0, fail: 0 },
}

function renderBar(development?: DevelopmentBlock) {
  return renderWithIntl(
    <TooltipProvider>
      <ProcessControlBar development={development} />
    </TooltipProvider>
  )
}

function issues(n: number): DevelopmentIssue[] {
  return Array.from({ length: n }, (_, i) => ({ id: `ISS-${String(i + 1).padStart(4, "0")}` }))
}

describe("ProcessControlBar — Extract gating on already-extracted issues", () => {
  test("Extract is ENABLED when there are no issues yet", async () => {
    renderBar({ issues: [] })
    act(() => FakeEventSource.last?.emit(IDLE_STATUS))

    const extract = screen.getByRole("button", { name: "Extract" })
    await waitFor(() => expect(extract).toBeEnabled())
  })

  test("Extract is GREYED (aria-disabled) once issues exist for the target", async () => {
    renderBar({ issues: issues(8) })
    act(() => FakeEventSource.last?.emit(IDLE_STATUS))

    const extract = await screen.findByRole("button", { name: "Extract" })
    expect(extract).toHaveAttribute("aria-disabled", "true")
    expect(extract).toHaveClass("opacity-50")
    expect(extract).toHaveAttribute("data-slot", "tooltip-trigger")
    expect(extract).not.toHaveAttribute("disabled")
  })

  test("the greyed Extract carries the honest re-extraction message", () => {
    expect(extractedGateMessage(8)).toBe(
      "Already extracted — 8 issues. Re-extraction isn't available yet."
    )
  })

  test("activating the greyed Extract (click OR keyboard) does NOT POST to extract", async () => {
    const user = userEvent.setup()
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    renderBar({ issues: issues(3) })
    act(() => FakeEventSource.last?.emit(IDLE_STATUS))

    const extract = await screen.findByRole("button", { name: "Extract" })
    await user.click(extract).catch(() => undefined)
    extract.focus()
    await user.keyboard("[Enter]").catch(() => undefined)
    await user.keyboard("[Space]").catch(() => undefined)

    const calls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(calls.some((url) => url.includes("/api/control/extract"))).toBe(false)
  })

  test("singular wording when exactly one issue exists", () => {
    expect(extractedGateMessage(1)).toBe(
      "Already extracted — 1 issue. Re-extraction isn't available yet."
    )
    expect(extractedGateMessage(2)).toContain("2 issues")
  })
})
