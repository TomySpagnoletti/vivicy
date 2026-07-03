import { rmSync } from "node:fs"
import path from "node:path"

import { expect, test } from "@playwright/test"

import { onboardScaffoldParent, RUNTIME_DIR } from "../playwright.config"

/**
 * G10 onboarding. The onboarding server points at a target with NO `.vivicy/`, so
 * the map route returns `no_target` and the four-card chooser renders. This spec:
 *
 *   1. asserts ALL FOUR cards are offered (open a project, start from scratch,
 *      import your docs, build the spec with Vivi);
 *   2. drives the scaffold (start-from-scratch) card end to end — opens the
 *      scaffold dialog, gives a name + absolute target, scaffolds, and confirms
 *      the app lands on the freshly scaffolded project's "no architecture map yet"
 *      empty state.
 *
 * Serial: the scaffold persists a current-project into this server's runtime dir,
 * which changes the map state for the rest of the file.
 */
test.describe.configure({ mode: "serial" })

// The browser key is the project-name suffix ("onboarding-<browserKey>"); each
// browser scaffolds into its OWN parent dir (global-setup wipes each), so the
// matrix's parallel onboarding projects never race the same scaffold target.
function browserKeyFor(projectName: string): string {
  return projectName.replace(/^onboarding-/, "")
}

function scaffoldTargetFor(projectName: string): string {
  return path.join(onboardScaffoldParent(browserKeyFor(projectName)), "e2e-scaffolded")
}

test.describe("Vivicy onboarding (four start modes)", () => {
  // Both tests must start from the pristine `no_target` chooser. The scaffold test
  // persists a current-project into this server's runtime dir, and Playwright's
  // serial-mode retry re-runs the WHOLE group — so without this reset a retried
  // "shows four modes" would boot into the scaffolded project's no-map state, not
  // the chooser. Deleting the persisted current-project before each test restores
  // `no_target` deterministically (the env target has no `.vivicy/`), independent
  // of run/retry order.
  test.beforeEach(async ({}, testInfo) => {
    rmSync(path.join(RUNTIME_DIR("onboarding", browserKeyFor(testInfo.project.name)), "current-project.json"), {
      force: true,
    })
  })

  test("shows all four start modes", async ({ page }, testInfo) => {
    await page.goto("/")

    // The chooser heading + all four mode cards render: the two acquisition cards
    // (Open a project, Start from scratch) and the two intake cards (Import your
    // docs, Build the spec with Vivi).
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
    await expect(
      page.getByRole("button", { name: /Talk to Vivi/i })
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
    // it HAS a `.vivicy/canonical/` (the scaffolded skeleton) but no generated map,
    // so the no-map onboarding card renders.
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
