import { expect, test } from "./browser-issues"

test.describe("Vivicy onboarding (no architecture map)", () => {
  test("renders the no-map onboarding state without a raw error", async ({
    page,
  }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (err) => pageErrors.push(err.message))

    await page.goto("/")

    const card = page.locator('[data-empty-reason="no_map"]')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByText("No issues extracted yet", { exact: true })
    ).toBeVisible()
    await expect(
      page.getByText(/authors the full plan/i)
    ).toBeVisible()

    await expect(
      page.getByRole("button", { name: /Extract from docs/i })
    ).toBeVisible()

    await expect(page.locator(".react-flow__node")).toHaveCount(0)
    await expect(
      page.getByText(/architecture map not found/i)
    ).toHaveCount(0)
    await expect(page.getByText(/Request failed/i)).toHaveCount(0)

    expect(pageErrors).toEqual([])
  })
})
