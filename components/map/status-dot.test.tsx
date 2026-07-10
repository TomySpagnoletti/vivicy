import { render } from "@testing-library/react"
import { describe, expect, test } from "vitest"

import { StatusDot } from "@/components/map/status-dot"
import type { NodeStatus } from "@/lib/types"

const EXPECTED_BG: Record<NodeStatus, string> = {
  not_started: "bg-border",
  in_progress: "bg-status-in-progress",
  reviewing: "bg-status-reviewing",
  implemented: "bg-status-implemented",
  verified: "bg-status-verified",
  blocked: "bg-status-blocked",
}

function renderDot(status: NodeStatus | null | undefined) {
  const { container } = render(<StatusDot status={status} />)
  return container.querySelector("span") as HTMLSpanElement
}

describe("StatusDot — status maps to a background token", () => {
  test.each(Object.entries(EXPECTED_BG))(
    "%s renders the %s background class",
    (status, expectedClass) => {
      const dot = renderDot(status as NodeStatus)
      expect(dot).toHaveClass(expectedClass)
      expect(dot).toHaveAttribute("aria-hidden")
      expect(dot).toHaveClass("rounded-full")
    }
  )

  test("null and undefined fall back to the neutral not_started token", () => {
    expect(renderDot(null)).toHaveClass("bg-border")
    expect(renderDot(undefined)).toHaveClass("bg-border")
  })

  test("distinct statuses produce distinct color classes", () => {
    const inProgress = renderDot("in_progress")
    const verified = renderDot("verified")
    const blocked = renderDot("blocked")
    expect(inProgress).toHaveClass("bg-status-in-progress")
    expect(verified).toHaveClass("bg-status-verified")
    expect(blocked).toHaveClass("bg-status-blocked")
    expect(inProgress).not.toHaveClass("bg-status-verified")
    expect(verified).not.toHaveClass("bg-status-blocked")
  })

  test("an extra className is merged onto the dot, not replacing the token", () => {
    const { container } = render(<StatusDot status="verified" className="mt-1 shrink-0" />)
    const dot = container.querySelector("span") as HTMLSpanElement
    expect(dot).toHaveClass("bg-status-verified")
    expect(dot).toHaveClass("mt-1")
    expect(dot).toHaveClass("shrink-0")
  })
})
