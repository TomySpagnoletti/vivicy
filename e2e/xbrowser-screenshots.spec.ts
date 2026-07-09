import path from "node:path"

import { expect, test } from "./browser-issues"

import { ensurePanelOpen, isMobileProject } from "./helpers"

/**
 * Cross-browser visual capture (the owner asked to "prove the whole UI works
 * across browsers" with screenshots of the key screens). Writes PNGs into
 * /tmp/vivicy-xbrowser/ (created by global-setup), one set PER browser project
 * (filenames carry the project name), so the same screen can be compared across
 * Chrome-desktop, Chrome-mobile, Firefox, and WebKit.
 *
 * These are non-mutating captures of the rich demo app: they open dialogs and the
 * panel but never SAVE, so they leave the shared on-disk state untouched and are
 * matrix-parallel-safe. The panel-onboarding capture lives in onboarding.spec's
 * first (serial) test instead, so it runs against the pristine `no_target` state
 * before that file's scaffold test mutates the shared onboarding runtime.
 */

const OUT_DIR = "/tmp/vivicy-xbrowser"

function shot(projectName: string, name: string): string {
  return path.join(OUT_DIR, `${name}--${projectName}.png`)
}

test.describe("cross-browser screenshots — main app (demo shape)", () => {
  test("capture map, sidebar, and the key modals", async ({ page }, testInfo) => {
    // Only the demo shape renders the rich app; skip on the empty/onboarding shapes.
    test.skip(
      !testInfo.project.name.startsWith("demo-"),
      "Main-app captures run on the demo shape only."
    )
    const project = testInfo.project.name
    await page.goto("/")

    // 1) Map.
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
    // Let the fitView animation and minimap settle before the frame.
    await page.waitForTimeout(1_000)
    await page.screenshot({ path: shot(project, "01-map") })

    // 2) Sidebar expanded (open the off-canvas Sheet on mobile; docked on desktop).
    await ensurePanelOpen(page, testInfo)
    const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible()
    // Expand the Information section so the panel reads as "expanded".
    await page.getByRole("button", { name: "Information" }).click()
    await expect(sidebar.getByText("Status legend")).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: shot(project, "02-sidebar-expanded") })

    // On mobile, close the Sheet so the modals below open over the map cleanly.
    if (isMobileProject(testInfo)) {
      await page.keyboard.press("Escape")
      await expect(page.locator('[data-mobile="true"]')).toBeHidden({ timeout: 10_000 })
    }

    // 3) Open-project modal (the directory picker).
    await page.getByRole("button", { name: "Change project" }).click()
    const picker = page.getByRole("dialog")
    await expect(picker.getByText("Open project")).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: shot(project, "03-open-project-modal") })
    await page.keyboard.press("Escape")
    await expect(picker).toBeHidden({ timeout: 10_000 })

    // 4) Agent CLIs modal (real health detection against the dev machine).
    const chip = page.getByRole("button", { name: "Agent CLI status" })
    await expect(chip).toHaveAttribute("data-agents-state", /ok|warn/, { timeout: 15_000 })
    await chip.click()
    const cliModal = page.getByRole("dialog")
    await expect(cliModal.getByText("Agent CLIs")).toBeVisible()
    await expect(cliModal.getByText(/Installed|Not found/).first()).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(300)
    await page.screenshot({ path: shot(project, "04-agent-clis-modal") })
    await page.keyboard.press("Escape")
    await expect(cliModal).toBeHidden({ timeout: 10_000 })

    // 5) Agent settings dialog. The gear is in the panel, so re-open it on mobile.
    await ensurePanelOpen(page, testInfo)
    await page.getByRole("button", { name: "Settings" }).click()
    const settings = page.getByRole("dialog", { name: "Agent settings" })
    await expect(settings.getByText("Agent settings")).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: shot(project, "05-agent-settings") })
    await page.keyboard.press("Escape")
    await expect(settings).toBeHidden({ timeout: 10_000 })
  })
})
