import path from "node:path"

import { expect, test } from "@playwright/test"

import { onboardScaffoldParent } from "../playwright.config"

/**
 * G10 onboarding. The onboarding server points at a target with NO docs/, so the
 * map route returns `no_target` and the three-card chooser renders. This spec:
 *
 *   1. asserts ALL THREE cards are offered (open a project, start from scratch,
 *      import your docs);
 *   2. drives Mode B end to end — opens the scaffold dialog, gives a name +
 *      absolute target, scaffolds, and confirms the app lands on the freshly
 *      scaffolded project's "no architecture map yet" empty state.
 *
 * Serial: the scaffold persists a current-project into this server's runtime dir,
 * which changes the map state for the rest of the file.
 */
test.describe.configure({ mode: "serial" })

// The browser key is the project-name suffix ("onboarding-<browserKey>"); each
// browser scaffolds into its OWN parent dir (global-setup wipes each), so the
// matrix's parallel onboarding projects never race the same scaffold target.
function scaffoldTargetFor(projectName: string): string {
  const browserKey = projectName.replace(/^onboarding-/, "")
  return path.join(onboardScaffoldParent(browserKey), "e2e-scaffolded")
}

test.describe("Vivicy onboarding (three start modes)", () => {
  test("shows all three start modes", async ({ page }, testInfo) => {
    await page.goto("/")

    // The chooser heading + all three mode cards render.
    await expect(page.getByRole("heading", { name: "Start a project" })).toBeVisible({
      timeout: 30_000,
    })
    await expect(
      page.getByRole("button", { name: /Open existing folder/i })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: /Scaffold a new project/i })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: /Import docs/i })
    ).toBeVisible()

    // Cross-browser capture of the pristine `no_target` chooser. This is the FIRST
    // test in the serial file, so it runs BEFORE the Mode-B scaffold below mutates
    // the server's current-project — capturing here avoids any cross-spec ordering
    // dependency on the shared onboarding runtime dir.
    await page.waitForTimeout(300)
    await page.screenshot({
      path: `/tmp/vivicy-xbrowser/06-onboarding--${testInfo.project.name}.png`,
    })
  })

  test("Mode B scaffolds a new project and lands on the no-map state", async ({
    page,
  }, testInfo) => {
    const scaffoldTarget = scaffoldTargetFor(testInfo.project.name)
    const pageErrors: string[] = []
    page.on("pageerror", (err) => pageErrors.push(err.message))

    await page.goto("/")
    await expect(
      page.getByRole("button", { name: /Scaffold a new project/i })
    ).toBeVisible({ timeout: 30_000 })

    // Open the Mode B (scaffold) dialog.
    await page.getByRole("button", { name: /Scaffold a new project/i }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Start from scratch")).toBeVisible()

    // Name the project and give an absolute target (deterministic, avoids
    // browser-path canonicalization differences).
    await dialog.getByLabel("Project name").fill("E2E Scaffolded")
    await dialog.getByLabel(/absolute target path/i).fill(scaffoldTarget)

    // Scaffold: POST /api/project/scaffold, success toast, dialog closes.
    await dialog.getByRole("button", { name: /Scaffold project/i }).click()
    await expect(page.getByText(/Project scaffolded/i).first()).toBeVisible({
      timeout: 30_000,
    })
    await expect(dialog).not.toBeVisible()

    // The app re-fetched the map and now lands on the freshly-scaffolded project:
    // it HAS docs/ (the canonical README placeholder) but no generated map, so the
    // no-map onboarding card renders.
    const card = page.locator('[data-empty-reason="no_map"]')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByText("No issues extracted yet", { exact: true })
    ).toBeVisible()

    // The current-project affordance reflects the scaffolded project's basename.
    await expect(
      page.getByRole("button", { name: "Change project" }).getByText("e2e-scaffolded")
    ).toBeVisible({ timeout: 15_000 })

    // No graph, no raw error, no runtime throw.
    await expect(page.locator(".react-flow__node")).toHaveCount(0)
    await expect(page.getByText(/Request failed/i)).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })
})
