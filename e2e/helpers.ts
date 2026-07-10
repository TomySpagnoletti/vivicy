import { expect, type Locator, type Page, type TestInfo } from "@playwright/test"

export function isMobileProject(testInfo: TestInfo): boolean {
  return testInfo.project.name.includes("-mobile")
}

// Requires a rendered map first — the panel toggle only appears once '.react-flow__node' is visible.
export async function ensurePanelOpen(page: Page, testInfo: TestInfo): Promise<void> {
  const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
  if (!isMobileProject(testInfo)) {
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible({ timeout: 30_000 })
    return
  }

  const wordmark = sidebar.getByText("Vivicy", { exact: true })
  if (await wordmark.isVisible().catch(() => false)) return

  const toggle = page.locator("[data-panel-toggle]")
  await expect(toggle).toBeVisible({ timeout: 30_000 })
  await toggle.click()
  await expect(page.locator('[data-mobile="true"]')).toBeVisible({ timeout: 15_000 })
  await expect(wordmark).toBeVisible({ timeout: 15_000 })
}

export async function openSettingsDialog(page: Page, testInfo: TestInfo): Promise<void> {
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
  await ensurePanelOpen(page, testInfo)
  // SSE-driven map refreshes keep re-animating the mobile Sheet, so a plain click can miss Playwright's stability gate.
  await clickPastOverlap(page.getByRole("button", { name: "Settings" }))
  await expect(page.getByRole("dialog").getByText("Agent settings")).toBeVisible()
}

// force:true is deliberate: a sibling row can visually overlap the (correct) target, so a plain click never satisfies Playwright's pointer-events gate and times out.
export async function clickPastOverlap(target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  await target.click({ force: true })
}
