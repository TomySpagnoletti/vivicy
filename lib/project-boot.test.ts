import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { renormalizeManagedFiles } = vi.hoisted(() => ({ renormalizeManagedFiles: vi.fn() }))

vi.mock("@/lib/scaffold", async () => {
  const actual = await vi.importActual<typeof import("@/lib/scaffold")>("@/lib/scaffold")
  renormalizeManagedFiles.mockImplementation(actual.renormalizeManagedFiles)
  return { ...actual, renormalizeManagedFiles }
})

import { METHOD_MARKERS } from "@/lib/managed-block"
import { ensureProjectOpened } from "@/lib/project-boot"

const OPENED = Symbol.for("vivicy.project.opened")

let workDir: string
let prevFactoryRoot: string | undefined

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "vivicy-open-")))
  prevFactoryRoot = process.env.VIVICY_FACTORY_ROOT
  process.env.VIVICY_FACTORY_ROOT = path.resolve(process.cwd(), "factory")
  delete (globalThis as unknown as Record<symbol, boolean | undefined>)[OPENED]
  renormalizeManagedFiles.mockClear()
})

afterEach(() => {
  delete (globalThis as unknown as Record<symbol, boolean | undefined>)[OPENED]
  if (prevFactoryRoot === undefined) delete process.env.VIVICY_FACTORY_ROOT
  else process.env.VIVICY_FACTORY_ROOT = prevFactoryRoot
  rmSync(workDir, { recursive: true, force: true })
})

describe("ensureProjectOpened", () => {
  it("brings the repo's managed block to the current definition and keeps the owner's own bytes", () => {
    const target = path.join(workDir, "governed-before-the-block-moved")
    mkdirSync(path.join(target, ".vivicy"), { recursive: true })
    const ownerHead = "# Owner guide\n\nHouse rules above the managed block.\n\n"
    writeFileSync(
      path.join(target, "AGENTS.md"),
      `${ownerHead}${METHOD_MARKERS.begin}\nA thinner method contract from the pass that governed this repo.\n${METHOD_MARKERS.end}\n`
    )

    ensureProjectOpened(target)

    const agents = readFileSync(path.join(target, "AGENTS.md"), "utf8")
    expect(agents.startsWith(ownerHead)).toBe(true)
    expect(agents).not.toContain("A thinner method contract")
    expect(agents).toContain("A test must discriminate")
    expect(agents).toContain("smallest verified increments")
  })

  it("renormalizes ONCE per server, however many requests the process serves", () => {
    mkdirSync(path.join(workDir, ".vivicy"), { recursive: true })

    ensureProjectOpened(workDir)
    ensureProjectOpened(workDir)
    ensureProjectOpened(workDir)

    expect(renormalizeManagedFiles).toHaveBeenCalledTimes(1)
    expect(renormalizeManagedFiles).toHaveBeenCalledWith(workDir)
  })

  it("never lets a failed renormalization take the server down, and never retries it in the same process", () => {
    renormalizeManagedFiles.mockImplementationOnce(() => {
      throw new Error("EROFS: read-only file system")
    })

    expect(() => ensureProjectOpened(workDir)).not.toThrow()
    ensureProjectOpened(workDir)
    expect(renormalizeManagedFiles).toHaveBeenCalledTimes(1)
  })
})
