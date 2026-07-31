import { expect, test } from "./browser-issues"

import { clickPastOverlap, ensurePanelOpen } from "./helpers"

test.describe("Document-preparation stage (SP) in the workflow status surface", () => {
  test("SP renders as the first dev-loop stage and reflects the doc-prep report", async ({ page }, testInfo) => {
    await page.goto("/")

    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
    await ensurePanelOpen(page, testInfo)

    await clickPastOverlap(page.getByRole("button", { name: "Workflow", exact: true }))

    const sp = page.locator('[data-stage="SP"]')
    await expect(sp).toBeVisible({ timeout: 15_000 })
    await expect(sp).toContainText("SP")
    await expect(sp).toContainText("Doc prep")

    await expect(sp).toContainText(/done/i)
    await expect(sp).toContainText(/doc-prep green: 2 canonical documents placed/)

    const stageIds = await page.locator("[data-stage]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-stage")))
    expect(stageIds.indexOf("SP")).toBe(stageIds.indexOf("S1") + 1)
    expect(stageIds.indexOf("SP")).toBeLessThan(stageIds.indexOf("S2"))
  })
})
