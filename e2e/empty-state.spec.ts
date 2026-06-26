import { expect, test } from "@playwright/test"

/**
 * Points the app at a target that has docs/ but no architecture-data.json (the
 * `empty` project + no-map server, wired in playwright.config). Asserts the
 * onboarding state renders cleanly: no crash, no raw 404 / error text, and the
 * "No issues extracted yet" guidance + Extract affordance are present.
 */
test.describe("Vivicy onboarding (no architecture map)", () => {
  test("renders the no-map onboarding state without a raw error", async ({
    page,
  }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (err) => pageErrors.push(err.message))

    await page.goto("/")

    // The onboarding card renders the no-map guidance.
    const card = page.locator('[data-empty-reason="no_map"]')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByText("No issues extracted yet", { exact: true })
    ).toBeVisible()
    await expect(
      page.getByText(/authors the full plan/i)
    ).toBeVisible()

    // The Extract affordance is offered from the onboarding card.
    await expect(
      page.getByRole("button", { name: /Extract from docs/i })
    ).toBeVisible()

    // No graph is rendered, and crucially no raw error surfaced: the old route
    // 404'd with "architecture map not found" — that text must be gone.
    await expect(page.locator(".react-flow__node")).toHaveCount(0)
    await expect(
      page.getByText(/architecture map not found/i)
    ).toHaveCount(0)
    await expect(page.getByText(/Request failed/i)).toHaveCount(0)

    // The page did not throw at runtime.
    expect(pageErrors).toEqual([])
  })
})
