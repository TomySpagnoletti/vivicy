import { mkdirSync, rmSync } from "node:fs"

import { expect, test } from "./browser-issues"

import { ONBOARD_TARGET_ROOT } from "../playwright.config"

// Serial and never shared: each browser's server governs its OWN folder, and this file governs it exactly once.
test.describe.configure({ mode: "serial" })

test.describe("Vivicy onboarding (the server's own folder governs itself)", () => {
  // A serial-mode retry re-runs the WHOLE group, so the folder test 2 governed would boot test 1 into the workspace instead of the gate. Restore the pristine ungoverned folder before every attempt; the binding is env-fixed, so nothing else has to move.
  test.beforeAll(({}, testInfo) => {
    const target = ONBOARD_TARGET_ROOT(testInfo.project.name.replace(/^onboarding-/, ""))
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
  })

  test("an ungoverned binding lands on the govern gate — no folder to pick, no Vivi yet", async ({ page }, testInfo) => {
    await page.goto("/")

    const gate = page.locator('[data-empty-reason="not_governed"]')
    await expect(gate).toBeVisible({ timeout: 30_000 })
    await expect(gate.getByRole("heading", { name: "Set up this project" })).toBeVisible()
    await expect(gate.getByText("/tmp/vivicy-onboard-target-")).toBeVisible()
    await expect(page.getByLabel("Current path")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Open Vivi" })).toHaveCount(0)
    await expect(page.getByLabel("Message Vivi")).toHaveCount(0)

    await page.waitForTimeout(300)
    await page.screenshot({
      path: `/tmp/vivicy-xbrowser/06-onboarding--${testInfo.project.name}.png`,
    })
  })

  test("start governance (docs optional) governs the bound folder and lands on the empty-canonical map state", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (err) => pageErrors.push(err.message))

    await page.goto("/")
    await expect(page.locator('[data-empty-reason="not_governed"]')).toBeVisible({ timeout: 30_000 })

    await page.getByRole("button", { name: "Start governance", exact: true }).click()
    await expect(page.getByText(/Governance laid/i).first()).toBeVisible({ timeout: 30_000 })

    const canonicalHint = page.locator('[data-empty-reason="empty_canonical"]')
    await expect(canonicalHint).toBeVisible({ timeout: 30_000 })
    await expect(canonicalHint).toContainText("Talk to Vivi to get grilled")

    await expect(page.getByLabel("Message Vivi")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole("button", { name: /Start governance/i })).toHaveCount(0)

    await expect(page.getByText(/what do you want to build/i)).toBeVisible({
      timeout: 15_000,
    })

    const panel = page.getByRole("complementary")
    await expect(panel.getByText("Already wrote some of this down?")).toBeVisible({ timeout: 15_000 })
    const importButton = panel.getByRole("button", { name: "I have docs to import" })
    await expect(importButton).toBeEnabled()
    const fileChooserPromise = page.waitForEvent("filechooser")
    await importButton.click()
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles({
      name: "brief.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("The quick brown fox jumps over the lazy dog by the river every morning. ".repeat(8)),
    })
    await expect(panel.getByText(/document.*imported/i)).toBeVisible({ timeout: 15_000 })
    await expect(panel.locator('[data-slot="menu-card"][data-turned="true"]')).toHaveCount(1)
    await expect(importButton).toHaveCount(0)
    await expect(panel.getByText(/in the kitchen/i)).toBeVisible()

    await expect(panel.getByText(/dry mode/i)).toHaveCount(1, { timeout: 30_000 })

    const attach = panel.getByRole("button", { name: "Attach documents" })
    await expect(attach).toBeEnabled()
    const composerChooserPromise = page.waitForEvent("filechooser")
    await attach.click()
    const composerChooser = await composerChooserPromise
    await composerChooser.setFiles({
      name: "spec.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("The five boxing wizards jump quickly over the lazy dog again and again every night. ".repeat(8)),
    })
    await expect(panel.getByText(/in the kitchen/i)).toHaveCount(2, { timeout: 15_000 })
    await expect(panel.getByText(/dry mode/i)).toHaveCount(2, { timeout: 30_000 })

    await page.reload()
    await expect(page.getByText(/what do you want to build/i)).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText(/document.*imported/i)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/in the kitchen/i)).toHaveCount(2, { timeout: 15_000 })
    await expect(page.getByText(/dry mode/i)).toHaveCount(2, { timeout: 15_000 })

    await expect(page.locator(".react-flow__node")).toHaveCount(0)
    await expect(page.getByText(/Request failed/i)).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })
})
