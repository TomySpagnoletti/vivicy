import { expect, test } from "./browser-issues"

import { clickPastOverlap, ensurePanelOpen, isMobileProject } from "./helpers"

test.describe("Vivicy architecture map viewer", () => {
  test("renders the map and the interactive shadcn sidebar shell", async ({
    page,
  }, testInfo) => {
    await page.goto("/")

    // The panel toggle only renders once the map reaches its ready state; wait for a node before opening the panel on mobile.
    const nodes = page.locator(".react-flow__node")
    await expect(nodes.first()).toBeVisible({ timeout: 30_000 })
    expect(await nodes.count()).toBeGreaterThanOrEqual(1)

    await ensurePanelOpen(page, testInfo)
    const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible()
    await expect(sidebar.getByText("visual vibe coding")).toBeVisible()

    const infoTrigger = page.getByRole("button", { name: "Information" })
    await expect(infoTrigger).toHaveAttribute("aria-expanded", "false")
    await infoTrigger.click()
    await expect(infoTrigger).toHaveAttribute("aria-expanded", "true")
    await expect(sidebar.getByText("Status legend")).toBeVisible()

    // shadcn's ToggleGroup renders single-select items as radios (aria-checked).
    await page.getByRole("button", { name: "Filters" }).click()
    const targetBtn = page.getByRole("radio", { name: "Target" })
    const progressBtn = page.getByRole("radio", { name: "Progress" })
    await expect(targetBtn).toHaveAttribute("aria-checked", "true")
    // The mobile Sheet scrolls, so sibling accordion content can overlap the toggle at rest; clickPastOverlap works around it.
    await clickPastOverlap(progressBtn)
    await expect(progressBtn).toHaveAttribute("aria-checked", "true")
    await expect(targetBtn).toHaveAttribute("aria-checked", "false")

    // The peek/wide/closed width cycle is a desktop-only affordance (it drives the docked sidebar's --sidebar-width); mobile's off-canvas Sheet has no such DOM, so scope these assertions to desktop.
    if (isMobileProject(testInfo)) return

    const container = page.locator('[data-slot="sidebar"][data-side="right"]')
    const toggle = page.locator("[data-panel-toggle]")
    const widthOf = () =>
      page.evaluate(() =>
        getComputedStyle(document.querySelector('[data-slot="sidebar-wrapper"]')!)
          .getPropertyValue("--sidebar-width")
          .trim()
      )

    await expect(container).toHaveAttribute("data-state", "expanded")
    await expect(toggle).toHaveAttribute("aria-label", "Widen panel")
    const peekWidth = await widthOf()

    await toggle.click()
    await expect(container).toHaveAttribute("data-state", "expanded")
    await expect(toggle).toHaveAttribute("aria-label", "Close panel")
    const wideWidth = await widthOf()
    expect(parseFloat(wideWidth)).toBeGreaterThan(parseFloat(peekWidth))

    await toggle.click()
    await expect(container).toHaveAttribute("data-state", "collapsed")
    await expect(toggle).toHaveAttribute("aria-label", "Open panel")

    await toggle.click()
    await expect(container).toHaveAttribute("data-state", "expanded")
    await expect(toggle).toHaveAttribute("aria-label", "Widen panel")
    expect(await widthOf()).toBe(peekWidth)
  })

  test("quota footer collapses and expands (honest, persisted)", async ({
    page,
  }, testInfo) => {
    await page.goto("/")
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 30_000,
    })
    await ensurePanelOpen(page, testInfo)
    const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible()

    const footer = sidebar.locator('[data-sidebar="footer"]')
    await expect(footer.getByText("Quota", { exact: true })).toBeVisible()
    await expect(
      footer.getByText(/Agent quota status appears here/i)
    ).toBeVisible()
    await expect(footer.getByText(/\d+%/)).toHaveCount(0)
  })
})
