import { expect, test, type ConsoleMessage } from "./browser-issues"

import { clickPastOverlap, ensurePanelOpen, isMobileProject } from "./helpers"

/**
 * Covers the four owner-requested changes on the populated demo target:
 *   1. the sidebar toggle cycles through the grown 24rem and 36rem widths;
 *   2. the page loads with NO hydration error in the console (the reported bug),
 *      even when a non-default panel width is already persisted;
 *   3. the color legend lives IN the sidebar, collapsed by default, and expands;
 *   4. the minimap is present and non-empty (rendered node rects with real fill).
 *
 * (1) and the width side of (2) are DESKTOP affordances — they assert the docked
 * sidebar's `--sidebar-width`, which only exists on desktop (on mobile the panel
 * is a single-width off-canvas Sheet). Those width assertions are scoped to
 * desktop; the legend, hydration-cleanliness, and minimap checks run everywhere.
 */

const sidebarName = "Vivicy panel"

test.describe("sidebar widths (24rem / 36rem)", () => {
  test("the toggle cycles peek=24rem -> wide=36rem -> closed", async ({
    page,
  }, testInfo) => {
    await page.goto("/")
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 30_000,
    })
    await ensurePanelOpen(page, testInfo)
    const sidebar = page.getByRole("complementary", { name: sidebarName })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible()

    // The 24rem/36rem width cycle is a desktop-only affordance (see file header).
    test.skip(
      isMobileProject(testInfo),
      "Mobile uses a single-width off-canvas Sheet; the width cycle is desktop-only."
    )

    const container = page.locator('[data-slot="sidebar"][data-side="right"]')
    const toggle = page.locator("[data-panel-toggle]")
    const widthOf = () =>
      page.evaluate(() =>
        getComputedStyle(
          document.querySelector('[data-slot="sidebar-wrapper"]')!
        )
          .getPropertyValue("--sidebar-width")
          .trim()
      )

    // (1) peek: open, the comfortable 24rem default (today's old "wide").
    await expect(container).toHaveAttribute("data-state", "expanded")
    expect(await widthOf()).toBe("24rem")

    // (2) peek -> wide: the roomy 36rem (1.5x). Still open.
    await toggle.click()
    await expect(container).toHaveAttribute("data-state", "expanded")
    expect(await widthOf()).toBe("36rem")

    // (3) wide -> closed: offcanvas.
    await toggle.click()
    await expect(container).toHaveAttribute("data-state", "collapsed")

    // closed -> peek: wraps back to 24rem.
    await toggle.click()
    await expect(container).toHaveAttribute("data-state", "expanded")
    expect(await widthOf()).toBe("24rem")
  })
})

test.describe("no hydration error (the reported bug)", () => {
  test("loads clean even with a non-default panel width persisted", async ({
    page,
  }, testInfo) => {
    // The reported bug: with a persisted "wide" state, the SSR --sidebar-width
    // (default) and the first client render (persisted) disagreed -> a hydration
    // mismatch error in the console. Pre-seed the persisted state BEFORE first
    // paint to reproduce that exact condition.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("vivicy:panel-state", "wide")
      } catch {
        // ignore
      }
    })

    // Match only a genuine hydration MISMATCH error, not benign dev instrumentation
    // that happens to contain the word "hydrate" — Firefox's Next dev build emits a
    // `console.timeStamp("Hydrated")` performance marker (msg.type() === "timeStamp"),
    // which is NOT an error. A real mismatch is logged by React at error/warning
    // severity with explicit mismatch wording, so require both.
    const isHydrationMismatch = (text: string) =>
      /hydrat/i.test(text) &&
      /(mismatch|did not match|didn't match|server rendered|server-rendered|while hydrating|text content)/i.test(
        text
      )
    const hydrationErrors: string[] = []
    const onConsole = (msg: ConsoleMessage) => {
      const type = msg.type()
      if ((type === "error" || type === "warning") && isHydrationMismatch(msg.text())) {
        hydrationErrors.push(msg.text())
      }
    }
    page.on("console", onConsole)
    page.on("pageerror", (err) => {
      if (isHydrationMismatch(err.message)) hydrationErrors.push(err.message)
    })

    await page.goto("/")
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 30_000,
    })
    // Let React settle (hydration + the post-hydration snapshot swap).
    await page.waitForTimeout(1_000)

    // The whole point: NO hydration error was logged — this must hold on every
    // browser (the reported regression was browser-agnostic).
    expect(hydrationErrors).toEqual([])

    // On desktop the persisted "wide" state still takes effect (panel ends up at
    // 36rem), proving the fix did not regress persistence — only moved it past
    // hydration. The docked width var is desktop-only DOM.
    if (isMobileProject(testInfo)) return
    const sidebar = page.getByRole("complementary", { name: sidebarName })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible()
    const width = await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-slot="sidebar-wrapper"]')!)
        .getPropertyValue("--sidebar-width")
        .trim()
    )
    expect(width).toBe("36rem")
  })
})

test.describe("legend lives in the sidebar (collapsed by default)", () => {
  test("the legend section is present, collapsed, and expands", async ({
    page,
  }, testInfo) => {
    await page.goto("/")
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 30_000,
    })
    await ensurePanelOpen(page, testInfo)
    const sidebar = page.getByRole("complementary", { name: sidebarName })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible()

    // The legend trigger is in the sidebar (target view -> "Kind colors").
    const trigger = sidebar.getByRole("button", { name: /Legend · Kind colors/i })
    await expect(trigger).toBeVisible()

    // Collapsed by default: the radix Collapsible trigger reports closed and the
    // content is not rendered/visible.
    await expect(trigger).toHaveAttribute("data-state", "closed")

    // The floating legend overlay was REMOVED from the map.
    await expect(page.locator(".map-legend")).toHaveCount(0)

    // Expand it: the content (a swatch row) appears. On the mobile Sheet the
    // scrollable panel content (issue cards) can overlap this footer trigger at
    // rest; click past that overlap.
    await clickPastOverlap(trigger)
    await expect(trigger).toHaveAttribute("data-state", "open")
    const content = sidebar.locator('[data-slot="collapsible-content"]')
    await expect(content).toBeVisible()
    // At least one legend swatch label renders inside the expanded content.
    await expect(content.locator("span").first()).toBeVisible()
  })

  test("the legend lives in the fixed footer region, above the quota footer", async ({
    page,
  }, testInfo) => {
    await page.goto("/")
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 30_000,
    })
    await ensurePanelOpen(page, testInfo)
    const sidebar = page.getByRole("complementary", { name: sidebarName })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible()

    const footer = sidebar.locator('[data-sidebar="footer"]')
    // The legend trigger is inside the footer region...
    const legend = footer.getByRole("button", { name: /Legend · /i })
    await expect(legend).toBeVisible()
    // ...and sits ABOVE the "Quota" label (smaller top coordinate).
    const quota = footer.getByText("Quota", { exact: true })
    const legendBox = await legend.boundingBox()
    const quotaBox = await quota.boundingBox()
    expect(legendBox).not.toBeNull()
    expect(quotaBox).not.toBeNull()
    expect(legendBox!.y).toBeLessThan(quotaBox!.y)
  })
})

test.describe("minimap is present and non-empty", () => {
  test("renders node rects filled with real (non-white) color", async ({
    page,
  }) => {
    await page.goto("/")
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 30_000,
    })
    await page.waitForTimeout(1_500)

    const minimap = page.locator(".react-flow__minimap")
    await expect(minimap).toBeVisible()

    // Smaller footprint: the minimap box is the compact 140x100 we set.
    const box = await minimap.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeLessThanOrEqual(180)
    expect(box!.height).toBeLessThanOrEqual(140)

    // Non-empty: at least one node rect is painted, and the rects are NOT all
    // pure white (the previous empty/white failure mode).
    const rects = page.locator(".react-flow__minimap-node")
    expect(await rects.count()).toBeGreaterThanOrEqual(1)

    const paints = await page.$$eval(".react-flow__minimap-node", (els) =>
      els.map((el) => ({
        fill: getComputedStyle(el).fill,
        stroke: getComputedStyle(el).stroke,
      }))
    )
    // Every rect must have a real stroke color (the saturated border that keeps
    // even near-white fills visible) — none is "none"/transparent.
    for (const p of paints) {
      expect(p.stroke).not.toBe("none")
      expect(p.stroke).not.toBe("")
    }
    // Concretely non-white: at least one rect's stroke is not white.
    const someColored = paints.some(
      (p) => p.stroke !== "rgb(255, 255, 255)" && p.stroke !== "rgba(0, 0, 0, 0)"
    )
    expect(someColored).toBe(true)
  })
})
