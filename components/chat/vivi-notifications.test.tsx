import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, test, vi } from "vitest"

import type { Notification } from "@/lib/notifications"
import {
  isActionableNotification,
  NotificationsFeed,
} from "@/components/chat/vivi-notifications"
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
  renderWithIntl(
    <NotificationsFeed
      notifications={notifications}
      crs={[]}
      onReload={vi.fn()}
      onAskVivi={onAskVivi}
    />
  )
  return onAskVivi
}

describe("isActionableNotification", () => {
  test.each(["error", "warning", "warn"])("%s calls for a next step", (level) => {
    expect(isActionableNotification(notification({ level }))).toBe(true)
  })

  test.each(["info", "success", undefined])("%s is purely informational", (level) => {
    expect(isActionableNotification(notification({ level }))).toBe(false)
  })
})

describe("Ask Vivi pill", () => {
  test("an actionable notification shows the green Sparkles pill wired to onAskVivi", async () => {
    const onAskVivi = renderFeed([
      notification({ level: "error", message: "extraction blocked after retries" }),
    ])

    const pill = await screen.findByRole("button", { name: "Ask Vivi" })
    expect(pill.className).toContain("rounded-full")
    expect(pill.className).toContain("bg-primary")
    expect(pill.querySelector("svg.lucide-sparkles")).not.toBeNull()

    await userEvent.click(pill)
    expect(onAskVivi).toHaveBeenCalledWith("extraction blocked after retries")
  })

  test("an informational notification offers no Ask Vivi pill", async () => {
    renderFeed([notification({ level: "info", message: "import batch placed" })])

    expect(await screen.findByText("import batch placed")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Ask Vivi" })).toBeNull()
  })
})
