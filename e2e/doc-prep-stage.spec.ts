import { expect, test } from "./browser-issues"

import { clickPastOverlap, ensurePanelOpen } from "./helpers"

// The doc-prep report seeded into the demo fixture must surface as the SP stage in the sidebar pipeline view.
test.describe("Document-preparation stage (SP) in the pipeline status surface", () => {
  test("SP renders as the first dev-loop stage and reflects the doc-prep report", async ({ page }, testInfo) => {
    await page.goto("/")

    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
    await ensurePanelOpen(page, testInfo)

    await clickPastOverlap(page.getByRole("button", { name: "Pipeline", exact: true }))

    const sp = page.locator('[data-stage="SP"]')
    await expect(sp).toBeVisible({ timeout: 15_000 })
    await expect(sp).toContainText("SP")
    await expect(sp).toContainText("Doc prep")

    // The stage picks up the seeded green doc-prep report (route → deriveStageStates → badge), like every other stage.
    await expect(sp).toContainText(/done/i)
    await expect(sp).toContainText(/doc-prep green: 2 canonical document\(s\) placed/)

    // SP sits first in the dev-loop, immediately after the S1 non-loop stage and before extraction (S2).
    const stageIds = await page.locator("[data-stage]").evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-stage"))
    )
    expect(stageIds.indexOf("SP")).toBe(stageIds.indexOf("S1") + 1)
    expect(stageIds.indexOf("SP")).toBeLessThan(stageIds.indexOf("S2"))
  })
})
