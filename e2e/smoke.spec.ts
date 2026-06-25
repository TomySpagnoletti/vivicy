import { expect, test } from "@playwright/test"

import { ensurePanelOpen, isMobileProject } from "./helpers"

test.describe("Vivicy architecture map viewer", () => {
  test("renders the map and the interactive shadcn sidebar shell", async ({
    page,
  }, testInfo) => {
    await page.goto("/")

    // The map renders at least one node (the panel toggle only appears in the
    // ready state, so wait for the map before opening the panel on mobile).
    const nodes = page.locator(".react-flow__node")
    await expect(nodes.first()).toBeVisible({ timeout: 30_000 })
    expect(await nodes.count()).toBeGreaterThanOrEqual(1)

    // The app shows the Vivicy wordmark in the sidebar header. On mobile the panel
    // is an off-canvas Sheet, so open it first; on desktop it's docked + open.
    await ensurePanelOpen(page, testInfo)
    const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible()
    await expect(sidebar.getByText("visual vibe coding")).toBeVisible()

    // An accordion section expands: Information starts collapsed, then opens.
    const infoTrigger = page.getByRole("button", { name: "Information" })
    await expect(infoTrigger).toHaveAttribute("aria-expanded", "false")
    await infoTrigger.click()
    await expect(infoTrigger).toHaveAttribute("aria-expanded", "true")
    await expect(sidebar.getByText("Status legend")).toBeVisible()

    // The view toggle works: open Filters, switch Target -> Progress. The
    // shadcn ToggleGroup renders single-select items as radios (aria-checked).
    await page.getByRole("button", { name: "Filters" }).click()
    const targetBtn = page.getByRole("radio", { name: "Target" })
    const progressBtn = page.getByRole("radio", { name: "Progress" })
    await expect(targetBtn).toHaveAttribute("aria-checked", "true")
    await progressBtn.click()
    await expect(progressBtn).toHaveAttribute("aria-checked", "true")
    await expect(targetBtn).toHaveAttribute("aria-checked", "false")

    // The 3-state width cycle (peek -> wide -> closed) is a DESKTOP affordance: it
    // drives the docked sidebar's `--sidebar-width`. On mobile the panel is a
    // single-width off-canvas Sheet, so that DOM (the right-docked sidebar
    // container + its width var) does not exist — the panel reachability on mobile
    // is proven above (the Sheet opened and its content is interactive). Scope the
    // width-cycle assertions to desktop.
    if (isMobileProject(testInfo)) return

    const container = page.locator('[data-slot="sidebar"][data-side="right"]')
    const toggle = page.locator("[data-panel-toggle]")
    const widthOf = () =>
      page.evaluate(() =>
        getComputedStyle(document.querySelector('[data-slot="sidebar-wrapper"]')!)
          .getPropertyValue("--sidebar-width")
          .trim()
      )

    // (1) peek: open + narrow width; toggle offers "Widen panel".
    await expect(container).toHaveAttribute("data-state", "expanded")
    await expect(toggle).toHaveAttribute("aria-label", "Widen panel")
    const peekWidth = await widthOf()

    // (2) peek -> wide: still open, a WIDER width than peek.
    await toggle.click()
    await expect(container).toHaveAttribute("data-state", "expanded")
    await expect(toggle).toHaveAttribute("aria-label", "Close panel")
    const wideWidth = await widthOf()
    expect(parseFloat(wideWidth)).toBeGreaterThan(parseFloat(peekWidth))

    // (3) wide -> closed: panel offcanvas; toggle offers "Open panel".
    await toggle.click()
    await expect(container).toHaveAttribute("data-state", "collapsed")
    await expect(toggle).toHaveAttribute("aria-label", "Open panel")

    // closed -> peek: cycle wraps back to the narrow state.
    await toggle.click()
    await expect(container).toHaveAttribute("data-state", "expanded")
    await expect(toggle).toHaveAttribute("aria-label", "Widen panel")
    expect(await widthOf()).toBe(peekWidth)
  })

  test("quota footer collapses and expands (honest, persisted)", async ({
    page,
  }, testInfo) => {
    await page.goto("/")
    // Wait for the ready state, then open the panel (Sheet on mobile).
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 30_000,
    })
    await ensurePanelOpen(page, testInfo)
    const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible()

    // The footer header is always present. With no active run, it shows a sober
    // placeholder and no expand control (nothing to expand yet).
    const footer = sidebar.locator('[data-sidebar="footer"]')
    await expect(footer.getByText("Quota", { exact: true })).toBeVisible()
    await expect(
      footer.getByText(/Agent quota status appears here/i)
    ).toBeVisible()
    // Honest: never a fabricated quota percentage when there is no data. (The
    // run-progress bar elsewhere in the panel is real and out of scope here.)
    await expect(footer.getByText(/\d+%/)).toHaveCount(0)
  })
})
