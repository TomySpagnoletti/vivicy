import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { SectionLegend } from "@/components/sidebar/section-legend"
import { __resetPersistedBooleanStoresForTests } from "@/hooks/use-persisted-boolean"
import type { MapNode } from "@/lib/types"
import { renderWithIntl } from "@/test/render"

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
  // Persisted-open state lives in a module store AND localStorage — reset both so each test starts collapsed.
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
    renderWithIntl(<SectionLegend view="target" nodes={NODES} />)

    expect(screen.queryByText("service")).not.toBeInTheDocument()
    expect(screen.queryByText("agent")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Legend ·/ }))

    expect(await screen.findByText("agent")).toBeInTheDocument()
    expect(screen.getByText("service")).toBeInTheDocument()
  })
})

describe("SectionLegend — title reflects the current view", () => {
  test("target view labels the legend 'Kind colors'", () => {
    renderWithIntl(<SectionLegend view="target" nodes={NODES} />)
    expect(screen.getByRole("button", { name: /Legend · Kind colors/ })).toBeInTheDocument()
  })

  test("progress view labels the legend 'Progress colors'", () => {
    renderWithIntl(<SectionLegend view="progress" nodes={NODES} />)
    expect(
      screen.getByRole("button", { name: /Legend · Progress colors/ })
    ).toBeInTheDocument()
  })

  test("progress view, once opened, shows status swatches from the status legend", async () => {
    const user = userEvent.setup()
    renderWithIntl(
      <SectionLegend
        view="progress"
        nodes={NODES}
        statusLegend={{ in_progress: "#dbeafe", verified: "#dcfce7" }}
      />
    )
    expect(screen.queryByText("verified")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Legend ·/ }))

    expect(await screen.findByText("in_progress")).toBeInTheDocument()
    expect(screen.getByText("verified")).toBeInTheDocument()
    expect(screen.queryByText("service")).not.toBeInTheDocument()
  })
})
