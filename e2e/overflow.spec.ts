import { expect, test, type Page } from "./browser-issues"

import { DEMO_TARGET_ROOT, LONG_TARGET_ROOT } from "../playwright.config"

// Serial: these tests mutate the process-global current-project on disk; interleaving would race. Runs as a dependency phase before other specs — see playwright.config's OVERFLOW_SPEC note.
test.describe.configure({ mode: "serial" })

const TOLERANCE = 2

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
  // afterAll (not per-test): restores the demo target so the main phase starts from the canonical project — otherwise setup.spec's demo re-select becomes a real switch racing control.spec.
  test.afterAll(async ({ request }) => {
    const restored = await request.post("/api/project", {
      data: { root: DEMO_TARGET_ROOT },
    })
    expect(restored.ok()).toBe(true)
  })

  test("demo target: map, Open-project modal, Details, and transcript modal all fit", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1320, height: 820 })
    await page.goto("/")

    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
    await expectNoPageOverflow(page, "demo map (initial)")

    await page.getByRole("button", { name: "Change project" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Open project")).toBeVisible()

    await expectNoPageOverflow(page, "Open-project modal (default)")
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Use", exact: true })).toBeVisible()
    await expect(dialog.getByRole("button", { name: /Select this folder/ })).toBeVisible()
    const dialogBox = await dialog.boundingBox()
    expect(dialogBox).not.toBeNull()
    if (dialogBox) {
      expect(dialogBox.x).toBeGreaterThanOrEqual(-TOLERANCE)
      expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(1320 + TOLERANCE)
    }

    await dialog.getByLabel("Or paste an absolute path").fill(LONG_TARGET_ROOT)
    await expectNoPageOverflow(page, "Open-project modal (long path typed)")
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Use", exact: true })).toBeVisible()

    await dialog.getByRole("button", { name: "New folder" }).click()
    await expect(dialog.getByPlaceholder("new-folder-name")).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Create" })).toBeVisible()
    await expectNoPageOverflow(page, "Open-project modal (new-folder form)")
    await dialog.getByRole("button", { name: "Cancel new folder" }).click()

    await dialog.getByLabel("Or paste an absolute path").fill(LONG_TARGET_ROOT)
    await dialog.getByRole("button", { name: "Use", exact: true }).click()
    await expect(dialog).toBeHidden({ timeout: 15_000 })

    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
    await expectNoPageOverflow(page, "long target: map")

    await page.getByRole("button", { name: "Change project" }).hover()
    await expectNoPageOverflow(page, "long target: project tooltip")
    await expectContainedInParent(
      page,
      '[data-slot="tooltip-content"]',
      "long target: project tooltip content"
    )

    await page.locator(".react-flow__node").first().click()
    await page.getByRole("button", { name: "Details" }).click()
    const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
    await expect(sidebar.getByText("Source refs")).toBeVisible({ timeout: 15_000 })
    await expectNoPageOverflow(page, "long target: Details panel")

    await page.getByRole("button", { name: "Tasks" }).click()
    await expect(sidebar.getByText("ISS-0001", { exact: true })).toBeVisible({ timeout: 15_000 })
    await expectNoPageOverflow(page, "long target: Tasks panel")

    const transcriptButton = sidebar.locator('button[title*="/transcripts/"]').first()
    if (await transcriptButton.count()) {
      // Retries with a re-resolved, force-clicked button: background SSE-driven map refreshes can re-render/detach the row mid-click. No networkidle wait — the page holds a persistent SSE connection so network never idles.
      const transcript = page.getByRole("dialog")
      await expect(async () => {
        await transcriptButton.scrollIntoViewIfNeeded()
        await transcriptButton.click({ force: true, noWaitAfter: true, timeout: 3_000 })
        await expect(transcript).toBeVisible({ timeout: 3_000 })
      }).toPass({ timeout: 30_000 })
      await expectNoPageOverflow(page, "long target: transcript modal")
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
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Use", exact: true })).toBeVisible()
    await expect(dialog.getByRole("button", { name: /Select this folder/ })).toBeVisible()
  })
})
