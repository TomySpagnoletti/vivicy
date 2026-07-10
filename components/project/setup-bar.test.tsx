import { screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { SetupBar } from "@/components/project/setup-bar"
import { renderWithIntl } from "@/test/render"

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
    // Mirrors app/layout.tsx's TooltipProvider wrapper — SetupBar's tooltip triggers require that ancestor.
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

    expect(
      screen.queryByRole("button", { name: "Talk to Vivi" })
    ).not.toBeInTheDocument()
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
