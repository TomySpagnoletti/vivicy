import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import { getProjectRuntimeDir } from "@/lib/project-runtime"
import { getRuntimeDir } from "@/lib/runtime-dir"
import { pruneGitkeeps } from "@/lib/skeleton"
import { getTargetRoot } from "@/lib/target"

export class UploadError extends Error {
  constructor(
    message: string,
    readonly code:
      | "no_files"
      | "unsupported_type"
      | "zip_unsupported"
      | "bad_staging"
      | "not_verified"
      | "would_overwrite",
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = "UploadError"
  }
}

export type UploadKind = "canonical" | "spike" | "map" | "unknown"

export interface StagedFile {
  name: string
  rel: string
  bytes: number
  kind: UploadKind
}

export interface StageResult {
  stagingId: string
  staged: StagedFile[]
}

export interface NormalizedFile {
  from: string
  to: string
  kind: UploadKind
}

export interface NormalizationProblem {
  file: string
  kind: "conversion_unavailable"
  detail: string
}

export interface NormalizeResult {
  normalized: NormalizedFile[]
  problems: NormalizationProblem[]
}

export interface UploadReport {
  verdict: "green" | "red"
  problems: Array<{ file: string; kind: string; detail: string }>
  summary: string
}

export interface PlacedFile {
  to: string
  kind: UploadKind
}

const ACCEPTED_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".doc",
  ".docx",
  ".yml",
  ".yaml",
  ".zip",
])

const CANONICAL_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".doc", ".docx"])

const MAP_CONTENT_RE = /^nodes:/m
const MAP_TAXONOMY_RE = /\bkind_taxonomy\b/

export type ZipExpander = (zipPath: string, destDir: string) => boolean

export type DocConverter = (docPath: string) => string | null

/** Staging is scoped per-project: the verify leg cross-checks the target's existing canonical, so this must resolve to the same target. */
export function getStagingDir(stagingId: string): string {
  const targetRoot = getTargetRoot()
  const base = targetRoot === null ? getRuntimeDir() : getProjectRuntimeDir(getRuntimeDir(), targetRoot)
  return path.join(base, "uploads", stagingId)
}

export function getRawDir(stagingId: string): string {
  return path.join(getStagingDir(stagingId), "raw")
}

export function getNormalizedDir(stagingId: string): string {
  return path.join(getStagingDir(stagingId), "normalized")
}

export function getReportPath(stagingId: string): string {
  return path.join(getStagingDir(stagingId), "report.json")
}

function assertStaging(stagingId: string): string {
  const raw = getRawDir(stagingId)
  if (typeof stagingId !== "string" || stagingId.length === 0 || !existsSync(raw)) {
    throw new UploadError(`unknown staging id: ${stagingId || "(empty)"}`, "bad_staging")
  }
  return raw
}

export const expandZip: ZipExpander = (zipPath, destDir) => {
  const [command, args] =
    process.platform === "darwin"
      ? ["ditto", ["-x", "-k", zipPath, destDir]]
      : ["unzip", ["-o", zipPath, "-d", destDir]]
  try {
    const r = spawnSync(command as string, args as string[], { encoding: "utf8" })
    return r.status === 0
  } catch {
    return false
  }
}

export const convertDoc: DocConverter = (docPath) => {
  if (process.platform !== "darwin") return null
  const outPath = `${docPath}.converted.txt`
  try {
    const r = spawnSync("textutil", ["-convert", "txt", "-output", outPath, docPath], {
      encoding: "utf8",
    })
    if (r.status !== 0 || !existsSync(outPath)) return null
    return readFileSync(outPath, "utf8")
  } catch {
    return null
  }
}

export function isAcceptedFilename(name: string): boolean {
  return ACCEPTED_EXTENSIONS.has(path.extname(name).toLowerCase())
}

export function classify(rel: string, readContent: () => string): UploadKind {
  const segments = rel.split(/[\\/]/)
  if (segments.some((segment) => /spike/i.test(segment))) return "spike"
  const ext = path.extname(rel).toLowerCase()
  if (ext === ".yml" || ext === ".yaml") {
    const content = readContent()
    return MAP_CONTENT_RE.test(content) || MAP_TAXONOMY_RE.test(content) ? "map" : "unknown"
  }
  if (CANONICAL_EXTENSIONS.has(ext)) return "canonical"
  return "unknown"
}

export interface UploadEntry {
  rel: string
  name: string
  bytes: Uint8Array
}

function safeRel(rel: string, name: string): string {
  const candidate = (rel && rel.length > 0 ? rel : name).replace(/\\/g, "/")
  const normalized = path
    .normalize(candidate)
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
    .join("/")
  return normalized.length > 0 ? normalized : path.basename(name)
}

export function stageUpload(
  entries: UploadEntry[],
  expander: ZipExpander = expandZip
): StageResult {
  if (!entries || entries.length === 0) {
    throw new UploadError("no files were uploaded", "no_files")
  }
  for (const entry of entries) {
    if (!isAcceptedFilename(entry.rel || entry.name)) {
      throw new UploadError(
        `unsupported file type: ${entry.rel || entry.name}`,
        "unsupported_type"
      )
    }
  }

  const stagingId = crypto.randomUUID()
  const rawDir = getRawDir(stagingId)
  mkdirSync(rawDir, { recursive: true })

  for (const entry of entries) {
    const rel = safeRel(entry.rel, entry.name)
    const abs = path.join(rawDir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, entry.bytes)
    if (path.extname(rel).toLowerCase() === ".zip") {
      if (!expander(abs, path.dirname(abs))) {
        throw new UploadError(`could not expand zip: ${rel}`, "zip_unsupported")
      }
    }
  }

  return { stagingId, staged: scanRaw(stagingId) }
}

function scanRaw(stagingId: string): StagedFile[] {
  const rawDir = getRawDir(stagingId)
  const staged: StagedFile[] = []
  for (const abs of walkFiles(rawDir)) {
    const rel = path.relative(rawDir, abs)
    if (path.extname(rel).toLowerCase() === ".zip") continue
    staged.push({
      name: path.basename(rel),
      rel,
      bytes: statSync(abs).size,
      kind: classify(rel, () => readFileSync(abs, "utf8")),
    })
  }
  return staged.sort((a, b) => a.rel.localeCompare(b.rel))
}

function walkFiles(dir: string): string[] {
  const out: string[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(abs)
      else if (entry.isFile()) out.push(abs)
    }
  }
  return out
}

export function normalizeStaging(
  stagingId: string,
  converter: DocConverter = convertDoc
): NormalizeResult {
  assertStaging(stagingId)
  const rawDir = getRawDir(stagingId)
  const normalizedDir = getNormalizedDir(stagingId)
  const normalized: NormalizedFile[] = []
  const problems: NormalizationProblem[] = []

  for (const staged of scanRaw(stagingId)) {
    const fromAbs = path.join(rawDir, staged.rel)
    const ext = path.extname(staged.rel).toLowerCase()

    if (staged.kind === "unknown") continue

    if (staged.kind === "map") {
      const to = staged.rel
      writeNormalized(normalizedDir, to, readFileSync(fromAbs))
      normalized.push({ from: staged.rel, to, kind: "map" })
      continue
    }

    if (ext === ".md" || ext === ".markdown") {
      const to = toMarkdownRel(staged.rel)
      writeNormalized(normalizedDir, to, readFileSync(fromAbs))
      normalized.push({ from: staged.rel, to, kind: staged.kind })
    } else if (ext === ".txt") {
      const to = toMarkdownRel(staged.rel)
      writeNormalized(normalizedDir, to, readFileSync(fromAbs))
      normalized.push({ from: staged.rel, to, kind: staged.kind })
    } else {
      const text = converter(fromAbs)
      if (text === null) {
        problems.push({
          file: staged.rel,
          kind: "conversion_unavailable",
          detail: `could not convert ${ext} to text (textutil unavailable or failed); file excluded from the normalized set`,
        })
        continue
      }
      const to = toMarkdownRel(staged.rel)
      writeNormalized(normalizedDir, to, text)
      normalized.push({ from: staged.rel, to, kind: staged.kind })
    }
  }

  return { normalized, problems }
}

function toMarkdownRel(rel: string): string {
  const ext = path.extname(rel)
  return ext ? `${rel.slice(0, -ext.length)}.md` : `${rel}.md`
}

function writeNormalized(normalizedDir: string, rel: string, contents: string | Uint8Array): void {
  const abs = path.join(normalizedDir, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, contents)
}

export function readReport(stagingId: string): UploadReport | null {
  const file = getReportPath(stagingId)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8")) as UploadReport
  } catch {
    return null
  }
}

function destinationFor(normalizedRel: string, kind: UploadKind): string | null {
  const base = path.basename(normalizedRel)
  switch (kind) {
    case "canonical":
      return path.join(".vivicy", "canonical", base)
    case "spike":
      return path.join(".vivicy", "development", "spikes", base)
    case "map":
      return path.join(".vivicy", "architecture-map", "architecture-map.yml")
    default:
      return null
  }
}

export function applyUpload(stagingId: string, targetRoot: string): { placed: PlacedFile[] } {
  assertStaging(stagingId)
  const report = readReport(stagingId)
  if (!report || report.verdict !== "green") {
    throw new UploadError(
      report ? `upload verdict is "${report.verdict}", not green` : "no verification report — run verify first",
      "not_verified"
    )
  }

  const normalizedDir = getNormalizedDir(stagingId)
  const plan: Array<{ fromAbs: string; toRel: string; kind: UploadKind }> = []
  for (const abs of walkFiles(normalizedDir)) {
    const rel = path.relative(normalizedDir, abs)
    const kind = classify(rel, () => readFileSync(abs, "utf8"))
    const toRel = destinationFor(rel, kind)
    if (toRel === null) continue
    plan.push({ fromAbs: abs, toRel, kind })
  }

  const seen = new Map<string, string>()
  const collisions: string[] = []
  for (const item of plan) {
    if (existsSync(path.join(targetRoot, item.toRel))) collisions.push(item.toRel)
    const prior = seen.get(item.toRel)
    if (prior !== undefined) collisions.push(`${item.toRel} (staged twice: ${prior} and ${path.relative(normalizedDir, item.fromAbs)})`)
    else seen.set(item.toRel, path.relative(normalizedDir, item.fromAbs))
  }
  if (collisions.length > 0) {
    throw new UploadError(
      `refusing to overwrite existing file(s): ${collisions.join(", ")}`,
      "would_overwrite",
      { collisions }
    )
  }

  const placed: PlacedFile[] = []
  for (const item of plan) {
    const destAbs = path.join(targetRoot, item.toRel)
    mkdirSync(path.dirname(destAbs), { recursive: true })
    // Re-checked here (not just in the pass above) to close the race with a writer landing between the plan and this write.
    if (existsSync(destAbs)) {
      throw new UploadError(`destination appeared during placement: ${item.toRel}`, "would_overwrite", {
        collisions: [item.toRel],
      })
    }
    copyFileSync(item.fromAbs, destAbs)
    placed.push({ to: item.toRel, kind: item.kind })
  }
  pruneGitkeeps(targetRoot)
  return { placed: placed.sort((a, b) => a.to.localeCompare(b.to)) }
}
