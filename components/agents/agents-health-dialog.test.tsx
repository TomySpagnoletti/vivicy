import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { AgentsHealthDialog } from "@/components/agents/agents-health-dialog"
import type { AgentHealth, AgentsHealth } from "@/lib/agents-health-types"
import { renderWithIntl } from "@/test/render"

/** Build a health snapshot, defaulting both agents to authed subscriptions. */
function health(overrides?: {
  claude?: Partial<AgentHealth>
  codex?: Partial<AgentHealth>
}): AgentsHealth {
  const base = (version: string, plan: string): AgentHealth => ({
    present: true,
    version,
    authenticated: true,
    authMethod: "subscription",
    plan,
  })
  return {
    claude: { ...base("2.1.191", "max"), ...overrides?.claude },
    codex: { ...base("0.141.0", "ChatGPT"), ...overrides?.codex },
  }
}

/** A fetch stub: GET /health returns `current`; POST /update returns `updateBody`. */
function stubFetch(opts: {
  current: AgentsHealth
  updateBody?: unknown
  updateStatus?: number
  updateReject?: boolean
}) {
  // Mirror the real `fetch(url, init)` shape so recorded calls expose the POST
  // body/method for assertions; `init` is intentionally part of the signature.
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    if (href.includes("/api/agents/update")) {
      if (opts.updateReject) throw new Error("network down")
      // Touch `init` so the param is meaningful (the route always sends a body).
      if (init && typeof init.body !== "string") throw new Error("expected a JSON body")
      return new Response(JSON.stringify(opts.updateBody ?? { ok: true }), {
        status: opts.updateStatus ?? 200,
      })
    }
    // Default: the health endpoint.
    return new Response(JSON.stringify({ ok: true, agents: opts.current }), { status: 200 })
  })
}

beforeEach(() => {
  // jsdom: scrollHeight is 0 and clipboard may be missing; provide safe stubs.
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    value: 100,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function openDialog() {
  const user = userEvent.setup()
  renderWithIntl(<AgentsHealthDialog />)
  // Wait for the initial health load to settle, then open the modal.
  const trigger = await screen.findByRole("button", { name: "Agent CLI status" })
  await user.click(trigger)
  await screen.findByText("Agent CLIs")
  return user
}

describe("AgentsHealthDialog — cleaned version line", () => {
  test("renders the normalized version (no repeated product name)", async () => {
    vi.stubGlobal("fetch", stubFetch({ current: health() }))
    await openDialog()

    // The dialog shows "· 2.1.191" / "· 0.141.0", never "(Claude Code)" or
    // "codex-cli ..." — the redundant product name is gone.
    expect(await screen.findByText("· 2.1.191")).toBeInTheDocument()
    expect(screen.getByText("· 0.141.0")).toBeInTheDocument()
    expect(screen.queryByText(/\(Claude Code\)/)).not.toBeInTheDocument()
    expect(screen.queryByText(/codex-cli/)).not.toBeInTheDocument()
  })
})

describe("AgentsHealthDialog — dynamic cost note (subscription vs api_key)", () => {
  test("subscription shows the quota note", async () => {
    vi.stubGlobal("fetch", stubFetch({ current: health() }))
    await openDialog()
    expect(
      await screen.findAllByText("Usage counts against your plan quota — no per-token charge.")
    ).not.toHaveLength(0)
    expect(
      screen.queryByText("Billed pay-per-token against your provider API account.")
    ).not.toBeInTheDocument()
  })

  test("api_key shows the pay-per-token note (provably dynamic)", async () => {
    const apiKeyHealth = health({
      claude: { authMethod: "api_key", plan: null },
      codex: { authMethod: "api_key", plan: null },
    })
    vi.stubGlobal("fetch", stubFetch({ current: apiKeyHealth }))
    await openDialog()
    expect(
      await screen.findAllByText("Billed pay-per-token against your provider API account.")
    ).not.toHaveLength(0)
    expect(
      screen.queryByText("Usage counts against your plan quota — no per-token charge.")
    ).not.toBeInTheDocument()
  })

  test("mixed: one subscription, one api_key → BOTH notes render", async () => {
    const mixed = health({ codex: { authMethod: "api_key", plan: null } })
    vi.stubGlobal("fetch", stubFetch({ current: mixed }))
    await openDialog()
    expect(
      await screen.findByText("Usage counts against your plan quota — no per-token charge.")
    ).toBeInTheDocument()
    expect(
      screen.getByText("Billed pay-per-token against your provider API account.")
    ).toBeInTheDocument()
  })
})

describe("AgentsHealthDialog — per-agent Update button", () => {
  test("clicking Update POSTs the agent to /api/agents/update and shows done", async () => {
    const updated = health({ claude: { version: "2.1.192" } })
    const fetchMock = stubFetch({
      current: health(),
      updateBody: {
        ok: true,
        agent: "claude",
        command: "claude update",
        code: 0,
        stdout: "Updated to 2.1.192",
        stderr: "",
        agents: updated,
      },
    })
    vi.stubGlobal("fetch", fetchMock)
    const user = await openDialog()

    const updateBtn = await screen.findByRole("button", { name: "Update Claude Code" })
    await user.click(updateBtn)

    // It POSTed the correct agent body to the allow-listed route.
    await waitFor(() => {
      const updateCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/agents/update"))
      expect(updateCall).toBeTruthy()
      expect(String(updateCall?.[1]?.method)).toBe("POST")
      expect(JSON.parse(String(updateCall?.[1]?.body))).toEqual({ agent: "claude" })
    })

    // The captured output + done marker render; version refreshes from the response.
    expect(await screen.findByText(/✓ done/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("· 2.1.192")).toBeInTheDocument())
  })

  test("the button is disabled while the update is running", async () => {
    // A deferred update response so we can observe the running state.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes("/api/agents/update")) {
        await gate
        return new Response(JSON.stringify({ ok: true, agents: health() }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, agents: health() }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)
    const user = await openDialog()

    const updateBtn = await screen.findByRole("button", { name: "Update Codex CLI" })
    await user.click(updateBtn)
    // Running: label flips and the button is disabled.
    await waitFor(() => expect(screen.getByRole("button", { name: "Update Codex CLI" })).toBeDisabled())
    expect(screen.getAllByText("Updating…").length).toBeGreaterThan(0)

    release()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Update Codex CLI" })).toBeEnabled()
    )
  })

  test("a failed update surfaces the error state honestly", async () => {
    const fetchMock = stubFetch({
      current: health(),
      updateBody: {
        ok: false,
        agent: "claude",
        command: "claude update",
        code: 1,
        stdout: "",
        stderr: "could not reach update server",
        agents: health(),
      },
    })
    vi.stubGlobal("fetch", fetchMock)
    const user = await openDialog()

    const updateBtn = await screen.findByRole("button", { name: "Update Claude Code" })
    await user.click(updateBtn)

    const log = await screen.findByText(/✗ failed/)
    expect(log).toBeInTheDocument()
    // The captured stderr is shown in the log, not swallowed.
    expect(within(log.closest("pre")!).getByText(/could not reach update server/)).toBeTruthy()
  })

  test("no Update button when the CLI is not installed", async () => {
    const notInstalled = health({
      claude: { present: false, version: null, authenticated: false, authMethod: null, plan: null },
    })
    vi.stubGlobal("fetch", stubFetch({ current: notInstalled }))
    await openDialog()
    expect(screen.queryByRole("button", { name: "Update Claude Code" })).not.toBeInTheDocument()
    // The installed Codex still offers Update.
    expect(screen.getByRole("button", { name: "Update Codex CLI" })).toBeInTheDocument()
  })
})
