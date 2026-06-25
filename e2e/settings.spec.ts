import { expect, test } from "@playwright/test"

import { openSettingsDialog } from "./helpers"

/**
 * Drives the per-agent settings dialog end to end: open it from the sidebar gear,
 * change the implementer's thinking level, save (PUT /api/settings + toast), then
 * reopen and confirm the new value persisted (round-trip through the JSON store).
 *
 * Serial: the settings store is process-global on disk, so concurrent edits would
 * race it. The test sets a deterministic value, so re-runs are idempotent.
 */
test.describe.configure({ mode: "serial" })

test.describe("Vivicy agent settings", () => {
  test("open the dialog, change an effort, save, and re-read it", async ({ page }, testInfo) => {
    await page.goto("/")

    // Open the settings dialog from the header gear (opens the panel on mobile).
    await openSettingsDialog(page, testInfo)
    const dialog = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Agent settings")).toBeVisible()

    // The implementer block defaults to the latest Claude model (now a Select).
    const modelSelect = dialog.getByRole("combobox", { name: "Implementer model" })
    await expect(modelSelect).toContainText("claude-opus-4-8")

    // Change the implementer thinking level via the shadcn Select to a known,
    // non-default value so the assertion is deterministic across runs.
    const effortTrigger = dialog.getByRole("combobox", { name: "Implementer thinking level" })
    await effortTrigger.click()
    await page.getByRole("option", { name: "max", exact: true }).click()
    await expect(effortTrigger).toContainText("max")

    // Save: PUT /api/settings, success toast, dialog closes.
    await dialog.getByRole("button", { name: "Save" }).click()
    // sonner stacks toasts; scope to the most recent so a lingering prior toast
    // never trips strict mode.
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog).not.toBeVisible()

    // Re-open: the saved thinking level was read back from the store.
    await page.getByRole("button", { name: "Settings" }).click()
    const dialog2 = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog2).toBeVisible()
    await expect(
      dialog2.getByRole("combobox", { name: "Implementer thinking level" })
    ).toContainText("max")

    // Restore the documented default so the test is idempotent and leaves a clean
    // store for other runs.
    await dialog2.getByRole("combobox", { name: "Implementer thinking level" }).click()
    await page.getByRole("option", { name: "xhigh", exact: true }).click()
    await dialog2.getByRole("button", { name: "Save" }).click()
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog2).not.toBeVisible()
  })

  test("swap the role -> CLI assignment, save, and re-read it (R12)", async ({ page }, testInfo) => {
    await page.goto("/")

    await openSettingsDialog(page, testInfo)
    const dialog = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog.getByText("Agent settings")).toBeVisible()

    // Default assignment: implementer = Claude Code, reviewer = Codex.
    const implementerCli = dialog.getByRole("combobox", { name: "Implementer agent" })
    const reviewerCli = dialog.getByRole("combobox", { name: "Reviewer agent" })
    await expect(implementerCli).toContainText("Claude Code")
    await expect(reviewerCli).toContainText("Codex")

    // Assign the implementer to Codex. The distinct-CLI invariant moves the
    // reviewer to Claude Code automatically (one CLI can't hold both roles).
    await implementerCli.click()
    await page.getByRole("option", { name: "Codex", exact: true }).click()
    await expect(implementerCli).toContainText("Codex")
    await expect(reviewerCli).toContainText("Claude Code")

    // Save: PUT /api/settings, success toast, dialog closes.
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog).not.toBeVisible()

    // Re-open: the swapped assignment was read back from the store.
    await page.getByRole("button", { name: "Settings" }).click()
    const dialog2 = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog2.getByText("Agent settings")).toBeVisible()
    await expect(
      dialog2.getByRole("combobox", { name: "Implementer agent" })
    ).toContainText("Codex")
    await expect(
      dialog2.getByRole("combobox", { name: "Reviewer agent" })
    ).toContainText("Claude Code")

    // Restore the documented default assignment so the store is clean for others.
    await dialog2.getByRole("combobox", { name: "Implementer agent" }).click()
    await page.getByRole("option", { name: "Claude Code", exact: true }).click()
    await expect(
      dialog2.getByRole("combobox", { name: "Reviewer agent" })
    ).toContainText("Codex")
    await dialog2.getByRole("button", { name: "Save" }).click()
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog2).not.toBeVisible()
  })

  test("pick a model + fast mode, with strict per-model compatibility (P5)", async ({ page }, testInfo) => {
    await page.goto("/")

    await openSettingsDialog(page, testInfo)
    const dialog = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog.getByText("Agent settings")).toBeVisible()

    // The implementer model is a Select listing the curated Claude models.
    const modelSelect = dialog.getByRole("combobox", { name: "Implementer model" })
    await expect(modelSelect).toContainText("claude-opus-4-8")

    // Default model (Opus 4.8) is fast-capable: the Fast switch is enabled. Turn it on.
    const fast = dialog.getByRole("switch", { name: "Implementer fast mode" })
    await expect(fast).toBeEnabled()
    await fast.click()
    await expect(fast).toBeChecked()

    // Switch to an older Opus that has NO fast mode: the toggle becomes disabled.
    await modelSelect.click()
    await page.getByRole("option", { name: "claude-opus-4-5", exact: true }).click()
    await expect(modelSelect).toContainText("claude-opus-4-5")
    await expect(dialog.getByRole("switch", { name: "Implementer fast mode" })).toBeDisabled()

    // Restore the fast-capable default and turn fast back off, save, re-read.
    await modelSelect.click()
    await page.getByRole("option", { name: "claude-opus-4-8", exact: true }).click()
    const fast2 = dialog.getByRole("switch", { name: "Implementer fast mode" })
    await expect(fast2).toBeEnabled()
    await expect(fast2).not.toBeChecked() // reset by the model switch
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog).not.toBeVisible()
  })

  // Capture the upgraded modal at 1320x820 with both compatibility cases visible:
  // implementer = Opus 4.8 with Fast ON (enabled), reviewer = Spark with no thinking
  // level and Fast DISABLED + its honest tooltip. Lives in the serial settings
  // describe so it never races the shared on-disk store with the other mutators.
  test("screenshot — model picker, fast toggle, disabled-fast case (1320x820)", async ({ page }, testInfo) => {
    // A fixed 1320x820 documentation frame: a desktop capture by definition, so it
    // runs on the desktop projects only (the mobile project would fight its own
    // device viewport).
    test.skip(
      testInfo.project.name.includes("-mobile"),
      "Fixed-frame desktop documentation screenshot."
    )
    await page.setViewportSize({ width: 1320, height: 820 })
    await page.goto("/")

    await page.getByRole("button", { name: "Settings" }).click()
    const dialog = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog.getByText("Agent settings")).toBeVisible()

    // Implementer = Claude Opus 4.8 (fast-capable). Turn fast ON so the enabled
    // switch reads active in the shot.
    const implFast = dialog.getByRole("switch", { name: "Implementer fast mode" })
    await expect(implFast).toBeEnabled()
    await implFast.click()
    await expect(implFast).toBeChecked()

    // Reviewer = Codex on Spark: no separate thinking level, Fast disabled.
    const reviewerModel = dialog.getByRole("combobox", { name: "Reviewer model" })
    await reviewerModel.click()
    await page.getByRole("option", { name: "gpt-5.3-codex-spark", exact: true }).click()
    await expect(reviewerModel).toContainText("gpt-5.3-codex-spark")
    await expect(dialog.getByRole("switch", { name: "Reviewer fast mode" })).toBeDisabled()

    // Reveal the honest disabled-fast tooltip so the reason is in the frame.
    await dialog.getByLabel("Reviewer fast mode unavailable").focus()
    await expect(page.getByText(/Spark is already a low-latency model/i).first()).toBeVisible()

    await page.waitForTimeout(250)
    await page.screenshot({ path: "/tmp/vivicy-settings.png" })

    // Restore the documented defaults so the store is clean for other runs.
    await reviewerModel.click()
    await page.getByRole("option", { name: "gpt-5.5", exact: true }).click()
    await implFast.click()
    await expect(implFast).not.toBeChecked()
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog).not.toBeVisible()
  })

  test("set max parallel issues, save, and re-read it (concurrency knob)", async ({ page }, testInfo) => {
    await page.goto("/")

    await openSettingsDialog(page, testInfo)
    const dialog = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog.getByText("Agent settings")).toBeVisible()

    // Defaults to 1 (the sequential loop).
    const maxParallel = dialog.getByLabel("Max parallel issues")
    await expect(maxParallel).toHaveValue("1")

    // Set it to 3 and save.
    await maxParallel.fill("3")
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog).not.toBeVisible()

    // Re-open: the value persisted through the JSON store.
    await page.getByRole("button", { name: "Settings" }).click()
    const dialog2 = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog2.getByText("Agent settings")).toBeVisible()
    await expect(dialog2.getByLabel("Max parallel issues")).toHaveValue("3")

    // Restore the default (1) so the store is clean for other runs.
    await dialog2.getByLabel("Max parallel issues").fill("1")
    await dialog2.getByRole("button", { name: "Save" }).click()
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog2).not.toBeVisible()
  })

  test("the concurrency stepper enforces the 1–12 range with up/down arrows", async ({ page }, testInfo) => {
    await page.goto("/")

    await openSettingsDialog(page, testInfo)
    const dialog = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog.getByText("Agent settings")).toBeVisible()

    const maxParallel = dialog.getByLabel("Max parallel issues")
    // The input advertises the 1–12 range.
    await expect(maxParallel).toHaveAttribute("min", "1")
    await expect(maxParallel).toHaveAttribute("max", "12")

    // The up arrow steps the value by 1; clicking it past 12 never exceeds the cap.
    const increase = dialog.getByRole("button", { name: "Increase" })
    await maxParallel.fill("11")
    await increase.click()
    await expect(maxParallel).toHaveValue("12")
    await expect(increase).toBeDisabled() // capped at 12

    // The down arrow floors at 1 and then disables (never below the sequential 1).
    const decrease = dialog.getByRole("button", { name: "Decrease" })
    await maxParallel.fill("2")
    await decrease.click()
    await expect(maxParallel).toHaveValue("1")
    await expect(decrease).toBeDisabled()

    // Leave the store clean (1 = sequential default).
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog).not.toBeVisible()
  })

  // Capture the Concurrency section at 1320x820 with the 1–12 stepper mid-range so
  // both arrows and the "spread across the map" note are visible. Serial, store-clean.
  test("screenshot — concurrency 1–12 stepper (1320x820)", async ({ page }, testInfo) => {
    // Fixed 1320x820 documentation frame: desktop-only (see the model-picker shot).
    test.skip(
      testInfo.project.name.includes("-mobile"),
      "Fixed-frame desktop documentation screenshot."
    )
    await page.setViewportSize({ width: 1320, height: 820 })
    await page.goto("/")

    await page.getByRole("button", { name: "Settings" }).click()
    const dialog = page.getByRole("dialog", { name: "Agent settings" })
    await expect(dialog.getByText("Agent settings")).toBeVisible()

    // Set a mid-range value so the stepper reads clearly (neither bound disabled).
    const maxParallel = dialog.getByLabel("Max parallel issues")
    await maxParallel.fill("6")
    await expect(maxParallel).toHaveValue("6")
    // Both arrows are active at a mid value.
    await expect(dialog.getByRole("button", { name: "Increase" })).toBeEnabled()
    await expect(dialog.getByRole("button", { name: "Decrease" })).toBeEnabled()

    // Bring the Concurrency section (label + stepper + spread note) fully into the
    // frame so the whole control reads in the shot, not just its top edge.
    await dialog
      .getByText(/spread across different parts of the map/i)
      .scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
    await page.screenshot({ path: "/tmp/vivicy-concurrency.png" })

    // Restore the default (1) so the store is clean for other runs.
    await maxParallel.fill("1")
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog).not.toBeVisible()
  })
})
