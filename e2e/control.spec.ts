import { expect, test } from "@playwright/test"

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
  test("Run shows running, Stop returns idle, Extract reports + keeps the map", async ({
    page,
  }) => {
    await page.goto("/")

    const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible()

    // The status pill reflects the real demo ledger via SSE.
    const statusBadge = page.getByLabel(/^status:/)
    await expect(statusBadge).toBeVisible({ timeout: 15_000 })

    // The map renders from the demo target.
    const nodes = page.locator(".react-flow__node")
    await expect(nodes.first()).toBeVisible({ timeout: 30_000 })

    // Make sure no prior run is active: if a Stop control is present, clear it.
    if (await page.getByRole("button", { name: "Stop" }).count()) {
      await page.getByRole("button", { name: "Stop" }).click()
      await page.getByRole("button", { name: "Stop", exact: true }).last().click()
      await expect(page.getByRole("button", { name: /^(Run|Resume)$/ })).toBeVisible({
        timeout: 15_000,
      })
    }

    // Run: the start endpoint records the fake lock; SSE flips the pill to running.
    await page.getByRole("button", { name: /^(Run|Resume)$/ }).click()
    await expect(statusBadge).toHaveText(/running/i, { timeout: 15_000 })
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()

    // Stop: confirm via the AlertDialog, then the pill leaves the running state.
    await page.getByRole("button", { name: "Stop" }).click()
    const dialog = page.getByRole("alertdialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Stop the dev-loop?")).toBeVisible()
    await dialog.getByRole("button", { name: "Stop", exact: true }).click()
    await expect(statusBadge).not.toHaveText(/running/i, { timeout: 15_000 })
    await expect(page.getByRole("button", { name: /^(Run|Resume)$/ })).toBeVisible()

    // Extract: the three deterministic steps run (faked) and toast success; the
    // map + Tasks section remain present.
    await page.getByRole("button", { name: "Extract" }).click()
    await expect(page.getByText(/Extraction complete/i)).toBeVisible({ timeout: 15_000 })

    // The Tasks accordion section is present and lists the demo issues. The
    // rich issue card shows the issue id and its file path, so match the id
    // element exactly to avoid colliding with the path text.
    await page.getByRole("button", { name: "Tasks" }).click()
    await expect(sidebar.getByText("ISS-0001", { exact: true })).toBeVisible()
    await expect(nodes.first()).toBeVisible()
  })
})
