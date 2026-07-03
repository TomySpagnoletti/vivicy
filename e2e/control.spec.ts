import { expect, test } from "@playwright/test"

import { clickPastOverlap, ensurePanelOpen } from "./helpers"

/**
 * Drives the control plane end to end against the populated demo target
 * (VIVICY_TARGET_ROOT=/tmp/vivicy-demo) with the spawner stubbed
 * (VIVICY_FAKE_SPAWN=1, set on the dev server in playwright.config). No real
 * claude/codex is launched: the fake spawner records a lock so the status
 * endpoint reports the run as live, while reading the real demo ledger.
 *
 * Single serial test on purpose — the run lock is process-global, so concurrent
 * control flows would race it.
 */
test.describe.configure({ mode: "serial" })

test.describe("Vivicy control plane", () => {
  test("Run shows running, Stop returns idle, Extract is gated when issues exist", async ({
    page,
  }, testInfo) => {
    await page.goto("/")

    // The map renders from the demo target.
    const nodes = page.locator(".react-flow__node")
    await expect(nodes.first()).toBeVisible({ timeout: 30_000 })

    // The control plane (Run/Stop/Extract + status pill) lives in the panel; open
    // it (off-canvas Sheet on mobile, docked on desktop) before driving it.
    await ensurePanelOpen(page, testInfo)
    const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible()

    // The status pill reflects the real demo ledger via SSE.
    const statusBadge = page.getByLabel(/^status:/)
    await expect(statusBadge).toBeVisible({ timeout: 15_000 })

    // Make sure no prior run is active: if a Stop control is present, clear it.
    if (await page.getByRole("button", { name: "Stop" }).count()) {
      await clickPastOverlap(page.getByRole("button", { name: "Stop" }))
      await page.getByRole("button", { name: "Stop", exact: true }).last().click()
      await expect(page.getByRole("button", { name: /^(Run|Resume)$/ })).toBeVisible({
        timeout: 15_000,
      })
    }

    // Run: the start endpoint records the fake lock; SSE flips the pill to running.
    // The control-bar buttons live in the scrollable panel, so on the mobile Sheet
    // a neighbouring row (the sidebar header / status row) can overlap them at rest;
    // click past that overlap.
    await clickPastOverlap(page.getByRole("button", { name: /^(Run|Resume)$/ }))
    await expect(statusBadge).toHaveText(/running/i, { timeout: 15_000 })
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()

    // Stop: confirm via the AlertDialog, then the pill leaves the running state.
    await clickPastOverlap(page.getByRole("button", { name: "Stop" }))
    const dialog = page.getByRole("alertdialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Stop the development loop?")).toBeVisible()
    await dialog.getByRole("button", { name: "Stop", exact: true }).click()
    await expect(statusBadge).not.toHaveText(/running/i, { timeout: 15_000 })
    await expect(page.getByRole("button", { name: /^(Run|Resume)$/ })).toBeVisible()

    // Extract: the demo target has already been extracted (its development block
    // carries 8 issues), so the control-bar Extract is greyed (aria-disabled) and
    // its tooltip explains why. Re-extraction isn't available yet.
    const extract = page.getByRole("button", { name: "Extract" })
    await expect(extract).toBeVisible()
    await expect(extract).toHaveAttribute("aria-disabled", "true")
    // Hover the greyed trigger so the shadcn tooltip surfaces the honest reason.
    await extract.hover()
    await expect(
      page.getByText(/Already extracted — \d+ issues?\. Re-extraction isn't available yet\./)
    ).toBeVisible({ timeout: 10_000 })

    // The Tasks accordion section is present and lists the demo issues. The
    // rich issue card shows the issue id and its file path, so match the id
    // element exactly to avoid colliding with the path text. Click past any
    // mobile-Sheet sibling overlap (same rationale as the control-bar clicks).
    await clickPastOverlap(page.getByRole("button", { name: "Tasks" }))
    await expect(sidebar.getByText("ISS-0001", { exact: true })).toBeVisible()
    await expect(nodes.first()).toBeVisible()
  })
})
