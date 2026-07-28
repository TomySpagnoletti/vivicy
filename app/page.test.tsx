import { StrictMode } from "react"
import { screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { AgentHealth, AgentsHealth } from "@/lib/agents-health-types"
import type { CurrentProject } from "@/lib/project-types"
import Page from "@/app/page"
import { __resetPersistedBooleanStoresForTests } from "@/hooks/use-persisted-boolean"
import { renderWithIntl } from "@/test/render"

vi.mock("@/components/map/architecture-map", () => ({
  ArchitectureMap: () => null,
}))
vi.mock("@/components/workflow/workflow-widget", () => ({
  WorkflowWidget: () => null,
}))

class FakeEventSource {
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {}
  close() {}
}

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function stubFetch(health: AgentsHealth, mapBody: unknown) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/api/agents/health")) return json({ ok: true, agents: health })
    if (url.includes("/api/map")) return json(mapBody)
    if (url.includes("/api/project")) return json({ project: null })
    if (url.includes("/api/control/notifications")) return json({ ok: true, notifications: [] })
    if (url.includes("/api/control/crs")) return json({ ok: true, crs: [] })
    if (url.includes("/api/vivi/sessions")) return json({ ok: true, sessions: [] })
    if (init?.method === "POST") return json({ ok: true })
    return json({ ok: true })
  })
}

const NO_MAP = { empty: true, reason: "no_map" }

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource)
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
  __resetPersistedBooleanStoresForTests()
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  __resetPersistedBooleanStoresForTests()
  window.localStorage.clear()
})

describe("Page — Vivi launcher gated on the agent-CLI install state", () => {
  test("both CLIs installed: the launcher bubble mounts, no install gate", async () => {
    vi.stubGlobal("fetch", stubFetch({ claude: agent(), codex: agent() }, NO_MAP))
    renderWithIntl(<Page />)

    expect(
      await screen.findByRole("button", { name: "Open Vivi" })
    ).toBeInTheDocument()
    expect(screen.queryByText("Install the agent CLIs")).not.toBeInTheDocument()
  })

  test("both CLIs missing: the install gate shows and the launcher bubble is absent from the DOM", async () => {
    vi.stubGlobal("fetch", stubFetch({ claude: MISSING, codex: MISSING }, NO_MAP))
    renderWithIntl(<Page />)

    expect(await screen.findByText("Install the agent CLIs")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Open Vivi" })
    ).not.toBeInTheDocument()
  })

  test("one CLI missing: still gated — the launcher bubble is absent from the DOM", async () => {
    vi.stubGlobal("fetch", stubFetch({ claude: agent(), codex: MISSING }, NO_MAP))
    renderWithIntl(<Page />)

    expect(await screen.findByText("Install the agent CLIs")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Open Vivi" })
    ).not.toBeInTheDocument()
  })

  test("health probe fails (no agents in the body): the app fails open — no gate, launcher still renders", async () => {
    const failOpen = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/api/agents/health")) return json({ ok: false })
      if (url.includes("/api/map")) return json(NO_MAP)
      if (url.includes("/api/project")) return json({ project: null })
      if (url.includes("/api/control/notifications")) return json({ ok: true, notifications: [] })
      if (url.includes("/api/control/crs")) return json({ ok: true, crs: [] })
      if (url.includes("/api/vivi/sessions")) return json({ ok: true, sessions: [] })
      if (init?.method === "POST") return json({ ok: true })
      return json({ ok: true })
    })
    vi.stubGlobal("fetch", failOpen)
    renderWithIntl(<Page />)

    expect(
      await screen.findByRole("button", { name: "Open Vivi" })
    ).toBeInTheDocument()
    expect(screen.queryByText("Install the agent CLIs")).not.toBeInTheDocument()
  })
})

describe("Page — first-boot loading state", () => {
  test("renders the generic loading copy while the health probe is in flight", async () => {
    vi.stubGlobal("fetch", stubFetch({ claude: agent(), codex: agent() }, NO_MAP))
    renderWithIntl(<Page />)

    expect(screen.getByText("Loading…")).toBeInTheDocument()

    expect(
      await screen.findByRole("button", { name: "Open Vivi" })
    ).toBeInTheDocument()
  })
})

// Wiring only — the one-shot/governed contract itself is pinned in hooks/use-reopen-persisted-project.test.tsx.
describe("Page — a returning session re-opens its persisted project through the selection seam", () => {
  const GOVERNED: CurrentProject = { root: "/repos/acme", name: "acme", hasCanonicalSpec: true }

  test("hands the resolved project to the seam: the persisted root is POSTed once, with no click anywhere", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.includes("/api/agents/health")) return json({ ok: true, agents: { claude: agent(), codex: agent() } })
      if (url.includes("/api/map")) return json(NO_MAP)
      if (url.endsWith("/api/project")) return json({ ok: true, project: GOVERNED })
      if (url.includes("/api/control/notifications")) return json({ ok: true, notifications: [] })
      if (url.includes("/api/control/crs")) return json({ ok: true, crs: [] })
      if (url.includes("/api/vivi/sessions")) return json({ ok: true, sessions: [] })
      return json({ ok: true })
    })
    vi.stubGlobal("fetch", fetchMock)
    const seamPosts = () => calls.filter((c) => c.url.endsWith("/api/project") && c.init?.method === "POST")

    // StrictMode, because the App Router runs it by default: the mount-time double-invoke must not double-fire the seam.
    renderWithIntl(
      <StrictMode>
        <Page />
      </StrictMode>
    )

    await waitFor(() => expect(seamPosts().length).toBeGreaterThan(0))
    expect(await screen.findByRole("button", { name: "Open Vivi" })).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(seamPosts()).toHaveLength(1)
    expect(JSON.parse(String(seamPosts()[0].init?.body))).toEqual({
      root: GOVERNED.root,
      requireGoverned: true,
    })
  })
})
