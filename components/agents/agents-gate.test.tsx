import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, test, vi } from "vitest"

import type { AgentHealth, AgentsHealth } from "@/lib/agents-health-types"
import {
  AgentsAuthBanner,
  AgentsGate,
  agentsGateBlocked,
} from "@/components/agents/agents-gate"
import { renderWithIntl } from "@/test/render"

function agent(overrides: Partial<AgentHealth> = {}): AgentHealth {
  return {
    present: true,
    version: "1.0.0",
    authenticated: true,
    authMethod: "subscription",
    plan: null,
    ...overrides,
  }
}

const MISSING = agent({ present: false, version: null, authenticated: false, authMethod: null })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("agentsGateBlocked — the blocking rule", () => {
  test("blocks when either (or both) CLI binary is missing", () => {
    expect(agentsGateBlocked({ claude: MISSING, codex: MISSING })).toBe(true)
    expect(agentsGateBlocked({ claude: MISSING, codex: agent() })).toBe(true)
    expect(agentsGateBlocked({ claude: agent(), codex: MISSING })).toBe(true)
  })

  test("present-but-unauthenticated (or auth unknown) is NOT blocking", () => {
    expect(
      agentsGateBlocked({
        claude: agent({ authenticated: false, authMethod: null }),
        codex: agent({ authenticated: null, authMethod: null }),
      })
    ).toBe(false)
    expect(agentsGateBlocked({ claude: agent(), codex: agent() })).toBe(false)
  })
})

describe("AgentsGate — blocking install screen", () => {
  test("both missing: per-agent cards link to each CLI's install docs in a new tab — no command, no copy button", () => {
    vi.stubGlobal("fetch", vi.fn())
    renderWithIntl(
      <AgentsGate health={{ claude: MISSING, codex: MISSING }} onHealth={vi.fn()} />
    )

    expect(screen.getByText("Install the agent CLIs")).toBeInTheDocument()
    expect(screen.getByText("Claude Code")).toBeInTheDocument()
    expect(screen.getByText("Codex CLI")).toBeInTheDocument()
    expect(screen.getAllByText("Not found")).toHaveLength(2)

    const claudeLink = screen.getByRole("link", { name: /Claude Code installation guide/ })
    expect(claudeLink).toHaveAttribute("href", "https://code.claude.com/docs/en/quickstart")
    expect(claudeLink).toHaveAttribute("target", "_blank")
    expect(claudeLink).toHaveAttribute("rel", "noopener noreferrer")

    const codexLink = screen.getByRole("link", { name: /Codex CLI installation guide/ })
    expect(codexLink).toHaveAttribute("href", "https://learn.chatgpt.com/docs/codex/cli")
    expect(codexLink).toHaveAttribute("target", "_blank")
    expect(codexLink).toHaveAttribute("rel", "noopener noreferrer")

    expect(screen.getAllByText("(opens in new tab)")).toHaveLength(2)
    expect(screen.queryByText(/npm install/)).not.toBeInTheDocument()
    expect(screen.queryByText(/brew install/)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Copy:/ })).not.toBeInTheDocument()
  })

  test("one missing: the present agent shows its version/auth rows and no docs link; only the missing one links to its install docs", () => {
    vi.stubGlobal("fetch", vi.fn())
    renderWithIntl(
      <AgentsGate
        health={{ claude: agent({ version: "2.1.191" }), codex: MISSING }}
        onHealth={vi.fn()}
      />
    )

    expect(screen.getByText("· 2.1.191")).toBeInTheDocument()
    expect(screen.getByText("Installed")).toBeInTheDocument()
    expect(screen.getByText("Authenticated")).toBeInTheDocument()
    expect(screen.getByText("Not found")).toBeInTheDocument()

    expect(
      screen.queryByRole("link", { name: /Claude Code installation guide/ })
    ).not.toBeInTheDocument()
    const codexLink = screen.getByRole("link", { name: /Codex CLI installation guide/ })
    expect(codexLink).toHaveAttribute("href", "https://learn.chatgpt.com/docs/codex/cli")
    expect(screen.queryByText(/npm install/)).not.toBeInTheDocument()
  })

  test("Check again re-probes with ?fresh=1 and hands the fresh snapshot up", async () => {
    const freshHealth: AgentsHealth = { claude: agent(), codex: agent() }
    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ ok: true, agents: freshHealth }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    )
    vi.stubGlobal("fetch", fetchMock)
    const onHealth = vi.fn()
    const user = userEvent.setup()
    renderWithIntl(
      <AgentsGate health={{ claude: MISSING, codex: MISSING }} onHealth={onHealth} />
    )

    await user.click(screen.getByRole("button", { name: "Check again" }))

    await waitFor(() => expect(onHealth).toHaveBeenCalledWith(freshHealth))
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/agents/health?fresh=1")
  })
})

describe("AgentsAuthBanner — present-but-unauthenticated", () => {
  test("lists each signed-out agent with its auth command and dismisses on X", async () => {
    const user = userEvent.setup()
    renderWithIntl(
      <AgentsAuthBanner
        health={{
          claude: agent({ authenticated: false, authMethod: null }),
          codex: agent(),
        }}
      />
    )

    expect(screen.getByText("Agent sign-in needed")).toBeInTheDocument()
    expect(screen.getByText(/Claude Code is installed but not signed in/)).toBeInTheDocument()
    expect(screen.getByText("claude")).toBeInTheDocument()
    expect(screen.queryByText(/Codex CLI is installed but not signed in/)).not.toBeInTheDocument()

    await user.click(
      screen.getByRole("button", { name: "Dismiss the sign-in reminder" })
    )
    expect(screen.queryByText("Agent sign-in needed")).not.toBeInTheDocument()
  })

  test("renders nothing when every present agent is authenticated (or auth is unknown)", () => {
    const { container } = renderWithIntl(
      <AgentsAuthBanner
        health={{ claude: agent(), codex: agent({ authenticated: null, authMethod: null }) }}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
