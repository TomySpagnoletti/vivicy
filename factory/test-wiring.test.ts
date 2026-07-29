import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"

import { FACTORY_DIR } from "./target-root.ts"

const REPO_ROOT = resolve(FACTORY_DIR, "..")

// vitest's factory exclude is a top-level-only glob, so a test file in a factory SUBdirectory is picked up by vitest and can never be an orphan — this read matches that glob's depth.
function testFilesOnDisk(): string[] {
  return readdirSync(FACTORY_DIR)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
}

function nodeTestFiles(): string[] {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> }
  const script = pkg.scripts?.["factory:test"]
  assert.ok(script, 'package.json carries no "factory:test" script — the node --test half of the factory gate is gone')
  return script.split(/\s+/).flatMap((token) => {
    const file = /^factory\/([^/]+\.test\.ts)$/.exec(token)
    return file ? [file[1]] : []
  })
}

function vitestFiles(): string[] {
  const config = readFileSync(resolve(REPO_ROOT, "vitest.config.ts"), "utf8")
  const factoryPatterns = [...config.matchAll(/"(factory\/[^"]+)"/g)].map((match) => match[1])
  assert.equal(
    factoryPatterns.length,
    1,
    `vitest.config.ts must carry exactly one factory glob (saw: ${factoryPatterns.join(", ") || "none"}) — this guard reads it to know which factory tests vitest still runs`
  )
  const carveOut = /^factory\/!\(([^)]+)\)\.test\.ts$/.exec(factoryPatterns[0])
  assert.ok(
    carveOut,
    `the vitest factory exclude changed shape ("${factoryPatterns[0]}") — this guard reads the "factory/!(<stem>|<stem>).test.ts" negation, and refuses to guess which factory tests vitest runs`
  )
  return carveOut[1]
    .split("|")
    .map((stem) => `${stem}.test.ts`)
    .sort()
}

test("every factory *.test.ts is executed by exactly one runner", () => {
  const onDisk = testFilesOnDisk()
  const underNode = nodeTestFiles()
  const underVitest = vitestFiles()

  assert.deepEqual(
    underNode.filter((name, index) => underNode.indexOf(name) !== index),
    [],
    'package.json "factory:test" lists the same file twice — node --test would run it twice'
  )

  const wired = new Set([...underNode, ...underVitest])
  assert.deepEqual(
    onDisk.filter((name) => !wired.has(name)),
    [],
    'factory test file(s) run in NO gate: add each to the "factory:test" file list in package.json, or — if it is written against the vitest API — to the carve-out in vitest.config.ts'
  )

  assert.deepEqual(
    [...underNode, ...underVitest].filter((name) => !onDisk.includes(name)),
    [],
    "a runner still names a factory test file that is not on disk — a renamed or deleted test left its wiring behind"
  )

  assert.deepEqual(
    underNode.filter((name) => underVitest.includes(name)),
    [],
    "a factory test file is wired into BOTH node --test and vitest — it would run twice, under two runners"
  )
})
