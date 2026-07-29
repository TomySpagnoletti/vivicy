import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, test, vi } from "vitest"

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
