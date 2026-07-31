import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, test, vi } from "vitest"

import { TRANSLATED_NOTIFICATION_EVENTS } from "@/lib/notification-events"
import type { Notification } from "@/lib/notifications"
import { isActionableNotification, NotificationsFeed } from "@/components/chat/vivi-notifications"
import { renderWithIntl } from "@/test/render"

function notification(overrides: Partial<Notification>): Notification {
  return {
    id: "n-1",
    ts: "2026-07-02T10:00:00Z",
    level: "info",
    stage: "S9",
    event: "custom",
    message: "something happened",
    ...overrides,
  }
}

function renderFeed(notifications: Notification[], onAskVivi = vi.fn()) {
  renderWithIntl(<NotificationsFeed notifications={notifications} crs={[]} onReload={vi.fn()} onAskVivi={onAskVivi} />)
  return onAskVivi
}

describe("isActionableNotification", () => {
  test.each(["error", "warning"] as const)("%s calls for a next step", (level) => {
    expect(isActionableNotification(notification({ level }))).toBe(true)
  })

  test.each(["info", "success"] as const)("%s is purely informational", (level) => {
    expect(isActionableNotification(notification({ level }))).toBe(false)
  })
})

describe("Ask Vivi pill", () => {
  test("an actionable notification shows the green Sparkles pill wired to onAskVivi", async () => {
    const onAskVivi = renderFeed([notification({ level: "error", message: "extraction blocked after retries" })])

    const pill = await screen.findByRole("button", { name: "Ask Vivi" })
    expect(pill.className).toContain("rounded-full")
    expect(pill.className).toContain("bg-primary")
    expect(pill.querySelector("svg.lucide-sparkles")).not.toBeNull()

    await userEvent.click(pill)
    expect(onAskVivi).toHaveBeenCalledWith("extraction blocked after retries")
  })

  test("the finished run — the one notification that asks for nothing — offers no Ask Vivi pill", async () => {
    const message = "build complete — all 9 issues are delivered and whole-product acceptance passed; your project is ready"
    renderFeed([notification({ level: "success", stage: "S12", event: "run_finished", message })])

    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Ask Vivi" })).toBeNull()
  })
})

function sampleParams(stage: string, event: string, declared: readonly string[]): Record<string, string> {
  return Object.fromEntries(declared.map((name) => [name, `${name}-of-${stage}-${event}`]))
}

describe("catalogue rendering through the real provider", () => {
  const keyed = Object.entries(TRANSLATED_NOTIFICATION_EVENTS).flatMap(([stage, events]) =>
    Object.entries(events).map(([event, params]) => ({ stage, event, params: params as readonly string[] }))
  )

  test.each(keyed)("$stage.$event renders its key with every declared value substituted", ({ stage, event, params }) => {
    const values = sampleParams(stage, event, params)
    renderFeed([notification({ level: "error", stage, event, message: `RAW-${stage}-${event}`, params: values })])

    const row = screen.getByRole("listitem")
    expect(row).not.toHaveTextContent(`RAW-${stage}-${event}`)
    for (const value of Object.values(values)) expect(row).toHaveTextContent(value)
    expect(row.textContent).not.toMatch(/[{}]/)
  })

  test("a row missing a value its key interpolates renders the writer's own sentence instead", () => {
    renderFeed([
      notification({ level: "error", stage: "cycle", event: "cycle_error", message: "spec-cycle transition refused — a cycle is open" }),
    ])

    expect(screen.getByText("spec-cycle transition refused — a cycle is open")).toBeInTheDocument()
  })

  test("a declared-untranslated event renders the writer's composed sentence verbatim", () => {
    const message = "2 possible secret keys detected in 1 file of batch 2026-07-31 — remove or rotate them and re-import"
    renderFeed([notification({ level: "warning", stage: "import", event: "secret_finding", message })])

    expect(screen.getByText(message)).toBeInTheDocument()
  })
})
