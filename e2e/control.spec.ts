import { expect, test } from "./browser-issues"

import { clickPastOverlap, ensurePanelOpen, isMobileProject } from "./helpers"

// Widths where the panel is a docked rail (>= Tailwind's md): the toast stack is centred on the canvas, so it must clear the control bar at the narrowest one too, not just at the default viewport.
const DOCKED_RAIL_WIDTHS = [768, 1024, 1600]

// Serial: the run lock is process-global, so concurrent control flows would race it.
test.describe.configure({ mode: "serial" })

test.describe("Vivicy control plane", () => {
  test("Run shows running, Stop returns idle, Extract is gated when issues exist", async ({ page }, testInfo) => {
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
      page.getByText(/Already extracted — \d+ issues?\. To run it again, retry the extraction stage in the workflow, or ask Vivi\./)
    ).toBeVisible({ timeout: 10_000 })

    // exact:true avoids matching the file-path text that also contains the issue id.
    await clickPastOverlap(page.getByRole("button", { name: "Tasks" }))
    await expect(sidebar.getByText("ISSUE-0001", { exact: true })).toBeVisible()
    await expect(nodes.first()).toBeVisible()
  })

  test("a live toast never covers the control bar, at every docked-rail width", async ({ page }, testInfo) => {
    // The docked rail only exists at >= md; resizing a mobile project into that range would leave the Sheet mounted alongside it (two status badges).
    test.skip(isMobileProject(testInfo), "the docked rail is a >= md shape")

    await page.goto("/")
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
    await ensurePanelOpen(page, testInfo)

    const rail = page.getByRole("complementary", { name: "Vivicy panel" })
    const statusBadge = page.getByLabel(/^status:/)
    await expect(statusBadge).toBeVisible({ timeout: 15_000 })

    await clickPastOverlap(page.getByRole("button", { name: /^(Run|Resume)$/ }))
    const toast = page.locator("[data-sonner-toast]").first()
    await expect(toast).toBeVisible({ timeout: 15_000 })

    for (const width of DOCKED_RAIL_WIDTHS) {
      await page.setViewportSize({ width, height: 800 })
      // Guards both probes against a vacuous pass: an auto-dismissed toast covers nothing.
      await expect(toast, `the toast auto-dismissed before the ${width}px probe`).toBeVisible()

      const toastBox = await toast.boundingBox()
      const railBox = await rail.boundingBox()
      expect(toastBox, `no toast box at ${width}px`).not.toBeNull()
      expect(railBox, `no rail box at ${width}px`).not.toBeNull()
      expect(toastBox!.x + toastBox!.width, `the toast stack reaches into the rail at ${width}px`).toBeLessThanOrEqual(railBox!.x)

      const coveredBy = await statusBadge.evaluate((el) => {
        const box = el.getBoundingClientRect()
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return hit?.closest("[data-sonner-toaster]") ? "toast" : (hit?.tagName ?? "nothing")
      })
      expect(coveredBy, `the toast covers the status badge at ${width}px`).not.toBe("toast")
    }

    await clickPastOverlap(page.getByRole("button", { name: "Stop" }))
    await page.getByRole("alertdialog").getByRole("button", { name: "Stop", exact: true }).click()
    await expect(page.getByRole("button", { name: /^(Run|Resume)$/ })).toBeVisible({
      timeout: 15_000,
    })
  })
})
