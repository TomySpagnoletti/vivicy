import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { SetupBar } from "@/components/project/setup-bar"

/**
 * The persistent "Talk to Vivi" affordance (B8.1): once a project is resolved, SetupBar
 * shows a Sparkles button that opens the SAME ViviChat Sheet used at onboarding — so Vivi
 * is reachable at any time, including while the dev-loop runs (SetupBar is always mounted).
 * `fetch` is stubbed by URL: /api/project resolves a project (so the button renders),
 * /api/vivi returns the read-only engine, and the children's polls return benign JSON. No
 * real network, no agent — a cheap render + one interaction.
 */
describe("SetupBar — Talk to Vivi", () => {
  beforeEach(() => {
    // NotificationBell subscribes to an SSE stream on mount; jsdom has no EventSource,
    // so give it an inert stub (this test is about the Vivi affordance, not the bell).
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage: ((event: MessageEvent) => void) | null = null
        onerror: ((event: Event) => void) | null = null
        close(): void {}
      }
    )
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/project")) {
          return jsonResponse({ project: { name: "demo", root: "/tmp/demo" } })
        }
        if (url.startsWith("/api/vivi")) {
          return jsonResponse({
            engine: { provider: "claude", providerLabel: "Claude Code", model: "claude-opus-4-8" },
          })
        }
        // /api/agents/health, /api/control/notifications — benign shapes for the children.
        return jsonResponse({ ok: true, notifications: [] })
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test("shows the button once a project resolves and opens the Vivi Sheet on click", async () => {
    const user = userEvent.setup()
    // app/layout.tsx wraps the tree in TooltipProvider; mirror that so SetupBar's
    // tooltip triggers have their required provider ancestor.
    render(
      <TooltipProvider>
        <SetupBar onProjectChanged={vi.fn()} />
      </TooltipProvider>
    )

    // The affordance appears only after /api/project resolves a project.
    const button = await screen.findByRole("button", { name: "Talk to Vivi" })

    // The Sheet is closed until clicked.
    expect(screen.queryByText("Build the spec with Vivi")).not.toBeInTheDocument()

    await user.click(button)

    // Clicking opens the existing ViviChat Sheet (its title/description render).
    expect(await screen.findByText("Build the spec with Vivi")).toBeInTheDocument()
  })
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}
