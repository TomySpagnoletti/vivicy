import { act, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { NotificationBell } from "@/components/notifications/notification-bell"
import type { Notification } from "@/lib/notifications"
import { renderWithIntl } from "@/test/render"

// Minimal EventSource fake so the bell can subscribe to the SSE status stream
// in jsdom, mirroring components/sidebar/process-control-bar.test.tsx.
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

// stage/event have no messages/en/notifications.json entry on purpose: these
// fixtures assert on arbitrary opaque `message` text (dismiss/list mechanics),
// which only stays honest when notificationText has nothing to translate and
// falls back to the raw stored message, exactly like a real unmapped event.
function rows(...overrides: Array<Partial<Notification>>): Notification[] {
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

function stubFetch(notifications: Notification[]) {
  const live = notifications.slice()
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/api/control/notifications")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { id?: string; all?: boolean }
        if (body.all) {
          for (const n of live) n.dismissed = true
        } else if (body.id) {
          const found = live.find((n) => (n.id ?? n.ts) === body.id)
          if (found) found.dismissed = true
        }
        return new Response(JSON.stringify({ ok: true, dismissed: 1 }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, notifications: live }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
}

beforeEach(() => {
  vi.useRealTimers()
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource)
  FakeEventSource.last = null
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("NotificationBell — unread count", () => {
  test("shows no badge when there are no notifications", async () => {
    vi.stubGlobal("fetch", stubFetch([]))
    renderWithIntl(<NotificationBell />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument())
    expect(screen.queryByLabelText(/unread notification/)).toBeNull()
  })

  test("counts only un-dismissed notifications", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch(rows({}, { dismissed: true }, {}))
    )
    renderWithIntl(<NotificationBell />)
    await waitFor(() => expect(screen.getByLabelText("2 unread notifications")).toBeInTheDocument())
  })

  test("singular wording for exactly one unread", async () => {
    vi.stubGlobal("fetch", stubFetch(rows({})))
    renderWithIntl(<NotificationBell />)
    await waitFor(() => expect(screen.getByLabelText("1 unread notification")).toBeInTheDocument())
  })
})

describe("NotificationBell — SSE reactivity", () => {
  test("a status-signature change on the stream triggers an immediate refetch", async () => {
    const fetchMock = stubFetch([])
    vi.stubGlobal("fetch", fetchMock)
    renderWithIntl(<NotificationBell />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument())

    const countGets = () =>
      fetchMock.mock.calls.filter(
        (c) => String(c[0]).includes("/api/control/notifications") && (c[1] as RequestInit | undefined)?.method !== "POST"
      ).length
    const baseline = countGets()

    // First frame only records the signature — no refetch (mirrors the control
    // bar's skip-first-frame rule).
    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))
    expect(countGets()).toBe(baseline)

    // A changed signature (an issue completed) must refetch promptly (P9).
    await act(() => FakeEventSource.last?.emit({ ...IDLE_STATUS, issues_total: 8, issues_done: 1, run_active: true }))
    await waitFor(() => expect(countGets()).toBe(baseline + 1))
  })

  test("an identical signature does not refetch (no churn on every poll tick)", async () => {
    const fetchMock = stubFetch([])
    vi.stubGlobal("fetch", fetchMock)
    renderWithIntl(<NotificationBell />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument())

    const countGets = () =>
      fetchMock.mock.calls.filter(
        (c) => String(c[0]).includes("/api/control/notifications") && (c[1] as RequestInit | undefined)?.method !== "POST"
      ).length

    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))
    const afterFirst = countGets()
    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))
    await act(() => FakeEventSource.last?.emit(IDLE_STATUS))
    expect(countGets()).toBe(afterFirst)
  })
})

describe("NotificationBell — opening the center + dismiss flow", () => {
  test("clicking the bell opens the sheet listing newest-first", async () => {
    const user = userEvent.setup()
    vi.stubGlobal("fetch", stubFetch(rows({ message: "first" }, { message: "second" })))
    renderWithIntl(<NotificationBell />)
    await waitFor(() => expect(screen.getByLabelText("2 unread notifications")).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: "Notifications" }))
    const sheet = await screen.findByRole("dialog", { name: "Notifications" })
    const messages = within(sheet).getAllByText(/first|second/)
    expect(messages[0]).toHaveTextContent("second")
    expect(messages[1]).toHaveTextContent("first")
  })

  test("dismissing one notification POSTs its id and drops it from the list + badge", async () => {
    const user = userEvent.setup()
    const fetchMock = stubFetch(
      rows({ id: "keep-1", message: "keep me" }, { id: "bye-2", message: "dismiss me" })
    )
    vi.stubGlobal("fetch", fetchMock)
    renderWithIntl(<NotificationBell />)
    await waitFor(() => expect(screen.getByLabelText("2 unread notifications")).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: "Notifications" }))
    const sheet = await screen.findByRole("dialog", { name: "Notifications" })
    const row = within(sheet).getByText("dismiss me").closest("li") as HTMLElement
    await user.click(within(row).getByRole("button", { name: "Dismiss notification" }))

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/api/control/notifications") && (c[1] as RequestInit)?.method === "POST"
      )
      expect(postCall).toBeDefined()
      expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({ id: "bye-2" })
    })
    await waitFor(() => expect(screen.getByLabelText("1 unread notification")).toBeInTheDocument())
    expect(within(sheet).queryByText("dismiss me")).toBeNull()
    expect(within(sheet).getByText("keep me")).toBeInTheDocument()
  })

  test("clear all confirm dismisses every visible notification", async () => {
    const user = userEvent.setup()
    const fetchMock = stubFetch(rows({}, {}, {}))
    vi.stubGlobal("fetch", fetchMock)
    renderWithIntl(<NotificationBell />)
    await waitFor(() => expect(screen.getByLabelText("3 unread notifications")).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: "Notifications" }))
    await screen.findByRole("dialog", { name: "Notifications" })
    await user.click(screen.getByRole("button", { name: "Clear all" }))
    const confirmDialog = await screen.findByRole("alertdialog")
    await user.click(within(confirmDialog).getByRole("button", { name: "Clear all" }))

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/api/control/notifications") && (c[1] as RequestInit)?.method === "POST"
      )
      expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({ all: true })
    })
    await waitFor(() => expect(screen.queryByLabelText(/unread notification/)).toBeNull())
  })
})
