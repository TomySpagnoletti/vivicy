import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import {
  useViviPanel,
  ViviPanelProvider,
  VIVI_PANEL_OPEN_KEY,
} from "@/components/chat/vivi-panel-context"
import { __resetPersistedBooleanStoresForTests } from "@/hooks/use-persisted-boolean"

function Probe() {
  const { open, openPanel, closePanel, togglePanel } = useViviPanel()
  return (
    <div>
      <span data-testid="open">{String(open)}</span>
      <button onClick={openPanel}>open</button>
      <button onClick={closePanel}>close</button>
      <button onClick={togglePanel}>toggle</button>
    </div>
  )
}

function renderProbe() {
  return render(
    <ViviPanelProvider>
      <Probe />
    </ViviPanelProvider>
  )
}

beforeEach(() => {
  __resetPersistedBooleanStoresForTests()
  window.localStorage.clear()
})
afterEach(() => {
  __resetPersistedBooleanStoresForTests()
  window.localStorage.clear()
})

describe("ViviPanelProvider — persisted open state", () => {
  test("cold start with no stored key mounts closed", () => {
    renderProbe()
    expect(screen.getByTestId("open")).toHaveTextContent("false")
    expect(window.localStorage.getItem(VIVI_PANEL_OPEN_KEY)).toBeNull()
  })

  test("a stored open state is respected on mount", () => {
    window.localStorage.setItem(VIVI_PANEL_OPEN_KEY, "true")
    renderProbe()
    expect(screen.getByTestId("open")).toHaveTextContent("true")
  })

  test("a stored non-true value stays closed", () => {
    window.localStorage.setItem(VIVI_PANEL_OPEN_KEY, "bogus")
    renderProbe()
    expect(screen.getByTestId("open")).toHaveTextContent("false")
  })

  test("open, close, and toggle persist the choice", async () => {
    const user = userEvent.setup()
    renderProbe()

    await user.click(screen.getByRole("button", { name: "open" }))
    expect(screen.getByTestId("open")).toHaveTextContent("true")
    expect(window.localStorage.getItem(VIVI_PANEL_OPEN_KEY)).toBe("true")

    await user.click(screen.getByRole("button", { name: "close" }))
    expect(screen.getByTestId("open")).toHaveTextContent("false")
    expect(window.localStorage.getItem(VIVI_PANEL_OPEN_KEY)).toBe("false")

    await user.click(screen.getByRole("button", { name: "toggle" }))
    expect(screen.getByTestId("open")).toHaveTextContent("true")
    expect(window.localStorage.getItem(VIVI_PANEL_OPEN_KEY)).toBe("true")
  })
})
