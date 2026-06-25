import { expect, test } from "@playwright/test"

import { DEMO_TARGET_ROOT } from "../playwright.config"

/**
 * Drives the R10 project picker and the R11 agent-CLI health chip against the
 * demo server (VIVICY_TARGET_ROOT=/tmp/vivicy-demo, fake spawner). The picker
 * persists the chosen project into this server's isolated runtime dir, so it
 * selects the demo target itself — re-asserting the demo map and keeping the run
 * idempotent for the other demo-server specs.
 *
 * Serial: the picker writes the process-global current-project store on disk.
 */
test.describe.configure({ mode: "serial" })

// /tmp/vivicy-demo -> ["tmp", "vivicy-demo"]; the picker navigates root -> tmp ->
// vivicy-demo by clicking folder rows, then selects the open folder.
const SEGMENTS = DEMO_TARGET_ROOT.split("/").filter(Boolean)
const TARGET_NAME = SEGMENTS.at(-1) as string

test.describe("Vivicy setup surface (project picker + agent health)", () => {
  test("open the picker, navigate by folders, select, and the map reloads", async ({
    page,
  }) => {
    await page.goto("/")
    // The map renders from the demo target first (baseline before re-selecting).
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })

    // Open the picker from the setup bar's "change project" affordance.
    await page.getByRole("button", { name: "Change project" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Open project")).toBeVisible()
    await expect(dialog.getByLabel("Current path")).toBeVisible()

    // Jump to the filesystem root via the breadcrumb, then walk DOWN into the
    // demo target by clicking each folder row — exercising the server-side
    // directory browser at every step. Folder rows are scoped to the "Folders"
    // list so they never collide with same-named breadcrumb segments.
    await dialog.getByLabel("Current path").getByRole("button", { name: "/" }).click()
    const folders = dialog.getByRole("group", { name: "Folders" })
    for (const segment of SEGMENTS) {
      const row = folders.getByRole("button", { name: segment, exact: true })
      await expect(row).toBeVisible({ timeout: 15_000 })
      await row.click()
    }

    // "Select this folder" reflects the now-open demo target, then persists it.
    // (On macOS /tmp canonicalizes to /private/tmp, so assert the basename, which
    // is stable, rather than the pre-realpath path.)
    const selectBtn = dialog.getByRole("button", { name: /Select this folder/ })
    await expect(selectBtn).toContainText(TARGET_NAME)
    await selectBtn.click()

    // The dialog closes and the affordance now shows the project name.
    await expect(dialog).toBeHidden({ timeout: 15_000 })
    await expect(
      page.getByRole("button", { name: "Change project" }).getByText(TARGET_NAME)
    ).toBeVisible({ timeout: 15_000 })

    // The map reloaded for the selected project (still the demo graph).
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
  })

  test("the manual absolute-path fallback selects a project", async ({ page }) => {
    await page.goto("/")
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })

    await page.getByRole("button", { name: "Change project" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Open project")).toBeVisible()

    // Paste the absolute path and Use it (the documented fallback).
    await dialog.getByLabel("Or paste an absolute path").fill(DEMO_TARGET_ROOT)
    await dialog.getByRole("button", { name: "Use", exact: true }).click()

    await expect(dialog).toBeHidden({ timeout: 15_000 })
    await expect(
      page.getByRole("button", { name: "Change project" }).getByText(TARGET_NAME)
    ).toBeVisible({ timeout: 15_000 })
  })

  test("the agent-CLI health chip renders with a definite state", async ({ page }) => {
    await page.goto("/")
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })

    // The chip resolves to ok/warn (not stuck loading) once health responds.
    const chip = page.getByRole("button", { name: "Agent CLI status" })
    await expect(chip).toBeVisible()
    await expect(chip).toHaveAttribute("data-agents-state", /ok|warn/, { timeout: 15_000 })

    // Open the dialog: both agent cards render (one fieldset each), with at least
    // one definite presence badge (Installed or Not found) so we know detection
    // resolved rather than hanging in the loading state.
    await chip.click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Agent CLIs")).toBeVisible()
    await expect(dialog.locator("fieldset")).toHaveCount(2)
    await expect(
      dialog.getByText(/Installed|Not found/).first()
    ).toBeVisible({ timeout: 15_000 })

    // The version line is NORMALIZED: the redundant product name is stripped, so
    // neither "(Claude Code)" nor the "codex-cli " prefix appears anywhere.
    await expect(dialog.getByText(/\(Claude Code\)/)).toHaveCount(0)
    await expect(dialog.getByText(/codex-cli/)).toHaveCount(0)

    // Each installed CLI offers a per-agent Update action (the dev machine has
    // both installed). Skip the assertion gracefully if a CLI is genuinely absent.
    for (const label of ["Claude Code", "Codex CLI"]) {
      const card = dialog.locator("fieldset", { hasText: label })
      const installed = await card.getByText("Installed").count()
      if (installed > 0) {
        await expect(card.getByRole("button", { name: `Update ${label}` })).toBeVisible()
      }
    }
  })
})
