import { expect, test, type Locator, type Page } from "./browser-issues"

// This file runs on the `long` shape alone: its server is bound to a target buried under three very long path segments, which is what makes every measurement below meaningful.

const TOLERANCE = 2

const SMALLEST_PHONE_WIDTH = 320

const NODE_WITH_TRANSCRIPTS = ".react-flow__node[data-id='cli']"

async function openSection(page: Page, name: string) {
  const trigger = page.getByRole("button", { name, exact: true })
  await expect(trigger).toBeVisible({ timeout: 15_000 })
  if ((await trigger.getAttribute("aria-expanded")) === "false") await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
}

async function measureBox(locator: Locator) {
  return locator.evaluate((root) => {
    const bound = (el: Element): Element | null => {
      for (let parent = el.parentElement; parent !== null; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        if (style.overflowX === "auto" || style.overflowX === "scroll") return null
        const contentVisibility = style.contentVisibility ?? "visible"
        if (
          style.overflowX === "hidden" ||
          style.overflowX === "clip" ||
          contentVisibility === "auto" ||
          contentVisibility === "hidden" ||
          /\b(paint|content|strict)\b/.test(style.contain)
        ) {
          return parent
        }
        if (parent === root) break
      }
      return root
    }
    const escaping: string[] = []
    for (const el of root.querySelectorAll("*")) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      const bounds = bound(el)
      if (bounds === null) continue
      const over = rect.right - bounds.getBoundingClientRect().right
      if (over > 0.5) {
        escaping.push(
          `${el.tagName.toLowerCase()}[${el.getAttribute("data-slot") ?? ""}] +${Math.round(over)}px past ${bounds.tagName.toLowerCase()}[${bounds.getAttribute("data-slot") ?? ""}]`
        )
      }
    }
    const box = root.getBoundingClientRect()
    return { left: box.left, right: box.right, width: box.width, innerWidth: window.innerWidth, escaping }
  })
}

function expectNothingClipped(escaping: string[], label: string) {
  expect(escaping, `${label}: content clipped past the box that bounds it: ${escaping.join(", ")}`).toEqual([])
}

async function expectBoxContainsItsContent(locator: Locator, label: string) {
  expectNothingClipped((await measureBox(locator)).escaping, label)
}

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
  test("long target: map, Details, Tasks, and transcript modal all fit", async ({ page }) => {
    await page.setViewportSize({ width: 1320, height: 820 })
    await page.goto("/")

    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
    await expectNoPageOverflow(page, "long target: map")

    await page.locator(NODE_WITH_TRANSCRIPTS).click()
    await openSection(page, "Details")
    const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
    await expect(sidebar.getByText("Source refs")).toBeVisible({ timeout: 15_000 })
    await expectNoPageOverflow(page, "long target: Details panel")
    await expectBoxContainsItsContent(sidebar, "long target: Details panel")

    await openSection(page, "Tasks")
    await expect(sidebar.getByText("ISSUE-0001", { exact: true })).toBeVisible({ timeout: 15_000 })
    await expectNoPageOverflow(page, "long target: Tasks panel")
    await expectBoxContainsItsContent(sidebar, "long target: Tasks panel")

    await openSection(page, "Cycles")
    await expect(sidebar.getByText("Active cycle")).toBeVisible({ timeout: 15_000 })
    await expectNoPageOverflow(page, "long target: Cycles panel")
    await expectBoxContainsItsContent(sidebar, "long target: Cycles panel")

    const transcriptButton = sidebar.locator('button[title*="/transcripts/"]').first()
    await expect(transcriptButton).toBeVisible({ timeout: 15_000 })
    // Never wait for networkidle here: the page holds a persistent SSE connection, whose refreshes are also what detach this row mid-click.
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
  })

  test("narrow viewport: the map fits, and so does the sidebar at its narrowest", async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 720 })
    await page.goto("/")
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
    await expectNoPageOverflow(page, "narrow: map")

    await page.setViewportSize({ width: SMALLEST_PHONE_WIDTH, height: 720 })
    await page.locator("[data-panel-toggle]").click()
    const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(sidebar.locator('button[title*="/transcripts/"]').first()).toBeVisible({
      timeout: 15_000,
    })
    await expectBoxContainsItsContent(sidebar, "narrow: sidebar sheet")
    await expectNoPageOverflow(page, "narrow: sidebar sheet")
  })
})

const PANEL_CLAMP_FLOOR = 380

const PHONE_WIDTHS = [SMALLEST_PHONE_WIDTH, 360, 375, 390, 412]

const DESKTOP_PANEL_WIDTHS: [viewport: number, panel: number][] = [
  [1280, PANEL_CLAMP_FLOOR],
  [1600, 400],
  [1920, 480],
]

function viviPanel(page: Page) {
  return page.getByRole("complementary", { name: "Vivi", exact: true })
}

async function measurePanel(page: Page) {
  return measureBox(viviPanel(page))
}

async function openViviPanel(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height })
  await page.goto("/")
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 })
  await page.getByRole("button", { name: "Open Vivi" }).click()
  await expect(viviPanel(page)).toBeVisible()
  await expect.poll(async () => Math.abs((await measurePanel(page)).left)).toBeLessThanOrEqual(TOLERANCE)
}

async function expectPanelFitsViewport(page: Page, label: string): Promise<number> {
  const panel = await measurePanel(page)
  expect(panel.left, `${label}: panel left edge (${panel.left}) must stay at the viewport edge`).toBeGreaterThanOrEqual(-TOLERANCE)
  expect(panel.right, `${label}: panel right edge (${panel.right}) must be <= innerWidth (${panel.innerWidth})`).toBeLessThanOrEqual(
    panel.innerWidth + TOLERANCE
  )
  expectNothingClipped(panel.escaping, `${label}: panel`)
  return panel.width
}

test.describe("Vivi panel width contract", () => {
  test("phone widths: the panel fits the viewport on both tabs", async ({ page }) => {
    await openViviPanel(page, PHONE_WIDTHS[0], 812)

    for (const width of PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: 812 })

      await page.getByRole("tab", { name: "Chat" }).click()
      const onChat = await expectPanelFitsViewport(page, `${width}px chat`)
      expect(
        Math.abs(onChat - Math.min(width, PANEL_CLAMP_FLOOR)),
        `${width}px: panel width (${onChat}) must be min(viewport, ${PANEL_CLAMP_FLOOR})`
      ).toBeLessThanOrEqual(TOLERANCE)
      await expectNoPageOverflow(page, `${width}px chat`)

      await page.getByRole("tab", { name: "Notifications" }).click()
      await expectPanelFitsViewport(page, `${width}px notifications`)
      await expectNoPageOverflow(page, `${width}px notifications`)
    }
  })

  test("desktop widths: the clamp curve is unchanged", async ({ page }) => {
    await openViviPanel(page, DESKTOP_PANEL_WIDTHS[0][0], 800)

    for (const [viewport, expected] of DESKTOP_PANEL_WIDTHS) {
      await page.setViewportSize({ width: viewport, height: 800 })
      const width = await expectPanelFitsViewport(page, `${viewport}px desktop`)
      expect(Math.abs(width - expected), `${viewport}px: panel width (${width}) must stay ${expected}`).toBeLessThanOrEqual(TOLERANCE)
      await expectNoPageOverflow(page, `${viewport}px desktop`)
    }
  })
})
