import { act, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { QuotaFooter, formatReset } from "@/components/sidebar/quota-footer"
import { renderWithIntl } from "@/test/render"

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
  window.localStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

// A future ISO time so reset countdowns render.
const future = (h: number, m = 0) => new Date(Date.now() + (h * 3600 + m * 60) * 1000).toISOString()

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

describe("QuotaFooter — real % where available, honest — where not", () => {
  test("collapsed: REAL Codex percentages, honest — for the unknown weekly", async () => {
    renderWithIntl(<QuotaFooter />)
    act(() => {
      FakeEventSource.last?.emit({
        quota: {
          agents: {
            // Codex exposes real % for BOTH windows (its rollout rate_limits).
            codex: {
              model: "gpt-5.5",
              status: "available",
              reset_at: null,
              last_message: null,
              windows: {
                "5h": { used_pct: 38, remaining: 62, reset_at: future(2, 14) },
                weekly: { used_pct: 12, remaining: 88, reset_at: future(40) },
              },
            },
            // Claude exposes a 5h reset but NO percentage; weekly is unknown.
            claude: {
              model: "claude-opus-4-8",
              status: "available",
              reset_at: null,
              last_message: null,
              windows: { "5h": { used_pct: null, remaining: null, reset_at: future(3) } },
            },
          },
        },
      })
    })

    await waitFor(() => expect(screen.getByText("Opus 4.8")).toBeInTheDocument())
    // Real Codex numbers appear honestly.
    expect(screen.getByText(/5h 38%/)).toBeInTheDocument()
    expect(screen.getByText(/wk 12%/)).toBeInTheDocument()
    // Claude has no percentage anywhere => "—" for both windows.
    expect(screen.getByText(/5h —/)).toBeInTheDocument()
    expect(screen.getByText(/wk —/)).toBeInTheDocument()
    // Collapsed view shows no Progress bars yet.
    expect(screen.queryByRole("progressbar")).toBeNull()
  })

  test("expand/collapse toggles detail and persists the choice", async () => {
    const user = userEvent.setup()
    renderWithIntl(<QuotaFooter />)
    act(() => {
      FakeEventSource.last?.emit({
        quota: {
          agents: {
            codex: {
              model: "gpt-5.5",
              status: "available",
              reset_at: null,
              last_message: null,
              windows: {
                "5h": { used_pct: 38, remaining: 62, reset_at: future(2, 14) },
                weekly: { used_pct: 12, remaining: 88, reset_at: future(40) },
              },
            },
          },
        },
      })
    })
    await waitFor(() => expect(screen.getByText("GPT 5.5")).toBeInTheDocument())

    // Starts collapsed: no Progress bars, no per-window long labels.
    expect(screen.queryByRole("progressbar")).toBeNull()

    await user.click(screen.getByRole("button", { name: /expand quota details/i }))

    // Expanded: a Progress bar per window with a real percentage (5h + weekly).
    await waitFor(() => expect(screen.getAllByRole("progressbar")).toHaveLength(2))
    expect(screen.getByText("5-hour")).toBeInTheDocument()
    expect(screen.getByText("Weekly")).toBeInTheDocument()
    // Reset countdown is shown for a known reset.
    expect(screen.getByText(/resets in 2h1[34]/)).toBeInTheDocument()
    // Persisted as expanded.
    expect(window.localStorage.getItem("vivicy:quota-footer-collapsed")).toBe("false")

    await user.click(screen.getByRole("button", { name: /collapse quota details/i }))
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull())
    expect(window.localStorage.getItem("vivicy:quota-footer-collapsed")).toBe("true")
  })

  test("expanded: a window with a null percentage shows — and NO Progress bar", async () => {
    const user = userEvent.setup()
    renderWithIntl(<QuotaFooter />)
    act(() => {
      FakeEventSource.last?.emit({
        quota: {
          agents: {
            claude: {
              model: "claude-opus-4-8",
              status: "available",
              reset_at: null,
              last_message: null,
              // 5h has a reset but no %, weekly entirely unknown.
              windows: { "5h": { used_pct: null, remaining: null, reset_at: future(3) } },
            },
          },
        },
      })
    })
    await waitFor(() => expect(screen.getByText("Opus 4.8")).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: /expand quota details/i }))

    // Both windows render their labels, but NEITHER has a real % => no bars,
    // honest "—" instead of a fabricated number.
    await waitFor(() => expect(screen.getByText("5-hour")).toBeInTheDocument())
    expect(screen.getByText("Weekly")).toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).toBeNull()
    // No fabricated percentage anywhere for Claude.
    expect(document.body.textContent).not.toMatch(/\d+%/)
  })

  test("throttled agent is highlighted with a destructive badge", async () => {
    const user = userEvent.setup()
    renderWithIntl(<QuotaFooter />)
    act(() => {
      FakeEventSource.last?.emit({
        quota: {
          agents: {
            codex: {
              model: "gpt-5.5",
              status: "throttled",
              reset_at: future(2, 14),
              last_message: "usage limit reached; resets at 14:14",
              windows: {
                "5h": { used_pct: 100, remaining: 0, reset_at: future(2, 14) },
                weekly: { used_pct: 80, remaining: 20, reset_at: future(40) },
              },
            },
          },
        },
      })
    })
    await waitFor(() => expect(screen.getByText("GPT 5.5")).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: /expand quota details/i }))
    await waitFor(() => expect(screen.getByText("throttled")).toBeInTheDocument())
    // Real percentages still shown for the throttled agent.
    expect(screen.getByText("100%")).toBeInTheDocument()
  })

  test("renders a neutral placeholder when no quota is known yet", () => {
    renderWithIntl(<QuotaFooter />)
    expect(screen.getByText(/Agent quota status appears here/i)).toBeInTheDocument()
    // No toggle button until there is at least one agent.
    expect(screen.queryByRole("button", { name: /quota details/i })).toBeNull()
  })

  test("derives each row's model + thinking label from the passed settings", async () => {
    const user = userEvent.setup()
    renderWithIntl(
      <QuotaFooter
        settings={{
          implementer: { provider: "claude", model: "claude-opus-4-8", effort: "max", fast: false },
          reviewer: { provider: "codex", model: "custom-codex-x", effort: "low", fast: false },
          maxParallel: 1,
          allowUnsafeSkills: false,
        }}
      />
    )
    act(() => {
      FakeEventSource.last?.emit({
        quota: {
          agents: {
            claude: { model: "claude-old", status: "available", reset_at: null, last_message: null },
            codex: { model: "gpt-old", status: "available", reset_at: null, last_message: null },
          },
        },
      })
    })
    await waitFor(() => expect(screen.getByText("Opus 4.8")).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: /expand quota details/i }))
    // Implementer: friendly name from the configured model + configured effort.
    expect(screen.getByText(/· max/)).toBeInTheDocument()
    // Reviewer: unknown model id shown raw (honest), configured effort.
    expect(screen.getByText("custom-codex-x")).toBeInTheDocument()
    expect(screen.getByText(/· low/)).toBeInTheDocument()
    // The reported (quota-state) models must NOT win over settings.
    expect(screen.queryByText("claude-old")).toBeNull()
    expect(screen.queryByText("gpt-old")).toBeNull()
  })
})
