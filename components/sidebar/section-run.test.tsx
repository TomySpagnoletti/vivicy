import { act, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, test, vi } from "vitest"

import { SectionRun } from "@/components/sidebar/section-run"
import type { ProductRunView } from "@/lib/product-run"
import { renderWithIntl } from "@/test/render"

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

function view(overrides: Partial<ProductRunView>): ProductRunView {
  return {
    phase: "stopped",
    command: null,
    url: null,
    url_source: null,
    log_file: null,
    log_tail: null,
    started_at: null,
    ...overrides,
  }
}

function stubFetch(run: ProductRunView, onPost?: (url: string) => void) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (init?.method === "POST") {
      onPost?.(url)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (url.includes("/api/control/run")) {
      return new Response(JSON.stringify({ ok: true, run }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("SectionRun states", () => {
  test("not_established shows the honest empty state and no run button", async () => {
    vi.stubGlobal("fetch", stubFetch(view({ phase: "not_established" })))
    renderWithIntl(<SectionRun />)
    await waitFor(() => expect(screen.getByText(/Vivicy sets the run command while it builds/)).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /^Run$/ })).toBeNull()
  })

  test("stopped shows the command and a Run button", async () => {
    vi.stubGlobal("fetch", stubFetch(view({ phase: "stopped", command: "npm run dev" })))
    renderWithIntl(<SectionRun />)
    await waitFor(() => expect(screen.getByText("npm run dev")).toBeInTheDocument())
    expect(screen.getByText(/Your product is ready/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Run/ })).toBeInTheDocument()
  })

  test("running surfaces a clickable URL, the start time, the command, and a Stop button", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch(
        view({
          phase: "running",
          command: "next dev --port 3000",
          url: "http://localhost:3000",
          url_source: "log",
          started_at: "2026-07-24T12:00:00.000Z",
          log_tail: "Local: http://localhost:3000",
        })
      )
    )
    renderWithIntl(<SectionRun />)
    const link = await screen.findByRole("link")
    expect(link).toHaveAttribute("href", "http://localhost:3000")
    expect(link).toHaveAttribute("target", "_blank")
    expect(screen.getByText(/^started /)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument()
  })

  test("running with only a command-derived URL flags it as a best guess", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch(view({ phase: "running", command: "next dev --port 4321", url: "http://localhost:4321", url_source: "command" }))
    )
    renderWithIntl(<SectionRun />)
    await waitFor(() => expect(screen.getByText(/Best guess from the command/)).toBeInTheDocument())
  })

  test("exited surfaces the failure loudly with the log auto-opened", async () => {
    vi.stubGlobal("fetch", stubFetch(view({ phase: "exited", command: "npm run dev", log_tail: "Error: EADDRINUSE :::3000" })))
    renderWithIntl(<SectionRun />)
    await waitFor(() => expect(screen.getByText(/stopped on its own/)).toBeInTheDocument())
    expect(screen.getByText(/EADDRINUSE/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Run/ })).toBeInTheDocument()
  })

  // The live path the reviewer broke: the owner watches running -> crash on ONE mounted instance; the log must open on the transition, not only on a fresh page-load into exited.
  test("running -> exited transition auto-opens the log on the SAME mounted instance", async () => {
    vi.useFakeTimers()
    try {
      const box = {
        run: view({
          phase: "running",
          command: "npm run dev",
          url: "http://localhost:3000",
          url_source: "log",
          log_tail: "watching for file changes",
        }),
      }
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          if ((init as RequestInit | undefined)?.method === "POST") return new Response("{}", { status: 200 })
          if (String(input).includes("/api/control/run")) {
            return new Response(JSON.stringify({ ok: true, run: box.run }), { status: 200 })
          }
          return new Response("{}", { status: 200 })
        })
      )
      renderWithIntl(<SectionRun />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })
      expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument()
      // running: the log is collapsed by default, so its tail text is not mounted
      expect(screen.queryByText(/watching for file changes/)).toBeNull()

      box.run = view({ phase: "exited", command: "npm run dev", log_tail: "Error: EADDRINUSE :::3000" })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(screen.getByText(/stopped on its own/)).toBeInTheDocument()
      // the log auto-opened on the live transition (phase-keyed remount), not only on a fresh mount
      expect(screen.getByText(/EADDRINUSE/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("SectionRun actions (the click is the owner's)", () => {
  test("Run POSTs the start endpoint", async () => {
    const posted: string[] = []
    vi.stubGlobal(
      "fetch",
      stubFetch(view({ phase: "stopped", command: "npm run dev" }), (u) => posted.push(u))
    )
    renderWithIntl(<SectionRun />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: /Run/ }))
    await waitFor(() => expect(posted.some((u) => u.includes("/api/control/run/start"))).toBe(true))
  })

  test("Stop POSTs the stop endpoint", async () => {
    const posted: string[] = []
    vi.stubGlobal(
      "fetch",
      stubFetch(view({ phase: "running", command: "npm run dev", url: "http://localhost:3000", url_source: "log" }), (u) => posted.push(u))
    )
    renderWithIntl(<SectionRun />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: /Stop/ }))
    await waitFor(() => expect(posted.some((u) => u.includes("/api/control/run/stop"))).toBe(true))
  })
})
