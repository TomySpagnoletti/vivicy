import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { SectionLegend } from "@/components/sidebar/section-legend"
import { __resetPersistedBooleanStoresForTests } from "@/hooks/use-persisted-boolean"
import type { MapNode } from "@/lib/types"

/** Two nodes of distinct kinds so the target legend has >1 swatch. */
function node(id: string, kind: string): MapNode {
  return {
    id,
    label: id,
    kind,
    lane: "core",
    layout_x: 0,
    layout_y: 0,
    graph_ref: `node:${id}`,
  }
}

const NODES = [node("a", "service"), node("b", "agent")]

beforeEach(() => {
  // The persisted-open state lives in a module-level store; reset it (and the
  // backing localStorage) so each test starts collapsed-by-default.
  __resetPersistedBooleanStoresForTests()
  window.localStorage.clear()
})
afterEach(() => {
  __resetPersistedBooleanStoresForTests()
  window.localStorage.clear()
})

describe("SectionLegend — collapsed by default", () => {
  test("swatch labels are hidden until the trigger is clicked", async () => {
    const user = userEvent.setup()
    render(<SectionLegend view="target" nodes={NODES} />)

    // The Collapsible content is closed: Radix renders it hidden, so the swatch
    // labels are not visible to the accessibility tree / screen queries.
    expect(screen.queryByText("service")).not.toBeInTheDocument()
    expect(screen.queryByText("agent")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Legend ·/ }))

    // After opening, the kind swatches appear (sorted: agent, service).
    expect(await screen.findByText("agent")).toBeInTheDocument()
    expect(screen.getByText("service")).toBeInTheDocument()
  })
})

describe("SectionLegend — title reflects the current view", () => {
  test("target view labels the legend 'Kind colors'", () => {
    render(<SectionLegend view="target" nodes={NODES} />)
    expect(screen.getByRole("button", { name: /Legend · Kind colors/ })).toBeInTheDocument()
  })

  test("progress view labels the legend 'Progress colors'", () => {
    render(<SectionLegend view="progress" nodes={NODES} />)
    expect(
      screen.getByRole("button", { name: /Legend · Progress colors/ })
    ).toBeInTheDocument()
  })

  test("progress view, once opened, shows status swatches from the status legend", async () => {
    const user = userEvent.setup()
    render(
      <SectionLegend
        view="progress"
        nodes={NODES}
        statusLegend={{ in_progress: "#dbeafe", verified: "#dcfce7" }}
      />
    )
    // Closed first: no status labels visible.
    expect(screen.queryByText("verified")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Legend ·/ }))

    // Opened: one swatch per status key from the supplied legend.
    expect(await screen.findByText("in_progress")).toBeInTheDocument()
    expect(screen.getByText("verified")).toBeInTheDocument()
    // It used the status keys, not the node kinds.
    expect(screen.queryByText("service")).not.toBeInTheDocument()
  })
})
