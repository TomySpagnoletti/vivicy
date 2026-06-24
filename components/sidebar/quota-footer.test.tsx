import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { QuotaFooter, formatReset } from "@/components/sidebar/quota-footer"

// Minimal EventSource fake so the footer can subscribe in jsdom. We capture the
// instance to push frames into onmessage as the SSE stream would.
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
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("formatReset", () => {
  const now = Date.UTC(2026, 5, 24, 12, 0, 0)
  test("renders hours+minutes and minutes-only, hides past/unknown", () => {
    expect(formatReset(new Date(now + (2 * 3600 + 14 * 60) * 1000).toISOString(), now)).toBe(
      "resets in 2h14"
    )
    expect(formatReset(new Date(now + 45 * 60 * 1000).toISOString(), now)).toBe("resets in 45m")
    expect(formatReset(new Date(now - 60_000).toISOString(), now)).toBeNull() // already past
    expect(formatReset(null, now)).toBeNull() // unknown
  })
})

describe("QuotaFooter (honest live display)", () => {
  test("shows available agents from the live stream, no fabricated numbers", async () => {
    render(<QuotaFooter />)
    act(() => {
      FakeEventSource.last?.emit({
        quota: {
          agents: {
            claude: { model: "claude-opus-4-8", status: "available", reset_at: null, last_message: null },
            codex: { model: "gpt-5.5", status: "available", reset_at: null, last_message: null },
          },
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByText("Opus 4.8")).toBeInTheDocument()
    })
    // Both agents read "available".
    expect(screen.getAllByText("available")).toHaveLength(2)
    // HONEST: no usage percentage / progress bar anywhere — there is no real
    // remaining-quota number to show.
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(document.body.textContent).not.toMatch(/\d+%/)
  })

  test("derives each row's model + thinking label from the passed settings", async () => {
    // Non-default settings prove the labels are DERIVED, not hardcoded: the
    // implementer's effort is "max" and the reviewer's model id is a custom
    // string (unknown to friendlyModel => shown raw, never fabricated).
    render(
      <QuotaFooter
        settings={{
          implementer: { provider: "claude", model: "claude-opus-4-8", effort: "max" },
          reviewer: { provider: "codex", model: "custom-codex-x", effort: "low" },
        }}
      />
    )
    act(() => {
      FakeEventSource.last?.emit({
        quota: {
          agents: {
            // The live quota model differs from settings; the footer must prefer
            // the configured model, not the reported one.
            claude: { model: "claude-old", status: "available", reset_at: null, last_message: null },
            codex: { model: "gpt-old", status: "available", reset_at: null, last_message: null },
          },
        },
      })
    })

    await waitFor(() => {
      // Implementer: friendly name from the configured model + configured effort.
      expect(screen.getByText("Opus 4.8")).toBeInTheDocument()
    })
    expect(screen.getByText(/· max/)).toBeInTheDocument()
    // Reviewer: unknown model id shown raw (honest), configured effort.
    expect(screen.getByText("custom-codex-x")).toBeInTheDocument()
    expect(screen.getByText(/· low/)).toBeInTheDocument()
    // The reported (quota-state) models must NOT win over settings.
    expect(screen.queryByText("claude-old")).toBeNull()
    expect(screen.queryByText("gpt-old")).toBeNull()
  })

  test("shows a throttled badge + reset countdown when an agent is rate-limited", async () => {
    render(<QuotaFooter />)
    const resetAt = new Date(Date.now() + (2 * 3600 + 14 * 60) * 1000).toISOString()
    act(() => {
      FakeEventSource.last?.emit({
        quota: {
          agents: {
            claude: {
              model: "claude-opus-4-8",
              status: "throttled",
              reset_at: resetAt,
              last_message: "rate limit: resets at 14:14",
            },
          },
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByText("throttled")).toBeInTheDocument()
    })
    expect(screen.getByText("resets in 2h14")).toBeInTheDocument()
    // Still no fabricated percentage.
    expect(document.body.textContent).not.toMatch(/\d+%/)
  })

  test("renders a neutral placeholder when no quota is known yet", () => {
    render(<QuotaFooter />)
    // No frame emitted: empty agents map -> a sober placeholder, not fake bars.
    expect(screen.getByText(/Agent quota status appears here/i)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/\d+%/)
  })
})
