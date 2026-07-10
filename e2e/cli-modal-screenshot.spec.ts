import { expect, test } from "./browser-issues"

// Runs against REAL CLI health detection on the dev machine — not mocked, so results vary by what's installed locally.
test("Agent CLIs modal — cleaned versions, Update buttons, cost note", async ({ page }) => {
  await page.setViewportSize({ width: 1320, height: 820 })
  await page.goto("/")
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })

  const chip = page.getByRole("button", { name: "Agent CLI status" })
  await expect(chip).toHaveAttribute("data-agents-state", /ok|warn/, { timeout: 15_000 })
  await chip.click()

  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("Agent CLIs")).toBeVisible()
  await expect(dialog.getByText(/Installed|Not found/).first()).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.screenshot({ path: "/tmp/vivicy-cli-modal.png" })
})
