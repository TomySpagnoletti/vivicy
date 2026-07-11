import { expect, test } from "./browser-issues"

import { clickPastOverlap, ensurePanelOpen } from "./helpers"

// Serial: the run lock is process-global, so concurrent control flows would race it.
test.describe.configure({ mode: "serial" })

test.describe("Vivicy control plane", () => {
  test("Run shows running, Stop returns idle, Extract is gated when issues exist", async ({
    page,
  }, testInfo) => {
    await page.goto("/")

    const nodes = page.locator(".react-flow__node")
    await expect(nodes.first()).toBeVisible({ timeout: 30_000 })

    await ensurePanelOpen(page, testInfo)
    const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible()

    const statusBadge = page.getByLabel(/^status:/)
    await expect(statusBadge).toBeVisible({ timeout: 15_000 })

    if (await page.getByRole("button", { name: "Stop" }).count()) {
      await clickPastOverlap(page.getByRole("button", { name: "Stop" }))
      await page.getByRole("button", { name: "Stop", exact: true }).last().click()
      await expect(page.getByRole("button", { name: /^(Run|Resume)$/ })).toBeVisible({
        timeout: 15_000,
      })
    }

    await clickPastOverlap(page.getByRole("button", { name: /^(Run|Resume)$/ }))
    await expect(statusBadge).toHaveText(/running/i, { timeout: 15_000 })
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()

    await clickPastOverlap(page.getByRole("button", { name: "Stop" }))
    const dialog = page.getByRole("alertdialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Stop the development loop?")).toBeVisible()
    await dialog.getByRole("button", { name: "Stop", exact: true }).click()
    await expect(statusBadge).not.toHaveText(/running/i, { timeout: 15_000 })
    await expect(page.getByRole("button", { name: /^(Run|Resume)$/ })).toBeVisible()

    const extract = page.getByRole("button", { name: "Extract" })
    await expect(extract).toBeVisible()
    await expect(extract).toHaveAttribute("aria-disabled", "true")
    await extract.hover()
    await expect(
      page.getByText(/Already extracted — \d+ issues?\. Re-extraction isn't available yet\./)
    ).toBeVisible({ timeout: 10_000 })

    // exact:true avoids matching the file-path text that also contains the issue id.
    await clickPastOverlap(page.getByRole("button", { name: "Tasks" }))
    await expect(sidebar.getByText("ISS-0001", { exact: true })).toBeVisible()
    await expect(nodes.first()).toBeVisible()
  })
})
