import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { ViviTurn } from "@/lib/vivi"
import type { Notification } from "@/lib/notifications"
import { ViviPanel } from "@/components/chat/vivi-panel"
import {
  useViviPanel,
  ViviPanelProvider,
} from "@/components/chat/vivi-panel-context"
import { __resetPersistedBooleanStoresForTests } from "@/hooks/use-persisted-boolean"
import { renderWithIntl } from "@/test/render"

const SESSION_A = "11111111-1111-1111-1111-111111111111"
const SESSION_B = "22222222-2222-2222-2222-222222222222"

const HISTORY: ViviTurn[] = [
  { role: "user", text: "I want a todo app.", ts: "2026-07-08T10:00:00Z" },
  {
    role: "vivi",
    text: "What states can a todo be in?",
    ts: "2026-07-08T10:01:00Z",
    wrote: [".vivicy/canonical/01-product.md"],
  },
  {
    role: "vivi",
    text: "I tried something forbidden.",
    ts: "2026-07-08T10:02:00Z",
    rejected: "rejected: Vivi wrote outside its allowlist",
  },
  {
    role: "action",
    text: "✓ pipeline.extract: extraction complete",
    ts: "2026-07-08T10:03:00Z",
    actions: [
      { tool: "pipeline.extract", ok: true, summary: "extraction complete" },
    ],
  },
  {
    role: "card",
    text: "Freeze the spec?",
    ts: "2026-07-08T10:04:00Z",
    card: {
      id: "card-1",
      title: "Freeze the spec?",
      body: "This locks the canonical.",
      actions: [
        {
          id: "go",
          label: "Freeze it",
          action: { kind: "control", tool: "pipeline.extract" },
        },
        {
          id: "later",
          label: "Not yet",
          variant: "outline",
          action: { kind: "dismiss" },
        },
      ],
    },
  },
]

const PENDING_CR = {
  id: "CR-0001",
  title: "Spike gate:phase0:s01-argon2id hypothesis disproven",
  status: "idea",
  classification: "major_product_change",
  created_at: "2026-07-03",
  source: "agent",
}

// stage/event intentionally unmapped in notifications.json: keeps notificationText falling back to the raw message, which these assertions rely on.
function notificationRows(...overrides: Array<Partial<Notification>>): Notification[] {
  return overrides.map((o, i) => ({
    id: `test-id-${i}`,
    ts: `2026-07-02T10:0${i}:00Z`,
    level: "info",
    stage: "test",
    event: "custom",
    message: `notification ${i}`,
    ...o,
  }))
}

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

const IDLE_STATUS = {
  run_active: false,
  verdict: "OK",
  issues_total: 0,
  issues_done: 0,
  gates: { pass: 0, fail: 0 },
}

function stubFetch(opts: {
  sessions?: {
    sessionId: string
    updated_at: string
    preview: string
    turns: number
  }[]
  turnsBySession?: Record<string, ViviTurn[]>
  post?: () => { body: unknown; status?: number }
  notifications?: Notification[]
  crs?: Array<typeof PENDING_CR>
  decide?: () => { body: unknown; status?: number }
  scaffold?: () => { body: unknown; status?: number }
}) {
  const liveNotifications = (opts.notifications ?? []).slice()
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/api/control/notifications")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { id?: string; all?: boolean }
        if (body.all) {
          for (const n of liveNotifications) n.dismissed = true
        } else if (body.id) {
          const found = liveNotifications.find((n) => (n.id ?? n.ts) === body.id)
          if (found) found.dismissed = true
        }
        return jsonResponse({ ok: true, dismissed: 1 })
      }
      return jsonResponse({ ok: true, notifications: liveNotifications })
    }
    if (url.includes("/api/control/crs/decide")) {
      const decide = opts.decide?.() ?? { body: { ok: true, summary: "applied" } }
      return jsonResponse(decide.body, decide.status)
    }
    if (url.includes("/api/control/crs")) {
      return jsonResponse({ ok: true, crs: opts.crs ?? [] })
    }
    if (url.includes("/api/project/scaffold")) {
      const scaffold = opts.scaffold?.() ?? {
        body: {
          ok: true,
          project: { root: "/tmp/acme-app", name: "acme-app", hasCanonicalSpec: true },
        },
      }
      return jsonResponse(scaffold.body, scaffold.status)
    }
    if (url.includes("/api/fs/list")) {
      return jsonResponse({ ok: true, path: "/home/dev", parent: "/home", entries: [] })
    }
    if (url.startsWith("/api/vivi/sessions/")) {
      const id = url.slice("/api/vivi/sessions/".length)
      return jsonResponse({
        ok: true,
        sessionId: id,
        turns: opts.turnsBySession?.[id] ?? [],
      })
    }
    if (url.startsWith("/api/vivi/sessions")) {
      return jsonResponse({ ok: true, sessions: opts.sessions ?? [] })
    }
    if (init?.method === "POST") {
      const post = opts.post?.() ?? { body: { ok: true } }
      return jsonResponse(post.body, post.status)
    }
    // Engine data is load-bearing, not dead: it makes the "no engine badge" test discriminating — a regressed on-open engine fetch would render the badge and turn the assertion red.
    return jsonResponse({
      ok: true,
      engine: {
        provider: "claude",
        providerLabel: "Claude Code",
        model: "claude-opus-4-8",
      },
    })
  })
}

function renderPanel(props?: {
  onActivity?: () => void
  hasTarget?: boolean
  projectRoot?: string | null
}) {
  return renderWithIntl(
    <ViviPanelProvider>
      <ViviPanel {...props} />
    </ViviPanelProvider>
  )
}

function CtaOpener() {
  const { openPanel } = useViviPanel()
  return (
    <button type="button" data-testid="vivi-cta" onClick={openPanel}>
      open
    </button>
  )
}

function renderPanelWithOpener(props?: {
  onActivity?: () => void
  hasTarget?: boolean
  projectRoot?: string | null
}) {
  return renderWithIntl(
    <ViviPanelProvider>
      <ViviPanel {...props} />
      <CtaOpener />
    </ViviPanelProvider>
  )
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource)
  FakeEventSource.last = null
  __resetPersistedBooleanStoresForTests()
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  __resetPersistedBooleanStoresForTests()
  window.localStorage.clear()
})

describe("ViviPanel — launcher bubble", () => {
  test("renders the launcher bubble when not on the no_target screen; the panel stays hidden until clicked", () => {
    vi.stubGlobal("fetch", stubFetch({}))
    renderPanel()
    expect(
      screen.getByRole("button", { name: "Open Vivi" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument()
  })

  test("hasTarget=true keeps the launcher bubble present", () => {
    vi.stubGlobal("fetch", stubFetch({}))
    renderPanel({ hasTarget: true })
    expect(
      screen.getByRole("button", { name: "Open Vivi" })
    ).toBeInTheDocument()
  })

  test("hasTarget=false hides the launcher bubble; the CTA opens the panel, which still closes and reopens", async () => {
    vi.stubGlobal("fetch", stubFetch({}))
    const user = userEvent.setup()
    renderPanelWithOpener({ hasTarget: false, projectRoot: null })

    expect(
      screen.queryByRole("button", { name: "Open Vivi" })
    ).not.toBeInTheDocument()

    await user.click(screen.getByTestId("vivi-cta"))
    expect(
      await screen.findByRole("complementary", { name: "Vivi" })
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Close Vivi" }))
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Vivi" })
      ).not.toBeInTheDocument()
    )

    await user.click(screen.getByTestId("vivi-cta"))
    expect(
      await screen.findByRole("complementary", { name: "Vivi" })
    ).toBeInTheDocument()

    expect(
      screen.queryByRole("button", { name: "Open Vivi" })
    ).not.toBeInTheDocument()
  })

  test("clicking the bubble opens the panel with header controls and tabs, no engine badge", async () => {
    vi.stubGlobal("fetch", stubFetch({}))
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))

    expect(
      await screen.findByRole("complementary", { name: "Vivi" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "New conversation" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Close Vivi" })
    ).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Chat" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Notifications/ })).toBeInTheDocument()
    expect(
      screen.queryByText(/claude-opus-4-8/)
    ).not.toBeInTheDocument()
  })
})

describe("ViviPanel — rehydration", () => {
  test("first open resumes the newest session and renders user/vivi/action/card turns", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        sessions: [
          {
            sessionId: SESSION_A,
            updated_at: "2026-07-08T10:04:00Z",
            preview: "I want a todo app.",
            turns: 5,
          },
        ],
        turnsBySession: { [SESSION_A]: HISTORY },
      })
    )
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))

    expect(await screen.findByText("I want a todo app.")).toBeInTheDocument()
    expect(
      screen.getByText("What states can a todo be in?")
    ).toBeInTheDocument()
    expect(
      screen.getByText(".vivicy/canonical/01-product.md")
    ).toBeInTheDocument()
    expect(screen.getByText(/wrote outside its allowlist/)).toBeInTheDocument()

    expect(screen.getByText("Actions")).toBeInTheDocument()
    expect(
      screen.getByText(/✓ pipeline\.extract: extraction complete/)
    ).toBeInTheDocument()

    expect(screen.getByText("Freeze the spec?")).toBeInTheDocument()
    expect(screen.getByText("This locks the canonical.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Freeze it" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Not yet" })).toBeEnabled()
  })

  test("a project-root change drops the thread and rehydrates against the new project's sessions", async () => {
    const sessions = [
      {
        sessionId: SESSION_A,
        updated_at: "2026-07-08T10:04:00Z",
        preview: "I want a todo app.",
        turns: 5,
      },
    ]
    vi.stubGlobal(
      "fetch",
      stubFetch({ sessions, turnsBySession: { [SESSION_A]: HISTORY } })
    )
    const user = userEvent.setup()
    const view = renderPanel({ projectRoot: "/proj/alpha" })

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    expect(await screen.findByText("I want a todo app.")).toBeInTheDocument()

    sessions.length = 0
    view.rerender(
      <ViviPanelProvider>
        <ViviPanel projectRoot="/proj/beta" />
      </ViviPanelProvider>
    )
    await waitFor(() =>
      expect(screen.queryByText("I want a todo app.")).not.toBeInTheDocument()
    )
    expect(screen.getByText(/a sentence is enough to start/)).toBeInTheDocument()
  })
})

describe("ViviPanel — send flow", () => {
  test("sending POSTs the message, then re-fetches the session so server-appended turns render", async () => {
    const afterTurns: ViviTurn[] = [
      { role: "user", text: "Add auth.", ts: "2026-07-08T11:00:00Z" },
      {
        role: "vivi",
        text: "Noted — magic links it is.",
        ts: "2026-07-08T11:01:00Z",
        wrote: [".vivicy/canonical/02-scope.md"],
      },
      {
        role: "action",
        text: "✓ status.read: pipeline idle",
        ts: "2026-07-08T11:02:00Z",
        actions: [{ tool: "status.read", ok: true, summary: "pipeline idle" }],
      },
    ]
    const fetchMock = stubFetch({
      sessions: [],
      turnsBySession: { [SESSION_B]: afterTurns },
      post: () => ({
        body: {
          ok: true,
          sessionId: SESSION_B,
          reply: "Noted — magic links it is.",
          wrote: [".vivicy/canonical/02-scope.md"],
          actions: [
            { tool: "status.read", ok: true, summary: "pipeline idle" },
          ],
        },
      }),
    })
    vi.stubGlobal("fetch", fetchMock)
    const onActivity = vi.fn()
    const user = userEvent.setup()
    renderPanel({ onActivity })

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    await user.type(screen.getByLabelText("Message Vivi"), "Add auth.")
    await user.click(screen.getByRole("button", { name: "Send message" }))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]) === "/api/vivi" &&
          (c[1] as RequestInit | undefined)?.method === "POST"
      )
      expect(post).toBeDefined()
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
        message: "Add auth.",
      })
    })

    expect(
      await screen.findByText("Noted — magic links it is.")
    ).toBeInTheDocument()
    expect(
      screen.getByText(/✓ status\.read: pipeline idle/)
    ).toBeInTheDocument()

    await waitFor(() => expect(onActivity).toHaveBeenCalled())
  })

  test("Enter sends the draft; Shift+Enter only inserts a newline", async () => {
    const fetchMock = stubFetch({
      sessions: [],
      turnsBySession: { [SESSION_B]: [] },
      post: () => ({
        body: { ok: true, sessionId: SESSION_B, reply: "ok", wrote: [] },
      }),
    })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    const input = screen.getByLabelText("Message Vivi")

    const countPosts = () =>
      fetchMock.mock.calls.filter(
        (c) =>
          String(c[0]) === "/api/vivi" &&
          (c[1] as RequestInit | undefined)?.method === "POST"
      ).length

    await user.type(input, "line one{Shift>}{Enter}{/Shift}line two")
    expect(countPosts()).toBe(0)
    expect(input).toHaveValue("line one\nline two")

    await user.type(input, "{Enter}")
    await waitFor(() => expect(countPosts()).toBe(1))
    const post = fetchMock.mock.calls.find(
      (c) =>
        String(c[0]) === "/api/vivi" &&
        (c[1] as RequestInit | undefined)?.method === "POST"
    )
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
      message: "line one\nline two",
    })
  })

  test("a failed POST surfaces an inline i18n error line — never a crash", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        sessions: [],
        post: () => ({
          body: {
            ok: false,
            error: "no project selected",
            code: "missing_target",
          },
          status: 422,
        }),
      })
    )
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    await user.type(screen.getByLabelText("Message Vivi"), "hello?")
    await user.click(screen.getByRole("button", { name: "Send message" }))

    expect(
      await screen.findByText(
        "no project selected — choose a target project first"
      )
    ).toBeInTheDocument()
    expect(screen.getByText("hello?")).toBeInTheDocument()
  })
})

describe("ViviPanel — onboarding view (no target project)", () => {
  test("hasTarget=false hosts the three acquisition choices instead of the chat", async () => {
    vi.stubGlobal("fetch", stubFetch({}))
    const user = userEvent.setup()
    renderPanelWithOpener({ hasTarget: false, projectRoot: null })

    await user.click(screen.getByTestId("vivi-cta"))

    const heading = await screen.findByText("Start a project")
    expect(heading).toBeInTheDocument()
    expect(heading).toHaveClass("text-center")
    expect(
      screen.queryByText(/develops one project from its canonical spec/)
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Open an existing project/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Start a new project/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Import documents/ })
    ).toBeInTheDocument()

    expect(screen.queryByLabelText("Message Vivi")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "New conversation" })
    ).not.toBeInTheDocument()
  })

  test("the scaffold choice POSTs /api/project/scaffold and reports the acquisition up", async () => {
    const fetchMock = stubFetch({})
    vi.stubGlobal("fetch", fetchMock)
    const onActivity = vi.fn()
    const user = userEvent.setup()
    renderPanelWithOpener({ hasTarget: false, projectRoot: null, onActivity })

    await user.click(screen.getByTestId("vivi-cta"))
    await user.click(
      await screen.findByRole("button", { name: /Start a new project/ })
    )

    // Inputs stay disabled until the folder listing settles; typing into a disabled input is a silent no-op, so wait for enabled first.
    const pathInput = screen.getByLabelText(/absolute target path/i)
    await waitFor(() => expect(pathInput).toBeEnabled(), { timeout: 5_000 })
    await user.type(screen.getByLabelText("Project name"), "Acme App")
    await user.type(pathInput, "/tmp/acme-app")
    const submit = screen.getByRole("button", { name: /Scaffold project/ })
    await waitFor(() => expect(submit).toBeEnabled())
    await user.click(submit)

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]).includes("/api/project/scaffold") &&
          (c[1] as RequestInit | undefined)?.method === "POST"
      )
      expect(post).toBeDefined()
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
        targetDir: "/tmp/acme-app",
        projectName: "Acme App",
      })
    })
    await waitFor(() => expect(onActivity).toHaveBeenCalled())
    // 15s test timeout must clear the internal 5s waitFor above with headroom, or full-suite contention flakes.
  }, 15_000)

  test("acquisition flips the panel to chat mode with the composer focused", async () => {
    vi.stubGlobal("fetch", stubFetch({ sessions: [] }))
    const user = userEvent.setup()
    const view = renderPanelWithOpener({ hasTarget: false, projectRoot: null })

    await user.click(screen.getByTestId("vivi-cta"))
    expect(await screen.findByText("Start a project")).toBeInTheDocument()

    view.rerender(
      <ViviPanelProvider>
        <ViviPanel hasTarget projectRoot="/tmp/acme-app" />
      </ViviPanelProvider>
    )

    const composer = await screen.findByLabelText("Message Vivi")
    await waitFor(() => expect(composer).toHaveFocus())
    expect(screen.getByText(/Tell Vivi what you want to build/)).toBeInTheDocument()
    expect(screen.queryByText("Start a project")).not.toBeInTheDocument()
  })
})

describe("ViviPanel — notifications tab", () => {
  test("the tab shows the undismissed count and the feed lists newest first", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        notifications: notificationRows(
          { message: "first" },
          { message: "second", dismissed: true },
          { message: "third" }
        ),
      })
    )
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    await waitFor(() =>
      expect(screen.getByLabelText("2 unread notifications")).toBeInTheDocument()
    )

    await user.click(screen.getByRole("tab", { name: /Notifications/ }))
    const feed = await screen.findByRole("tabpanel")
    const messages = within(feed).getAllByText(/^(first|third)$/)
    expect(messages[0]).toHaveTextContent("third")
    expect(messages[1]).toHaveTextContent("first")
    expect(within(feed).queryByText("second")).not.toBeInTheDocument()
  })

  test("dismissing one notification POSTs its id and drops it from feed + badge", async () => {
    const fetchMock = stubFetch({
      notifications: notificationRows(
        { id: "keep-1", message: "keep me" },
        { id: "bye-2", message: "dismiss me" }
      ),
    })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    await user.click(screen.getByRole("tab", { name: /Notifications/ }))
    const row = (await screen.findByText("dismiss me")).closest("li") as HTMLElement
    await user.click(within(row).getByRole("button", { name: "Dismiss notification" }))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]).includes("/api/control/notifications") &&
          (c[1] as RequestInit | undefined)?.method === "POST"
      )
      expect(post).toBeDefined()
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
        id: "bye-2",
      })
    })
    await waitFor(() =>
      expect(screen.queryByText("dismiss me")).not.toBeInTheDocument()
    )
    expect(screen.getByText("keep me")).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByLabelText("1 unread notification")).toBeInTheDocument()
    )
  })

  test("clear all confirms, POSTs { all: true }, and empties the feed", async () => {
    const fetchMock = stubFetch({ notifications: notificationRows({}, {}, {}) })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    await user.click(screen.getByRole("tab", { name: /Notifications/ }))
    await screen.findByText("notification 0")
    await user.click(screen.getByRole("button", { name: "Clear all" }))
    const confirm = await screen.findByRole("alertdialog")
    await user.click(within(confirm).getByRole("button", { name: "Clear all" }))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]).includes("/api/control/notifications") &&
          (c[1] as RequestInit | undefined)?.method === "POST"
      )
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
        all: true,
      })
    })
    await waitFor(() => expect(screen.getByText("No notifications.")).toBeInTheDocument())
  })

  test("a dev-status signature change on the SSE stream refetches the feed", async () => {
    const fetchMock = stubFetch({ notifications: [] })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull())

    const countGets = () =>
      fetchMock.mock.calls.filter(
        (c) =>
          String(c[0]).includes("/api/control/notifications") &&
          (c[1] as RequestInit | undefined)?.method !== "POST"
      ).length
    const baseline = countGets()

    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))
    expect(countGets()).toBe(baseline)

    await act(() =>
      FakeEventSource.last?.emit({
        ...IDLE_STATUS,
        issues_total: 8,
        issues_done: 1,
        run_active: true,
      })
    )
    await waitFor(() => expect(countGets()).toBe(baseline + 1))
  })

  test("a mapped stage/event renders the catalog text with the bare id — never a double colon", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        notifications: notificationRows({
          level: "warning",
          stage: "S9",
          event: "gate_failed",
          message: "ISS-0004: gate red",
        }),
      })
    )
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    await user.click(screen.getByRole("tab", { name: /Notifications/ }))

    // id extraction must stop before the ": " delimiter in "{id}: gate red", or this renders a double colon.
    expect(await screen.findByText("ISS-0004: gate red")).toBeInTheDocument()
    expect(screen.queryByText(/ISS-0004::/)).not.toBeInTheDocument()
  })

  test("Ask Vivi lands on the Chat tab with the composer pre-filled — the user presses send", async () => {
    const fetchMock = stubFetch({
      notifications: notificationRows({ message: "extraction blocked after retries" }),
    })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    await user.click(screen.getByRole("tab", { name: /Notifications/ }))
    await user.click(await screen.findByRole("button", { name: "Ask Vivi" }))

    const composer = await screen.findByLabelText("Message Vivi")
    expect(composer).toHaveValue(
      "Explain this notification and what I should do: «extraction blocked after retries»"
    )
    await waitFor(() => expect(composer).toHaveFocus())
    const posts = fetchMock.mock.calls.filter(
      (c) =>
        String(c[0]) === "/api/vivi" &&
        (c[1] as RequestInit | undefined)?.method === "POST"
    )
    expect(posts).toHaveLength(0)
  })

  test("a pending CR renders as a card; approving confirms, POSTs the decision, and shows the outcome inline", async () => {
    const fetchMock = stubFetch({
      notifications: [],
      crs: [PENDING_CR],
      decide: () => ({ body: { ok: true, summary: "applied and re-extracted" } }),
    })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    await user.click(screen.getByRole("tab", { name: /Notifications/ }))

    expect(await screen.findByText(/awaiting your decision/i)).toBeInTheDocument()
    expect(screen.getByText("CR-0001")).toBeInTheDocument()
    expect(screen.getByText(/hypothesis disproven/i)).toBeInTheDocument()
    expect(screen.getByText("major_product_change")).toBeInTheDocument()
    expect(screen.getByText("2026-07-03")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /^Approve$/ }))
    expect(
      fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/control/crs/decide"))
    ).toBeUndefined()
    const confirm = await screen.findByRole("alertdialog")
    await user.click(within(confirm).getByRole("button", { name: /^Approve$/ }))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]).includes("/api/control/crs/decide") &&
          (c[1] as RequestInit | undefined)?.method === "POST"
      )
      expect(post).toBeDefined()
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
        id: "CR-0001",
        decision: "approved",
      })
    })
    expect(
      await screen.findByText(/CR-0001 approved — applied and re-extracted/)
    ).toBeInTheDocument()
  })
})

describe("ViviPanel — closed-panel attention badge", () => {
  test("the launcher badge sums undismissed notifications + pending CRs, hidden while open", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        notifications: notificationRows({ message: "one" }, { message: "two" }),
        crs: [PENDING_CR],
      })
    )
    const user = userEvent.setup()
    renderPanel()

    expect(
      await screen.findByLabelText("3 items need your attention")
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    await waitFor(() =>
      expect(
        screen.queryByLabelText("3 items need your attention")
      ).not.toBeInTheDocument()
    )
    expect(screen.getByLabelText("3 unread notifications")).toBeInTheDocument()
  })
})

describe("ViviPanel — turn resilience", () => {
  test("the composer stays enabled through the turn and regains focus when it completes", async () => {
    const afterTurns: ViviTurn[] = [
      { role: "user", text: "Add auth.", ts: "2026-07-08T11:00:00Z" },
      { role: "vivi", text: "Done — magic links.", ts: "2026-07-08T11:01:00Z" },
    ]
    const base = stubFetch({
      sessions: [],
      turnsBySession: { [SESSION_B]: afterTurns },
      post: () => ({
        body: {
          ok: true,
          sessionId: SESSION_B,
          reply: "Done — magic links.",
          wrote: [],
        },
      }),
    })
    const gate = deferred()
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/vivi" && init?.method === "POST") {
          await gate.promise
        }
        return base(input, init)
      }
    )
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    const composer = screen.getByLabelText("Message Vivi")
    await user.type(composer, "Add auth.")
    await user.click(screen.getByRole("button", { name: "Send message" }))

    expect(composer).toBeEnabled()
    await user.type(composer, "next thought")
    expect(composer).toHaveValue("next thought")

    act(() => screen.getByRole("button", { name: "Close Vivi" }).focus())
    expect(composer).not.toHaveFocus()

    gate.resolve()
    expect(
      await screen.findByText("Done — magic links.")
    ).toBeInTheDocument()
    await waitFor(() => expect(composer).toHaveFocus())
  })

  test("a rehydration cancelled by a dep flip retries instead of latching hydrated", async () => {
    let indexCalls = 0
    const firstGate = deferred() // never resolved: the cancelled first attempt
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith("/api/vivi/sessions/")) {
          return jsonResponse({ ok: true, sessionId: SESSION_A, turns: HISTORY })
        }
        if (url.startsWith("/api/vivi/sessions")) {
          indexCalls += 1
          if (indexCalls === 1) await firstGate.promise
          return jsonResponse({
            ok: true,
            sessions: [
              {
                sessionId: SESSION_A,
                updated_at: "2026-07-08T10:04:00Z",
                preview: "I want a todo app.",
                turns: 5,
              },
            ],
          })
        }
        if (url.includes("/api/control/notifications"))
          return jsonResponse({ ok: true, notifications: [] })
        if (url.includes("/api/control/crs"))
          return jsonResponse({ ok: true, crs: [] })
        if (init?.method === "POST") return jsonResponse({ ok: true })
        return jsonResponse({ ok: true })
      }
    )
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    const view = renderPanel({ projectRoot: "/proj/x" })

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    view.rerender(
      <ViviPanelProvider>
        <ViviPanel hasTarget projectRoot="/proj/x" />
      </ViviPanelProvider>
    )
    expect(await screen.findByText("I want a todo app.")).toBeInTheDocument()
  })

  test("a card resync landing after New conversation does not resurrect the cleared thread", async () => {
    let turnsCalls = 0
    const resyncGate = deferred()
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === "/api/vivi/card" && init?.method === "POST") {
          return jsonResponse({
            ok: true,
            summary: "frozen",
            decided: { actionId: "go", at: "2026-07-08T10:05:00Z", summary: "frozen" },
          })
        }
        if (url.startsWith("/api/vivi/sessions/")) {
          turnsCalls += 1
          if (turnsCalls >= 2) await resyncGate.promise
          return jsonResponse({ ok: true, sessionId: SESSION_A, turns: HISTORY })
        }
        if (url.startsWith("/api/vivi/sessions")) {
          return jsonResponse({
            ok: true,
            sessions: [
              {
                sessionId: SESSION_A,
                updated_at: "2026-07-08T10:04:00Z",
                preview: "I want a todo app.",
                turns: 5,
              },
            ],
          })
        }
        if (url.includes("/api/control/notifications"))
          return jsonResponse({ ok: true, notifications: [] })
        if (url.includes("/api/control/crs"))
          return jsonResponse({ ok: true, crs: [] })
        return jsonResponse({ ok: true })
      }
    )
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderPanel({ projectRoot: "/proj/x", hasTarget: true })

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    expect(await screen.findByText("I want a todo app.")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Freeze it" }))
    await user.click(screen.getByRole("button", { name: "New conversation" }))
    await waitFor(() =>
      expect(screen.queryByText("I want a todo app.")).not.toBeInTheDocument()
    )

    resyncGate.resolve()
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText("I want a todo app.")).not.toBeInTheDocument()
    expect(screen.getByText(/a sentence is enough to start/)).toBeInTheDocument()
  })

  test("a project switch mid-send discards the stale reply instead of writing it into the new project", async () => {
    const staleTurns: ViviTurn[] = [
      { role: "user", text: "Add auth.", ts: "2026-07-08T11:00:00Z" },
      { role: "vivi", text: "Stale reply.", ts: "2026-07-08T11:01:00Z" },
    ]
    const postGate = deferred()
    const sessions = [
      {
        sessionId: SESSION_A,
        updated_at: "2026-07-08T10:04:00Z",
        preview: "I want a todo app.",
        turns: 5,
      },
    ]
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === "/api/vivi" && init?.method === "POST") {
          await postGate.promise
          return jsonResponse({
            ok: true,
            sessionId: SESSION_B,
            reply: "Stale reply.",
            wrote: [],
          })
        }
        if (url.startsWith("/api/vivi/sessions/")) {
          const id = url.slice("/api/vivi/sessions/".length)
          return jsonResponse({
            ok: true,
            sessionId: id,
            turns: id === SESSION_A ? HISTORY : id === SESSION_B ? staleTurns : [],
          })
        }
        if (url.startsWith("/api/vivi/sessions")) {
          return jsonResponse({ ok: true, sessions })
        }
        if (url.includes("/api/control/notifications"))
          return jsonResponse({ ok: true, notifications: [] })
        if (url.includes("/api/control/crs"))
          return jsonResponse({ ok: true, crs: [] })
        return jsonResponse({ ok: true })
      }
    )
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    const view = renderPanel({ projectRoot: "/proj/alpha", hasTarget: true })

    await user.click(screen.getByRole("button", { name: "Open Vivi" }))
    expect(await screen.findByText("I want a todo app.")).toBeInTheDocument()

    await user.type(screen.getByLabelText("Message Vivi"), "Add auth.")
    await user.click(screen.getByRole("button", { name: "Send message" }))

    sessions.length = 0
    view.rerender(
      <ViviPanelProvider>
        <ViviPanel projectRoot="/proj/beta" hasTarget />
      </ViviPanelProvider>
    )
    await waitFor(() =>
      expect(screen.queryByText("I want a todo app.")).not.toBeInTheDocument()
    )

    postGate.resolve()
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText("Stale reply.")).not.toBeInTheDocument()
    expect(screen.getByText(/a sentence is enough to start/)).toBeInTheDocument()
  })
})

describe("ViviPanel — mid-turn resume", () => {
  test("a reload whose last turn is the user's shows the pending marker and polls until the reply lands", async () => {
    vi.useFakeTimers()
    try {
      const pendingThread: ViviTurn[] = [
        { role: "user", text: "Add auth.", ts: "2026-07-08T11:00:00Z" },
      ]
      const answeredThread: ViviTurn[] = [
        ...pendingThread,
        { role: "vivi", text: "Magic links it is.", ts: "2026-07-08T11:01:00Z" },
      ]
      let current = pendingThread
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          if (url.startsWith("/api/vivi/sessions/")) {
            return jsonResponse({ ok: true, sessionId: SESSION_A, turns: current })
          }
          if (url.startsWith("/api/vivi/sessions")) {
            return jsonResponse({
              ok: true,
              sessions: [
                {
                  sessionId: SESSION_A,
                  updated_at: "2026-07-08T11:00:00Z",
                  preview: "Add auth.",
                  turns: 1,
                },
              ],
            })
          }
          if (url.includes("/api/control/notifications"))
            return jsonResponse({ ok: true, notifications: [] })
          if (url.includes("/api/control/crs"))
            return jsonResponse({ ok: true, crs: [] })
          if (init?.method === "POST") return jsonResponse({ ok: true })
          return jsonResponse({ ok: true })
        }
      )
      vi.stubGlobal("fetch", fetchMock)
      // fireEvent, not userEvent: userEvent's internal delays deadlock under fake timers.
      renderPanel({ projectRoot: "/proj/x", hasTarget: true })
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Open Vivi" }))
      })
      await act(async () => {
        for (let i = 0; i < 20; i++) await Promise.resolve()
      })

      expect(screen.getByText("Add auth.")).toBeInTheDocument()
      expect(screen.getByText("Vivi is thinking…")).toBeInTheDocument()

      current = answeredThread
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100)
      })
      expect(screen.getByText("Magic links it is.")).toBeInTheDocument()
      expect(screen.queryByText("Vivi is thinking…")).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
