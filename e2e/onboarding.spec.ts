import { rmSync } from "node:fs"
import path from "node:path"

import { expect, test } from "./browser-issues"

import { onboardScaffoldParent, RUNTIME_DIR } from "../playwright.config"

// Serial: the scaffold test persists a current-project into this server's runtime dir, changing map state for the rest of the file.
test.describe.configure({ mode: "serial" })

// Each browser scaffolds into its own parent dir (global-setup wipes each) so parallel matrix runs never race the same scaffold target.
function browserKeyFor(projectName: string): string {
  return projectName.replace(/^onboarding-/, "")
}

function scaffoldTargetFor(projectName: string): string {
  return path.join(onboardScaffoldParent(browserKeyFor(projectName)), "e2e-scaffolded")
}

test.describe("Vivicy onboarding (panel-hosted)", () => {
  // Resets current-project.json before each test: Playwright's serial-mode retry re-runs the whole group, so without this a retried run would boot into the scaffolded state instead of pristine no_target.
  test.beforeEach(async ({}, testInfo) => {
    rmSync(path.join(RUNTIME_DIR("onboarding", browserKeyFor(testInfo.project.name)), "current-project.json"), {
      force: true,
    })
  })

  test("no_target keeps the Vivi panel closed until the empty-state CTA opens the start choices", async ({
    page,
  }, testInfo) => {
    await page.goto("/")

    await expect(page.getByText(/turns your spec into working software/)).toBeVisible({
      timeout: 30_000,
    })

    await expect(page.getByRole("heading", { name: "Start a project" })).toHaveCount(0)

    await expect(page.getByRole("button", { name: "Open Vivi" })).toHaveCount(0)

    await page
      .locator('[data-empty-reason="no_target"]')
      .getByRole("button", { name: "Talk to Vivi" })
      .click()

    await expect(page.getByRole("heading", { name: "Start a project" })).toBeVisible()
    await expect(
      page.getByRole("button", { name: /Open an existing project/i })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: /Start a new project/i })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: /Import documents/i })
    ).toBeVisible()

    await expect(page.getByLabel("Message Vivi")).toHaveCount(0)

    // Captured before the scaffold test below mutates current-project.json — this is the first test in the serial file.
    await page.waitForTimeout(300)
    await page.screenshot({
      path: `/tmp/vivicy-xbrowser/06-onboarding--${testInfo.project.name}.png`,
    })
  })

  test("the scaffold choice creates a new project and lands on the empty-canonical map state", async ({
    page,
  }, testInfo) => {
    const scaffoldTarget = scaffoldTargetFor(testInfo.project.name)
    const pageErrors: string[] = []
    page.on("pageerror", (err) => pageErrors.push(err.message))

    await page.goto("/")
    await expect(page.getByText(/turns your spec into working software/)).toBeVisible({
      timeout: 30_000,
    })
    await page
      .locator('[data-empty-reason="no_target"]')
      .getByRole("button", { name: "Talk to Vivi" })
      .click()
    await expect(
      page.getByRole("button", { name: /Start a new project/i })
    ).toBeVisible()

    await page.getByRole("button", { name: /Start a new project/i }).click()
    await expect(page.getByLabel("Project name")).toBeVisible()

    await page.getByLabel("Project name").fill("E2E Scaffolded")

    // Navigate the folder browser to the scaffold parent, then name the new folder — there is no absolute-path field. The "tmp" crumb resolves the macOS /tmp -> /private/tmp symlink for us.
    const parentSegments = path.dirname(scaffoldTarget).split("/").filter(Boolean)
    await page.getByLabel("Current path").getByRole("button", { name: "/" }).click()
    const folders = page.getByRole("group", { name: "Folders" })
    for (const segment of parentSegments) {
      const row = folders.getByRole("button", { name: segment, exact: true })
      await expect(row).toBeVisible({ timeout: 15_000 })
      await row.click()
    }
    await page.getByLabel("New folder name").fill(path.basename(scaffoldTarget))

    await page.getByRole("button", { name: /Scaffold project/i }).click()
    await expect(page.getByText(/Project scaffolded/i).first()).toBeVisible({
      timeout: 30_000,
    })

    // A freshly scaffolded project has an empty canonical (only the scaffold seed), so the map shows the bare empty-canonical arrow sentence, not the no_map Extract card.
    const canonicalHint = page.locator('[data-empty-reason="empty_canonical"]')
    await expect(canonicalHint).toBeVisible({ timeout: 30_000 })
    await expect(canonicalHint).toContainText("Talk to Vivi to get grilled")

    await expect(page.getByLabel("Message Vivi")).toBeVisible({ timeout: 15_000 })
    await expect(
      page.getByRole("button", { name: /Start a new project/i })
    ).toHaveCount(0)

    await expect(page.getByText(/what do you want to build/i)).toBeVisible({
      timeout: 15_000,
    })

    await page.reload()
    await expect(page.getByText(/what do you want to build/i)).toBeVisible({
      timeout: 30_000,
    })

    await expect(page.locator(".react-flow__node")).toHaveCount(0)
    await expect(page.getByText(/Request failed/i)).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })
})
