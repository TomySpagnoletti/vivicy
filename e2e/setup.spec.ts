import { expect, test } from "./browser-issues"

import { DEMO_TARGET_ROOT } from "../playwright.config"

// Serial: the picker persists to the shared on-disk current-project store.
test.describe.configure({ mode: "serial" })

const SEGMENTS = DEMO_TARGET_ROOT.split("/").filter(Boolean)
const TARGET_NAME = SEGMENTS.at(-1) as string

test.describe("Vivicy setup surface (project picker + agent health)", () => {
  test("open the picker, navigate by folders, select, and the map reloads", async ({
    page,
  }) => {
    await page.goto("/")
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })

    await page.getByRole("button", { name: "Change project" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Open project")).toBeVisible()
    await expect(dialog.getByLabel("Current path")).toBeVisible({ timeout: 15_000 })

    await dialog.getByLabel("Current path").getByRole("button", { name: "/" }).click()
    const folders = dialog.getByRole("group", { name: "Folders" })
    for (const segment of SEGMENTS) {
      const row = folders.getByRole("button", { name: segment, exact: true })
      await expect(row).toBeVisible({ timeout: 15_000 })
      await row.click()
    }

    // macOS realpath's /tmp to /private/tmp, so assert the stable basename, not the full path.
    const selectBtn = dialog.getByRole("button", { name: /Select this folder/ })
    await expect(selectBtn).toContainText(TARGET_NAME)
    await selectBtn.click()

    await expect(dialog).toBeHidden({ timeout: 15_000 })
    await expect(
      page.getByRole("button", { name: "Change project" }).getByText(TARGET_NAME)
    ).toBeVisible({ timeout: 15_000 })

    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
  })

  test("the manual absolute-path fallback selects a project", async ({ page }) => {
    await page.goto("/")
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })

    await page.getByRole("button", { name: "Change project" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Open project")).toBeVisible()

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

    const chip = page.getByRole("button", { name: "Agent CLI status" })
    await expect(chip).toBeVisible()
    await expect(chip).toHaveAttribute("data-agents-state", /ok|warn/, { timeout: 15_000 })

    await chip.click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Agent CLIs")).toBeVisible()
    await expect(dialog.locator("fieldset")).toHaveCount(2)
    await expect(
      dialog.getByText(/Installed|Not found/).first()
    ).toBeVisible({ timeout: 15_000 })

    await expect(dialog.getByText(/\(Claude Code\)/)).toHaveCount(0)
    await expect(dialog.getByText(/codex-cli/)).toHaveCount(0)

    for (const label of ["Claude Code", "Codex CLI"]) {
      const card = dialog.locator("fieldset", { hasText: label })
      const installed = await card.getByText("Installed").count()
      if (installed > 0) {
        await expect(card.getByRole("button", { name: `Update ${label}` })).toBeVisible()
      }
    }
  })
})
