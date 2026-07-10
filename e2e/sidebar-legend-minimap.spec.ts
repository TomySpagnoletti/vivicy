import { expect, test, type ConsoleMessage } from "./browser-issues"

import { clickPastOverlap, ensurePanelOpen, isMobileProject } from "./helpers"

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

    await expect(container).toHaveAttribute("data-state", "expanded")
    expect(await widthOf()).toBe("24rem")

    await toggle.click()
    await expect(container).toHaveAttribute("data-state", "expanded")
    expect(await widthOf()).toBe("36rem")

    await toggle.click()
    await expect(container).toHaveAttribute("data-state", "collapsed")

    await toggle.click()
    await expect(container).toHaveAttribute("data-state", "expanded")
    expect(await widthOf()).toBe("24rem")
  })
})

test.describe("no hydration error (the reported bug)", () => {
  test("loads clean even with a non-default panel width persisted", async ({
    page,
  }, testInfo) => {
    // Pre-seed via addInitScript so the persisted state exists BEFORE first paint — a post-load write would miss the hydration mismatch.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("vivicy:panel-state", "wide")
      } catch {
      }
    })

    // Firefox's Next dev build emits a benign console.timeStamp("Hydrated") marker; require error/warning severity plus explicit mismatch wording so it isn't mistaken for a real one.
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
    await page.waitForTimeout(1_000)

    expect(hydrationErrors).toEqual([])

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

    const trigger = sidebar.getByRole("button", { name: /Legend · Kind colors/i })
    await expect(trigger).toBeVisible()

    await expect(trigger).toHaveAttribute("data-state", "closed")

    await expect(page.locator(".map-legend")).toHaveCount(0)

    // Mobile Sheet: panel content can overlap this footer trigger at rest.
    await clickPastOverlap(trigger)
    await expect(trigger).toHaveAttribute("data-state", "open")
    const content = sidebar.locator('[data-slot="collapsible-content"]')
    await expect(content).toBeVisible()
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
    const legend = footer.getByRole("button", { name: /Legend · /i })
    await expect(legend).toBeVisible()
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

    const box = await minimap.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeLessThanOrEqual(180)
    expect(box!.height).toBeLessThanOrEqual(140)

    const rects = page.locator(".react-flow__minimap-node")
    expect(await rects.count()).toBeGreaterThanOrEqual(1)

    const paints = await page.$$eval(".react-flow__minimap-node", (els) =>
      els.map((el) => ({
        fill: getComputedStyle(el).fill,
        stroke: getComputedStyle(el).stroke,
      }))
    )
    for (const p of paints) {
      expect(p.stroke).not.toBe("none")
      expect(p.stroke).not.toBe("")
    }
    const someColored = paints.some(
      (p) => p.stroke !== "rgb(255, 255, 255)" && p.stroke !== "rgba(0, 0, 0, 0)"
    )
    expect(someColored).toBe(true)
  })
})
