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

test.describe("No horizontal overflow anywhere", () => {
  // afterAll (not per-test): restores the demo target so the main phase starts from the canonical project — otherwise the long-target switch below leaks into control.spec's run.
  test.afterAll(async ({ request }) => {
    const restored = await request.post("/api/project", {
      data: { root: DEMO_TARGET_ROOT },
    })
    expect(restored.ok()).toBe(true)
  })

  test("demo target: map, Details, Tasks, and transcript modal all fit", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1320, height: 820 })
    await page.goto("/")

    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
    await expectNoPageOverflow(page, "demo map (initial)")

    // Switch to the long-rooted (governed) project via the API to exercise the long root across the chrome — map and panels.
    const switched = await page.request.post("/api/project", {
      data: { root: LONG_TARGET_ROOT, requireGoverned: true },
    })
    expect(switched.ok()).toBe(true)
    await page.reload()

    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
    await expectNoPageOverflow(page, "long target: map")

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

  test("narrow viewport: the map fits with no horizontal overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 760, height: 720 })
    await page.goto("/")
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
    await expectNoPageOverflow(page, "narrow: map")
  })
})
