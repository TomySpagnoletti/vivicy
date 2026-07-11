import path from "node:path"

import { expect, test } from "./browser-issues"

import { ensurePanelOpen, isMobileProject } from "./helpers"

// Non-mutating captures only (open dialogs/panel, never SAVE) — matrix-parallel-safe across browser projects. Panel-onboarding capture instead lives in onboarding.spec's first serial test, which must run before that file's scaffold test mutates the shared on-disk runtime.

const OUT_DIR = "/tmp/vivicy-xbrowser"

function shot(projectName: string, name: string): string {
  return path.join(OUT_DIR, `${name}--${projectName}.png`)
}

test.describe("cross-browser screenshots — main app (demo shape)", () => {
  test("capture map, sidebar, and the key modals", async ({ page }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("demo-"),
      "Main-app captures run on the demo shape only."
    )
    const project = testInfo.project.name
    await page.goto("/")

    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
    // Let the fitView animation and minimap settle before the frame.
    await page.waitForTimeout(1_000)
    await page.screenshot({ path: shot(project, "01-map") })

    await ensurePanelOpen(page, testInfo)
    const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Information" }).click()
    await expect(sidebar.getByText("Status legend")).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: shot(project, "02-sidebar-expanded") })

    // Close the Sheet on mobile first — the Settings modal must open over the map, not inside it.
    if (isMobileProject(testInfo)) {
      await page.keyboard.press("Escape")
      await expect(page.locator('[data-mobile="true"]')).toBeHidden({ timeout: 10_000 })
    }

    await ensurePanelOpen(page, testInfo)
    await page.getByRole("button", { name: "Settings" }).click()
    const settings = page.getByRole("dialog", { name: "Agent settings" })
    await expect(settings.getByText("Agent settings")).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: shot(project, "03-agent-settings") })
    await page.keyboard.press("Escape")
    await expect(settings).toBeHidden({ timeout: 10_000 })
  })
})
