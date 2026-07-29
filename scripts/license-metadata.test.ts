import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { REPO_ROOT } from "./test-matrix"

const LICENSE_FILE = "LICENSE"
const ABBREVIATION_HEADING = "## Abbreviation"

function readRepoFile(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8")
}

function declaredIdentifier(): string {
  const lines = readRepoFile(LICENSE_FILE).split("\n")
  const heading = lines.indexOf(ABBREVIATION_HEADING)
  if (heading !== -1) {
    for (const line of lines.slice(heading + 1)) {
      if (line.startsWith("## ")) break
      const value = line.trim()
      if (value) return value
    }
  }
  throw new Error(
    `${LICENSE_FILE} names no identifier under "${ABBREVIATION_HEADING}" — the one source package.json and the README derive from`
  )
}

describe("the LICENSE text is the single source of the repo's license identity", () => {
  it("names its own identifier, so every other carrier has something to derive from", () => {
    expect(declaredIdentifier()).toMatch(/^[A-Za-z0-9.+-]+$/)
  })

  it("is what package.json declares, never a second opinion the tooling would read instead", () => {
    const manifest = JSON.parse(readRepoFile("package.json")) as { license?: string }
    expect(manifest.license).toBe(declaredIdentifier())
  })

  it("is what the README names, in a line linking to the file it summarizes", () => {
    expect(readRepoFile("README.md")).toContain(`[${declaredIdentifier()}](./${LICENSE_FILE})`)
  })
})
