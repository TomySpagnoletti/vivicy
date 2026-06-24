import { expect, test } from "@playwright/test"

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
  test("open the dialog, change an effort, save, and re-read it", async ({ page }) => {
    await page.goto("/")

    const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible()

    // Open the settings dialog from the header gear.
    await page.getByRole("button", { name: "Settings" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Agent settings")).toBeVisible()

    // The implementer block defaults to the latest Claude model.
    const modelInput = dialog.getByLabel("Model").first()
    await expect(modelInput).toHaveValue("claude-opus-4-8")

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
    const dialog2 = page.getByRole("dialog")
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

  test("swap the role -> CLI assignment, save, and re-read it (R12)", async ({ page }) => {
    await page.goto("/")

    await page.getByRole("button", { name: "Settings" }).click()
    const dialog = page.getByRole("dialog")
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
    const dialog2 = page.getByRole("dialog")
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

  test("set max parallel issues, save, and re-read it (concurrency knob)", async ({ page }) => {
    await page.goto("/")

    await page.getByRole("button", { name: "Settings" }).click()
    const dialog = page.getByRole("dialog")
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
    const dialog2 = page.getByRole("dialog")
    await expect(dialog2.getByText("Agent settings")).toBeVisible()
    await expect(dialog2.getByLabel("Max parallel issues")).toHaveValue("3")

    // Restore the default (1) so the store is clean for other runs.
    await dialog2.getByLabel("Max parallel issues").fill("1")
    await dialog2.getByRole("button", { name: "Save" }).click()
    await expect(page.getByText(/Settings saved/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(dialog2).not.toBeVisible()
  })
})
