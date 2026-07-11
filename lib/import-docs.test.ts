import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { strToU8, zipSync } from "fflate"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  dominantLanguage,
  importDocuments,
  importIntoGoverned,
  mintBatchId,
  UPLOADS_DIR,
  type BatchManifest,
  type RawEntry,
} from "@/lib/import-docs"
import { readNotifications } from "@/lib/notifications"
import { isGovernedRoot } from "@/lib/project"

let workDir: string
let prevCwd: string
let prevRuntime: string | undefined
let prevFactoryRoot: string | undefined
let prevTarget: string | undefined

const ENGLISH = "The quick brown fox jumps over the lazy dog near the riverbank every single morning. ".repeat(6)

function u8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"))
}

function fileEntry(rel: string, text: string): RawEntry {
  return { rel, name: path.basename(rel), bytes: u8(text) }
}

function targetPath(name: string): string {
  return path.join(workDir, name)
}

function readManifest(root: string, batchId: string): BatchManifest {
  return JSON.parse(readFileSync(path.join(root, UPLOADS_DIR, batchId, "manifest.json"), "utf8"))
}

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "vivicy-import-")))
  prevCwd = process.cwd()
  prevRuntime = process.env.VIVICY_RUNTIME_DIR
  prevFactoryRoot = process.env.VIVICY_FACTORY_ROOT
  prevTarget = process.env.VIVICY_TARGET_ROOT
  delete process.env.VIVICY_TARGET_ROOT
  process.env.VIVICY_FACTORY_ROOT = path.resolve(prevCwd, "factory")
  process.env.VIVICY_RUNTIME_DIR = path.join(workDir, ".runtime")
  process.chdir(workDir)
})

afterEach(() => {
  vi.useRealTimers()
  process.chdir(prevCwd)
  for (const [key, value] of [
    ["VIVICY_RUNTIME_DIR", prevRuntime],
    ["VIVICY_FACTORY_ROOT", prevFactoryRoot],
    ["VIVICY_TARGET_ROOT", prevTarget],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(workDir, { recursive: true, force: true })
})

describe("governance guard", () => {
  it("refuses a target that is already governed, before any write", () => {
    const target = targetPath("governed")
    mkdirSync(path.join(target, ".vivicy", "canonical"), { recursive: true })
    writeFileSync(path.join(target, ".vivicy", "canonical", "product.md"), "# untouched\n")

    expect(() => importDocuments({ targetDir: target, entries: [fileEntry("a.md", "# hi\n")] })).toThrow(
      expect.objectContaining({ code: "already_governed" })
    )
    expect(existsSync(path.join(target, UPLOADS_DIR))).toBe(false)
    expect(readFileSync(path.join(target, ".vivicy", "canonical", "product.md"), "utf8")).toBe("# untouched\n")
  })

  it("governs and imports into a brand-new (non-existent) directory", () => {
    const target = targetPath("fresh")
    const result = importDocuments({ targetDir: target, entries: [fileEntry("spec.md", ENGLISH)] })

    expect(isGovernedRoot(result.targetPath)).toBe(true)
    expect(existsSync(path.join(result.targetPath, ".vivicy", "canonical"))).toBe(true)
    expect(existsSync(path.join(result.targetPath, "vivicy.json"))).toBe(true)
    expect(result.mode).toBe("from_scratch")
    expect(result.accepted.map((f) => f.path)).toEqual(["spec.md"])
    expect(existsSync(path.join(result.targetPath, UPLOADS_DIR, result.batchId, "spec.md"))).toBe(true)
  })

  it("governs and imports into an existing non-governed directory without clobbering its files", () => {
    const target = targetPath("existing")
    mkdirSync(target, { recursive: true })
    writeFileSync(path.join(target, "README.md"), "# mine\n")

    const result = importDocuments({ targetDir: target, entries: [fileEntry("docs/intro.md", ENGLISH)] })

    expect(result.mode).toBe("existing_project")
    expect(readFileSync(path.join(target, "README.md"), "utf8")).toBe("# mine\n")
    expect(isGovernedRoot(target)).toBe(true)
    expect(existsSync(path.join(result.targetPath, UPLOADS_DIR, result.batchId, "docs", "intro.md"))).toBe(true)
  })

  it("lays the skeleton exactly once — a second import is refused as already_governed", () => {
    const target = targetPath("once")
    importDocuments({ targetDir: target, entries: [fileEntry("a.md", ENGLISH)] })
    expect(() => importDocuments({ targetDir: target, entries: [fileEntry("b.md", ENGLISH)] })).toThrow(
      expect.objectContaining({ code: "already_governed" })
    )
  })
})

describe("batch layout and ids", () => {
  it("writes the batch under .vivicy/uploads/<id>/ preserving nested structure", () => {
    const target = targetPath("nested")
    const result = importDocuments({
      targetDir: target,
      entries: [fileEntry("a/b/deep.md", ENGLISH), fileEntry("top.txt", "notes")],
    })
    const batchDir = path.join(result.targetPath, UPLOADS_DIR, result.batchId)
    expect(existsSync(path.join(batchDir, "a", "b", "deep.md"))).toBe(true)
    expect(existsSync(path.join(batchDir, "top.txt"))).toBe(true)
  })

  it("mints collision-safe ids: two batches in the same instant get distinct dirs", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T14:31:05.123Z"))
    const root = targetPath("collide")
    mkdirSync(root, { recursive: true })
    const first = mintBatchId(root)
    const second = mintBatchId(root)
    expect(first).toBe("2026-07-11T14-31-05-123Z")
    expect(second).toBe("2026-07-11T14-31-05-123Z-2")
    expect(existsSync(path.join(root, UPLOADS_DIR, first))).toBe(true)
    expect(existsSync(path.join(root, UPLOADS_DIR, second))).toBe(true)
  })
})

describe("per-file type filtering", () => {
  it("accepts supported types and rejects unknown ones per-file, not the whole batch", () => {
    const target = targetPath("mixed")
    const result = importDocuments({
      targetDir: target,
      entries: [fileEntry("good.md", ENGLISH), fileEntry("bad.exe", "MZ"), fileEntry("data.csv", "a,b\n1,2\n")],
    })
    expect(result.accepted.map((f) => f.path).sort()).toEqual(["data.csv", "good.md"])
    expect(result.rejected).toEqual([{ path: "bad.exe", code: "unsupported_type" }])
  })

  it("refuses the whole import when no file is a supported type, before governing", () => {
    const target = targetPath("all-bad")
    expect(() =>
      importDocuments({ targetDir: target, entries: [fileEntry("a.exe", "x"), fileEntry("b.bin", "y")] })
    ).toThrow(expect.objectContaining({ code: "no_supported_files" }))
    expect(existsSync(target)).toBe(false)
  })

  it("refuses an empty upload with no_files", () => {
    expect(() => importDocuments({ targetDir: targetPath("empty"), entries: [] })).toThrow(
      expect.objectContaining({ code: "no_files" })
    )
  })
})

describe("zip explosion", () => {
  it("explodes a zip into the batch preserving its internal structure", () => {
    const zip = zipSync({ "canon/a.md": strToU8(ENGLISH), "b.txt": strToU8("hello"), "skip.exe": strToU8("x") })
    const target = targetPath("zipped")
    const result = importDocuments({
      targetDir: target,
      entries: [{ rel: "bundle.zip", name: "bundle.zip", bytes: zip }],
    })
    expect(result.accepted.map((f) => f.path).sort()).toEqual(["b.txt", "canon/a.md"])
    expect(result.rejected).toEqual([{ path: "skip.exe", code: "unsupported_type" }])
    const batchDir = path.join(result.targetPath, UPLOADS_DIR, result.batchId)
    expect(existsSync(path.join(batchDir, "canon", "a.md"))).toBe(true)
  })

  it("rejects a zip-slip (../) entry as a security boundary", () => {
    const zip = zipSync({ "../escape.md": strToU8(ENGLISH) })
    expect(() =>
      importDocuments({ targetDir: targetPath("slip"), entries: [{ rel: "evil.zip", name: "evil.zip", bytes: zip }] })
    ).toThrow(expect.objectContaining({ code: "zip_slip" }))
  })

  it("throws zip_unreadable on a corrupt archive", () => {
    expect(() =>
      importDocuments({
        targetDir: targetPath("corrupt"),
        entries: [{ rel: "x.zip", name: "x.zip", bytes: u8("not a real zip") }],
      })
    ).toThrow(expect.objectContaining({ code: "zip_unreadable" }))
  })

  it("explodes one level of nesting but rejects a zip nested deeper", () => {
    const inner = zipSync({ "deep.md": strToU8(ENGLISH) })
    const tooDeep = zipSync({ "deeper.md": strToU8(ENGLISH) })
    const wrap = zipSync({ "toodeep.zip": tooDeep })
    const outer = zipSync({ "inner.zip": inner, "wrap.zip": wrap })
    const result = importDocuments({
      targetDir: targetPath("nested-zip"),
      entries: [{ rel: "outer.zip", name: "outer.zip", bytes: outer }],
    })
    expect(result.accepted.map((f) => f.path)).toEqual(["deep.md"])
    expect(result.rejected).toEqual([{ path: "toodeep.zip", code: "unsupported_type" }])
  })
})

describe("manifest", () => {
  it("records relative path, byte size, and sha256 for every batch file, sorted", () => {
    const target = targetPath("manifest")
    const csv = "id,name\n1,alpha\n2,beta\n"
    const result = importDocuments({
      targetDir: target,
      entries: [fileEntry("z/last.md", ENGLISH), fileEntry("first.csv", csv)],
    })
    const manifest = readManifest(result.targetPath, result.batchId)
    expect(manifest.batchId).toBe(result.batchId)
    expect(typeof manifest.createdAt).toBe("string")
    expect(manifest.files.map((f) => f.path)).toEqual(["first.csv", "z/last.md"])
    const csvEntry = manifest.files.find((f) => f.path === "first.csv")!
    expect(csvEntry.size).toBe(Buffer.byteLength(csv, "utf8"))
    expect(csvEntry.sha256).toBe(createHash("sha256").update(Buffer.from(csv, "utf8")).digest("hex"))
    expect(manifest.files).toEqual(result.accepted)
  })

  it("sets the dominant language by byte weight and states 'und' when nothing is scannable", () => {
    const eng = importDocuments({
      targetDir: targetPath("lang-eng"),
      entries: [fileEntry("big.md", ENGLISH), fileEntry("tiny.txt", "oui")],
    })
    expect(eng.language).toBe("eng")

    const binary = importDocuments({
      targetDir: targetPath("lang-und"),
      entries: [fileEntry("scan.pdf", "%PDF-1.4 binary-ish bytes")],
    })
    expect(binary.language).toBe("und")
  })

  it("dominantLanguage weights by byte count and breaks ties lexicographically", () => {
    expect(dominantLanguage(new Map())).toBe("und")
    expect(dominantLanguage(new Map([["fra", 200], ["eng", 100]]))).toBe("fra")
    expect(dominantLanguage(new Map([["fra", 100], ["eng", 100]]))).toBe("eng")
  })
})

describe("notification", () => {
  it("emits an append-only import batch notification", () => {
    const target = targetPath("notify")
    const result = importDocuments({ targetDir: target, entries: [fileEntry("a.md", ENGLISH)] })
    const events = readNotifications().filter((n) => n.stage === "import" && n.event === "batch")
    expect(events).toHaveLength(1)
    expect(events[0].message).toContain(result.batchId)
    expect(events[0].message).toContain("eng")
  })
})

function governedRoot(name: string): string {
  const root = importDocuments({ targetDir: targetPath(name), entries: [fileEntry("seed.md", ENGLISH)] }).targetPath
  return root
}

describe("importIntoGoverned (import into the current governed project)", () => {
  it("writes a fresh batch into an already-governed root without scaffolding or refusing it", () => {
    const root = governedRoot("gov-happy")
    const before = readdirBatches(root)

    const result = importIntoGoverned({
      root,
      entries: [fileEntry("brief.md", ENGLISH), fileEntry("data.csv", "a,b\n1,2\n"), fileEntry("skip.exe", "x")],
    })

    expect(result.accepted.map((f) => f.path).sort()).toEqual(["brief.md", "data.csv"])
    expect(result.rejected).toEqual([{ path: "skip.exe", code: "unsupported_type" }])
    expect(result.language).toBe("eng")
    const batchDir = path.join(root, UPLOADS_DIR, result.batchId)
    expect(existsSync(path.join(batchDir, "brief.md"))).toBe(true)
    const manifest = readManifest(root, result.batchId)
    expect(manifest.files).toEqual(result.accepted)
    expect(readdirBatches(root)).toEqual([...before, result.batchId].sort())
  })

  it("explodes a zip and preserves its structure, same as the acquisition route", () => {
    const root = governedRoot("gov-zip")
    const zip = zipSync({ "docs/a.md": strToU8(ENGLISH), "b.txt": strToU8("hello"), "skip.exe": strToU8("x") })
    const result = importIntoGoverned({ root, entries: [{ rel: "bundle.zip", name: "bundle.zip", bytes: zip }] })
    expect(result.accepted.map((f) => f.path).sort()).toEqual(["b.txt", "docs/a.md"])
    expect(existsSync(path.join(root, UPLOADS_DIR, result.batchId, "docs", "a.md"))).toBe(true)
  })

  it("refuses a non-governed root with not_governed and writes nothing", () => {
    const root = targetPath("ungoverned")
    mkdirSync(root, { recursive: true })
    expect(() => importIntoGoverned({ root, entries: [fileEntry("a.md", ENGLISH)] })).toThrow(
      expect.objectContaining({ code: "not_governed" })
    )
    expect(existsSync(path.join(root, UPLOADS_DIR))).toBe(false)
  })

  it("refuses no_files and no_supported_files without minting a batch", () => {
    const root = governedRoot("gov-refuse")
    const before = readdirBatches(root)
    expect(() => importIntoGoverned({ root, entries: [] })).toThrow(
      expect.objectContaining({ code: "no_files" })
    )
    expect(() => importIntoGoverned({ root, entries: [fileEntry("a.exe", "x")] })).toThrow(
      expect.objectContaining({ code: "no_supported_files" })
    )
    expect(readdirBatches(root)).toEqual(before)
  })

  it("emits its own append-only batch notification", () => {
    const root = governedRoot("gov-notify")
    const result = importIntoGoverned({ root, entries: [fileEntry("a.md", ENGLISH)] })
    const events = readNotifications().filter((n) => n.stage === "import" && n.event === "batch")
    expect(events.at(-1)?.message).toContain(result.batchId)
  })
})

function readdirBatches(root: string): string[] {
  const dir = path.join(root, UPLOADS_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort()
}
