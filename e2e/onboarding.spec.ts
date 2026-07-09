import { rmSync } from "node:fs"
import path from "node:path"

import { expect, test } from "./browser-issues"

import { onboardScaffoldParent, RUNTIME_DIR } from "../playwright.config"

/**
 * Panel-hosted onboarding (W4b). The onboarding server points at a target with NO
 * `.vivicy/`, so the map route returns `no_target`. Since W4b the full-screen
 * chooser is retired: the map area shows a calm empty state and the Vivi panel
 * AUTO-OPENS hosting the deterministic onboarding view. This spec:
 *
 *   1. asserts the gate: the launcher/panel is up on load, the panel auto-opened,
 *      and all THREE acquisition choices are offered (open an existing project,
 *      start a new project, import documents);
 *   2. drives the scaffold (start-a-new-project) choice end to end — expands the
 *      in-panel form, gives a name + absolute target, scaffolds, and confirms the
 *      panel flips to chat mode while the app lands on the freshly scaffolded
 *      project's "no architecture map yet" empty state.
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

test.describe("Vivicy onboarding (panel-hosted)", () => {
  // Both tests must start from the pristine `no_target` state. The scaffold test
  // persists a current-project into this server's runtime dir, and Playwright's
  // serial-mode retry re-runs the WHOLE group — so without this reset a retried
  // "shows the choices" would boot into the scaffolded project's no-map state.
  // Deleting the persisted current-project before each test restores `no_target`
  // deterministically (the env target has no `.vivicy/`), independent of
  // run/retry order.
  test.beforeEach(async ({}, testInfo) => {
    rmSync(path.join(RUNTIME_DIR("onboarding", browserKeyFor(testInfo.project.name)), "current-project.json"), {
      force: true,
    })
  })

  test("no_target auto-opens the Vivi panel with the three start choices", async ({
    page,
  }, testInfo) => {
    await page.goto("/")

    // The map area shows the calm empty state (no full-screen chooser anymore).
    await expect(page.getByText(/No project yet — Vivi sets one up/)).toBeVisible({
      timeout: 30_000,
    })

    // The panel AUTO-OPENED once on the first no_target render, hosting the
    // onboarding view: welcome header + the three user-driven choices (P7).
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

    // No chat composer without a target — the onboarding view owns the thread area.
    await expect(page.getByLabel("Message Vivi")).toHaveCount(0)

    // Cross-browser capture of the pristine `no_target` panel onboarding. This is
    // the FIRST test in the serial file, so it runs BEFORE the scaffold below
    // mutates the server's current-project — capturing here avoids any cross-spec
    // ordering dependency on the shared onboarding runtime dir.
    await page.waitForTimeout(300)
    await page.screenshot({
      path: `/tmp/vivicy-xbrowser/06-onboarding--${testInfo.project.name}.png`,
    })
  })

  test("the scaffold choice creates a new project and lands on the no-map state", async ({
    page,
  }, testInfo) => {
    const scaffoldTarget = scaffoldTargetFor(testInfo.project.name)
    const pageErrors: string[] = []
    page.on("pageerror", (err) => pageErrors.push(err.message))

    await page.goto("/")
    await expect(
      page.getByRole("button", { name: /Start a new project/i })
    ).toBeVisible({ timeout: 30_000 })

    // Expand the in-panel scaffold form.
    await page.getByRole("button", { name: /Start a new project/i }).click()
    await expect(page.getByLabel("Project name")).toBeVisible()

    // Name the project and give an absolute target (deterministic, avoids
    // browser-path canonicalization differences).
    await page.getByLabel("Project name").fill("E2E Scaffolded")
    await page.getByLabel(/absolute target path/i).fill(scaffoldTarget)

    // Scaffold: POST /api/project/scaffold, success toast.
    await page.getByRole("button", { name: /Scaffold project/i }).click()
    await expect(page.getByText(/Project scaffolded/i).first()).toBeVisible({
      timeout: 30_000,
    })

    // The app re-fetched map + project and now lands on the freshly-scaffolded
    // project: it HAS a `.vivicy/canonical/` (the scaffolded skeleton) but no
    // generated map, so the no-map onboarding card renders behind the panel.
    const card = page.locator('[data-empty-reason="no_map"]')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByText("No issues extracted yet", { exact: true })
    ).toBeVisible()

    // The panel flipped from the onboarding view to chat mode: the composer is
    // there for the first message, the choices are gone.
    await expect(page.getByLabel("Message Vivi")).toBeVisible({ timeout: 15_000 })
    await expect(
      page.getByRole("button", { name: /Start a new project/i })
    ).toHaveCount(0)

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
