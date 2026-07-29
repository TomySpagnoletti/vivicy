import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { ESLint } from "eslint"
import { afterAll, describe, expect, it } from "vitest"
import { resolveConfig } from "vitest/node"

import { computeBehaviorFingerprint, REPO_ROOT } from "./test-matrix"

const NESTED_CHECKOUTS = [
  { root: ".claude", phantom: ".claude/worktrees/f000" },
  { root: ".vivicy-worktrees", phantom: ".vivicy-worktrees/ISSUE-0001" },
]
const LINTED_SOURCE_FILE = "lib/map-data.ts"
const roots: string[] = []

function syntheticRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "vivicy-nested-checkout-"))
  roots.push(root)
  return root
}

function seed(root: string, rel: string, body: string): void {
  mkdirSync(path.join(root, path.dirname(rel)), { recursive: true })
  writeFileSync(path.join(root, rel), body)
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("nested checkouts are invisible to the repo's file-discovering tools", () => {
  it("eslint.config.mjs ignores lintable files inside a nested checkout, and still lints the real tree", async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT })
    for (const { phantom } of NESTED_CHECKOUTS) {
      const file = `${phantom}/${LINTED_SOURCE_FILE}`
      expect(await eslint.isPathIgnored(file), `${file} must not reach the lint gate`).toBe(true)
    }
    expect(await eslint.isPathIgnored(LINTED_SOURCE_FILE)).toBe(false)
  })

  it("vitest.config.ts resolves to a repo-wide test glob that excludes both nested checkouts", async () => {
    const { vitestConfig } = await resolveConfig({ root: REPO_ROOT, config: path.join(REPO_ROOT, "vitest.config.ts") })
    expect(vitestConfig.include, "discovery reaches every directory, so only the exclude keeps phantom copies out").toContain("**/*.test.ts")
    for (const { root } of NESTED_CHECKOUTS) {
      expect(vitestConfig.exclude, `**/${root}/** must stay in the resolved exclude`).toContain(`**/${root}/**`)
    }
  })

  it("the matrix behavior fingerprint is blind to a nested checkout of the whole tree", () => {
    const root = syntheticRoot()
    seed(root, "lib/thing.ts", "export const thing = 1\n")
    const clean = computeBehaviorFingerprint(root)
    for (const { phantom } of NESTED_CHECKOUTS) {
      seed(root, `${phantom}/lib/thing.ts`, "export const thing = 2\n")
      seed(root, `lib/${phantom}/lib/thing.ts`, "export const thing = 3\n")
    }
    expect(computeBehaviorFingerprint(root)).toBe(clean)
    seed(root, "lib/other.ts", "export const other = 4\n")
    expect(computeBehaviorFingerprint(root)).not.toBe(clean)
  })
})
