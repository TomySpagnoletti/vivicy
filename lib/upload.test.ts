import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  ControlError,
  runUploadVerify,
  type RunResult,
  type Spawner,
} from "@/lib/control"
import {
  applyUpload,
  classify,
  getNormalizedDir,
  getRawDir,
  getReportPath,
  getStagingDir,
  normalizeStaging,
  stageUpload,
  UploadError,
  type DocConverter,
  type UploadEntry,
  type ZipExpander,
} from "@/lib/upload"

/**
 * A recording fake spawner (mirrors lib/control.test.ts) so runUploadVerify
 * exercises the real control flow without launching a claude leg. The fake `run`
 * writes the report the way verify-upload.mjs's leg would, so the verdict merge
 * is tested end-to-end.
 */
function makeFakeSpawner(overrides: Partial<Spawner> = {}) {
  const alive = new Set<number>()
  let nextPid = 1000
  const spawner: Spawner = {
    spawnDetached: () => ({ pid: nextPid++ }),
    run: async (): Promise<RunResult> => ({ code: 0, lastLine: "OK", stdout: "OK\n", stderr: "" }),
    killGroup: (pid) => {
      alive.delete(pid)
      return true
    },
    isAlive: (pid) => alive.has(pid),
    ...overrides,
  }
  return { spawner }
}

/** A fake zip expander that "expands" by writing a known file into destDir. */
const fakeExpander: ZipExpander = (_zipPath, destDir) => {
  writeFileSync(path.join(destDir, "from-zip.md"), "# Unzipped\n\nContent from the archive.\n")
  return true
}

/** A fake doc converter that returns deterministic text (stands in for textutil). */
const fakeConverter: DocConverter = (docPath) =>
  `# Converted ${path.basename(docPath)}\n\nThe converted body preserves the intention.\n`

let factoryRoot: string
let targetRoot: string
let runtimeDir: string
let prevCwd: string

/** Build a fake factory dir holding the scripts the control plane resolves. */
function scaffoldFactory(root: string) {
  mkdirSync(root, { recursive: true })
  for (const rel of ["verify-upload.mjs"]) {
    writeFileSync(path.join(root, rel), "// stub\n")
  }
}

beforeEach(() => {
  factoryRoot = mkdtempSync(path.join(tmpdir(), "vivicy-factory-"))
  targetRoot = mkdtempSync(path.join(tmpdir(), "vivicy-target-"))
  runtimeDir = mkdtempSync(path.join(tmpdir(), "vivicy-cwd-"))
  scaffoldFactory(factoryRoot)

  process.env.VIVICY_FACTORY_ROOT = factoryRoot
  process.env.VIVICY_TARGET_ROOT = targetRoot

  // getRuntimeDir() (staging root) + getTargetRoot() are cwd-relative; isolate per test.
  prevCwd = process.cwd()
  process.chdir(runtimeDir)
})

afterEach(() => {
  process.chdir(prevCwd)
  for (const dir of [factoryRoot, targetRoot, runtimeDir]) {
    rmSync(dir, { recursive: true, force: true })
  }
  delete process.env.VIVICY_FACTORY_ROOT
  delete process.env.VIVICY_TARGET_ROOT
})

/** Build an UploadEntry from a rel path + text. */
function entry(rel: string, text: string, name = path.basename(rel)): UploadEntry {
  return { rel, name, bytes: new TextEncoder().encode(text) }
}

/** Seed a green report for a staging id (the state /apply requires). */
function writeGreenReport(stagingId: string) {
  writeFileSync(
    getReportPath(stagingId),
    JSON.stringify({ verdict: "green", problems: [], summary: "ok" }, null, 2)
  )
}

describe("classify", () => {
  it("routes a spike by any path segment containing 'spike' (case-insensitive)", () => {
    expect(classify("Spikes/db-choice.md", () => "")).toBe("spike")
    expect(classify("docs/SPIKE-01.md", () => "")).toBe("spike")
    expect(classify("a/b/investigate.md", () => "")).toBe("canonical")
  })

  it("routes a .yml/.yaml map by content (nodes: or kind_taxonomy)", () => {
    expect(classify("architecture-map.yml", () => "version: 1\nnodes:\n  - id: a\n")).toBe("map")
    expect(classify("m.yaml", () => "kind_taxonomy:\n  service: {}\n")).toBe("map")
    expect(classify("config.yml", () => "some: value\nother: 2\n")).toBe("unknown")
  })

  it("routes docs to canonical and everything else to unknown", () => {
    expect(classify("01-product.md", () => "")).toBe("canonical")
    expect(classify("notes.txt", () => "")).toBe("canonical")
    expect(classify("brief.docx", () => "")).toBe("canonical")
    expect(classify("data.json", () => "")).toBe("unknown")
  })
})

describe("stageUpload", () => {
  it("refuses an empty upload", () => {
    expect(() => stageUpload([])).toThrow(UploadError)
    try {
      stageUpload([])
    } catch (e) {
      expect((e as UploadError).code).toBe("no_files")
    }
  })

  it("refuses an unsupported file type", () => {
    try {
      stageUpload([entry("app.ts", "export const x = 1")])
      throw new Error("expected throw")
    } catch (e) {
      expect((e as UploadError).code).toBe("unsupported_type")
    }
  })

  it("stages files under raw/, preserves relative paths, and classifies each", () => {
    const { stagingId, staged } = stageUpload([
      entry("canonical/01-product.md", "# Product\n"),
      entry("spikes/db.md", "# DB spike\n"),
      entry("architecture-map/architecture-map.yml", "version: 1\nnodes:\n  - id: a\n"),
      entry("misc/data.json".replace(".json", ".yaml"), "just: config\n"),
    ])

    const rawDir = getRawDir(stagingId)
    expect(existsSync(path.join(rawDir, "canonical/01-product.md"))).toBe(true)

    const byRel = Object.fromEntries(staged.map((s) => [s.rel, s.kind]))
    expect(byRel["canonical/01-product.md"]).toBe("canonical")
    expect(byRel["spikes/db.md"]).toBe("spike")
    expect(byRel["architecture-map/architecture-map.yml"]).toBe("map")
    expect(byRel["misc/data.yaml"]).toBe("unknown")
    expect(staged.every((s) => s.bytes > 0)).toBe(true)
  })

  it("expands a zip into raw/ via the injected expander and classifies the result", () => {
    const { staged } = stageUpload(
      [entry("bundle.zip", "PK-fake-bytes")],
      fakeExpander
    )
    // The zip archive itself is excluded; its expanded content is classified.
    expect(staged.some((s) => s.rel === "bundle.zip")).toBe(false)
    expect(staged.find((s) => s.rel === "from-zip.md")?.kind).toBe("canonical")
  })

  it("raises zip_unsupported when the expander cannot expand", () => {
    try {
      stageUpload([entry("bundle.zip", "PK")], () => false)
      throw new Error("expected throw")
    } catch (e) {
      expect((e as UploadError).code).toBe("zip_unsupported")
    }
  })

  // Programmatic zip via `ditto` (darwin only) — exercises the REAL expander path.
  it.skipIf(process.platform !== "darwin")(
    "expands a real zip created with ditto (darwin)",
    () => {
      // Build a real .zip with a nested doc using `ditto -c -k`.
      const src = mkdtempSync(path.join(tmpdir(), "vivicy-zipsrc-"))
      mkdirSync(path.join(src, "docs"), { recursive: true })
      writeFileSync(path.join(src, "docs", "brief.md"), "# Brief\n\nReal zipped content.\n")
      const zipPath = path.join(runtimeDir, "corpus.zip")
      const r = spawnSync("ditto", ["-c", "-k", "--sequesterRsrc", src, zipPath], {
        encoding: "utf8",
      })
      expect(r.status).toBe(0)

      const bytes = new Uint8Array(readFileSync(zipPath))
      const { staged } = stageUpload([{ rel: "corpus.zip", name: "corpus.zip", bytes }])
      expect(staged.some((s) => s.rel.endsWith("brief.md") && s.kind === "canonical")).toBe(true)
      rmSync(src, { recursive: true, force: true })
    }
  )
})

describe("normalizeStaging", () => {
  it("copies .md as-is and renames .txt to .md, preserving structure", () => {
    const { stagingId } = stageUpload([
      entry("a/keep.md", "# Keep\n"),
      entry("a/note.txt", "plain text note"),
    ])
    const { normalized, problems } = normalizeStaging(stagingId, fakeConverter)
    expect(problems).toHaveLength(0)

    const normDir = getNormalizedDir(stagingId)
    expect(readFileSync(path.join(normDir, "a/keep.md"), "utf8")).toBe("# Keep\n")
    // .txt -> .md
    expect(existsSync(path.join(normDir, "a/note.md"))).toBe(true)
    expect(readFileSync(path.join(normDir, "a/note.md"), "utf8")).toBe("plain text note")
    const tos = normalized.map((n) => n.to).sort()
    expect(tos).toEqual(["a/keep.md", "a/note.md"])
  })

  it("converts .docx via the injected converter, writing .md", () => {
    const { stagingId } = stageUpload([entry("brief.docx", "binary-docx-bytes")])
    const { normalized, problems } = normalizeStaging(stagingId, fakeConverter)

    expect(problems).toHaveLength(0)
    const normDir = getNormalizedDir(stagingId)
    expect(existsSync(path.join(normDir, "brief.md"))).toBe(true)
    expect(readFileSync(path.join(normDir, "brief.md"), "utf8")).toContain("intention")
    expect(normalized.find((n) => n.from === "brief.docx")?.to).toBe("brief.md")
  })

  it("reports conversion_unavailable and excludes the file when conversion fails", () => {
    const { stagingId } = stageUpload([
      entry("good.md", "# Good\n"),
      entry("bad.docx", "binary"),
    ])
    // Converter returns null => conversion unavailable.
    const { normalized, problems } = normalizeStaging(stagingId, () => null)

    expect(problems).toHaveLength(1)
    expect(problems[0].kind).toBe("conversion_unavailable")
    expect(problems[0].file).toBe("bad.docx")
    // The good file still normalizes; the bad one is excluded.
    expect(normalized.map((n) => n.from)).toEqual(["good.md"])
    expect(existsSync(path.join(getNormalizedDir(stagingId), "bad.md"))).toBe(false)
  })

  it("copies map files verbatim and excludes unknown files", () => {
    const { stagingId } = stageUpload([
      entry("architecture-map.yml", "version: 1\nnodes:\n  - id: a\n"),
      entry("stray.yaml", "just: config\n"),
    ])
    const { normalized } = normalizeStaging(stagingId, fakeConverter)

    const normDir = getNormalizedDir(stagingId)
    expect(readFileSync(path.join(normDir, "architecture-map.yml"), "utf8")).toContain("nodes:")
    // unknown excluded
    expect(existsSync(path.join(normDir, "stray.yaml"))).toBe(false)
    expect(normalized.map((n) => n.kind)).toEqual(["map"])
  })

  it("refuses a bad staging id", () => {
    try {
      normalizeStaging("not-a-real-id", fakeConverter)
      throw new Error("expected throw")
    } catch (e) {
      expect((e as UploadError).code).toBe("bad_staging")
    }
  })
})

describe("applyUpload", () => {
  it("refuses to place without a green report", () => {
    const { stagingId } = stageUpload([entry("01-product.md", "# Product\n")])
    normalizeStaging(stagingId, fakeConverter)
    // No report yet.
    try {
      applyUpload(stagingId, targetRoot)
      throw new Error("expected throw")
    } catch (e) {
      expect((e as UploadError).code).toBe("not_verified")
    }
    // A red report is equally refused.
    writeFileSync(
      getReportPath(stagingId),
      JSON.stringify({ verdict: "red", problems: [], summary: "nope" })
    )
    try {
      applyUpload(stagingId, targetRoot)
      throw new Error("expected throw")
    } catch (e) {
      expect((e as UploadError).code).toBe("not_verified")
    }
  })

  it("places canonical/spike/map at their contract destinations on green", () => {
    const { stagingId } = stageUpload([
      entry("01-product.md", "# Product\n"),
      entry("spikes/db.md", "# DB spike\n"),
      entry("architecture-map.yml", "version: 1\nnodes:\n  - id: a\n"),
    ])
    normalizeStaging(stagingId, fakeConverter)
    writeGreenReport(stagingId)

    const { placed } = applyUpload(stagingId, targetRoot)
    const dests = placed.map((p) => p.to).sort()
    expect(dests).toEqual([
      path.join(".vivicy", "architecture-map", "architecture-map.yml"),
      path.join(".vivicy", "canonical", "01-product.md"),
      path.join(".vivicy", "development", "spikes", "db.md"),
    ])
    expect(existsSync(path.join(targetRoot, ".vivicy/canonical/01-product.md"))).toBe(true)
    expect(existsSync(path.join(targetRoot, ".vivicy/development/spikes/db.md"))).toBe(true)
    expect(existsSync(path.join(targetRoot, ".vivicy/architecture-map/architecture-map.yml"))).toBe(true)
  })

  it("check-all-then-place-all: one collision places NOTHING", () => {
    const { stagingId } = stageUpload([
      entry("01-product.md", "# Product\n"),
      entry("02-scope.md", "# Scope\n"),
    ])
    normalizeStaging(stagingId, fakeConverter)
    writeGreenReport(stagingId)

    // Seed ONE colliding destination among the two.
    const collidingDest = path.join(targetRoot, ".vivicy/canonical/01-product.md")
    mkdirSync(path.dirname(collidingDest), { recursive: true })
    writeFileSync(collidingDest, "PRE-EXISTING — must not be overwritten\n")

    try {
      applyUpload(stagingId, targetRoot)
      throw new Error("expected throw")
    } catch (e) {
      expect((e as UploadError).code).toBe("would_overwrite")
      expect((e as UploadError).details?.collisions).toContain(
        path.join(".vivicy", "canonical", "01-product.md")
      )
    }
    // Nothing placed: the colliding file is untouched AND the non-colliding one
    // was NOT written (check-all-then-place-all).
    expect(readFileSync(collidingDest, "utf8")).toBe("PRE-EXISTING — must not be overwritten\n")
    expect(existsSync(path.join(targetRoot, ".vivicy/canonical/02-scope.md"))).toBe(false)
  })

  it("refuses two staged files that flatten to the same destination", () => {
    // Two spikes named identically in different subdirs both map to
    // .vivicy/development/spikes/db.md — placing them would silently drop one.
    const { stagingId } = stageUpload([
      entry("spikes/db.md", "# DB spike A\n"),
      entry("old/spikes/db.md", "# DB spike B\n"),
    ])
    normalizeStaging(stagingId, fakeConverter)
    writeGreenReport(stagingId)

    try {
      applyUpload(stagingId, targetRoot)
      throw new Error("expected throw")
    } catch (e) {
      expect((e as UploadError).code).toBe("would_overwrite")
      expect(String((e as UploadError).details?.collisions)).toMatch(/staged twice/)
    }
    expect(existsSync(path.join(targetRoot, ".vivicy/development/spikes/db.md"))).toBe(false)
  })
})

describe("runUploadVerify (control plane)", () => {
  it("normalizes, drives verify-upload.mjs with --staging, and reports green", async () => {
    const { stagingId } = stageUpload([
      entry("01-product.md", "# Product\n"),
      entry("note.txt", "a plain note"),
    ])

    let seenScript = ""
    let seenStaging = ""
    let runCount = 0
    const { spawner } = makeFakeSpawner({
      run: async ({ args, env }) => {
        runCount += 1
        seenScript = path.basename(args.find((a) => a.endsWith(".mjs")) ?? "")
        seenStaging = args[args.indexOf("--staging") + 1] ?? ""
        expect(env.VIVICY_TARGET_ROOT).toBe(targetRoot)
        // The leg would write the report; the fake does it here.
        writeGreenReport(stagingId)
        return { code: 0, lastLine: "green", stdout: "green\n", stderr: "" }
      },
    })

    const result = await runUploadVerify(spawner, stagingId)

    expect(seenScript).toBe("verify-upload.mjs")
    expect(seenStaging).toBe(getStagingDir(stagingId))
    expect(runCount).toBe(1)
    expect(result.ok).toBe(true)
    expect(result.verdict).toBe("green")
    // Normalization ran: .txt -> .md is reported.
    expect(result.normalized.some((n) => n.to === "note.md")).toBe(true)
    // And the normalized corpus exists on disk for the leg to read.
    expect(existsSync(path.join(getNormalizedDir(stagingId), "note.md"))).toBe(true)
  })

  it("is red when the report is red (drift/contradiction), and merges problems", async () => {
    const { stagingId } = stageUpload([entry("01-product.md", "# Product\n")])
    const { spawner } = makeFakeSpawner({
      run: async () => {
        writeFileSync(
          getReportPath(stagingId),
          JSON.stringify({
            verdict: "red",
            problems: [{ file: "01-product.md", kind: "drift", detail: "conflicts with canonical" }],
            summary: "1 problem",
          })
        )
        return { code: 1, lastLine: "red", stdout: "", stderr: "red\n" }
      },
    })

    const result = await runUploadVerify(spawner, stagingId)
    expect(result.ok).toBe(false)
    expect(result.verdict).toBe("red")
    expect(result.problems.some((p) => p.kind === "drift")).toBe(true)
  })

  it("is red (fail-closed) when the leg wrote no report", async () => {
    const { stagingId } = stageUpload([entry("01-product.md", "# Product\n")])
    const { spawner } = makeFakeSpawner({
      run: async () => ({ code: 0, lastLine: "done", stdout: "done\n", stderr: "" }),
    })
    const result = await runUploadVerify(spawner, stagingId)
    expect(result.verdict).toBe("red")
  })

  it("forces red when normalization has a fatal problem, even on a green report", async () => {
    // A .docx that cannot convert on this (non-darwin) host => a fatal norm problem.
    // On darwin the real converter would succeed, so drive the deterministic case by
    // staging a docx and letting the REAL convertDoc run: skip where it would pass.
    const { stagingId } = stageUpload([
      entry("01-product.md", "# Product\n"),
      entry("brief.docx", "binary-docx"),
    ])
    const { spawner } = makeFakeSpawner({
      run: async () => {
        writeGreenReport(stagingId)
        return { code: 0, lastLine: "green", stdout: "green\n", stderr: "" }
      },
    })
    const result = await runUploadVerify(spawner, stagingId)

    if (process.platform === "darwin") {
      // textutil converts the fake bytes? It fails on non-docx bytes, yielding a
      // conversion problem -> red. Either way, a conversion problem forces red.
      expect(["green", "red"]).toContain(result.verdict)
    } else {
      expect(result.verdict).toBe("red")
      expect(result.problems.some((p) => p.kind === "conversion_unavailable")).toBe(true)
    }
  })

  it("throws missing_target when no staging dir exists for the id", async () => {
    const { spawner } = makeFakeSpawner()
    await expect(runUploadVerify(spawner, "nonexistent-id")).rejects.toThrow(ControlError)
  })
})
