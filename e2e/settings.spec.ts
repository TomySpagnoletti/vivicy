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
})
