import { readFile } from "node:fs/promises"
import path from "node:path"

import tailwind from "@tailwindcss/postcss"
import postcss from "postcss"
import { beforeAll, describe, expect, it } from "vitest"

import { REPO_ROOT } from "@/scripts/test-matrix"

const STYLESHEET = path.join(REPO_ROOT, "app/globals.css")
const PROBE_FROM = path.join(REPO_ROOT, "app", "globals.probe.css")
const DARK_VARIANT_LINE = /^@custom-variant dark .*\n/m
const TEST_CODE_EXCLUSION = '@source not "../**/*.{test,spec}.{ts,tsx}";'
const PROSE_EXCLUSION = '@source not "../**/*.md";'
const TEST_ONLY_CLASS = "bg-blue-500"
const TEST_ONLY_CLASS_SOURCE = "lib/utils.test.ts"
const PROSE_ONLY_CLASS = "bg-fuchsia-500"
const PROSE_ONLY_CLASS_SOURCE = "AGENTS.md"

async function emitted(stylesheet: string): Promise<string> {
  const { css } = await postcss([tailwind({ base: REPO_ROOT, optimize: false })]).process(stylesheet, { from: PROBE_FROM })
  return css
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function without(exclusion: string): string {
  const stripped = source.replace(`${exclusion}\n`, "")
  expect(stripped, `app/globals.css must carry \`${exclusion}\``).not.toBe(source)
  return stripped
}

let source: string
let css: string

beforeAll(async () => {
  source = await readFile(STYLESHEET, "utf8")
  css = await emitted(source)
})

describe("the app renders light-only, whatever the OS colour-scheme preference", () => {
  it("emits not one dark colour-scheme media query", () => {
    expect(occurrences(css, "prefers-color-scheme")).toBe(0)
  })

  it("emits no `dark:` utility rule — shadcn's defaults are swept, not merely inert", () => {
    expect(css).not.toMatch(/\.dark\\:/)
  })

  it("declares the root colour-scheme light, so form controls and scrollbars never auto-darken", () => {
    expect(css).toMatch(/:root \{\n\s*color-scheme: light;/)
  })

  it("owes that silence to the dark-variant redefinition: restoring Tailwind's default brings the media queries back", async () => {
    const withoutRedefinition = source.replace(DARK_VARIANT_LINE, "")
    expect(withoutRedefinition, "app/globals.css must carry the @custom-variant dark redefinition").not.toBe(source)
    expect(occurrences(await emitted(withoutRedefinition), "@media (prefers-color-scheme: dark)")).toBeGreaterThan(0)
  })

  it("gates a `dark:` utility the tree does not carry yet on a class, never on the OS preference", async () => {
    const withFutureUtility = await emitted(`${source}\n@source inline("dark:bg-red-500");\n`)
    const rule = withFutureUtility.indexOf(".dark\\:bg-red-500")
    expect(rule, "@source inline must have generated the utility").toBeGreaterThan(-1)
    expect(withFutureUtility.slice(rule, rule + 200)).toContain("&:where(.dark, .dark *)")
    expect(occurrences(withFutureUtility, "prefers-color-scheme")).toBe(0)
  })
})

describe("the stylesheet compiles from rendered sources only, never from test code or prose", () => {
  it("a class whose sole author is a test file never reaches production CSS", async () => {
    const witnessSource = await readFile(path.join(REPO_ROOT, TEST_ONLY_CLASS_SOURCE), "utf8")
    expect(
      witnessSource,
      `${TEST_ONLY_CLASS_SOURCE} no longer writes \`${TEST_ONLY_CLASS}\` — pick another class written only by a test file outside app/`
    ).toContain(TEST_ONLY_CLASS)
    expect(css).not.toContain(`.${TEST_ONLY_CLASS}`)
    expect(await emitted(without(TEST_CODE_EXCLUSION))).toContain(`.${TEST_ONLY_CLASS}`)
  })

  it("a utility class spelled in tracked prose reaches no rule, root-level markdown included", async () => {
    const witnessSource = await readFile(path.join(REPO_ROOT, PROSE_ONLY_CLASS_SOURCE), "utf8")
    expect(
      witnessSource,
      `${PROSE_ONLY_CLASS_SOURCE} no longer spells \`${PROSE_ONLY_CLASS}\` — restore the planted witness in its Tailwind structural-invariant entry`
    ).toContain(PROSE_ONLY_CLASS)
    expect(css).not.toContain(`.${PROSE_ONLY_CLASS}`)
    expect(await emitted(without(PROSE_EXCLUSION))).toContain(`.${PROSE_ONLY_CLASS}`)
  })
})
