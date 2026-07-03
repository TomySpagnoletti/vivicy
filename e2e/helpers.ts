import { expect, type Locator, type Page, type TestInfo } from "@playwright/test"

/**
 * Cross-browser e2e helpers. The four-browser matrix (see playwright.config)
 * includes a Chrome-mobile (Pixel 7) project where the right panel renders as an
 * off-canvas Sheet instead of the desktop docked sidebar. Specs that touch panel
 * content (Filters, Tasks, Details, Settings gear, legend, quota) must OPEN that
 * Sheet first on mobile; on desktop the panel is docked and open by default.
 *
 * These helpers keep that branch in one place so every spec stays a single,
 * honest assertion across all four browsers — the mobile path is exercised, not
 * skipped.
 */

/** True when the running project is the Chrome-mobile (Pixel 7) one. */
export function isMobileProject(testInfo: TestInfo): boolean {
  return testInfo.project.name.includes("-mobile")
}

/**
 * Ensure the right panel (the Vivicy sidebar) is OPEN and its content reachable.
 *
 * Desktop: the panel is docked and open by default — nothing to do, but we still
 * confirm the wordmark is visible so callers can rely on a ready panel.
 *
 * Mobile: the panel is an off-canvas Sheet, closed by default. Click the edge
 * panel toggle (which, on mobile, drives the Sheet open) and wait for the Sheet
 * content to render. Idempotent: if the Sheet is already open, the wordmark is
 * already visible and we return immediately.
 *
 * Requires a rendered map (the toggle only appears in the `ready` state). Callers
 * that need the panel must first wait for `.react-flow__node` to be visible.
 */
export async function ensurePanelOpen(page: Page, testInfo: TestInfo): Promise<void> {
  const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
  if (!isMobileProject(testInfo)) {
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible({ timeout: 30_000 })
    return
  }

  // Mobile: open the Sheet via the edge toggle if it isn't already open.
  const wordmark = sidebar.getByText("Vivicy", { exact: true })
  if (await wordmark.isVisible().catch(() => false)) return

  const toggle = page.locator("[data-panel-toggle]")
  await expect(toggle).toBeVisible({ timeout: 30_000 })
  await toggle.click()
  // The Sheet (mobile sidebar) mounts and animates in; wait for its content.
  await expect(page.locator('[data-mobile="true"]')).toBeVisible({ timeout: 15_000 })
  await expect(wordmark).toBeVisible({ timeout: 15_000 })
}

/**
 * Open the per-agent Settings dialog (the header gear lives in the panel). Waits
 * for the ready map, opens the panel on mobile, then clicks the gear. The
 * Settings dialog is a full-screen modal once open, so the underlying panel state
 * no longer matters after this returns.
 */
export async function openSettingsDialog(page: Page, testInfo: TestInfo): Promise<void> {
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
  await ensurePanelOpen(page, testInfo)
  // On mobile the gear sits in the off-canvas Sheet, which SSE-driven map refreshes
  // can keep re-animating — a plain click can miss Playwright's stability gate. Open
  // past that with the shared overlap-safe click.
  await clickPastOverlap(page.getByRole("button", { name: "Settings" }))
  await expect(page.getByRole("dialog").getByText("Agent settings")).toBeVisible()
}

/**
 * Click a control that a scrollable container can visually overlap.
 *
 * On the Pixel 7 (mobile) project the right panel is an off-canvas Sheet and the
 * settings dialog is a `max-h-svh` scroller — both taller than the viewport with
 * the rich demo fixture. A target inside them is the correct element (the locator
 * resolves) but a sibling row can sit over it at its resting position, so a plain
 * click never satisfies Playwright's "receives pointer events" gate and times out.
 * Scrolling the target into view and forcing the click dispatches to that exact
 * element past the overlap. On desktop this is a normal scroll-then-click.
 */
export async function clickPastOverlap(target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  await target.click({ force: true })
}
