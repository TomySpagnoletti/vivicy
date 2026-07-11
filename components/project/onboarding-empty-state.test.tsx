import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, test } from "vitest"

import {
  useViviPanel,
  ViviPanelProvider,
} from "@/components/chat/vivi-panel-context"
import { OnboardingEmptyState } from "@/components/project/onboarding-empty-state"
import { __resetPersistedBooleanStoresForTests } from "@/hooks/use-persisted-boolean"
import { renderWithIntl } from "@/test/render"

function PanelProbe() {
  const { open, closePanel } = useViviPanel()
  return (
    <div>
      <span data-testid="panel-open">{String(open)}</span>
      <button onClick={closePanel}>close panel</button>
    </div>
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

test("renders the insieme brand illustration above the copy, not a decorative icon", () => {
  renderWithIntl(
    <ViviPanelProvider>
      <OnboardingEmptyState />
    </ViviPanelProvider>
  )

  expect(
    screen.getByRole("img", { name: "La Nonna and il Nonno" })
  ).toBeInTheDocument()
})

test("mounting never opens the panel; the icon-free Talk to Vivi button does, and again after a close", async () => {
  const user = userEvent.setup()
  renderWithIntl(
    <ViviPanelProvider>
      <OnboardingEmptyState />
      <PanelProbe />
    </ViviPanelProvider>
  )

  expect(
    screen.getByText(/turns your spec into working software/)
  ).toBeInTheDocument()
  expect(screen.getByTestId("panel-open")).toHaveTextContent("false")

  const cta = screen.getByRole("button", { name: "Talk to Vivi" })
  expect(cta.querySelector("svg")).toBeNull()

  await user.click(cta)
  expect(screen.getByTestId("panel-open")).toHaveTextContent("true")

  await user.click(screen.getByRole("button", { name: "close panel" }))
  expect(screen.getByTestId("panel-open")).toHaveTextContent("false")

  await user.click(screen.getByRole("button", { name: "Talk to Vivi" }))
  expect(screen.getByTestId("panel-open")).toHaveTextContent("true")
})
