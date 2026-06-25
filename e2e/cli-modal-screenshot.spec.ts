import { expect, test } from "@playwright/test"

/**
 * Capture the "Agent CLIs" modal at a fixed 1320x820 so the cleaned version
 * lines, the per-agent Update buttons, and the (subscription) cost note are all
 * visible in one frame. Runs on the demo server, which performs REAL health
 * detection against the dev machine's installed CLIs.
 */
test("Agent CLIs modal — cleaned versions, Update buttons, cost note", async ({ page }) => {
  await page.setViewportSize({ width: 1320, height: 820 })
  await page.goto("/")
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })

  const chip = page.getByRole("button", { name: "Agent CLI status" })
  await expect(chip).toHaveAttribute("data-agents-state", /ok|warn/, { timeout: 15_000 })
  await chip.click()

  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("Agent CLIs")).toBeVisible()
  // Let detection resolve (presence badge) before the shot.
  await expect(dialog.getByText(/Installed|Not found/).first()).toBeVisible({ timeout: 15_000 })
  // Give the per-agent Update buttons a beat to render on the resolved cards.
  await page.waitForTimeout(300)

  await page.screenshot({ path: "/tmp/vivicy-cli-modal.png" })
})
