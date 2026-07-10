import { act, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { QuotaFooter, formatReset } from "@/components/sidebar/quota-footer"
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
  window.localStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

const future = (h: number, m = 0) => new Date(Date.now() + (h * 3600 + m * 60) * 1000).toISOString()

describe("formatReset", () => {
  const now = Date.UTC(2026, 5, 24, 12, 0, 0)
  test("renders hours+minutes and minutes-only, hides past/unknown", () => {
    expect(formatReset(new Date(now + (2 * 3600 + 14 * 60) * 1000).toISOString(), now)).toBe(
      "resets in 2h14"
    )
    expect(formatReset(new Date(now + 45 * 60 * 1000).toISOString(), now)).toBe("resets in 45m")
    expect(formatReset(new Date(now - 60_000).toISOString(), now)).toBeNull()
    expect(formatReset(null, now)).toBeNull()
  })
})

describe("QuotaFooter — real % where available, honest — where not", () => {
  test("collapsed: REAL Codex percentages, honest — for the unknown weekly", async () => {
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
    expect(screen.getByText(/5h 38%/)).toBeInTheDocument()
    expect(screen.getByText(/wk 12%/)).toBeInTheDocument()
    expect(screen.getByText(/5h —/)).toBeInTheDocument()
    expect(screen.getByText(/wk —/)).toBeInTheDocument()
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

    expect(screen.queryByRole("progressbar")).toBeNull()

    await user.click(screen.getByRole("button", { name: /expand quota details/i }))

    await waitFor(() => expect(screen.getAllByRole("progressbar")).toHaveLength(2))
    expect(screen.getByText("5-hour")).toBeInTheDocument()
    expect(screen.getByText("Weekly")).toBeInTheDocument()
    expect(screen.getByText(/resets in 2h1[34]/)).toBeInTheDocument()
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
              windows: { "5h": { used_pct: null, remaining: null, reset_at: future(3) } },
            },
          },
        },
      })
    })
    await waitFor(() => expect(screen.getByText("Opus 4.8")).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: /expand quota details/i }))

    await waitFor(() => expect(screen.getByText("5-hour")).toBeInTheDocument())
    expect(screen.getByText("Weekly")).toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).toBeNull()
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
    expect(screen.getByText("100%")).toBeInTheDocument()
  })

  test("renders a neutral placeholder when no quota is known yet", () => {
    renderWithIntl(<QuotaFooter />)
    expect(screen.getByText(/Agent quota status appears here/i)).toBeInTheDocument()
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
    expect(screen.getByText(/· max/)).toBeInTheDocument()
    expect(screen.getByText("custom-codex-x")).toBeInTheDocument()
    expect(screen.getByText(/· low/)).toBeInTheDocument()
    expect(screen.queryByText("claude-old")).toBeNull()
    expect(screen.queryByText("gpt-old")).toBeNull()
  })

  test("swapped assignment: each CLI row shows its own settings entry, matched by live provider", async () => {
    const user = userEvent.setup()
    renderWithIntl(
      <QuotaFooter
        settings={{
          implementer: { provider: "codex", model: "gpt-5.4", effort: "high", fast: false },
          reviewer: { provider: "claude", model: "claude-opus-4-7", effort: "max", fast: false },
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
            gemini: { model: "gemini-x", status: "available", reset_at: null, last_message: null },
          },
        },
      })
    })

    await waitFor(() => expect(screen.getByText("claude-opus-4-7")).toBeInTheDocument())
    const labels = screen.getAllByText(/^(claude-opus-4-7|gpt-5\.4|gemini-x)$/).map((el) => el.textContent)
    expect(labels).toEqual(["claude-opus-4-7", "gpt-5.4", "gemini-x"])

    await user.click(screen.getByRole("button", { name: /expand quota details/i }))
    expect(screen.getByText("claude-opus-4-7")).toHaveTextContent("· max")
    expect(screen.getByText("gpt-5.4")).toHaveTextContent("· high")
    expect(screen.getByText("gemini-x")).not.toHaveTextContent("·")
    expect(screen.queryByText("claude-old")).toBeNull()
    expect(screen.queryByText("gpt-old")).toBeNull()
  })
})
