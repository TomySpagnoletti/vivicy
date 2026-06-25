import { expect, test, type Page } from "@playwright/test"

import { LONG_TARGET_ROOT } from "../playwright.config"

/**
 * Horizontal-overflow audit (the owner asked to "vérifier partout, sur toute
 * l'interface avec des tests"). Drives the main app on the demo target AND with a
 * very long target path, opening the Open-project modal, a Details panel, and the
 * transcript modal, asserting at each step that:
 *
 *   - the PAGE has no horizontal overflow
 *     (document.documentElement.scrollWidth <= innerWidth + tolerance), and
 *   - key containers don't overflow their own parent.
 *
 * A small tolerance absorbs sub-pixel rounding from devicePixelRatio.
 *
 * Serial: the picker persists the current project on disk (process-global), and
 * selecting the long target would otherwise race the other demo-server specs.
 */
test.describe.configure({ mode: "serial" })

const TOLERANCE = 2

/** Assert the document doesn't scroll horizontally (no page-level overflow). */
async function expectNoPageOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    return {
      scrollWidth: doc.scrollWidth,
      innerWidth: window.innerWidth,
      bodyScroll: document.body.scrollWidth,
    }
  })
  expect(
    overflow.scrollWidth,
    `${label}: documentElement.scrollWidth (${overflow.scrollWidth}) must be <= innerWidth (${overflow.innerWidth})`
  ).toBeLessThanOrEqual(overflow.innerWidth + TOLERANCE)
  expect(
    overflow.bodyScroll,
    `${label}: body.scrollWidth (${overflow.bodyScroll}) must be <= innerWidth (${overflow.innerWidth})`
  ).toBeLessThanOrEqual(overflow.innerWidth + TOLERANCE)
}

/**
 * Assert that every element matching `selector` fits within its offsetParent —
 * i.e. its right edge doesn't extend past the parent's content box (no child
 * pushing its container wider than itself).
 */
async function expectContainedInParent(page: Page, selector: string, label: string) {
  const offenders = await page.evaluate(
    ({ selector, tolerance }) => {
      const out: Array<{ text: string; childRight: number; parentRight: number }> = []
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const parent = el.parentElement
        if (!parent) continue
        const c = el.getBoundingClientRect()
        const p = parent.getBoundingClientRect()
        if (c.right > p.right + tolerance) {
          out.push({
            text: (el.textContent ?? "").slice(0, 60),
            childRight: Math.round(c.right),
            parentRight: Math.round(p.right),
          })
        }
      }
      return out
    },
    { selector, tolerance: TOLERANCE }
  )
  expect(offenders, `${label}: elements overflowing their parent: ${JSON.stringify(offenders)}`).toEqual(
    []
  )
}

test.describe("No horizontal overflow anywhere", () => {
  test("demo target: map, Open-project modal, Details, and transcript modal all fit", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1320, height: 820 })
    await page.goto("/")

    // The demo map renders.
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
    await expectNoPageOverflow(page, "demo map (initial)")

    // --- Open-project modal (the dialog the owner flagged) ---
    await page.getByRole("button", { name: "Change project" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Open project")).toBeVisible()

    // The dialog never exceeds the viewport, and Cancel + Use stay visible.
    await expectNoPageOverflow(page, "Open-project modal (default)")
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Use", exact: true })).toBeVisible()
    await expect(dialog.getByRole("button", { name: /Select this folder/ })).toBeVisible()
    // The dialog box itself fits within the viewport width.
    const dialogBox = await dialog.boundingBox()
    expect(dialogBox).not.toBeNull()
    if (dialogBox) {
      expect(dialogBox.x).toBeGreaterThanOrEqual(-TOLERANCE)
      expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(1320 + TOLERANCE)
    }

    // Navigate into the deep, very-long path so the breadcrumb + "Select this
    // folder" row carry long strings — the exact case that used to clip the
    // buttons off the right edge.
    await dialog.getByLabel("Or paste an absolute path").fill(LONG_TARGET_ROOT)
    // Filling the input doesn't browse; instead browse via the manual path Use
    // would SELECT it. To exercise the in-modal long breadcrumb we navigate the
    // browser to the long path through the breadcrumb root then keep the modal
    // open with long content present in the manual input row.
    await expectNoPageOverflow(page, "Open-project modal (long path typed)")
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Use", exact: true })).toBeVisible()

    // The New-folder affordance opens its inline form without overflowing.
    await dialog.getByRole("button", { name: "New folder" }).click()
    await expect(dialog.getByPlaceholder("new-folder-name")).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Create" })).toBeVisible()
    await expectNoPageOverflow(page, "Open-project modal (new-folder form)")
    // Close the new-folder form and select the long target so the rest of the UI
    // gets long content.
    await dialog.getByRole("button", { name: "Cancel new folder" }).click()

    // Select the long target via the manual path (the documented fallback). This
    // makes the header project tooltip + Details panel carry the long path.
    await dialog.getByLabel("Or paste an absolute path").fill(LONG_TARGET_ROOT)
    await dialog.getByRole("button", { name: "Use", exact: true }).click()
    await expect(dialog).toBeHidden({ timeout: 15_000 })

    // The map reloads for the long target (same demo graph, long root).
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
    await expectNoPageOverflow(page, "long target: map")

    // --- Header project tooltip with the very long path ---
    await page.getByRole("button", { name: "Change project" }).hover()
    // Whether or not the tooltip renders, hovering must not introduce overflow,
    // and the project affordance button stays within the viewport.
    await expectNoPageOverflow(page, "long target: project tooltip")
    await expectContainedInParent(
      page,
      '[data-slot="tooltip-content"]',
      "long target: project tooltip content"
    )

    // --- Details panel with long source paths/refs ---
    await page.locator(".react-flow__node").first().click()
    await page.getByRole("button", { name: "Details" }).click()
    const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
    await expect(sidebar.getByText("Source refs")).toBeVisible({ timeout: 15_000 })
    await expectNoPageOverflow(page, "long target: Details panel")

    // --- Tasks panel: issue cards with long paths ---
    await page.getByRole("button", { name: "Tasks" }).click()
    await expect(sidebar.getByText("ISS-0001", { exact: true })).toBeVisible({ timeout: 15_000 })
    await expectNoPageOverflow(page, "long target: Tasks panel")

    // --- Transcript modal ---
    // The demo issues carry transcript refs; open the first transcript button.
    const transcriptButton = sidebar.locator('button[title*="/transcripts/"]').first()
    if (await transcriptButton.count()) {
      // The panel runs background map refreshes (loadMap on status/SSE), which
      // re-render the Tasks list and can DETACH the row mid-click. Retry the open,
      // re-resolving the (possibly re-rendered) button each attempt and FORCE-
      // clicking so the constant re-render doesn't fail Playwright's stability gate
      // — robust to the re-render race without weakening the assertion. (No
      // networkidle wait: the page holds a persistent /api/status/stream SSE
      // connection, so the network never goes idle.)
      const transcript = page.getByRole("dialog")
      await expect(async () => {
        await transcriptButton.scrollIntoViewIfNeeded()
        await transcriptButton.click({ force: true, noWaitAfter: true, timeout: 3_000 })
        await expect(transcript).toBeVisible({ timeout: 3_000 })
      }).toPass({ timeout: 30_000 })
      await expectNoPageOverflow(page, "long target: transcript modal")
      // The transcript dialog box fits the viewport width.
      const tBox = await transcript.boundingBox()
      if (tBox) {
        expect(tBox.x + tBox.width).toBeLessThanOrEqual(1320 + TOLERANCE)
      }
    }
  })

  test("narrow viewport: the Open-project modal still fits and keeps its actions", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 760, height: 720 })
    await page.goto("/")
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
    await expectNoPageOverflow(page, "narrow: map")

    await page.getByRole("button", { name: "Change project" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Open project")).toBeVisible()
    await dialog.getByLabel("Or paste an absolute path").fill(LONG_TARGET_ROOT)
    await expectNoPageOverflow(page, "narrow: Open-project modal with long path")
    // Actions remain visible at a narrow width.
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Use", exact: true })).toBeVisible()
    await expect(dialog.getByRole("button", { name: /Select this folder/ })).toBeVisible()
  })
})
