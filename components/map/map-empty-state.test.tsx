import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, test, vi } from "vitest"

import { MapEmptyState } from "@/components/map/map-empty-state"

describe("MapEmptyState — guidance per empty reason", () => {
  test("no_target shows the project-picker guidance and NO Extract button", () => {
    render(<MapEmptyState reason="no_target" onExtract={vi.fn()} />)
    expect(screen.getByText("No project selected")).toBeInTheDocument()
    expect(screen.getByText(/Use “Open project” in the top-left/)).toBeInTheDocument()
    // Extract makes no sense before a target is resolved — even with onExtract.
    expect(
      screen.queryByRole("button", { name: /Extract from docs/ })
    ).not.toBeInTheDocument()
  })

  test("no_map shows the run-Extract guidance and an enabled Extract button", () => {
    render(<MapEmptyState reason="no_map" onExtract={vi.fn()} />)
    expect(screen.getByText("No architecture map yet")).toBeInTheDocument()
    expect(screen.getByText(/Run Extract to generate it from docs\//)).toBeInTheDocument()
    const extract = screen.getByRole("button", { name: "Extract from docs" })
    expect(extract).toBeEnabled()
  })

  test("empty_map shows the re-run guidance and an Extract button", () => {
    render(<MapEmptyState reason="empty_map" onExtract={vi.fn()} />)
    expect(screen.getByText("Architecture map is empty")).toBeInTheDocument()
    expect(screen.getByText(/Re-run Extract after the canonical docs/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Extract from docs" })).toBeInTheDocument()
    // The reason is reflected on the Card for downstream selectors.
    expect(document.querySelector('[data-empty-reason="empty_map"]')).toBeTruthy()
  })

  test("clicking Extract calls onExtract", async () => {
    const user = userEvent.setup()
    const onExtract = vi.fn()
    render(<MapEmptyState reason="no_map" onExtract={onExtract} />)
    await user.click(screen.getByRole("button", { name: "Extract from docs" }))
    expect(onExtract).toHaveBeenCalledTimes(1)
  })

  test("extracting=true labels the button 'Extracting…' and disables it", async () => {
    const user = userEvent.setup()
    const onExtract = vi.fn()
    render(<MapEmptyState reason="no_map" onExtract={onExtract} extracting />)
    const extract = screen.getByRole("button", { name: "Extracting…" })
    expect(extract).toBeDisabled()
    // The idle label is gone, and a disabled button cannot fire onExtract.
    expect(screen.queryByRole("button", { name: "Extract from docs" })).toBeNull()
    await user.click(extract).catch(() => undefined)
    expect(onExtract).not.toHaveBeenCalled()
  })

  test("no Extract button when onExtract is omitted, even for an extractable reason", () => {
    render(<MapEmptyState reason="no_map" />)
    expect(screen.getByText("No architecture map yet")).toBeInTheDocument()
    expect(screen.queryByRole("button")).toBeNull()
  })
})
