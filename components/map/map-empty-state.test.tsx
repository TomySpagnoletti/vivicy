import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, test, vi } from "vitest"

import { MapEmptyState } from "@/components/map/map-empty-state"
import map from "@/messages/en/map.json"
import project from "@/messages/en/project.json"

// MapEmptyState hosts project/import-docs-flow.tsx in its inline dialog (owned by
// the project area), so its catalog namespace has to be present too, not just "map".
function renderEmptyState(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ map, project }}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("MapEmptyState — guidance per empty reason", () => {
  test("no_target shows the open-Vivi guidance and NO Extract button", () => {
    renderEmptyState(<MapEmptyState reason="no_target" onExtract={vi.fn()} />)
    expect(screen.getByText("No project selected")).toBeInTheDocument()
    expect(screen.getByText(/Open Vivi \(bottom-left\) to set one up/)).toBeInTheDocument()
    // Extract makes no sense before a target is resolved — even with onExtract.
    expect(
      screen.queryByRole("button", { name: /Extract from docs/ })
    ).not.toBeInTheDocument()
  })

  test("no_map shows the run-Extract guidance and an enabled Extract button", () => {
    renderEmptyState(<MapEmptyState reason="no_map" onExtract={vi.fn()} />)
    expect(screen.getByText("No issues extracted yet")).toBeInTheDocument()
    expect(screen.getByText(/authors the full plan/)).toBeInTheDocument()
    const extract = screen.getByRole("button", { name: "Extract from docs" })
    expect(extract).toBeEnabled()
  })

  test("empty_map shows the re-run guidance and an Extract button", () => {
    renderEmptyState(<MapEmptyState reason="empty_map" onExtract={vi.fn()} />)
    expect(screen.getByText("Architecture map is empty")).toBeInTheDocument()
    expect(screen.getByText(/re-run Extract/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Extract from docs" })).toBeInTheDocument()
    // The reason is reflected on the Card for downstream selectors.
    expect(document.querySelector('[data-empty-reason="empty_map"]')).toBeTruthy()
  })

  test("clicking Extract calls onExtract", async () => {
    const user = userEvent.setup()
    const onExtract = vi.fn()
    renderEmptyState(<MapEmptyState reason="no_map" onExtract={onExtract} />)
    await user.click(screen.getByRole("button", { name: "Extract from docs" }))
    expect(onExtract).toHaveBeenCalledTimes(1)
  })

  test("extracting=true labels the button 'Extracting…' and disables it", async () => {
    const user = userEvent.setup()
    const onExtract = vi.fn()
    renderEmptyState(<MapEmptyState reason="no_map" onExtract={onExtract} extracting />)
    const extract = screen.getByRole("button", { name: "Extracting…" })
    expect(extract).toBeDisabled()
    // The idle label is gone, and a disabled button cannot fire onExtract.
    expect(screen.queryByRole("button", { name: "Extract from docs" })).toBeNull()
    await user.click(extract).catch(() => undefined)
    expect(onExtract).not.toHaveBeenCalled()
  })

  test("no Extract button when onExtract is omitted, but Import docs still offered", () => {
    renderEmptyState(<MapEmptyState reason="no_map" />)
    expect(screen.getByText("No issues extracted yet")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Extract from docs/ })).toBeNull()
    // A target already exists in no_map/empty_map, so Import docs (G1) is always
    // offered regardless of whether the caller wired an Extract handler.
    expect(screen.getByRole("button", { name: /Import docs/ })).toBeInTheDocument()
  })

  test("Import docs button opens the import dialog", async () => {
    const user = userEvent.setup()
    renderEmptyState(<MapEmptyState reason="no_map" onExtract={vi.fn()} />)
    await user.click(screen.getByRole("button", { name: /Import docs/ }))
    expect(screen.getByRole("dialog", { name: "Import your docs" })).toBeInTheDocument()
  })

  test("no_target shows neither Extract nor Import docs", () => {
    renderEmptyState(<MapEmptyState reason="no_target" onExtract={vi.fn()} />)
    expect(screen.queryByRole("button", { name: /Extract from docs/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Import docs/ })).toBeNull()
  })

  test("empty-canonical extractError shows the guard message and highlights Import", () => {
    renderEmptyState(
      <MapEmptyState
        reason="no_map"
        onExtract={vi.fn()}
        extractError={{
          message: "canonical is empty (only the scaffold README) — import or write docs first",
          code: "empty_canonical",
        }}
      />
    )
    expect(
      screen.getByText(/canonical is empty \(only the scaffold README\)/)
    ).toBeInTheDocument()
    // The Import action becomes the primary (default-variant) button — the fix
    // for an empty canonical — while Extract stays the secondary outline action.
    expect(screen.getByRole("button", { name: /Import docs/ })).toHaveAttribute(
      "data-variant",
      "default"
    )
    expect(screen.getByRole("button", { name: "Extract from docs" })).toHaveAttribute(
      "data-variant",
      "outline"
    )
  })

  test("a non-empty-canonical extractError shows the message without highlighting Import", () => {
    renderEmptyState(
      <MapEmptyState
        reason="no_map"
        onExtract={vi.fn()}
        extractError={{ message: "extraction blocked after 3 retries", code: "spawn_failed" }}
      />
    )
    expect(screen.getByText("extraction blocked after 3 retries")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Import docs/ })).toHaveAttribute(
      "data-variant",
      "outline"
    )
  })
})
