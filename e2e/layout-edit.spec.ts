import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { expect, test } from "./browser-issues"

import { DEMO_TARGET_ROOT } from "../playwright.config"

// Demo target is a committed git repo; snapshot/restore keeps it pristine. Serial: the test mutates shared files.
test.describe.configure({ mode: "serial" })

const MAP_YML = path.join(
  DEMO_TARGET_ROOT,
  ".vivicy/architecture-map/architecture-map.yml"
)
const VIEWER_JSON = path.join(
  DEMO_TARGET_ROOT,
  ".vivicy/architecture-map/architecture-data.json"
)

test.describe("Architecture map layout editing", () => {
  let ymlSnapshot = ""
  let jsonSnapshot = ""

  test.beforeAll(() => {
    ymlSnapshot = readFileSync(MAP_YML, "utf8")
    jsonSnapshot = readFileSync(VIEWER_JSON, "utf8")
  })

  test.afterAll(() => {
    writeFileSync(MAP_YML, ymlSnapshot)
    writeFileSync(VIEWER_JSON, jsonSnapshot)
  })

  test("toggles edit mode, drags a node, and saves the layout to the source map", async ({
    page,
  }) => {
    await page.goto("/")

    const nodes = page.locator(".react-flow__node")
    await expect(nodes.first()).toBeVisible({ timeout: 30_000 })

    const firstNode = nodes.first()
    await expect(page.getByRole("button", { name: "Edit layout" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Editing layout" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Save layout" })).toHaveCount(0)

    const editToggle = page.getByRole("button", { name: "Edit layout" })
    await expect(editToggle).toBeVisible()
    await editToggle.click()
    await expect(page.getByRole("button", { name: "Editing layout" })).toBeVisible()

    // Offset must clear the snap grid or the drag registers as a no-op.
    const saveButton = page.getByRole("button", { name: "Save layout" })
    await expect(async () => {
      const before = await firstNode.boundingBox()
      if (!before) throw new Error("could not measure the node to drag")
      const startX = before.x + before.width / 2
      const startY = before.y + before.height / 2
      await page.mouse.move(startX, startY)
      await page.mouse.down()
      // Settle so React Flow registers drag-start before the moves.
      await page.waitForTimeout(50)
      await page.mouse.move(startX + 90, startY + 70, { steps: 12 })
      await page.mouse.up()
      await expect(saveButton).toBeVisible({ timeout: 3_000 })
      const after = await firstNode.boundingBox()
      if (!after) throw new Error("could not re-measure the node after the drag")
      const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y)
      expect(moved, "the node did not move on screen after the drag").toBeGreaterThan(10)
    }).toPass({ timeout: 30_000 })

    await saveButton.click()

    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/Save failed/i)).toHaveCount(0)

    const patched = readFileSync(MAP_YML, "utf8")
    expect(patched).not.toBe(ymlSnapshot)
    const countNodes = (s: string) => (s.match(/^ {2}- id:/gm) ?? []).length
    expect(countNodes(patched)).toBe(countNodes(ymlSnapshot))
  })
})
