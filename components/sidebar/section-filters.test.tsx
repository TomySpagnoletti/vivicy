import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, test, vi } from "vitest"

import { SectionFilters } from "@/components/sidebar/section-filters"
import type { ArchitectureMapData } from "@/lib/types"
import { renderWithIntl } from "@/test/render"

const DATA: ArchitectureMapData = {
  name: "demo-map",
  lanes: [
    { id: "edge", label: "Edge" },
    { id: "core", label: "Core" },
  ],
  statusLegend: {
    not_started: "#f8fafc",
    in_progress: "#dbeafe",
    verified: "#dcfce7",
  },
  nodes: [],
  edges: [],
}

function setup(overrides?: Partial<Parameters<typeof SectionFilters>[0]>) {
  const props = {
    data: DATA,
    view: "target" as const,
    onViewChange: vi.fn(),
    query: "",
    onQueryChange: vi.fn(),
    laneFilter: "all",
    onLaneFilterChange: vi.fn(),
    statusFilter: "all",
    onStatusFilterChange: vi.fn(),
    scopeFilter: "all",
    onScopeFilterChange: vi.fn(),
    ...overrides,
  }
  renderWithIntl(<SectionFilters {...props} />)
  return props
}

describe("SectionFilters — view toggle", () => {
  test("clicking Progress fires onViewChange('progress')", async () => {
    const user = userEvent.setup()
    const props = setup({ view: "target" })
    await user.click(screen.getByRole("radio", { name: "Progress" }))
    expect(props.onViewChange).toHaveBeenCalledWith("progress")
  })

  test("clicking Target while on Progress fires onViewChange('target')", async () => {
    const user = userEvent.setup()
    const props = setup({ view: "progress" })
    await user.click(screen.getByRole("radio", { name: "Target" }))
    expect(props.onViewChange).toHaveBeenCalledWith("target")
  })

  test("the current view is reflected as the pressed toggle", () => {
    setup({ view: "progress" })
    expect(screen.getByRole("radio", { name: "Progress" })).toHaveAttribute(
      "aria-checked",
      "true"
    )
    expect(screen.getByRole("radio", { name: "Target" })).toHaveAttribute(
      "aria-checked",
      "false"
    )
  })
})

describe("SectionFilters — search input", () => {
  test("typing fires onQueryChange with the typed character", async () => {
    const user = userEvent.setup()
    const props = setup()
    const input = screen.getByRole("searchbox")
    await user.type(input, "a")
    expect(props.onQueryChange).toHaveBeenCalledWith("a")
  })

  test("renders the current query value", () => {
    setup({ query: "telegram" })
    expect(screen.getByRole("searchbox")).toHaveValue("telegram")
  })
})

describe("SectionFilters — lane / status / scope selects", () => {
  test("choosing a lane fires onLaneFilterChange with the lane id", async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(screen.getByLabelText("Lane"))
    await user.click(await screen.findByRole("option", { name: "Core" }))
    expect(props.onLaneFilterChange).toHaveBeenCalledWith("core")
  })

  test("the lane dropdown lists every lane from the data plus All", async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByLabelText("Lane"))
    const listbox = await screen.findByRole("listbox")
    expect(within(listbox).getByRole("option", { name: "All" })).toBeInTheDocument()
    expect(within(listbox).getByRole("option", { name: "Edge" })).toBeInTheDocument()
    expect(within(listbox).getByRole("option", { name: "Core" })).toBeInTheDocument()
  })

  test("choosing a status fires onStatusFilterChange with the status key", async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(screen.getByLabelText("Status"))
    await user.click(await screen.findByRole("option", { name: "in progress" }))
    expect(props.onStatusFilterChange).toHaveBeenCalledWith("in_progress")
  })

  test("choosing a scope fires onScopeFilterChange with the scope value", async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(screen.getByLabelText("Scope"))
    await user.click(await screen.findByRole("option", { name: "MVP" }))
    expect(props.onScopeFilterChange).toHaveBeenCalledWith("mvp")
  })
})
