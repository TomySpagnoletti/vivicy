import { expect, test } from "@playwright/test"

test.describe("Vivicy architecture map viewer", () => {
  test("renders the map and the interactive shadcn sidebar shell", async ({
    page,
  }) => {
    await page.goto("/")

    // The app loads and shows the Vivicy wordmark in the sidebar header.
    const sidebar = page.getByRole("complementary", { name: "Vivicy panel" })
    await expect(sidebar.getByText("Vivicy", { exact: true })).toBeVisible()
    await expect(sidebar.getByText("visual vibe coding")).toBeVisible()

    // The map renders at least one node.
    const nodes = page.locator(".react-flow__node")
    await expect(nodes.first()).toBeVisible({ timeout: 30_000 })
    expect(await nodes.count()).toBeGreaterThanOrEqual(1)

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

    // The shadcn Sidebar collapses offcanvas and re-expands via the trigger.
    // The container stays in the DOM, so assert its data-state rather than
    // visibility.
    const container = page.locator('[data-slot="sidebar"][data-side="right"]')
    await expect(container).toHaveAttribute("data-state", "expanded")
    await page.getByRole("button", { name: "Collapse panel" }).click()
    await expect(container).toHaveAttribute("data-state", "collapsed")
    await page.getByRole("button", { name: "Expand panel" }).click()
    await expect(container).toHaveAttribute("data-state", "expanded")
  })
})
