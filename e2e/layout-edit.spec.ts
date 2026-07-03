import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { expect, test } from "@playwright/test"

import { DEMO_TARGET_ROOT } from "../playwright.config"

/**
 * Layout editing against the populated demo target (VIVICY_TARGET_ROOT=
 * /tmp/vivicy-demo). Toggles edit mode, drags a node, clicks Save, and asserts
 * the save round-trips through the real /api/architecture-map/layout route
 * (which patches the source yml and regenerates the served viewer data).
 *
 * The demo target is a committed git repo, so the source map and generated data
 * are snapshotted before the run and restored after — even on failure — so the
 * suite leaves it pristine. Serial: the single test mutates shared files.
 */
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
    // Restore the demo target to its committed bytes regardless of outcome.
    writeFileSync(MAP_YML, ymlSnapshot)
    writeFileSync(VIEWER_JSON, jsonSnapshot)
  })

  test("toggles edit mode, drags a node, and saves the layout to the source map", async ({
    page,
  }) => {
    await page.goto("/")

    // The map renders from the demo target.
    const nodes = page.locator(".react-flow__node")
    await expect(nodes.first()).toBeVisible({ timeout: 30_000 })

    // Read-only by default: the Edit-layout toggle is offered (not yet active)
    // and there is no Save control.
    const firstNode = nodes.first()
    await expect(page.getByRole("button", { name: "Edit layout" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Editing layout" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Save layout" })).toHaveCount(0)

    // Turn ON layout editing.
    const editToggle = page.getByRole("button", { name: "Edit layout" })
    await expect(editToggle).toBeVisible()
    await editToggle.click()
    await expect(page.getByRole("button", { name: "Editing layout" })).toBeVisible()

    // Drag the first node by a screen offset large enough to clear the snap grid.
    // React Flow's drag needs the pointer-down to register before the moves; under
    // CI/matrix load that init can occasionally be dropped, leaving the node
    // un-moved. Retry the whole drag until it BOTH marks the layout dirty (Save
    // appears) AND the node's on-screen position actually changed — a drag that
    // registers a click but nets zero movement can reveal Save yet leave the yml
    // byte-identical, so requiring a real positional delta here removes that flake
    // at its source rather than letting the later yml comparison fail. The position
    // is re-measured each attempt.
    const saveButton = page.getByRole("button", { name: "Save layout" })
    await expect(async () => {
      const before = await firstNode.boundingBox()
      if (!before) throw new Error("could not measure the node to drag")
      const startX = before.x + before.width / 2
      const startY = before.y + before.height / 2
      await page.mouse.move(startX, startY)
      await page.mouse.down()
      // A short settle so React Flow registers the drag start before the moves.
      await page.waitForTimeout(50)
      await page.mouse.move(startX + 90, startY + 70, { steps: 12 })
      await page.mouse.up()
      // The move must have marked the layout dirty, revealing Save...
      await expect(saveButton).toBeVisible({ timeout: 3_000 })
      // ...and actually shifted the node on screen (a real move, not a jiggle that
      // snaps back to the origin — that would reveal Save but not change the yml).
      const after = await firstNode.boundingBox()
      if (!after) throw new Error("could not re-measure the node after the drag")
      const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y)
      expect(moved, "the node did not move on screen after the drag").toBeGreaterThan(10)
    }).toPass({ timeout: 30_000 })

    await saveButton.click()

    // The save succeeds: the status flips to "Saved" and no error is shown.
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/Save failed/i)).toHaveCount(0)

    // The source map on disk now carries the moved coordinates: it differs from
    // the committed snapshot but is still a well-formed map (node/edge counts
    // unchanged), proving the patch hit the real yml, not a shadow copy.
    const patched = readFileSync(MAP_YML, "utf8")
    expect(patched).not.toBe(ymlSnapshot)
    const countNodes = (s: string) => (s.match(/^ {2}- id:/gm) ?? []).length
    expect(countNodes(patched)).toBe(countNodes(ymlSnapshot))
  })
})
