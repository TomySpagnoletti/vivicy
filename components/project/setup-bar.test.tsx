import { screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { AgentsHealth } from "@/lib/agents-health-types"
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

  test("renders no trigger button when a project is set — the switcher and Agents triggers are removed", () => {
    renderWithIntl(
      <SetupBar
        project={{ name: "demo", root: "/tmp/demo", hasCanonicalSpec: true }}
        onProjectChanged={vi.fn()}
      />
    )

    expect(screen.queryByRole("button", { name: "Change project" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Agent CLI status" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Talk to Vivi" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Notifications" })).not.toBeInTheDocument()
  })

  test("renders no trigger button when no project is set", () => {
    renderWithIntl(<SetupBar project={null} onProjectChanged={vi.fn()} />)
    expect(screen.queryByRole("button", { name: "Change project" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Agent CLI status" })).not.toBeInTheDocument()
  })

  test("still probes agent health on mount and surfaces a warning — functionality survives the removed trigger", async () => {
    const onAgentsWarning = vi.fn()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, agents: unhealthy() }))
    )

    renderWithIntl(
      <SetupBar project={null} onProjectChanged={vi.fn()} onAgentsWarning={onAgentsWarning} />
    )

    await waitFor(() => expect(onAgentsWarning).toHaveBeenCalled())
  })
})

function unhealthy(): AgentsHealth {
  return {
    claude: { present: false, version: null, authenticated: false, authMethod: null, plan: null },
    codex: { present: true, version: "1.0.0", authenticated: true, authMethod: "subscription", plan: "max" },
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}
