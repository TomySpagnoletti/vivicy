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

test("mounting never opens the panel; the Open Vivi button does, and again after a close", async () => {
  const user = userEvent.setup()
  renderWithIntl(
    <ViviPanelProvider>
      <OnboardingEmptyState />
      <PanelProbe />
    </ViviPanelProvider>
  )

  expect(screen.getByText(/No project yet/)).toBeInTheDocument()
  expect(screen.getByTestId("panel-open")).toHaveTextContent("false")

  await user.click(screen.getByRole("button", { name: "Open Vivi" }))
  expect(screen.getByTestId("panel-open")).toHaveTextContent("true")

  await user.click(screen.getByRole("button", { name: "close panel" }))
  expect(screen.getByTestId("panel-open")).toHaveTextContent("false")

  await user.click(screen.getByRole("button", { name: "Open Vivi" }))
  expect(screen.getByTestId("panel-open")).toHaveTextContent("true")
})
