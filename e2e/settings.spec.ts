import { expect, test } from "./browser-issues"

import { clickPastOverlap, openSettingsDialog } from "./helpers"

// Serial: the settings store is process-global on disk; concurrent runs would race it.
test.describe.configure({ mode: "serial" })

test.describe("Vivicy agent settings", () => {
  test("open the dialog, change an effort, save, and re-read it", async ({ page }, testInfo) => {
    await page.goto("/")

    await openSettingsDialog(page, testInfo)
    const dialog = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Agent settings")).toBeVisible()

    const modelSelect = dialog.getByRole("combobox", { name: "Implementer model" })
    await expect(modelSelect).toContainText("claude-opus-4-8")

    const effortTrigger = dialog.getByRole("combobox", { name: "Implementer thinking level" })
    await effortTrigger.click()
    await page.getByRole("option", { name: "max", exact: true }).click()
    await expect(effortTrigger).toContainText("max")

    await clickPastOverlap(dialog.getByRole("button", { name: "Save" }))
    // sonner stacks toasts; .first() avoids a strict-mode violation from a lingering prior toast.
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog).not.toBeVisible()

    await page.getByRole("button", { name: "Settings" }).click()
    const dialog2 = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog2).toBeVisible()
    await expect(
      dialog2.getByRole("combobox", { name: "Implementer thinking level" })
    ).toContainText("max")

    await dialog2.getByRole("combobox", { name: "Implementer thinking level" }).click()
    await page.getByRole("option", { name: "xhigh", exact: true }).click()
    await clickPastOverlap(dialog2.getByRole("button", { name: "Save" }))
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog2).not.toBeVisible()
  })

  test("swap the role -> CLI assignment, save, and re-read it (R12)", async ({ page }, testInfo) => {
    await page.goto("/")

    await openSettingsDialog(page, testInfo)
    const dialog = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog.getByText("Agent settings")).toBeVisible()

    const implementerCli = dialog.getByRole("combobox", { name: "Implementer agent" })
    const reviewerCli = dialog.getByRole("combobox", { name: "Reviewer agent" })
    await expect(implementerCli).toContainText("Claude Code")
    await expect(reviewerCli).toContainText("Codex")

    await implementerCli.click()
    await page.getByRole("option", { name: "Codex", exact: true }).click()
    await expect(implementerCli).toContainText("Codex")
    await expect(reviewerCli).toContainText("Claude Code")

    await clickPastOverlap(dialog.getByRole("button", { name: "Save" }))
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog).not.toBeVisible()

    await page.getByRole("button", { name: "Settings" }).click()
    const dialog2 = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog2.getByText("Agent settings")).toBeVisible()
    await expect(
      dialog2.getByRole("combobox", { name: "Implementer agent" })
    ).toContainText("Codex")
    await expect(
      dialog2.getByRole("combobox", { name: "Reviewer agent" })
    ).toContainText("Claude Code")

    await dialog2.getByRole("combobox", { name: "Implementer agent" }).click()
    await page.getByRole("option", { name: "Claude Code", exact: true }).click()
    await expect(
      dialog2.getByRole("combobox", { name: "Reviewer agent" })
    ).toContainText("Codex")
    await clickPastOverlap(dialog2.getByRole("button", { name: "Save" }))
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog2).not.toBeVisible()
  })

  test("pick a model + fast mode, with strict per-model compatibility (P5)", async ({ page }, testInfo) => {
    await page.goto("/")

    await openSettingsDialog(page, testInfo)
    const dialog = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog.getByText("Agent settings")).toBeVisible()

    const modelSelect = dialog.getByRole("combobox", { name: "Implementer model" })
    await expect(modelSelect).toContainText("claude-opus-4-8")

    const fast = dialog.getByRole("switch", { name: "Implementer fast mode" })
    await expect(fast).toBeEnabled()
    await fast.click()
    await expect(fast).toBeChecked()

    await modelSelect.click()
    await page.getByRole("option", { name: "claude-opus-4-5", exact: true }).click()
    await expect(modelSelect).toContainText("claude-opus-4-5")
    await expect(dialog.getByRole("switch", { name: "Implementer fast mode" })).toBeDisabled()

    await modelSelect.click()
    await page.getByRole("option", { name: "claude-opus-4-8", exact: true }).click()
    const fast2 = dialog.getByRole("switch", { name: "Implementer fast mode" })
    await expect(fast2).toBeEnabled()
    await expect(fast2).not.toBeChecked()
    await clickPastOverlap(dialog.getByRole("button", { name: "Save" }))
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog).not.toBeVisible()
  })

  test("screenshot — model picker, fast toggle, disabled-fast case (1320x820)", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("-mobile"),
      "Fixed-frame desktop documentation screenshot."
    )
    await page.setViewportSize({ width: 1320, height: 820 })
    await page.goto("/")

    await page.getByRole("button", { name: "Settings" }).click()
    const dialog = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog.getByText("Agent settings")).toBeVisible()

    const implFast = dialog.getByRole("switch", { name: "Implementer fast mode" })
    await expect(implFast).toBeEnabled()
    await implFast.click()
    await expect(implFast).toBeChecked()

    const reviewerModel = dialog.getByRole("combobox", { name: "Reviewer model" })
    await reviewerModel.click()
    await page.getByRole("option", { name: "gpt-5.3-codex-spark", exact: true }).click()
    await expect(reviewerModel).toContainText("gpt-5.3-codex-spark")
    await expect(dialog.getByRole("switch", { name: "Reviewer fast mode" })).toBeDisabled()

    await dialog.getByLabel("Reviewer fast mode unavailable").focus()
    await expect(page.getByText(/Spark is already a low-latency model/i).first()).toBeVisible()

    await page.waitForTimeout(250)
    await page.screenshot({ path: "/tmp/vivicy-settings.png" })

    await reviewerModel.click()
    await page.getByRole("option", { name: "gpt-5.5", exact: true }).click()
    await implFast.click()
    await expect(implFast).not.toBeChecked()
    await clickPastOverlap(dialog.getByRole("button", { name: "Save" }))
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog).not.toBeVisible()
  })

  test("set max parallel issues, save, and re-read it (concurrency knob)", async ({ page }, testInfo) => {
    await page.goto("/")

    await openSettingsDialog(page, testInfo)
    const dialog = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog.getByText("Agent settings")).toBeVisible()

    const maxParallel = dialog.getByLabel("Max parallel issues")
    await expect(maxParallel).toHaveValue("1")

    await maxParallel.fill("3")
    await clickPastOverlap(dialog.getByRole("button", { name: "Save" }))
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog).not.toBeVisible()

    await page.getByRole("button", { name: "Settings" }).click()
    const dialog2 = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog2.getByText("Agent settings")).toBeVisible()
    await expect(dialog2.getByLabel("Max parallel issues")).toHaveValue("3")

    await dialog2.getByLabel("Max parallel issues").fill("1")
    await clickPastOverlap(dialog2.getByRole("button", { name: "Save" }))
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog2).not.toBeVisible()
  })

  test("the concurrency stepper enforces the 1–12 range with up/down arrows", async ({ page }, testInfo) => {
    await page.goto("/")

    await openSettingsDialog(page, testInfo)
    const dialog = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog.getByText("Agent settings")).toBeVisible()

    const maxParallel = dialog.getByLabel("Max parallel issues")
    await expect(maxParallel).toHaveAttribute("min", "1")
    await expect(maxParallel).toHaveAttribute("max", "12")

    const increase = dialog.getByRole("button", { name: "Increase" })
    await maxParallel.fill("11")
    await increase.click()
    await expect(maxParallel).toHaveValue("12")
    await expect(increase).toBeDisabled()

    const decrease = dialog.getByRole("button", { name: "Decrease" })
    await maxParallel.fill("2")
    await decrease.click()
    await expect(maxParallel).toHaveValue("1")
    await expect(decrease).toBeDisabled()

    await clickPastOverlap(dialog.getByRole("button", { name: "Save" }))
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog).not.toBeVisible()
  })

  test("screenshot — concurrency 1–12 stepper (1320x820)", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("-mobile"),
      "Fixed-frame desktop documentation screenshot."
    )
    await page.setViewportSize({ width: 1320, height: 820 })
    await page.goto("/")

    await page.getByRole("button", { name: "Settings" }).click()
    const dialog = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog.getByText("Agent settings")).toBeVisible()

    const maxParallel = dialog.getByLabel("Max parallel issues")
    await maxParallel.fill("6")
    await expect(maxParallel).toHaveValue("6")
    await expect(dialog.getByRole("button", { name: "Increase" })).toBeEnabled()
    await expect(dialog.getByRole("button", { name: "Decrease" })).toBeEnabled()

    await dialog
      .getByText(/spread across different parts of the map/i)
      .scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
    await page.screenshot({ path: "/tmp/vivicy-concurrency.png" })

    await maxParallel.fill("1")
    await clickPastOverlap(dialog.getByRole("button", { name: "Save" }))
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog).not.toBeVisible()
  })
})
