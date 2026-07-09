import { screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { SetupBar } from "@/components/project/setup-bar"
import { renderWithIntl } from "@/test/render"

/**
 * SetupBar after W5: a fully CONTROLLED bar — the page owns the current project
 * and passes it down (single source of truth with the Vivi panel). Vivi moved OUT
 * to the global launcher bubble (W3) and the notification bell moved into the
 * panel's Notifications tab (W5/D3), so neither may render here. `fetch` is
 * stubbed with benign JSON for the agents-health child; no real network.
 */
describe("SetupBar", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true }))
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test("shows the project affordance from the controlled prop — and no Vivi button, no bell", () => {
    // app/layout.tsx wraps the tree in TooltipProvider; mirror that so SetupBar's
    // tooltip triggers have their required provider ancestor.
    renderWithIntl(
      <TooltipProvider>
        <SetupBar
          project={{ name: "demo", root: "/tmp/demo", hasCanonicalSpec: true }}
          onProjectChanged={vi.fn()}
        />
      </TooltipProvider>
    )

    const button = screen.getByRole("button", { name: "Change project" })
    expect(button).toHaveTextContent("demo")

    // The old per-bar Vivi entry point is gone — the global bubble replaced it.
    expect(
      screen.queryByRole("button", { name: "Talk to Vivi" })
    ).not.toBeInTheDocument()
    // The notification bell is retired — the panel's Notifications tab replaced it.
    expect(
      screen.queryByRole("button", { name: "Notifications" })
    ).not.toBeInTheDocument()
  })

  test("hides the switcher affordance while no project is set", () => {
    renderWithIntl(
      <TooltipProvider>
        <SetupBar project={null} onProjectChanged={vi.fn()} />
      </TooltipProvider>
    )
    expect(
      screen.queryByRole("button", { name: "Change project" })
    ).not.toBeInTheDocument()
  })
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}
